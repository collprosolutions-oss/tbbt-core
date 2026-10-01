/**
 * OWNER-recorded invoice credits / corrections.
 *
 * InvoiceCredit rows are the source of truth for an internal write-down
 * against an issued invoice. They never rewrite Invoice.total or LineItem
 * snapshots, never mutate Payment rows, never call Stripe, and never send
 * a customer message. Remaining due is invoice total minus attributed
 * payments minus recorded credits.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  invoicePaymentBreakdown,
  listPaymentsForInvoice,
  moneyMax,
  ProjectPaymentError,
} from "@/lib/project-payments";
import { assertRequiredTablesExist } from "@/lib/request-path-schema";
import { writeSettingsAuditLog } from "@/lib/settings-ops";

const ZERO = new Prisma.Decimal(0);
const MAX_REASON_LENGTH = 500;
const MAX_IDEMPOTENCY_KEY_LENGTH = 80;

export class InvoiceCreditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvoiceCreditError";
  }
}

type CreditsDb = PrismaClient | Prisma.TransactionClient;

const CREDIT_SELECT = {
  id: true,
  invoiceId: true,
  amount: true,
  reason: true,
  recordedByMembershipId: true,
  idempotencyKey: true,
  createdAt: true,
} as const;

export type InvoiceCreditRow = {
  id: string;
  invoiceId: string;
  amount: Prisma.Decimal;
  reason: string;
  recordedByMembershipId: string;
  idempotencyKey: string;
  createdAt: Date;
};

export type RecordedInvoiceCreditResult = {
  alreadyRecorded: boolean;
  created: boolean;
  creditId: string | null;
  amountDue: Prisma.Decimal;
  recordedAmount: Prisma.Decimal;
};

let ensureTablePromise: Promise<void> | null = null;

export function resetInvoiceCreditTableEnsure() {
  ensureTablePromise = null;
}

export async function ensureInvoiceCreditTable(db: CreditsDb) {
  if (!ensureTablePromise) {
    ensureTablePromise = assertRequiredTablesExist(db, ["InvoiceCredit"]).catch(
      (error) => {
        ensureTablePromise = null;
        throw error;
      },
    );
  }
  await ensureTablePromise;
}

function toMoney(value: Prisma.Decimal | number | string) {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

export function sumInvoiceCreditAmounts(
  credits: Array<{ amount: Prisma.Decimal | number | string }>,
) {
  return credits.reduce((sum, row) => sum.add(toMoney(row.amount)), ZERO);
}

export async function listInvoiceCreditsForInvoice(
  db: CreditsDb,
  input: { businessId: string; invoiceId: string },
): Promise<InvoiceCreditRow[]> {
  await ensureInvoiceCreditTable(db);
  return db.invoiceCredit.findMany({
    where: {
      businessId: input.businessId,
      invoiceId: input.invoiceId,
    },
    orderBy: { createdAt: "asc" },
    select: CREDIT_SELECT,
  });
}

export async function listInvoiceCreditsGroupedByInvoiceId(
  db: CreditsDb,
  businessId: string,
  invoiceIds: string[],
) {
  await ensureInvoiceCreditTable(db);
  const grouped = new Map<string, InvoiceCreditRow[]>();
  const ids = [...new Set(invoiceIds.filter(Boolean))];
  for (const invoiceId of ids) grouped.set(invoiceId, []);
  if (ids.length === 0) return grouped;
  const rows = await db.invoiceCredit.findMany({
    where: {
      businessId,
      invoiceId: { in: ids },
    },
    orderBy: { createdAt: "asc" },
    select: CREDIT_SELECT,
  });
  for (const row of rows) {
    const list = grouped.get(row.invoiceId) ?? [];
    list.push(row);
    grouped.set(row.invoiceId, list);
  }
  return grouped;
}

function parseCreditAmount(raw: string | null | undefined) {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    throw new InvoiceCreditError("Enter a credit amount greater than zero.");
  }
  try {
    const amount = new Prisma.Decimal(trimmed);
    if (!amount.isFinite()) {
      throw new InvoiceCreditError("Enter a valid credit amount.");
    }
    return amount;
  } catch (error) {
    if (error instanceof InvoiceCreditError) throw error;
    throw new InvoiceCreditError("Enter a valid credit amount.");
  }
}

function parseCreditReason(raw: string | null | undefined) {
  const reason = raw?.trim() ?? "";
  if (!reason) {
    throw new InvoiceCreditError("Enter a reason for this credit.");
  }
  if (reason.length > MAX_REASON_LENGTH) {
    throw new InvoiceCreditError("Keep the credit reason under 500 characters.");
  }
  return reason;
}

function parseIdempotencyKey(raw: string | null | undefined) {
  const key = raw?.trim() ?? "";
  if (!key || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new InvoiceCreditError("That credit could not be recorded.");
  }
  return key;
}

function membershipIdFromAccess(access: BusinessAccess) {
  const membershipId = access.workspace.membership?.id?.trim() ?? "";
  if (!membershipId) {
    throw new InvoiceCreditError("That credit could not be recorded.");
  }
  return membershipId;
}

export async function recordOwnerInvoiceCredit(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    invoiceId: string;
    amount?: string | null;
    reason?: string | null;
    idempotencyKey?: string | null;
  },
): Promise<RecordedInvoiceCreditResult> {
  requireBusinessCapability(access, CAPABILITIES.RECORD_INVOICE_CREDIT);
  if (!input.invoiceId) {
    throw new InvoiceCreditError("That invoice could not be found.");
  }
  const amount = parseCreditAmount(input.amount);
  const reason = parseCreditReason(input.reason);
  const idempotencyKey = parseIdempotencyKey(input.idempotencyKey);
  const recordedByMembershipId = membershipIdFromAccess(access);

  if (!amount.gt(0)) {
    throw new InvoiceCreditError("Enter a credit amount greater than zero.");
  }

  return db.$transaction(async (tx) => {
    await ensureInvoiceCreditTable(tx);
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM "Invoice"
      WHERE id = ${input.invoiceId} AND "businessId" = ${access.businessId}
      FOR UPDATE
    `;
    if (locked.length === 0) {
      throw new InvoiceCreditError("That invoice could not be found.");
    }

    const invoice = access.assertOwned(
      await tx.invoice.findFirst({
        where: { id: input.invoiceId, ...access.scope },
        include: {
          lineItems: {
            orderBy: { createdAt: "asc" },
            select: { id: true, description: true, quantity: true, unitPrice: true, total: true },
          },
        },
      }),
    );

    const recorder = await tx.membership.findFirst({
      where: {
        id: recordedByMembershipId,
        businessId: access.businessId,
      },
      select: { id: true },
    });
    if (!recorder) {
      throw new InvoiceCreditError("That credit could not be recorded.");
    }

    const existing = await tx.invoiceCredit.findFirst({
      where: {
        businessId: access.businessId,
        invoiceId: invoice.id,
        idempotencyKey,
      },
      select: CREDIT_SELECT,
    });
    const payments = await listPaymentsForInvoice(tx, {
      businessId: access.businessId,
      invoice: { id: invoice.id, jobId: invoice.jobId, kind: invoice.kind },
    });
    const credits = await listInvoiceCreditsForInvoice(tx, {
      businessId: access.businessId,
      invoiceId: invoice.id,
    });
    const breakdown = invoicePaymentBreakdown({
      status: invoice.status,
      total: invoice.total,
      payments,
      credits,
    });

    if (existing) {
      return {
        alreadyRecorded: true,
        created: false,
        creditId: existing.id,
        amountDue: breakdown.amountDue,
        recordedAmount: existing.amount,
      };
    }

    if (invoice.status !== "SENT") {
      throw new InvoiceCreditError("Record a credit only against a sent invoice.");
    }

    const remaining = breakdown.amountDue;
    if (remaining.lte(0)) {
      throw new InvoiceCreditError("This invoice has no remaining balance to credit.");
    }
    if (amount.gt(remaining)) {
      throw new InvoiceCreditError("That amount is more than the remaining balance.");
    }

    const paymentSnapshot = payments.map((row) => ({
      id: row.id,
      amount: row.amount.toString(),
      purpose: row.purpose,
      method: row.method,
    }));
    const lineSnapshot = invoice.lineItems.map((line) => ({
      id: line.id,
      description: line.description,
      quantity: line.quantity.toString(),
      unitPrice: line.unitPrice.toString(),
      total: line.total.toString(),
    }));

    let created;
    try {
      created = await tx.invoiceCredit.create({
        data: {
          businessId: invoice.businessId,
          invoiceId: invoice.id,
          customerId: invoice.customerId,
          amount,
          reason,
          recordedByMembershipId: recorder.id,
          idempotencyKey,
        },
        select: { id: true, amount: true },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const raced = await tx.invoiceCredit.findFirst({
          where: {
            businessId: access.businessId,
            invoiceId: invoice.id,
            idempotencyKey,
          },
          select: CREDIT_SELECT,
        });
        if (raced) {
          const afterRace = invoicePaymentBreakdown({
            status: invoice.status,
            total: invoice.total,
            payments,
            credits: [...credits, raced],
          });
          return {
            alreadyRecorded: true,
            created: false,
            creditId: raced.id,
            amountDue: afterRace.amountDue,
            recordedAmount: raced.amount,
          };
        }
      }
      throw error;
    }

    const nextDue = moneyMax(remaining.sub(amount));
    await writeSettingsAuditLog(tx, {
      businessId: access.businessId,
      changedByMembershipId: recorder.id,
      settingArea: "invoices",
      settingKey: "invoiceCredit",
      previousValue: {
        invoiceId: invoice.id,
        invoiceTotal: invoice.total.toString(),
        remainingDue: remaining.toString(),
        paymentIds: paymentSnapshot.map((row) => row.id),
        lineItemIds: lineSnapshot.map((line) => line.id),
      },
      newValue: {
        creditId: created.id,
        amount: created.amount.toString(),
        reason,
        remainingDue: nextDue.toString(),
        stripeRefund: false,
        customerMessage: false,
      },
    });

    return {
      alreadyRecorded: false,
      created: true,
      creditId: created.id,
      amountDue: nextDue,
      recordedAmount: created.amount,
    };
  });
}

export function invoiceCreditErrorMessage(error: unknown, fallback: string) {
  if (error instanceof InvoiceCreditError) return error.message;
  if (error instanceof ProjectPaymentError) return error.message;
  return fallback;
}
