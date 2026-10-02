/**
 * OWNER-reviewed draft invoice for one completed recurring occurrence.
 *
 * Reuses persistDraftInvoiceFromCompletedJob() snapshots and job-scoped
 * payment attach. Binds Invoice.jobId to the occurrence only. Retries
 * return the same draft. Never sends, charges, or bills the source job
 * or another occurrence. Not a background billing engine.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { ForbiddenError, requireBusinessRole } from "@/lib/authorization";
import {
  businessTimeZoneForRecurringBooking,
  isRecurringOccurrenceJob,
  parseOwnerRecurringConfirmation,
  recurringBookingCivilDate,
} from "@/lib/cleaning-recurring-booking";
import { formatAddress, formatMoney } from "@/lib/format";
import {
  JOB_INVOICE_SCOPE_INCLUDE,
  persistDraftInvoiceFromCompletedJob,
  RECURRING_OCCURRENCE_USE_DRAFT_INVOICE_ACTION_MESSAGE,
  type PersistDraftInvoiceResult,
} from "@/lib/invoice-carry-forward";
import { resolveApprovedWorkOrderScope } from "@/lib/job-work-order";

export { RECURRING_OCCURRENCE_USE_DRAFT_INVOICE_ACTION_MESSAGE };

export const OWNER_CREATES_RECURRING_OCCURRENCE_INVOICE_MESSAGE =
  "Only the business owner can create a draft invoice for a completed recurring booking.";
export const RECURRING_OCCURRENCE_INVOICE_SOURCE_MESSAGE =
  "This action invoices one completed recurring booking, not the original job or another visit.";
export const RECURRING_OCCURRENCE_INVOICE_NOT_COMPLETED_MESSAGE =
  "Only a completed recurring booking can become a draft invoice.";
export const RECURRING_OCCURRENCE_INVOICE_CONFIRM_REQUIRED_MESSAGE =
  "Confirm this draft invoice is for this completed recurring booking only. It will not send, charge, or bill the original job.";
export const RECURRING_OCCURRENCE_INVOICE_CREATED_MESSAGE =
  "Draft invoice created for this completed recurring booking. It was not sent or charged.";
export const RECURRING_OCCURRENCE_INVOICE_REUSED_MESSAGE =
  "This completed recurring booking already has that draft invoice. It was not sent or charged again.";
export const RECURRING_OCCURRENCE_INVOICE_SCOPE_REQUIRED_MESSAGE =
  "This recurring booking has no approved work to invoice.";

export class RecurringOccurrenceInvoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecurringOccurrenceInvoiceError";
  }
}

export function recurringOccurrenceInvoiceErrorMessage(
  error: unknown,
  fallback: string,
) {
  if (error instanceof RecurringOccurrenceInvoiceError) return error.message;
  if (error instanceof ForbiddenError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  return fallback;
}

type Db = PrismaClient | Prisma.TransactionClient;

function assertOwner(access: BusinessAccess) {
  if (access.workspace.role !== "OWNER") {
    throw new ForbiddenError(OWNER_CREATES_RECURRING_OCCURRENCE_INVOICE_MESSAGE);
  }
  requireBusinessRole(access, "OWNER");
}

const OCCURRENCE_INVOICE_JOB_SELECT = {
  id: true,
  businessId: true,
  status: true,
  customerId: true,
  estimateId: true,
  approvedEstimateVersionId: true,
  scheduledAt: true,
  recurrenceSourceJobId: true,
  recurrenceOccurrenceKey: true,
  nextBookingSourceJobId: true,
  correctiveCleanSourceJobId: true,
} as const;

export type RecurringOccurrenceInvoiceLine = {
  description: string;
  quantity: string;
  unitPrice: string;
  total: string;
};

export type RecurringOccurrenceInvoiceReview = {
  jobId: string;
  sourceJobId: string;
  occurrenceKey: string;
  civilDate: string | null;
  status: string;
  customerName: string | null;
  propertyLabel: string | null;
  versionNumber: number | null;
  lines: RecurringOccurrenceInvoiceLine[];
  totalLabel: string;
  invoices: Array<{ id: string; status: string; kind: string; totalLabel: string }>;
  existingInvoiceId: string | null;
  canCreate: boolean;
};

export async function persistDraftInvoiceFromCompletedRecurringOccurrence(
  db: PrismaClient,
  input: { businessId: string; jobId: string },
): Promise<PersistDraftInvoiceResult> {
  const job = await db.job.findFirst({
    where: { id: input.jobId, businessId: input.businessId },
    select: OCCURRENCE_INVOICE_JOB_SELECT,
  });
  if (!job) {
    return { ok: false, error: "That job could not be found." };
  }
  if (!isRecurringOccurrenceJob(job)) {
    return { ok: false, error: RECURRING_OCCURRENCE_INVOICE_SOURCE_MESSAGE };
  }
  if (job.status !== "COMPLETED") {
    return { ok: false, error: RECURRING_OCCURRENCE_INVOICE_NOT_COMPLETED_MESSAGE };
  }
  const source = await db.job.findFirst({
    where: { id: job.recurrenceSourceJobId!, businessId: input.businessId },
    select: { id: true },
  });
  if (!source || source.id === job.id) {
    return { ok: false, error: RECURRING_OCCURRENCE_INVOICE_SOURCE_MESSAGE };
  }

  return persistDraftInvoiceFromCompletedJob(db, {
    businessId: input.businessId,
    jobId: job.id,
    recurringOccurrence: "allow-job-payments-only",
  });
}

export async function createOwnedDraftInvoiceFromCompletedRecurringOccurrence(
  db: PrismaClient,
  access: BusinessAccess,
  input: { jobId: string; confirmCreate: string | boolean },
): Promise<Extract<PersistDraftInvoiceResult, { ok: true }>> {
  assertOwner(access);
  if (!parseOwnerRecurringConfirmation(input.confirmCreate)) {
    throw new RecurringOccurrenceInvoiceError(
      RECURRING_OCCURRENCE_INVOICE_CONFIRM_REQUIRED_MESSAGE,
    );
  }
  const job = access.assertOwned(
    await db.job.findFirst({
      where: { id: input.jobId, ...access.scope },
      select: OCCURRENCE_INVOICE_JOB_SELECT,
    }),
  );
  const result = await persistDraftInvoiceFromCompletedRecurringOccurrence(db, {
    businessId: access.businessId,
    jobId: job.id,
  });
  if (!result.ok) {
    throw new RecurringOccurrenceInvoiceError(result.error);
  }
  return result;
}

export async function loadRecurringOccurrenceInvoiceReview(
  db: Db,
  access: BusinessAccess,
  jobId: string,
): Promise<RecurringOccurrenceInvoiceReview | null> {
  const job = await db.job.findFirst({
    where: { id: jobId, ...access.scope },
    include: {
      ...JOB_INVOICE_SCOPE_INCLUDE,
      customer: { select: { id: true, businessId: true, name: true } },
      property: {
        select: {
          id: true,
          businessId: true,
          customerId: true,
          addressLine1: true,
          addressLine2: true,
          city: true,
          region: true,
          postalCode: true,
        },
      },
      invoices: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, status: true, kind: true, total: true },
      },
    },
  });
  if (!job) return null;
  access.assertOwned(job);
  if (!isRecurringOccurrenceJob(job) || !job.recurrenceSourceJobId || !job.recurrenceOccurrenceKey) {
    return null;
  }

  const source = await db.job.findFirst({
    where: { id: job.recurrenceSourceJobId, businessId: access.businessId },
    select: { id: true },
  });
  if (!source) return null;

  const timeZone = businessTimeZoneForRecurringBooking(access.workspace.business);
  const approvedScope = resolveApprovedWorkOrderScope(job);
  const lines: RecurringOccurrenceInvoiceLine[] =
    approvedScope.source === "none"
      ? []
      : approvedScope.lineItems.map((line) => ({
          description: line.description,
          quantity: line.quantity.toString(),
          unitPrice: formatMoney(line.unitPrice),
          total: formatMoney(line.total),
        }));
  const total =
    approvedScope.source === "none" ? new Prisma.Decimal(0) : approvedScope.total;
  const invoices = job.invoices.map((invoice) => ({
    id: invoice.id,
    status: invoice.status,
    kind: invoice.kind,
    totalLabel: formatMoney(invoice.total),
  }));

  return {
    jobId: job.id,
    sourceJobId: source.id,
    occurrenceKey: job.recurrenceOccurrenceKey,
    civilDate: job.scheduledAt ? recurringBookingCivilDate(job.scheduledAt, timeZone) : null,
    status: job.status,
    customerName:
      job.customer && job.customer.businessId === access.businessId ? job.customer.name : null,
    propertyLabel:
      job.property && job.property.businessId === access.businessId
        ? formatAddress(job.property)
        : null,
    versionNumber:
      approvedScope.source === "version" ? approvedScope.versionNumber : null,
    lines,
    totalLabel: formatMoney(total),
    invoices,
    existingInvoiceId: invoices[0]?.id ?? null,
    canCreate:
      access.workspace.role === "OWNER" &&
      job.status === "COMPLETED" &&
      approvedScope.source !== "none",
  };
}
