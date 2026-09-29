/**
 * Read model for OWNER recurring Cleaning bookings on a job.
 * Mutation-free: never creates jobs, invoices, or messages.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { formatAddress } from "@/lib/format";
import { lineItemTitle } from "@/lib/estimate-line-scope";
import {
  businessTimeZoneForRecurringBooking,
  cleaningRecurringBookingEligible,
  hasSelectedServiceScope,
  isActiveRecurringSeries,
  isCancelledRecurringSeries,
  isRecurringSeriesSource,
  recurringBookingCivilDate,
  resolveCleaningJobTradeCode,
  type RecurringBookingScopeLine,
} from "@/lib/cleaning-recurring-booking";

type Db = PrismaClient | Prisma.TransactionClient;

export type CleaningRecurringOccurrenceReview = {
  id: string;
  scheduledAt: Date | null;
  status: string;
  recurrenceStatus: string;
  recurrenceOccurrenceKey: string | null;
  civilDate: string | null;
};

export type CleaningRecurringBookingReview = {
  eligible: boolean;
  jobId: string;
  isSeriesSource: boolean;
  isOccurrence: boolean;
  sourceJobId: string | null;
  customer: { id: string; name: string } | null;
  property: { id: string; addressSummary: string } | null;
  scopeLines: RecurringBookingScopeLine[];
  estimateId: string | null;
  approvedEstimateVersionId: string | null;
  hasSelectedScope: boolean;
  cadence: string;
  recurrenceStatus: string;
  nextOccurrenceAt: Date | null;
  occurrences: CleaningRecurringOccurrenceReview[];
  canSetup: boolean;
  canStop: boolean;
  canResume: boolean;
  canFillUpcoming: boolean;
};

export async function loadCleaningRecurringBookingReview(
  db: Db,
  access: BusinessAccess,
  jobId: string,
): Promise<CleaningRecurringBookingReview | null> {
  const job = await db.job.findFirst({
    where: { id: jobId, ...access.scope },
    select: {
      id: true,
      businessId: true,
      status: true,
      customerId: true,
      propertyId: true,
      estimateId: true,
      approvedEstimateVersionId: true,
      approvedEstimateOptionId: true,
      serviceIntent: true,
      recurrenceCadence: true,
      recurrenceStatus: true,
      nextOccurrenceAt: true,
      recurrenceSourceJobId: true,
      nextBookingSourceJobId: true,
      correctiveCleanSourceJobId: true,
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
      estimate: {
        select: {
          id: true,
          businessId: true,
          serviceRequest: { select: { tradeCode: true } },
          lineItems: {
            orderBy: { createdAt: "asc" },
            select: {
              description: true,
              quantity: true,
              optionId: true,
              serviceCatalogItem: { select: { tradeCode: true } },
            },
          },
        },
      },
      approvedEstimateVersion: {
        select: {
          id: true,
          businessId: true,
          lineItems: {
            orderBy: { createdAt: "asc" },
            select: { description: true, quantity: true, optionId: true },
          },
        },
      },
    },
  });
  if (!job) return null;
  access.assertOwned(job);

  const tradeCode = resolveCleaningJobTradeCode({
    requestTradeCode: job.estimate?.serviceRequest?.tradeCode,
    catalogTradeCodes: (job.estimate?.lineItems ?? []).map(
      (line) => line.serviceCatalogItem?.tradeCode,
    ),
  });
  if (!cleaningRecurringBookingEligible(tradeCode)) {
    return null;
  }
  if (job.nextBookingSourceJobId || job.correctiveCleanSourceJobId) {
    return null;
  }

  const timeZone = businessTimeZoneForRecurringBooking(access.workspace.business);
  const optionId = job.approvedEstimateOptionId ?? null;
  const versionLines =
    job.approvedEstimateVersion && job.approvedEstimateVersion.businessId === access.businessId
      ? job.approvedEstimateVersion.lineItems
      : [];
  const estimateLines =
    versionLines.length === 0 && job.estimate && job.estimate.businessId === access.businessId
      ? job.estimate.lineItems
      : [];
  const scopeSource = (versionLines.length > 0 ? versionLines : estimateLines).filter(
    (line) => !optionId || line.optionId === optionId,
  );
  const scopeLines: RecurringBookingScopeLine[] = scopeSource.map((line) => ({
    title: lineItemTitle(line.description),
    quantity: line.quantity.toString(),
  }));

  const customer =
    job.customer && job.customer.businessId === access.businessId && job.customerId === job.customer.id
      ? { id: job.customer.id, name: job.customer.name }
      : null;
  const property =
    job.property &&
    job.property.businessId === access.businessId &&
    customer &&
    job.property.customerId === customer.id &&
    job.propertyId === job.property.id
      ? { id: job.property.id, addressSummary: formatAddress(job.property) }
      : null;

  const seriesSourceId = job.recurrenceSourceJobId ?? job.id;
  const occurrenceRows = await db.job.findMany({
    where: { businessId: access.businessId, recurrenceSourceJobId: seriesSourceId },
    select: {
      id: true,
      scheduledAt: true,
      status: true,
      recurrenceStatus: true,
      recurrenceOccurrenceKey: true,
    },
    orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
  });
  const occurrences: CleaningRecurringOccurrenceReview[] = occurrenceRows.map((row) => ({
    id: row.id,
    scheduledAt: row.scheduledAt,
    status: row.status,
    recurrenceStatus: row.recurrenceStatus,
    recurrenceOccurrenceKey: row.recurrenceOccurrenceKey,
    civilDate: row.scheduledAt ? recurringBookingCivilDate(row.scheduledAt, timeZone) : null,
  }));

  const approvedEstimateVersionId =
    job.approvedEstimateVersion && job.approvedEstimateVersion.businessId === access.businessId
      ? job.approvedEstimateVersion.id
      : null;
  const estimateId =
    job.estimate && job.estimate.businessId === access.businessId ? job.estimate.id : null;
  const hasSelectedScope = hasSelectedServiceScope({
    approvedEstimateVersionId,
    estimateId,
    scopeLineCount: scopeLines.length,
  });
  const isSource = isRecurringSeriesSource(job);
  const isOwner = access.workspace.role === "OWNER";
  const seriesJob = job.recurrenceSourceJobId
    ? await db.job.findFirst({
        where: { id: job.recurrenceSourceJobId, businessId: access.businessId },
        select: {
          serviceIntent: true,
          recurrenceCadence: true,
          recurrenceStatus: true,
          nextOccurrenceAt: true,
        },
      })
    : job;
  const cadence = seriesJob?.recurrenceCadence ?? job.recurrenceCadence;
  const recurrenceStatus = seriesJob?.recurrenceStatus ?? job.recurrenceStatus;
  const nextOccurrenceAt = seriesJob?.nextOccurrenceAt ?? job.nextOccurrenceAt;

  return {
    eligible: true,
    jobId: job.id,
    isSeriesSource: isSource,
    isOccurrence: Boolean(job.recurrenceSourceJobId),
    sourceJobId: job.recurrenceSourceJobId,
    customer,
    property,
    scopeLines,
    estimateId,
    approvedEstimateVersionId,
    hasSelectedScope,
    cadence,
    recurrenceStatus,
    nextOccurrenceAt,
    occurrences,
    canSetup:
      isOwner &&
      isSource &&
      occurrences.length === 0 &&
      Boolean(customer && property && hasSelectedScope),
    canStop:
      isOwner &&
      isSource &&
      occurrences.length > 0 &&
      isActiveRecurringSeries({
        serviceIntent: seriesJob?.serviceIntent ?? job.serviceIntent,
        recurrenceStatus,
      }),
    canResume:
      isOwner &&
      isSource &&
      occurrences.length > 0 &&
      isCancelledRecurringSeries({
        serviceIntent: seriesJob?.serviceIntent ?? job.serviceIntent,
        recurrenceStatus,
      }),
    canFillUpcoming:
      isOwner &&
      isSource &&
      occurrences.length > 0 &&
      isActiveRecurringSeries({
        serviceIntent: seriesJob?.serviceIntent ?? job.serviceIntent,
        recurrenceStatus,
      }),
  };
}
