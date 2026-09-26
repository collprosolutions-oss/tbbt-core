/**
 * Project payment records: material deposits and invoice credits.
 *
 * Payment rows are the source of truth. Estimate/job/invoice UIs derive
 * Deposit Due / Paid and Amount Due from those rows. Preview shares
 * Production and skips migrate, so reads/writes first ensure the table.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { emitAndProcessBusinessEvent } from "@/lib/automation/events";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { formatMoney } from "@/lib/format";
import { isPaymentMethodValue, type PaymentMethodValue } from "@/lib/invoice-payment";
import { resolveMaterialDeposit } from "@/lib/material-deposit";
import { isOriginalInvoiceKind } from "@/lib/revenue-integrity";

const ZERO = new Prisma.Decimal(0);

export const PAYMENT_PURPOSE_MATERIAL_DEPOSIT = "MATERIAL_DEPOSIT" as const;
export const PAYMENT_PURPOSE_INVOICE_BALANCE = "INVOICE_BALANCE" as const;

export type PaymentPurpose =
  | typeof PAYMENT_PURPOSE_MATERIAL_DEPOSIT
  | typeof PAYMENT_PURPOSE_INVOICE_BALANCE;

export type MaterialDepositStatus = "none" | "due" | "partial" | "paid";

export const MATERIAL_DEPOSIT_STATUS_LABELS: Record<MaterialDepositStatus, string> = {
  none: "No Deposit Required",
  due: "Deposit Due",
  partial: "Deposit Partially Paid",
  paid: "Deposit Paid",
};

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS "Payment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT,
    "estimateId" TEXT,
    "jobId" TEXT,
    "invoiceId" TEXT,
    "purpose" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "method" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "stripeCheckoutSessionId" TEXT,
    "stripePaymentIntentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);
`;

let ensureTablePromise: Promise<void> | null = null;

export class ProjectPaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectPaymentError";
  }
}

type PaymentsDb = PrismaClient | Prisma.TransactionClient;

export async function ensurePaymentTable(db: PaymentsDb) {
  if (!ensureTablePromise) {
    ensureTablePromise = (async () => {
      await db.$executeRawUnsafe(CREATE_TABLE_SQL);
      await db.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS "Payment_stripeCheckoutSessionId_key" ON "Payment"("stripeCheckoutSessionId")`,
      );
      await db.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS "Payment_stripePaymentIntentId_key" ON "Payment"("stripePaymentIntentId")`,
      );
      await db.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "Payment_businessId_idx" ON "Payment"("businessId")`,
      );
      await db.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "Payment_estimateId_idx" ON "Payment"("estimateId")`,
      );
      await db.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "Payment_jobId_idx" ON "Payment"("jobId")`,
      );
      await db.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "Payment_invoiceId_idx" ON "Payment"("invoiceId")`,
      );
    })().catch((error) => {
      ensureTablePromise = null;
      throw error;
    });
  }
  await ensureTablePromise;
}

function toMoney(value: Prisma.Decimal | number | string) {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

export function moneyMax(value: Prisma.Decimal, floor = ZERO) {
  return value.lt(floor) ? floor : value;
}

export function materialDepositStatus(
  required: Prisma.Decimal,
  paid: Prisma.Decimal,
): MaterialDepositStatus {
  if (required.lte(0)) return "none";
  if (paid.lte(0)) return "due";
  if (paid.lt(required)) return "partial";
  return "paid";
}

export function unpaidMaterialDepositWarning(
  remaining: Prisma.Decimal | number | string,
) {
  const amount = moneyMax(toMoney(remaining));
  if (amount.lte(0)) return null;
  return `Material deposit of ${formatMoney(amount)} is still due.`;
}

export async function depositPaidByEstimateIds(
  db: PaymentsDb,
  businessId: string,
  estimateIds: string[],
) {
  await ensurePaymentTable(db);
  const ids = [...new Set(estimateIds.filter(Boolean))];
  if (ids.length === 0) return new Map<string, Prisma.Decimal>();
  const rows = await db.payment.findMany({
    where: {
      businessId,
      estimateId: { in: ids },
      purpose: PAYMENT_PURPOSE_MATERIAL_DEPOSIT,
    },
    select: { estimateId: true, amount: true },
  });
  const paid = new Map<string, Prisma.Decimal>();
  for (const row of rows) {
    if (!row.estimateId) continue;
    paid.set(row.estimateId, (paid.get(row.estimateId) ?? ZERO).add(row.amount));
  }
  return paid;
}

export function sumPaymentAmounts(
  payments: Array<{ amount: Prisma.Decimal | number | string }>,
) {
  return payments.reduce((sum, row) => sum.add(toMoney(row.amount)), ZERO);
}

export type ProjectPaymentSummary = {
  estimateTotal: Prisma.Decimal;
  requiredDeposit: Prisma.Decimal;
  depositPaid: Prisma.Decimal;
  depositRemaining: Prisma.Decimal;
  depositStatus: MaterialDepositStatus;
  depositStatusLabel: string;
  totalPaid: Prisma.Decimal;
  remainingBalance: Prisma.Decimal;
  credit: Prisma.Decimal;
  depositOverage: Prisma.Decimal;
  payments: Array<{
    id: string;
    purpose: string;
    amount: Prisma.Decimal;
    method: string;
    receivedAt: Date;
    note: string | null;
  }>;
};

export function buildProjectPaymentSummary(input: {
  estimateTotal: Prisma.Decimal | number | string;
  requiredDeposit: Prisma.Decimal | number | string;
  payments: Array<{
    id: string;
    purpose: string;
    amount: Prisma.Decimal | number | string;
    method: string;
    receivedAt: Date;
    note: string | null;
  }>;
}): ProjectPaymentSummary {
  const estimateTotal = moneyMax(toMoney(input.estimateTotal));
  const requiredDeposit = moneyMax(toMoney(input.requiredDeposit));
  const depositPaid = moneyMax(
    sumPaymentAmounts(
      input.payments.filter((row) => row.purpose === PAYMENT_PURPOSE_MATERIAL_DEPOSIT),
    ),
  );
  const totalPaid = moneyMax(sumPaymentAmounts(input.payments));
  const remainingBalance = moneyMax(estimateTotal.sub(totalPaid));
  const credit = moneyMax(totalPaid.sub(estimateTotal));
  const status = materialDepositStatus(requiredDeposit, depositPaid);
  return {
    estimateTotal,
    requiredDeposit,
    depositPaid,
    depositRemaining: moneyMax(requiredDeposit.sub(depositPaid)),
    depositStatus: status,
    depositStatusLabel: MATERIAL_DEPOSIT_STATUS_LABELS[status],
    totalPaid,
    remainingBalance,
    credit,
    depositOverage: moneyMax(depositPaid.sub(requiredDeposit)),
    payments: input.payments.map((row) => ({
      id: row.id,
      purpose: row.purpose,
      amount: toMoney(row.amount),
      method: row.method,
      receivedAt: row.receivedAt,
      note: row.note,
    })),
  };
}

export type InvoicePaymentBreakdown = {
  total: Prisma.Decimal;
  depositPaid: Prisma.Decimal;
  otherPaid: Prisma.Decimal;
  amountPaid: Prisma.Decimal;
  amountDue: Prisma.Decimal;
  credit: Prisma.Decimal;
  legacyFullyPaid: boolean;
};

export function invoicePaymentBreakdown(input: {
  status: string;
  total: Prisma.Decimal | number | string;
  payments: Array<{
    purpose: string;
    amount: Prisma.Decimal | number | string;
  }>;
}): InvoicePaymentBreakdown {
  const total = moneyMax(toMoney(input.total));
  const recorded = moneyMax(sumPaymentAmounts(input.payments));
  if (recorded.lte(0) && input.status === "PAID") {
    return {
      total,
      depositPaid: ZERO,
      otherPaid: total,
      amountPaid: total,
      amountDue: ZERO,
      credit: ZERO,
      legacyFullyPaid: true,
    };
  }
  const depositPaid = moneyMax(
    sumPaymentAmounts(
      input.payments.filter((row) => row.purpose === PAYMENT_PURPOSE_MATERIAL_DEPOSIT),
    ),
  );
  const otherPaid = moneyMax(recorded.sub(depositPaid));
  return {
    total,
    depositPaid,
    otherPaid,
    amountPaid: recorded,
    amountDue: moneyMax(total.sub(recorded)),
    credit: moneyMax(recorded.sub(total)),
    legacyFullyPaid: false,
  };
}

/**
 * Remaining due across invoices from canonical Payment attribution.
 * One Payment is never counted on more than one invoice. Callers must
 * pass payments already grouped by listPaymentsGroupedByInvoiceId /
 * paymentsBelongingToInvoice — do not subtract every Payment row.
 */
export function sumInvoiceRemainingDue(
  invoices: Array<{
    id: string;
    status: string;
    total: Prisma.Decimal | number | string;
  }>,
  paymentsByInvoiceId: Map<
    string,
    Array<{ purpose: string; amount: Prisma.Decimal | number | string }>
  >,
) {
  return invoices.reduce((sum, invoice) => {
    return sum.add(
      invoicePaymentBreakdown({
        status: invoice.status,
        total: invoice.total,
        payments: paymentsByInvoiceId.get(invoice.id) ?? [],
      }).amountDue,
    );
  }, ZERO);
}

export function sumSentInvoiceRemainingDue(
  invoices: Array<{
    id: string;
    status: string;
    total: Prisma.Decimal | number | string;
  }>,
  paymentsByInvoiceId: Map<
    string,
    Array<{ purpose: string; amount: Prisma.Decimal | number | string }>
  >,
) {
  return sumInvoiceRemainingDue(
    invoices.filter((invoice) => invoice.status === "SENT"),
    paymentsByInvoiceId,
  );
}

const PROJECT_PAYMENT_SELECT = {
  id: true,
  purpose: true,
  amount: true,
  method: true,
  receivedAt: true,
  note: true,
  estimateId: true,
  jobId: true,
  invoiceId: true,
} as const;

export type ProjectPaymentRow = {
  id: string;
  purpose: string;
  amount: Prisma.Decimal;
  method: string;
  receivedAt: Date;
  note: string | null;
  estimateId: string | null;
  jobId: string | null;
  invoiceId: string | null;
};

export type InvoicePaymentTarget = {
  id: string;
  jobId?: string | null;
  kind?: string | null;
};

/**
 * Invoice-specific payment attribution. One Payment is never counted on
 * more than one invoice.
 *
 * 1. Payment.invoiceId present → belongs ONLY to that invoice.
 * 2. Payment.invoiceId null (legacy estimate/job-linked) → belongs ONLY
 *    to the ORIGINAL invoice for that job. Supplemental invoices never
 *    claim unallocated job-only rows.
 * 3. Once a job has ORIGINAL + SUPPLEMENTAL invoices, an unallocated
 *    job-only Payment is never counted independently on every invoice.
 */
export function paymentBelongsToInvoice(
  payment: { invoiceId: string | null; jobId: string | null },
  invoice: InvoicePaymentTarget,
): boolean {
  if (payment.invoiceId) {
    return payment.invoiceId === invoice.id;
  }
  if (!isOriginalInvoiceKind(invoice.kind)) {
    return false;
  }
  return Boolean(invoice.jobId) && payment.jobId === invoice.jobId;
}

export function paymentsBelongingToInvoice<
  T extends { id: string; invoiceId: string | null; jobId: string | null },
>(
  invoice: InvoicePaymentTarget,
  payments: T[],
): T[] {
  const seen = new Set<string>();
  return payments.filter((row) => {
    if (seen.has(row.id)) return false;
    const belongs = paymentBelongsToInvoice(row, invoice);
    if (belongs) seen.add(row.id);
    return belongs;
  });
}

export async function listPaymentsForInvoice(
  db: PaymentsDb,
  input: {
    businessId: string;
    invoice: InvoicePaymentTarget;
  },
) {
  const rows = await listProjectPayments(db, {
    businessId: input.businessId,
    invoiceId: input.invoice.id,
    jobId: input.invoice.jobId,
  });
  return paymentsBelongingToInvoice(input.invoice, rows);
}

export async function listProjectPayments(
  db: PaymentsDb,
  input: {
    businessId: string;
    estimateId?: string | null;
    jobId?: string | null;
    invoiceId?: string | null;
  },
) {
  await ensurePaymentTable(db);
  const or: Prisma.PaymentWhereInput[] = [];
  if (input.estimateId) or.push({ estimateId: input.estimateId });
  if (input.jobId) or.push({ jobId: input.jobId });
  if (input.invoiceId) or.push({ invoiceId: input.invoiceId });
  if (or.length === 0) return [];
  return db.payment.findMany({
    where: {
      businessId: input.businessId,
      OR: or,
    },
    orderBy: { receivedAt: "asc" },
    select: PROJECT_PAYMENT_SELECT,
  });
}

export async function listPaymentsGroupedByInvoiceId(
  db: PaymentsDb,
  businessId: string,
  invoices: InvoicePaymentTarget[],
) {
  await ensurePaymentTable(db);
  const grouped = new Map<string, ProjectPaymentRow[]>();
  if (invoices.length === 0) return grouped;
  const invoiceIds = invoices.map((invoice) => invoice.id);
  const jobIds = [
    ...new Set(
      invoices
        .map((invoice) => invoice.jobId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const or: Prisma.PaymentWhereInput[] = [{ invoiceId: { in: invoiceIds } }];
  if (jobIds.length > 0) or.push({ jobId: { in: jobIds } });
  const rows = await db.payment.findMany({
    where: {
      businessId,
      OR: or,
    },
    orderBy: { receivedAt: "asc" },
    select: PROJECT_PAYMENT_SELECT,
  });
  for (const invoice of invoices) {
    grouped.set(invoice.id, paymentsBelongingToInvoice(invoice, rows));
  }
  return grouped;
}

export function requiredDepositFromLines(
  lines: Array<{ type: string; total: Prisma.Decimal | number | string; description: string }>,
  total: Prisma.Decimal | number | string,
) {
  return resolveMaterialDeposit({ lines, total }).amount;
}

export type RecordedPayment = {
  id: string;
  created: boolean;
};

/**
 * Payment FKs to Customer/Estimate/Job/Invoice are not composite with
 * businessId. Prisma will persist or retarget a Payment across tenants
 * unless this helper rejects the related IDs first. Used by both
 * recordSucceededPayment (create) and attachEstimatePaymentsToInvoice
 * (updateMany).
 */
async function assertRelatedPaymentRecordsOwned(
  db: PaymentsDb,
  input: {
    businessId: string;
    customerId?: string | null;
    estimateId?: string | null;
    jobId?: string | null;
    invoiceId?: string | null;
  },
) {
  const lookups: Array<Promise<{ id: string } | null>> = [];
  if (input.customerId) {
    lookups.push(
      db.customer.findFirst({
        where: { id: input.customerId, businessId: input.businessId },
        select: { id: true },
      }),
    );
  }
  if (input.estimateId) {
    lookups.push(
      db.estimate.findFirst({
        where: { id: input.estimateId, businessId: input.businessId },
        select: { id: true },
      }),
    );
  }
  if (input.jobId) {
    lookups.push(
      db.job.findFirst({
        where: { id: input.jobId, businessId: input.businessId },
        select: { id: true },
      }),
    );
  }
  if (input.invoiceId) {
    lookups.push(
      db.invoice.findFirst({
        where: { id: input.invoiceId, businessId: input.businessId },
        select: { id: true },
      }),
    );
  }
  if (lookups.length === 0) return;
  const rows = await Promise.all(lookups);
  if (rows.some((row) => !row)) {
    throw new ProjectPaymentError("That payment could not be recorded.");
  }
}

export async function recordSucceededPayment(
  db: PaymentsDb,
  input: {
    businessId: string;
    customerId?: string | null;
    estimateId?: string | null;
    jobId?: string | null;
    invoiceId?: string | null;
    purpose: PaymentPurpose;
    amount: Prisma.Decimal;
    method: string;
    receivedAt?: Date;
    note?: string | null;
    stripeCheckoutSessionId?: string | null;
    stripePaymentIntentId?: string | null;
  },
): Promise<RecordedPayment> {
  await ensurePaymentTable(db);
  if (!input.amount.gt(0)) {
    throw new ProjectPaymentError("Enter a payment amount greater than zero.");
  }
  if (input.stripeCheckoutSessionId) {
    const existing = await db.payment.findFirst({
      where: {
        businessId: input.businessId,
        stripeCheckoutSessionId: input.stripeCheckoutSessionId,
      },
      select: { id: true },
    });
    if (existing) return { id: existing.id, created: false };
  }
  if (input.stripePaymentIntentId) {
    const existing = await db.payment.findFirst({
      where: {
        businessId: input.businessId,
        stripePaymentIntentId: input.stripePaymentIntentId,
      },
      select: { id: true },
    });
    if (existing) return { id: existing.id, created: false };
  }
  await assertRelatedPaymentRecordsOwned(db, input);
  try {
    const created = await db.payment.create({
      data: {
        businessId: input.businessId,
        customerId: input.customerId ?? null,
        estimateId: input.estimateId ?? null,
        jobId: input.jobId ?? null,
        invoiceId: input.invoiceId ?? null,
        purpose: input.purpose,
        amount: input.amount,
        method: input.method,
        receivedAt: input.receivedAt ?? new Date(),
        note: input.note?.trim() || null,
        stripeCheckoutSessionId: input.stripeCheckoutSessionId ?? null,
        stripePaymentIntentId: input.stripePaymentIntentId ?? null,
      },
      select: { id: true },
    });
    return { id: created.id, created: true };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const existing = await db.payment.findFirst({
        where: {
          businessId: input.businessId,
          OR: [
            input.stripeCheckoutSessionId
              ? { stripeCheckoutSessionId: input.stripeCheckoutSessionId }
              : undefined,
            input.stripePaymentIntentId
              ? { stripePaymentIntentId: input.stripePaymentIntentId }
              : undefined,
          ].filter(Boolean) as Prisma.PaymentWhereInput[],
        },
        select: { id: true },
      });
      if (existing) return { id: existing.id, created: false };
    }
    throw error;
  }
}

export async function attachEstimatePaymentsToInvoice(
  db: PaymentsDb,
  input: {
    businessId: string;
    estimateId?: string | null;
    jobId?: string | null;
    invoiceId: string;
  },
) {
  await ensurePaymentTable(db);
  await assertRelatedPaymentRecordsOwned(db, input);
  const invoice = await db.invoice.findFirst({
    where: { id: input.invoiceId, businessId: input.businessId },
    select: { id: true, kind: true },
  });
  if (!invoice || !isOriginalInvoiceKind(invoice.kind)) {
    return 0;
  }
  const or: Prisma.PaymentWhereInput[] = [];
  if (input.estimateId) or.push({ estimateId: input.estimateId, invoiceId: null });
  if (input.jobId) or.push({ jobId: input.jobId, invoiceId: null });
  if (or.length === 0) return 0;
  const updated = await db.payment.updateMany({
    where: {
      businessId: input.businessId,
      invoiceId: null,
      OR: or,
    },
    data: {
      invoiceId: input.invoiceId,
      ...(input.jobId ? { jobId: input.jobId } : {}),
    },
  });
  return updated.count;
}

export async function loadEstimatePaymentSummary(
  db: PaymentsDb,
  input: {
    businessId: string;
    estimateId: string;
    estimateTotal: Prisma.Decimal | number | string;
    requiredDeposit: Prisma.Decimal | number | string;
    jobId?: string | null;
    invoiceId?: string | null;
  },
) {
  const payments = await listProjectPayments(db, {
    businessId: input.businessId,
    estimateId: input.estimateId,
    jobId: input.jobId,
    invoiceId: input.invoiceId,
  });
  return buildProjectPaymentSummary({
    estimateTotal: input.estimateTotal,
    requiredDeposit: input.requiredDeposit,
    payments,
  });
}

export async function recordOwnerManualDeposit(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    estimateId: string;
    amount: string;
    method: string;
    receivedAt?: string;
    note?: string;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_INVOICES);
  const estimate = access.assertOwned(
    await db.estimate.findFirst({
      where: { id: input.estimateId, ...access.scope },
      select: {
        id: true,
        businessId: true,
        customerId: true,
        total: true,
        status: true,
        jobs: { select: { id: true, invoices: { select: { id: true }, take: 1, orderBy: { createdAt: "asc" } } }, take: 1 },
      },
    }),
  );
  if (estimate.status === "DRAFT") {
    throw new ProjectPaymentError("Send and approve the estimate before recording a deposit.");
  }
  if (!isPaymentMethodValue(input.method)) {
    throw new ProjectPaymentError("Choose a payment method.");
  }
  let amount: Prisma.Decimal;
  try {
    amount = new Prisma.Decimal(input.amount);
  } catch {
    throw new ProjectPaymentError("Enter a valid deposit amount.");
  }
  if (amount.lte(0) || !amount.isFinite()) {
    throw new ProjectPaymentError("Enter a deposit amount greater than zero.");
  }
  const receivedAt = input.receivedAt ? new Date(`${input.receivedAt}T12:00:00`) : new Date();
  if (Number.isNaN(receivedAt.getTime())) {
    throw new ProjectPaymentError("Choose a valid received date.");
  }
  const job = estimate.jobs[0] ?? null;
  const invoiceId = job?.invoices[0]?.id ?? null;
  return recordSucceededPayment(db, {
    businessId: estimate.businessId,
    customerId: estimate.customerId,
    estimateId: estimate.id,
    jobId: job?.id ?? null,
    invoiceId,
    purpose: PAYMENT_PURPOSE_MATERIAL_DEPOSIT,
    amount,
    method: input.method as PaymentMethodValue,
    receivedAt,
    note: input.note ?? null,
  });
}

export type OwnerInvoiceBalancePaymentResult = {
  alreadyPaid: boolean;
  created: boolean;
  paymentId: string | null;
  transitionedToPaid: boolean;
  invoicePaid: boolean;
  amountDue: Prisma.Decimal;
  recordedAmount: Prisma.Decimal;
  customerId: string | null;
};

function parseOwnerInvoicePaymentAmount(raw: string | null | undefined) {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return null;
  try {
    const amount = new Prisma.Decimal(trimmed);
    if (!amount.isFinite()) {
      throw new ProjectPaymentError("Enter a valid payment amount.");
    }
    return amount;
  } catch (error) {
    if (error instanceof ProjectPaymentError) throw error;
    throw new ProjectPaymentError("Enter a valid payment amount.");
  }
}

/**
 * Owner-recorded invoice-balance collection. Locks the Invoice row so
 * concurrent Mark Paid / Record Payment submissions share one remaining-
 * balance collection. Amount is always revalidated against current
 * attributed Payments — never against a client-submitted balance.
 */
export async function recordOwnerInvoiceBalancePayment(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    invoiceId: string;
    amount?: string | null;
    method: string;
    note?: string | null;
  },
): Promise<OwnerInvoiceBalancePaymentResult> {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_INVOICES);
  if (!input.invoiceId) {
    throw new ProjectPaymentError("That invoice could not be found.");
  }
  if (!isPaymentMethodValue(input.method)) {
    throw new ProjectPaymentError("Choose a payment method.");
  }

  const result = await db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM "Invoice"
      WHERE id = ${input.invoiceId} AND "businessId" = ${access.businessId}
      FOR UPDATE
    `;
    if (locked.length === 0) {
      throw new ProjectPaymentError("That invoice could not be found.");
    }

    const invoice = access.assertOwned(
      await tx.invoice.findFirst({
        where: { id: input.invoiceId, ...access.scope },
        include: { job: { select: { estimateId: true } } },
      }),
    );

    if (invoice.status === "PAID") {
      return {
        alreadyPaid: true,
        created: false,
        paymentId: null,
        transitionedToPaid: false,
        invoicePaid: true,
        amountDue: ZERO,
        recordedAmount: ZERO,
        customerId: invoice.customerId,
      };
    }

    if (invoice.status !== "SENT") {
      throw new ProjectPaymentError("Send the invoice before marking it paid.");
    }

    const payments = await listPaymentsForInvoice(tx, {
      businessId: access.businessId,
      invoice: { id: invoice.id, jobId: invoice.jobId, kind: invoice.kind },
    });
    const breakdown = invoicePaymentBreakdown({
      status: invoice.status,
      total: invoice.total,
      payments,
    });
    const remaining = breakdown.amountDue;

    if (remaining.lte(0)) {
      const closed = await tx.invoice.updateMany({
        where: {
          id: invoice.id,
          businessId: access.businessId,
          status: "SENT",
        },
        data: {
          status: "PAID",
          paidAt: new Date(),
          paymentMethod: input.method,
          paymentReference: input.note?.trim() || null,
        },
      });
      return {
        alreadyPaid: false,
        created: false,
        paymentId: null,
        transitionedToPaid: closed.count === 1,
        invoicePaid: true,
        amountDue: ZERO,
        recordedAmount: ZERO,
        customerId: invoice.customerId,
      };
    }

    const requested = parseOwnerInvoicePaymentAmount(input.amount);
    const amount = requested ?? remaining;
    if (amount.lte(0)) {
      throw new ProjectPaymentError("Enter a payment amount greater than zero.");
    }
    if (amount.gt(remaining)) {
      throw new ProjectPaymentError("That amount is more than the remaining balance.");
    }

    const recorded = await recordSucceededPayment(tx, {
      businessId: invoice.businessId,
      customerId: invoice.customerId,
      estimateId: invoice.job?.estimateId ?? null,
      jobId: invoice.jobId,
      invoiceId: invoice.id,
      purpose: PAYMENT_PURPOSE_INVOICE_BALANCE,
      amount,
      method: input.method,
      note: input.note ?? null,
    });

    const nextDue = moneyMax(remaining.sub(amount));
    let transitionedToPaid = false;
    if (nextDue.lte(0)) {
      const closed = await tx.invoice.updateMany({
        where: {
          id: invoice.id,
          businessId: access.businessId,
          status: "SENT",
        },
        data: {
          status: "PAID",
          paidAt: new Date(),
          paymentMethod: input.method,
          paymentReference: input.note?.trim() || null,
        },
      });
      transitionedToPaid = closed.count === 1;
    }

    return {
      alreadyPaid: false,
      created: recorded.created,
      paymentId: recorded.id,
      transitionedToPaid,
      invoicePaid: nextDue.lte(0),
      amountDue: nextDue,
      recordedAmount: amount,
      customerId: invoice.customerId,
    };
  });

  if (result.transitionedToPaid) {
    await emitAndProcessBusinessEvent(db, {
      businessId: access.businessId,
      type: "INVOICE_PAID",
      subjectType: "INVOICE",
      subjectId: input.invoiceId,
      payload: { customerId: result.customerId },
      idempotencyKey: `INVOICE_PAID:${input.invoiceId}`,
    });
  }

  return result;
}
