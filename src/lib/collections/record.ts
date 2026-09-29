/**
 * OWNER-explicit collections next-step / resolution writes.
 *
 * Writes InvoiceCollectionWorkItem only. Does not send SMS or email,
 * mark invoices paid, write Payment rows, infer bank deposits, or emit
 * payment/reminder events.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, ForbiddenError, requireBusinessCapability } from "@/lib/authorization";
import { requireCollectionsWorklistWrite } from "@/lib/collections/access";
import {
  COLLECTIONS_NEXT_STEPS,
  COLLECTIONS_NOTE_MAX_CHARS,
  COLLECTIONS_NOT_UNPAID_MESSAGE,
  COLLECTIONS_NOTE_TOO_LONG_MESSAGE,
  COLLECTIONS_UNAVAILABLE_MESSAGE,
  COLLECTIONS_UNKNOWN_INVOICE_MESSAGE,
  COLLECTIONS_UNKNOWN_NEXT_STEP_MESSAGE,
  COLLECTIONS_WORK_ITEM_LOCK_PREFIX,
  type CollectionsNextStep,
} from "@/lib/collections/constants";
import { missingCollectionWorkItemSchema } from "@/lib/collections/schema";
import {
  invoicePaymentBreakdown,
  listPaymentsForInvoice,
} from "@/lib/project-payments";

type CollectionsDb = PrismaClient | Prisma.TransactionClient;

const workItemSelect = {
  id: true,
  businessId: true,
  invoiceId: true,
  customerId: true,
  status: true,
  nextStep: true,
  note: true,
  resolvedAt: true,
} as const;

export class CollectionWorkItemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollectionWorkItemError";
  }
}

export class CollectionWorkItemUnavailableError extends CollectionWorkItemError {
  constructor(message = COLLECTIONS_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = "CollectionWorkItemUnavailableError";
  }
}

export { missingCollectionWorkItemSchema } from "@/lib/collections/schema";

export function collectionWorkItemErrorMessage(error: unknown, fallback: string) {
  if (
    error instanceof CollectionWorkItemError ||
    error instanceof CollectionWorkItemUnavailableError ||
    error instanceof ForbiddenError
  ) {
    return error.message;
  }
  if (missingCollectionWorkItemSchema(error)) {
    return COLLECTIONS_UNAVAILABLE_MESSAGE;
  }
  return fallback;
}

export function collectionWorkItemLockKey(input: { businessId: string; invoiceId: string }) {
  return `${COLLECTIONS_WORK_ITEM_LOCK_PREFIX}:${input.businessId}:${input.invoiceId}`;
}

export function isCollectionsNextStep(value: string): value is CollectionsNextStep {
  return (COLLECTIONS_NEXT_STEPS as readonly string[]).includes(value);
}

function parseNote(raw: string | null | undefined) {
  const note = raw?.trim() ?? "";
  if (note.length > COLLECTIONS_NOTE_MAX_CHARS) {
    throw new CollectionWorkItemError(COLLECTIONS_NOTE_TOO_LONG_MESSAGE);
  }
  return note;
}

async function withCollectionWriteLock<T>(
  db: CollectionsDb,
  lockKey: string,
  work: (tx: CollectionsDb) => Promise<T>,
): Promise<T> {
  if ("$transaction" in db && typeof db.$transaction === "function") {
    return db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      return work(tx);
    });
  }
  return work(db);
}

async function loadOwnedUnpaidInvoice(
  db: CollectionsDb,
  access: BusinessAccess,
  invoiceId: string,
) {
  const trimmed = invoiceId.trim();
  if (!trimmed) {
    throw new CollectionWorkItemError(COLLECTIONS_UNKNOWN_INVOICE_MESSAGE);
  }
  const invoice = await db.invoice.findFirst({
    where: { id: trimmed, businessId: access.businessId },
    select: {
      id: true,
      businessId: true,
      customerId: true,
      jobId: true,
      kind: true,
      status: true,
      total: true,
    },
  });
  if (!invoice) {
    throw new CollectionWorkItemError(COLLECTIONS_UNKNOWN_INVOICE_MESSAGE);
  }
  access.assertOwned(invoice);
  if (invoice.status !== "SENT") {
    throw new CollectionWorkItemError(COLLECTIONS_NOT_UNPAID_MESSAGE);
  }
  const payments = await listPaymentsForInvoice(db, {
    businessId: access.businessId,
    invoice: { id: invoice.id, jobId: invoice.jobId, kind: invoice.kind },
  });
  const breakdown = invoicePaymentBreakdown({
    status: invoice.status,
    total: invoice.total,
    payments,
  });
  if (breakdown.amountDue.lte(0)) {
    throw new CollectionWorkItemError(COLLECTIONS_NOT_UNPAID_MESSAGE);
  }
  return invoice;
}

export type RecordedCollectionWorkItem = {
  id: string;
  businessId: string;
  invoiceId: string;
  customerId: string | null;
  status: string;
  nextStep: string | null;
  note: string;
  resolvedAt: Date | null;
};

export type RecordCollectionNextStepInput = {
  invoiceId: string;
  nextStep: string;
  note?: string | null;
};

export type RecordCollectionNextStepResult = {
  outcome: "CREATED" | "UPDATED";
  workItem: RecordedCollectionWorkItem;
};

export type ResolveCollectionWorkItemInput = {
  invoiceId: string;
  note?: string | null;
};

export type ResolveCollectionWorkItemResult = {
  outcome: "CREATED" | "UPDATED" | "UNCHANGED";
  workItem: RecordedCollectionWorkItem;
};

async function findOwnedWorkItem(
  db: CollectionsDb,
  input: { businessId: string; invoiceId: string },
) {
  return db.invoiceCollectionWorkItem.findFirst({
    where: { businessId: input.businessId, invoiceId: input.invoiceId },
    select: workItemSelect,
  });
}

export async function recordCollectionNextStep(
  db: CollectionsDb,
  access: BusinessAccess,
  input: RecordCollectionNextStepInput,
): Promise<RecordCollectionNextStepResult> {
  requireCollectionsWorklistWrite(access);
  requireBusinessCapability(access, CAPABILITIES.MANAGE_INVOICES);

  if (!isCollectionsNextStep(input.nextStep)) {
    throw new CollectionWorkItemError(COLLECTIONS_UNKNOWN_NEXT_STEP_MESSAGE);
  }
  const note = parseNote(input.note);
  const invoice = await loadOwnedUnpaidInvoice(db, access, input.invoiceId);

  try {
    return await withCollectionWriteLock(
      db,
      collectionWorkItemLockKey({ businessId: access.businessId, invoiceId: invoice.id }),
      async (tx) => {
        const existing = await findOwnedWorkItem(tx, {
          businessId: access.businessId,
          invoiceId: invoice.id,
        });
        if (existing) {
          const updated = await tx.invoiceCollectionWorkItem.update({
            where: { id: existing.id },
            data: {
              customerId: invoice.customerId,
              status: "OPEN",
              nextStep: input.nextStep,
              note,
              resolvedAt: null,
              updatedByMembershipId: access.workspace.membership.id,
            },
            select: workItemSelect,
          });
          return { outcome: "UPDATED" as const, workItem: updated };
        }
        const created = await tx.invoiceCollectionWorkItem.create({
          data: {
            businessId: access.businessId,
            invoiceId: invoice.id,
            customerId: invoice.customerId,
            status: "OPEN",
            nextStep: input.nextStep,
            note,
            createdByMembershipId: access.workspace.membership.id,
            updatedByMembershipId: access.workspace.membership.id,
          },
          select: workItemSelect,
        });
        return { outcome: "CREATED" as const, workItem: created };
      },
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await findOwnedWorkItem(db, {
        businessId: access.businessId,
        invoiceId: invoice.id,
      });
      if (raced) return { outcome: "UPDATED", workItem: raced };
    }
    if (missingCollectionWorkItemSchema(error)) {
      throw new CollectionWorkItemUnavailableError();
    }
    throw error;
  }
}

export async function resolveCollectionWorkItem(
  db: CollectionsDb,
  access: BusinessAccess,
  input: ResolveCollectionWorkItemInput,
): Promise<ResolveCollectionWorkItemResult> {
  requireCollectionsWorklistWrite(access);
  requireBusinessCapability(access, CAPABILITIES.MANAGE_INVOICES);

  const note = parseNote(input.note);
  const invoice = await loadOwnedUnpaidInvoice(db, access, input.invoiceId);

  try {
    return await withCollectionWriteLock(
      db,
      collectionWorkItemLockKey({ businessId: access.businessId, invoiceId: invoice.id }),
      async (tx) => {
        const existing = await findOwnedWorkItem(tx, {
          businessId: access.businessId,
          invoiceId: invoice.id,
        });
        if (existing && existing.status === "RESOLVED" && existing.note === note) {
          return { outcome: "UNCHANGED" as const, workItem: existing };
        }
        if (existing) {
          const updated = await tx.invoiceCollectionWorkItem.update({
            where: { id: existing.id },
            data: {
              customerId: invoice.customerId,
              status: "RESOLVED",
              note,
              resolvedAt: existing.status === "RESOLVED" && existing.resolvedAt
                ? existing.resolvedAt
                : new Date(),
              updatedByMembershipId: access.workspace.membership.id,
            },
            select: workItemSelect,
          });
          return { outcome: "UPDATED" as const, workItem: updated };
        }
        const created = await tx.invoiceCollectionWorkItem.create({
          data: {
            businessId: access.businessId,
            invoiceId: invoice.id,
            customerId: invoice.customerId,
            status: "RESOLVED",
            note,
            resolvedAt: new Date(),
            createdByMembershipId: access.workspace.membership.id,
            updatedByMembershipId: access.workspace.membership.id,
          },
          select: workItemSelect,
        });
        return { outcome: "CREATED" as const, workItem: created };
      },
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await findOwnedWorkItem(db, {
        businessId: access.businessId,
        invoiceId: invoice.id,
      });
      if (raced) return { outcome: "UPDATED", workItem: raced };
    }
    if (missingCollectionWorkItemSchema(error)) {
      throw new CollectionWorkItemUnavailableError();
    }
    throw error;
  }
}
