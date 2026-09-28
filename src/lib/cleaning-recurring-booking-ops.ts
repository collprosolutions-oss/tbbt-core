/**
 * OWNER mutations: set up, fill, stop, and resume future recurring
 * Cleaning bookings.
 *
 * Copies same-business customer, property, and selected service scope.
 * Occurrences use recurrenceSourceJobId + unique recurrenceOccurrenceKey.
 * Never writes next-booking links, corrective-clean links, invoices, or
 * customer messages.
 */
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { ForbiddenError, requireBusinessRole } from "@/lib/authorization";
import {
  CLEANING_RECURRING_BOOKING_ONLY_MESSAGE,
  CLEANING_RECURRING_BOOKING_SOURCE_MESSAGE,
  CLEANING_RECURRING_CADENCE_REQUIRED_MESSAGE,
  CLEANING_RECURRING_CONFIRM_REQUIRED_MESSAGE,
  CLEANING_RECURRING_CUSTOMER_REQUIRED_MESSAGE,
  CLEANING_RECURRING_DATE_IN_PAST_MESSAGE,
  CLEANING_RECURRING_DATE_REQUIRED_MESSAGE,
  CLEANING_RECURRING_INVALID_DATE_MESSAGE,
  CLEANING_RECURRING_NOT_ACTIVE_MESSAGE,
  CLEANING_RECURRING_NOT_STOPPED_MESSAGE,
  CLEANING_RECURRING_PROPERTY_REQUIRED_MESSAGE,
  CLEANING_RECURRING_RESUME_CONFIRM_REQUIRED_MESSAGE,
  CLEANING_RECURRING_SCOPE_REQUIRED_MESSAGE,
  CLEANING_RECURRING_SLOT_BLOCKED_MESSAGE,
  CLEANING_RECURRING_STOP_CONFIRM_REQUIRED_MESSAGE,
  OWNER_MANAGES_RECURRING_BOOKINGS_MESSAGE,
  businessTimeZoneForRecurringBooking,
  canCancelUnstartedRecurringOccurrence,
  canReopenCancelledRecurringOccurrence,
  cleaningRecurringBookingEligible,
  firstCivilDateIsInPast,
  hasSelectedServiceScope,
  isActiveRecurringSeries,
  isCancelledRecurringSeries,
  isRecurringSeriesSource,
  isUnstartedRecurringJobStatus,
  listUpcomingRecurringStarts,
  parseOwnerRecurringCadence,
  parseOwnerRecurringConfirmation,
  parseOwnerRecurringStart,
  recurrenceOccurrenceKey,
  recurringBookingCivilDate,
  recurringOccurrencePlan,
  resolveCleaningJobTradeCode,
} from "@/lib/cleaning-recurring-booking";
import { evaluateProposedSchedule, hasScheduleWarning } from "@/lib/availability";
import { loadAvailabilitySettings, loadOccupiedJobs } from "@/lib/availability-data";
import { computeNextOccurrenceAt, parseRecurrenceCadence } from "@/lib/recurrence";
import { lockTenantOwnedJob } from "@/lib/time-card-ops";
import { loadCapacityJobs, loadSchedulingPolicy } from "@/lib/workforce-data";
import { detectScheduleConflicts } from "@/lib/workforce-conflicts";

type Db = PrismaClient | Prisma.TransactionClient;

export class CleaningRecurringBookingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CleaningRecurringBookingError";
  }
}

export function cleaningRecurringBookingErrorMessage(error: unknown, fallback: string) {
  if (error instanceof CleaningRecurringBookingError) return error.message;
  if (error instanceof ForbiddenError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  return fallback;
}

export function prismaUniqueConstraintTargets(error: unknown): string[] {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return [];
  }
  const target = error.meta?.target;
  if (Array.isArray(target)) {
    return target.map((value) => String(value));
  }
  if (typeof target === "string" && target.trim()) {
    return [target];
  }
  return [];
}

export function isRecurrenceOccurrenceKeyConflict(error: unknown): boolean {
  return prismaUniqueConstraintTargets(error).some(
    (value) =>
      value === "recurrenceOccurrenceKey" || value.includes("recurrenceOccurrenceKey"),
  );
}

const SOURCE_JOB_SELECT = {
  id: true,
  businessId: true,
  status: true,
  scheduledAt: true,
  customerId: true,
  propertyId: true,
  estimateId: true,
  approvedEstimateVersionId: true,
  scheduledDurationMinutes: true,
  pickupDurationMinutes: true,
  leadSource: true,
  campaignId: true,
  businessLocationId: true,
  serviceIntent: true,
  recurrenceCadence: true,
  recurrenceStatus: true,
  nextOccurrenceAt: true,
  recurrenceSourceJobId: true,
  nextBookingSourceJobId: true,
  correctiveCleanSourceJobId: true,
  customer: { select: { id: true, businessId: true } },
  property: { select: { id: true, businessId: true, customerId: true } },
  estimate: {
    select: {
      id: true,
      businessId: true,
      customerId: true,
      propertyId: true,
      serviceRequest: { select: { tradeCode: true } },
      lineItems: {
        select: { id: true, serviceCatalogItem: { select: { tradeCode: true } } },
      },
      property: { select: { id: true, businessId: true, customerId: true } },
    },
  },
  approvedEstimateVersion: {
    select: {
      id: true,
      businessId: true,
      lineItems: { select: { id: true } },
    },
  },
} as const;

type SourceJob = Prisma.JobGetPayload<{ select: typeof SOURCE_JOB_SELECT }>;

export type SetupCleaningRecurringBookingsInput = {
  jobId: string;
  cadence: string;
  date: string;
  time?: string;
  confirmCreate: string | boolean;
  now?: Date;
};

export type StopCleaningRecurringBookingsInput = {
  jobId: string;
  confirmStop: string | boolean;
  now?: Date;
};

export type ResumeCleaningRecurringBookingsInput = {
  jobId: string;
  confirmResume: string | boolean;
  now?: Date;
};

export type FillCleaningRecurringBookingsInput = {
  jobId: string;
  now?: Date;
};

export type RecurringBookingOccurrence = {
  id: string;
  businessId: string;
  customerId: string | null;
  propertyId: string | null;
  estimateId: string | null;
  approvedEstimateVersionId: string | null;
  recurrenceSourceJobId: string | null;
  nextBookingSourceJobId: string | null;
  correctiveCleanSourceJobId: string | null;
  recurrenceOccurrenceKey: string | null;
  status: string;
  scheduledAt: Date | null;
  serviceIntent: string;
  recurrenceCadence: string;
  recurrenceStatus: string;
  nextOccurrenceAt: Date | null;
};

export type CleaningRecurringBookingsResult = {
  sourceJobId: string;
  recurrenceStatus: string;
  recurrenceCadence: string;
  nextOccurrenceAt: Date | null;
  occurrences: RecurringBookingOccurrence[];
  createdCount: number;
  alreadyExists: boolean;
};

const OCCURRENCE_SELECT = {
  id: true,
  businessId: true,
  customerId: true,
  propertyId: true,
  estimateId: true,
  approvedEstimateVersionId: true,
  recurrenceSourceJobId: true,
  nextBookingSourceJobId: true,
  correctiveCleanSourceJobId: true,
  recurrenceOccurrenceKey: true,
  status: true,
  scheduledAt: true,
  serviceIntent: true,
  recurrenceCadence: true,
  recurrenceStatus: true,
  nextOccurrenceAt: true,
} as const;

function assertOwner(access: BusinessAccess) {
  if (access.workspace.role !== "OWNER") {
    throw new ForbiddenError(OWNER_MANAGES_RECURRING_BOOKINGS_MESSAGE);
  }
  requireBusinessRole(access, "OWNER");
}

function assertCleaningSeriesSource(job: SourceJob) {
  const tradeCode = resolveCleaningJobTradeCode({
    requestTradeCode: job.estimate?.serviceRequest?.tradeCode,
    catalogTradeCodes: (job.estimate?.lineItems ?? []).map(
      (line) => line.serviceCatalogItem?.tradeCode,
    ),
  });
  if (!cleaningRecurringBookingEligible(tradeCode)) {
    throw new CleaningRecurringBookingError(CLEANING_RECURRING_BOOKING_ONLY_MESSAGE);
  }
  if (!isRecurringSeriesSource(job)) {
    throw new CleaningRecurringBookingError(CLEANING_RECURRING_BOOKING_SOURCE_MESSAGE);
  }
}

function sameBusinessCustomer(job: SourceJob, businessId: string) {
  if (job.customer && job.customer.businessId === businessId && job.customerId === job.customer.id) {
    return job.customer;
  }
  return null;
}

function sameBusinessProperty(job: SourceJob, businessId: string, customerId: string) {
  if (
    job.property &&
    job.property.businessId === businessId &&
    job.property.customerId === customerId &&
    job.propertyId === job.property.id
  ) {
    return job.property;
  }
  const estimateProperty = job.estimate?.property;
  if (
    estimateProperty &&
    estimateProperty.businessId === businessId &&
    estimateProperty.customerId === customerId &&
    job.estimate?.businessId === businessId
  ) {
    return estimateProperty;
  }
  return null;
}

function selectedScopeBinding(job: SourceJob, businessId: string) {
  const approvedVersion =
    job.approvedEstimateVersion && job.approvedEstimateVersion.businessId === businessId
      ? job.approvedEstimateVersion
      : null;
  const estimate = job.estimate && job.estimate.businessId === businessId ? job.estimate : null;
  const scopeLineCount =
    (approvedVersion?.lineItems.length ?? 0) + (estimate?.lineItems.length ?? 0);
  if (
    !hasSelectedServiceScope({
      approvedEstimateVersionId: approvedVersion?.id ?? job.approvedEstimateVersionId,
      estimateId: estimate?.id ?? (job.estimateId && estimate ? job.estimateId : null),
      scopeLineCount,
    })
  ) {
    return null;
  }
  return {
    estimateId: estimate?.id ?? null,
    approvedEstimateVersionId: approvedVersion?.id ?? null,
  };
}

function seriesLockKey(businessId: string, sourceJobId: string) {
  return `cleaning-recurring:${businessId}:${sourceJobId}`;
}

async function loadSourceJob(db: Db, businessId: string, jobId: string) {
  return db.job.findFirst({
    where: { id: jobId, businessId },
    select: SOURCE_JOB_SELECT,
  });
}

async function findSeriesOccurrences(db: Db, businessId: string, sourceJobId: string) {
  return db.job.findMany({
    where: { businessId, recurrenceSourceJobId: sourceJobId },
    select: OCCURRENCE_SELECT,
    orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
  });
}

async function withSeriesLock<T>(
  db: PrismaClient,
  businessId: string,
  sourceJobId: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const lockKey = seriesLockKey(businessId, sourceJobId);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
    const locked = await lockTenantOwnedJob(tx, businessId, sourceJobId);
    if (!locked) {
      throw new Error("Record is not in the authorized business workspace.");
    }
    return work(tx);
  });
}

function seriesAnchorStart(input: {
  existing: RecurringBookingOccurrence[];
  fallbacks: Array<Date | null | undefined>;
  timeZone: string;
  now: Date;
}) {
  const todayCivil = recurringBookingCivilDate(input.now, input.timeZone);
  const future = input.existing
    .filter(
      (row) =>
        row.scheduledAt &&
        recurringBookingCivilDate(row.scheduledAt, input.timeZone) >= todayCivil,
    )
    .sort((a, b) => (a.scheduledAt?.getTime() ?? 0) - (b.scheduledAt?.getTime() ?? 0));
  return (
    future[0]?.scheduledAt ??
    input.existing.find((row) => row.scheduledAt)?.scheduledAt ??
    input.fallbacks.find((value): value is Date => value instanceof Date) ??
    null
  );
}

function requireCopiedBindings(job: SourceJob, businessId: string) {
  const customer = sameBusinessCustomer(job, businessId);
  if (!customer) {
    throw new CleaningRecurringBookingError(CLEANING_RECURRING_CUSTOMER_REQUIRED_MESSAGE);
  }
  const property = sameBusinessProperty(job, businessId, customer.id);
  if (!property) {
    throw new CleaningRecurringBookingError(CLEANING_RECURRING_PROPERTY_REQUIRED_MESSAGE);
  }
  const scope = selectedScopeBinding(job, businessId);
  if (!scope) {
    throw new CleaningRecurringBookingError(CLEANING_RECURRING_SCOPE_REQUIRED_MESSAGE);
  }
  return { customer, property, scope };
}

async function assertProposedSlotsOpen(
  db: Db,
  input: {
    businessId: string;
    timeZone: string;
    durationMinutes: number | null;
    pickupDurationMinutes: number | null;
    slots: Array<{ start: Date; excludeJobId?: string }>;
  },
) {
  if (input.slots.length === 0) return;

  const [settings, occupied, policy, capacityJobs] = await Promise.all([
    loadAvailabilitySettings(db, input.businessId),
    loadOccupiedJobs(db, input.businessId),
    loadSchedulingPolicy(db, input.businessId),
    loadCapacityJobs(db, input.businessId),
  ]);

  const extraOccupied: Array<{
    id: string;
    scheduledAt: Date;
    scheduledDurationMinutes: number | null;
  }> = [];
  const extraCapacity: Array<{
    id: string;
    scheduledAt: Date;
    scheduledDurationMinutes: number | null;
    pickupDurationMinutes: number | null;
    status: string;
  }> = [];

  for (const [index, slot] of input.slots.entries()) {
    const proposedId = slot.excludeJobId ?? `proposed-recurring:${index}:${slot.start.toISOString()}`;
    const evaluation = evaluateProposedSchedule({
      start: slot.start,
      durationMinutes: input.durationMinutes,
      settings,
      existing: occupied
        .filter((job) => job.id !== slot.excludeJobId)
        .concat(extraOccupied),
      timeZone: input.timeZone,
    });
    const conflicts = detectScheduleConflicts({
      jobs: capacityJobs
        .filter((job) => job.id !== slot.excludeJobId)
        .concat(extraCapacity),
      settings,
      policy,
      timeZone: input.timeZone,
      proposed: {
        jobId: proposedId,
        start: slot.start,
        durationMinutes: input.durationMinutes,
        pickupMinutes: input.pickupDurationMinutes ?? 0,
      },
    });
    const blocking = conflicts.some(
      (conflict) => conflict.severity === "ERROR" || conflict.severity === "WARNING",
    );
    if (hasScheduleWarning(evaluation) || blocking) {
      throw new CleaningRecurringBookingError(CLEANING_RECURRING_SLOT_BLOCKED_MESSAGE);
    }
    extraOccupied.push({
      id: proposedId,
      scheduledAt: slot.start,
      scheduledDurationMinutes: input.durationMinutes,
    });
    extraCapacity.push({
      id: proposedId,
      scheduledAt: slot.start,
      scheduledDurationMinutes: input.durationMinutes,
      pickupDurationMinutes: input.pickupDurationMinutes,
      status: "SCHEDULED",
    });
  }
}

async function materializeUpcoming(
  tx: Prisma.TransactionClient,
  input: {
    access: BusinessAccess;
    source: SourceJob;
    firstAt: Date;
    cadence: ReturnType<typeof parseOwnerRecurringCadence>;
    timeZone: string;
    now: Date;
    reopenCancelled?: boolean;
  },
) {
  if (!input.cadence) {
    throw new CleaningRecurringBookingError(CLEANING_RECURRING_CADENCE_REQUIRED_MESSAGE);
  }
  const bindings = requireCopiedBindings(input.source, input.access.businessId);
  const plan = recurringOccurrencePlan(input.cadence);
  const starts = listUpcomingRecurringStarts({
    firstAt: input.firstAt,
    cadence: input.cadence,
    timeZone: input.timeZone,
    now: input.now,
  });
  const existing = await findSeriesOccurrences(tx, input.access.businessId, input.source.id);
  const byKey = new Map(
    existing
      .filter((row) => row.recurrenceOccurrenceKey)
      .map((row) => [row.recurrenceOccurrenceKey as string, row]),
  );
  const toCreate: Array<{ scheduledAt: Date; key: string }> = [];
  const toReopen: RecurringBookingOccurrence[] = [];
  for (const scheduledAt of starts) {
    const civilDate = recurringBookingCivilDate(scheduledAt, input.timeZone);
    const key = recurrenceOccurrenceKey(input.source.id, civilDate);
    const already = byKey.get(key);
    if (!already) {
      toCreate.push({ scheduledAt, key });
      continue;
    }
    if (
      input.reopenCancelled &&
      canReopenCancelledRecurringOccurrence({
        status: already.status,
        scheduledAt: already.scheduledAt,
        timeZone: input.timeZone,
        now: input.now,
      })
    ) {
      toReopen.push(already);
    }
  }

  await assertProposedSlotsOpen(tx, {
    businessId: input.access.businessId,
    timeZone: input.timeZone,
    durationMinutes: input.source.scheduledDurationMinutes,
    pickupDurationMinutes: input.source.pickupDurationMinutes,
    slots: [
      ...toReopen.map((row) => ({
        start: row.scheduledAt as Date,
        excludeJobId: row.id,
      })),
      ...toCreate.map((row) => ({ start: row.scheduledAt })),
    ],
  });

  let createdCount = 0;
  for (const row of toReopen) {
    const reopened = await tx.job.update({
      where: { id: row.id },
      data: {
        status: "SCHEDULED",
        recurrenceStatus: "ACTIVE",
      },
      select: OCCURRENCE_SELECT,
    });
    if (reopened.recurrenceOccurrenceKey) {
      byKey.set(reopened.recurrenceOccurrenceKey, reopened);
    }
  }
  for (const { scheduledAt, key } of toCreate) {
    const created = await tx.job.create({
      data: {
        businessId: input.access.businessId,
        customerId: bindings.customer.id,
        propertyId: bindings.property.id,
        estimateId: bindings.scope.estimateId,
        approvedEstimateVersionId: bindings.scope.approvedEstimateVersionId,
        projectToken: randomUUID(),
        status: "SCHEDULED",
        scheduledAt,
        scheduledDurationMinutes: input.source.scheduledDurationMinutes,
        pickupDurationMinutes: input.source.pickupDurationMinutes,
        leadSource: input.source.leadSource,
        campaignId: input.source.campaignId,
        businessLocationId: input.source.businessLocationId,
        serviceIntent: plan.serviceIntent,
        recurrenceCadence: plan.recurrenceCadence,
        recurrenceStatus: plan.recurrenceStatus,
        nextOccurrenceAt: null,
        recurrenceSourceJobId: input.source.id,
        nextBookingSourceJobId: null,
        correctiveCleanSourceJobId: null,
        recurrenceOccurrenceKey: key,
        appointmentConfirmationStatus: "NONE",
      },
      select: OCCURRENCE_SELECT,
    });
    byKey.set(key, created);
    createdCount += 1;
  }

  const lastCreated = starts[starts.length - 1] ?? null;
  const nextOccurrenceAt = lastCreated
    ? computeNextOccurrenceAt(
        lastCreated,
        parseRecurrenceCadence(input.cadence),
        null,
        input.timeZone,
      )
    : computeNextOccurrenceAt(
        input.firstAt,
        parseRecurrenceCadence(input.cadence),
        null,
        input.timeZone,
      );

  await tx.job.update({
    where: { id: input.source.id },
    data: {
      serviceIntent: plan.serviceIntent,
      recurrenceCadence: plan.recurrenceCadence,
      recurrenceStatus: plan.recurrenceStatus,
      nextOccurrenceAt,
    },
  });

  const occurrences = await findSeriesOccurrences(tx, input.access.businessId, input.source.id);
  return { createdCount, nextOccurrenceAt, occurrences };
}

async function resultFromSource(
  db: Db,
  access: BusinessAccess,
  sourceJobId: string,
  extra: { createdCount: number; alreadyExists: boolean },
): Promise<CleaningRecurringBookingsResult> {
  const source = access.assertOwned(
    await db.job.findFirst({
      where: { id: sourceJobId, businessId: access.businessId },
      select: {
        id: true,
        businessId: true,
        recurrenceStatus: true,
        recurrenceCadence: true,
        nextOccurrenceAt: true,
      },
    }),
  );
  const occurrences = await findSeriesOccurrences(db, access.businessId, sourceJobId);
  return {
    sourceJobId: source.id,
    recurrenceStatus: source.recurrenceStatus,
    recurrenceCadence: source.recurrenceCadence,
    nextOccurrenceAt: source.nextOccurrenceAt,
    occurrences,
    createdCount: extra.createdCount,
    alreadyExists: extra.alreadyExists,
  };
}

export async function setupCleaningRecurringBookings(
  db: PrismaClient,
  access: BusinessAccess,
  input: SetupCleaningRecurringBookingsInput,
): Promise<CleaningRecurringBookingsResult> {
  assertOwner(access);

  if (!input.jobId.trim()) {
    throw new CleaningRecurringBookingError("That job could not be found.");
  }
  const cadence = parseOwnerRecurringCadence(input.cadence);
  if (!cadence) {
    throw new CleaningRecurringBookingError(CLEANING_RECURRING_CADENCE_REQUIRED_MESSAGE);
  }
  if (!input.date.trim()) {
    throw new CleaningRecurringBookingError(CLEANING_RECURRING_DATE_REQUIRED_MESSAGE);
  }
  if (!parseOwnerRecurringConfirmation(input.confirmCreate)) {
    throw new CleaningRecurringBookingError(CLEANING_RECURRING_CONFIRM_REQUIRED_MESSAGE);
  }

  const timeZone = businessTimeZoneForRecurringBooking(access.workspace.business);
  const firstAt = parseOwnerRecurringStart({
    date: input.date,
    time: input.time,
    timeZone,
  });
  if (!firstAt) {
    throw new CleaningRecurringBookingError(CLEANING_RECURRING_INVALID_DATE_MESSAGE);
  }
  const now = input.now ?? new Date();
  if (firstCivilDateIsInPast({ firstAt, timeZone, now })) {
    throw new CleaningRecurringBookingError(CLEANING_RECURRING_DATE_IN_PAST_MESSAGE);
  }

  const source = access.assertOwned(await loadSourceJob(db, access.businessId, input.jobId));
  assertCleaningSeriesSource(source);

  try {
    return await withSeriesLock(db, access.businessId, source.id, async (tx) => {
      const existing = await findSeriesOccurrences(tx, access.businessId, source.id);
      if (existing.length > 0) {
        return resultFromSource(tx, access, source.id, {
          createdCount: 0,
          alreadyExists: true,
        });
      }

      const fresh = access.assertOwned(await loadSourceJob(tx, access.businessId, source.id));
      assertCleaningSeriesSource(fresh);
      const materialized = await materializeUpcoming(tx, {
        access,
        source: fresh,
        firstAt,
        cadence,
        timeZone,
        now,
      });
      return {
        sourceJobId: source.id,
        recurrenceStatus: "ACTIVE",
        recurrenceCadence: cadence,
        nextOccurrenceAt: materialized.nextOccurrenceAt,
        occurrences: materialized.occurrences,
        createdCount: materialized.createdCount,
        alreadyExists: false,
      };
    });
  } catch (error) {
    if (isRecurrenceOccurrenceKeyConflict(error)) {
      return resultFromSource(db, access, source.id, {
        createdCount: 0,
        alreadyExists: true,
      });
    }
    throw error;
  }
}

export async function fillCleaningRecurringBookings(
  db: PrismaClient,
  access: BusinessAccess,
  input: FillCleaningRecurringBookingsInput,
): Promise<CleaningRecurringBookingsResult> {
  assertOwner(access);
  if (!input.jobId.trim()) {
    throw new CleaningRecurringBookingError("That job could not be found.");
  }

  const source = access.assertOwned(await loadSourceJob(db, access.businessId, input.jobId));
  assertCleaningSeriesSource(source);
  if (!isActiveRecurringSeries(source)) {
    throw new CleaningRecurringBookingError(CLEANING_RECURRING_NOT_ACTIVE_MESSAGE);
  }

  const timeZone = businessTimeZoneForRecurringBooking(access.workspace.business);
  const now = input.now ?? new Date();

  try {
    return await withSeriesLock(db, access.businessId, source.id, async (tx) => {
      const fresh = access.assertOwned(await loadSourceJob(tx, access.businessId, source.id));
      assertCleaningSeriesSource(fresh);
      if (!isActiveRecurringSeries(fresh)) {
        throw new CleaningRecurringBookingError(CLEANING_RECURRING_NOT_ACTIVE_MESSAGE);
      }
      const cadence = parseOwnerRecurringCadence(fresh.recurrenceCadence);
      const existing = await findSeriesOccurrences(tx, access.businessId, fresh.id);
      const firstAt = seriesAnchorStart({
        existing,
        fallbacks: [fresh.nextOccurrenceAt, fresh.scheduledAt],
        timeZone,
        now,
      });
      if (!firstAt || !cadence) {
        throw new CleaningRecurringBookingError(CLEANING_RECURRING_CADENCE_REQUIRED_MESSAGE);
      }
      const materialized = await materializeUpcoming(tx, {
        access,
        source: fresh,
        firstAt,
        cadence,
        timeZone,
        now,
      });
      return {
        sourceJobId: fresh.id,
        recurrenceStatus: "ACTIVE",
        recurrenceCadence: cadence,
        nextOccurrenceAt: materialized.nextOccurrenceAt,
        occurrences: materialized.occurrences,
        createdCount: materialized.createdCount,
        alreadyExists: materialized.createdCount === 0,
      };
    });
  } catch (error) {
    if (isRecurrenceOccurrenceKeyConflict(error)) {
      return resultFromSource(db, access, source.id, {
        createdCount: 0,
        alreadyExists: true,
      });
    }
    throw error;
  }
}

export async function stopCleaningRecurringBookings(
  db: PrismaClient,
  access: BusinessAccess,
  input: StopCleaningRecurringBookingsInput,
): Promise<CleaningRecurringBookingsResult> {
  assertOwner(access);
  if (!input.jobId.trim()) {
    throw new CleaningRecurringBookingError("That job could not be found.");
  }
  if (!parseOwnerRecurringConfirmation(input.confirmStop)) {
    throw new CleaningRecurringBookingError(CLEANING_RECURRING_STOP_CONFIRM_REQUIRED_MESSAGE);
  }

  const source = access.assertOwned(await loadSourceJob(db, access.businessId, input.jobId));
  assertCleaningSeriesSource(source);
  if (!isActiveRecurringSeries(source)) {
    throw new CleaningRecurringBookingError(CLEANING_RECURRING_NOT_ACTIVE_MESSAGE);
  }

  const timeZone = businessTimeZoneForRecurringBooking(access.workspace.business);
  const now = input.now ?? new Date();

  return withSeriesLock(db, access.businessId, source.id, async (tx) => {
    const fresh = access.assertOwned(await loadSourceJob(tx, access.businessId, source.id));
    assertCleaningSeriesSource(fresh);
    if (!isActiveRecurringSeries(fresh)) {
      return resultFromSource(tx, access, fresh.id, {
        createdCount: 0,
        alreadyExists: true,
      });
    }

    await tx.job.update({
      where: { id: fresh.id },
      data: {
        recurrenceStatus: "CANCELLED",
        nextOccurrenceAt: null,
      },
    });
    const existing = await findSeriesOccurrences(tx, access.businessId, fresh.id);
    const futureUnstarted = existing.filter((row) =>
      canCancelUnstartedRecurringOccurrence({
        status: row.status,
        scheduledAt: row.scheduledAt,
        timeZone,
        now,
      }),
    );
    const pastUnstarted = existing.filter(
      (row) =>
        isUnstartedRecurringJobStatus(row.status) &&
        !canCancelUnstartedRecurringOccurrence({
          status: row.status,
          scheduledAt: row.scheduledAt,
          timeZone,
          now,
        }),
    );
    if (futureUnstarted.length > 0) {
      await tx.job.updateMany({
        where: {
          businessId: access.businessId,
          id: { in: futureUnstarted.map((row) => row.id) },
        },
        data: { status: "CANCELLED", recurrenceStatus: "CANCELLED" },
      });
    }
    if (pastUnstarted.length > 0) {
      await tx.job.updateMany({
        where: {
          businessId: access.businessId,
          id: { in: pastUnstarted.map((row) => row.id) },
        },
        data: { recurrenceStatus: "CANCELLED" },
      });
    }
    return resultFromSource(tx, access, fresh.id, {
      createdCount: 0,
      alreadyExists: false,
    });
  });
}

export async function resumeCleaningRecurringBookings(
  db: PrismaClient,
  access: BusinessAccess,
  input: ResumeCleaningRecurringBookingsInput,
): Promise<CleaningRecurringBookingsResult> {
  assertOwner(access);
  if (!input.jobId.trim()) {
    throw new CleaningRecurringBookingError("That job could not be found.");
  }
  if (!parseOwnerRecurringConfirmation(input.confirmResume)) {
    throw new CleaningRecurringBookingError(CLEANING_RECURRING_RESUME_CONFIRM_REQUIRED_MESSAGE);
  }

  const source = access.assertOwned(await loadSourceJob(db, access.businessId, input.jobId));
  assertCleaningSeriesSource(source);
  if (!isCancelledRecurringSeries(source)) {
    throw new CleaningRecurringBookingError(CLEANING_RECURRING_NOT_STOPPED_MESSAGE);
  }

  const timeZone = businessTimeZoneForRecurringBooking(access.workspace.business);
  const now = input.now ?? new Date();

  return withSeriesLock(db, access.businessId, source.id, async (tx) => {
    const fresh = access.assertOwned(await loadSourceJob(tx, access.businessId, source.id));
    assertCleaningSeriesSource(fresh);
    if (!isCancelledRecurringSeries(fresh)) {
      throw new CleaningRecurringBookingError(CLEANING_RECURRING_NOT_STOPPED_MESSAGE);
    }
    const cadence = parseOwnerRecurringCadence(fresh.recurrenceCadence);
    const existing = await findSeriesOccurrences(tx, access.businessId, fresh.id);
    const firstAt = seriesAnchorStart({
      existing,
      fallbacks: [fresh.scheduledAt],
      timeZone,
      now,
    });
    if (!firstAt || !cadence) {
      throw new CleaningRecurringBookingError(CLEANING_RECURRING_CADENCE_REQUIRED_MESSAGE);
    }
    const materialized = await materializeUpcoming(tx, {
      access,
      source: { ...fresh, recurrenceStatus: "ACTIVE" },
      firstAt,
      cadence,
      timeZone,
      now,
      reopenCancelled: true,
    });
    return {
      sourceJobId: fresh.id,
      recurrenceStatus: "ACTIVE",
      recurrenceCadence: cadence,
      nextOccurrenceAt: materialized.nextOccurrenceAt,
      occurrences: materialized.occurrences,
      createdCount: materialized.createdCount,
      alreadyExists: false,
    };
  });
}

export async function countBusinessJobs(db: PrismaClient, businessId: string) {
  return db.job.count({ where: { businessId } });
}

export async function countBusinessInvoices(db: PrismaClient, businessId: string) {
  return db.invoice.count({ where: { businessId } });
}
