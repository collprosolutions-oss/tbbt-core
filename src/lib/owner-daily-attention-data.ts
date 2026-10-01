/**
 * Shared Dashboard / Today loaders for owner morning attention.
 *
 * Pages and regression tests import these query shapes so take-before-filter
 * and chosen-scope bugs cannot hide behind a re-implemented inline query.
 * Deposit paging applies the unpaid filter before the display limit.
 * First-awaiting excludes different-time / change-note jobs in the WHERE.
 * Conflict detection is bounded to the 21-day window and a job take.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { loadAvailabilitySettings } from "@/lib/availability-data";
import {
  OWNER_DAILY_ATTENTION_TAKE,
  OWNER_DAILY_CONFLICT_JOBS_TAKE,
  OWNER_DAILY_DEPOSIT_MAX_PAGES,
  OWNER_DAILY_DEPOSIT_PAGE_SIZE,
  buildOwnerDailyMaterialDepositAttention,
  buildOwnerDailyScheduleConflictAttention,
  type OwnerDailyAttentionItem,
  type OwnerDailyDepositEstimateRecord,
} from "@/lib/owner-daily-attention";
import {
  OWNER_TODAY_APPOINTMENT_TAKE,
  OWNER_TODAY_JOB_SELECT,
  buildOwnerTodayAppointmentAttention,
  type OwnerTodayAppointmentAttentionItem,
  type OwnerTodayJobRecord,
} from "@/lib/owner-today";
import { depositPaidByEstimateIds } from "@/lib/project-payments";
import { detectScheduleConflicts } from "@/lib/workforce-conflicts";
import {
  capacityJobsFromRows,
  loadSchedulingPolicy,
  loadWorkforceMembers,
} from "@/lib/workforce-data";

type DailyDb = PrismaClient | Prisma.TransactionClient;

export const OWNER_DAILY_DEPOSIT_ESTIMATE_SELECT = {
  id: true,
  businessId: true,
  status: true,
  total: true,
  approvedOptionId: true,
  customer: { select: { name: true } },
  lineItems: {
    select: { type: true, total: true, description: true, optionId: true },
  },
  approvedOption: { select: { id: true, name: true, total: true } },
  approvedVersion: {
    select: {
      total: true,
      lineItems: {
        select: { type: true, total: true, description: true, optionId: true },
      },
    },
  },
} as const;

export const OWNER_DAILY_CONFLICT_JOB_SELECT = {
  id: true,
  scheduledAt: true,
  scheduledDurationMinutes: true,
  pickupDurationMinutes: true,
  assignedMembershipId: true,
  status: true,
  serviceIntent: true,
  recurrenceCadence: true,
  recurrenceStatus: true,
  nextOccurrenceAt: true,
  recurrenceSourceJobId: true,
  requiredSkills: true,
  requiredProgression: true,
  customer: { select: { name: true } },
} as const;

/**
 * First-time awaiting only. DIFFERENT_TIME_REQUESTED and change-note jobs
 * stay on the existing appointment-attention lists and must not consume
 * this take window.
 */
export function ownerDailyFirstAwaitingCandidateWhere(start: Date) {
  // OWNER_DAILY_FIRST_AWAITING_WHERE_BEGIN
  return {
    scheduledAt: { gte: start },
    status: { not: "COMPLETED" as const },
    appointmentConfirmationStatus: "AWAITING_CUSTOMER" as const,
    appointmentChangeRequestNote: null,
    appointmentConfirmedForProposalId: null,
  };
  // OWNER_DAILY_FIRST_AWAITING_WHERE_END
}

export type OwnerDailyLoadedList<T> = {
  items: T[];
  count: number;
  truncated: boolean;
  scanLimited: boolean;
};

export type OwnerDailyConflictAttention = OwnerDailyLoadedList<OwnerDailyAttentionItem> & {
  jobScanTruncated: boolean;
  scannedJobCount: number;
};

export function ownerDailyConflictWindowWhere(range: { start: Date; end: Date }) {
  return {
    OR: [
      { scheduledAt: { gte: range.start, lt: range.end } },
      {
        serviceIntent: "RECURRING" as const,
        recurrenceStatus: "ACTIVE" as const,
        nextOccurrenceAt: { gte: range.start, lt: range.end },
      },
    ],
  };
}

function conflictScanAt(
  row: { scheduledAt: Date | null; nextOccurrenceAt?: Date | null },
  range: { start: Date; end: Date },
) {
  if (
    row.scheduledAt &&
    row.scheduledAt >= range.start &&
    row.scheduledAt < range.end
  ) {
    return row.scheduledAt;
  }
  return row.nextOccurrenceAt ?? row.scheduledAt ?? range.end;
}

export async function loadOwnerDailyMaterialDepositAttention(
  db: DailyDb,
  businessId: string,
  options?: { take?: number },
): Promise<OwnerDailyLoadedList<OwnerDailyAttentionItem>> {
  const take = options?.take ?? OWNER_DAILY_ATTENTION_TAKE;
  const unpaid: OwnerDailyAttentionItem[] = [];
  let page = 0;
  let done = false;

  // OWNER_DAILY_DEPOSIT_WINDOW_BEGIN
  while (unpaid.length <= take && page < OWNER_DAILY_DEPOSIT_MAX_PAGES) {
    const batch = (await db.estimate.findMany({
      where: { businessId, status: "APPROVED" },
      select: OWNER_DAILY_DEPOSIT_ESTIMATE_SELECT,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip: page * OWNER_DAILY_DEPOSIT_PAGE_SIZE,
      take: OWNER_DAILY_DEPOSIT_PAGE_SIZE,
    })) as OwnerDailyDepositEstimateRecord[];
    page += 1;
    if (batch.length === 0) {
      done = true;
      break;
    }
    const paid = await depositPaidByEstimateIds(
      db,
      businessId,
      batch.map((estimate) => estimate.id),
    );
    unpaid.push(
      ...buildOwnerDailyMaterialDepositAttention(batch, paid, businessId),
    );
    if (batch.length < OWNER_DAILY_DEPOSIT_PAGE_SIZE) {
      done = true;
      break;
    }
  }
  // OWNER_DAILY_DEPOSIT_WINDOW_END

  // OWNER_DAILY_DEPOSIT_RESULT_BEGIN
  const truncated = unpaid.length > take || !done;
  const scanLimited = !done && unpaid.length <= take;
  return {
    items: unpaid.slice(0, take),
    count: unpaid.length,
    truncated,
    scanLimited,
  };
  // OWNER_DAILY_DEPOSIT_RESULT_END
}

export async function loadOwnerDailyFirstAwaitingJobs(
  db: DailyDb,
  scope: { businessId: string },
  start: Date,
  take = OWNER_TODAY_APPOINTMENT_TAKE,
): Promise<OwnerTodayJobRecord[]> {
  return db.job.findMany({
    where: {
      ...scope,
      ...ownerDailyFirstAwaitingCandidateWhere(start),
    },
    select: OWNER_TODAY_JOB_SELECT,
    orderBy: { scheduledAt: "asc" },
    take,
  }) as Promise<OwnerTodayJobRecord[]>;
}

export function projectOwnerDailyFirstAwaitingAttention(
  jobs: readonly OwnerTodayJobRecord[],
  options: { businessId: string; start: Date; timeZone?: string },
): OwnerTodayAppointmentAttentionItem[] {
  return buildOwnerTodayAppointmentAttention(jobs, options).filter(
    (item) => item.kind === "AWAITING_CUSTOMER",
  );
}

export async function loadOwnerDailyConflictJobs(
  db: DailyDb,
  businessId: string,
  range: { start: Date; end: Date },
) {
  // OWNER_DAILY_CONFLICT_JOB_TAKE_BEGIN
  const queryTake = OWNER_DAILY_CONFLICT_JOBS_TAKE + 1;
  // OWNER_DAILY_CONFLICT_JOB_TAKE_END
  const [windowRows, recurringRows] = await Promise.all([
    db.job.findMany({
      where: {
        businessId,
        scheduledAt: { gte: range.start, lt: range.end },
      },
      select: OWNER_DAILY_CONFLICT_JOB_SELECT,
      // OWNER_DAILY_CONFLICT_WINDOW_ORDER_BEGIN
      orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
      // OWNER_DAILY_CONFLICT_WINDOW_ORDER_END
      take: queryTake,
    }),
    db.job.findMany({
      where: {
        businessId,
        serviceIntent: "RECURRING",
        recurrenceStatus: "ACTIVE",
        // OWNER_DAILY_CONFLICT_RECURRING_BOUND_BEGIN
        nextOccurrenceAt: { gte: range.start, lt: range.end },
        // OWNER_DAILY_CONFLICT_RECURRING_BOUND_END
        NOT: { scheduledAt: { gte: range.start, lt: range.end } },
      },
      select: OWNER_DAILY_CONFLICT_JOB_SELECT,
      orderBy: [{ nextOccurrenceAt: "asc" }, { id: "asc" }],
      take: queryTake,
    }),
  ]);
  const merged = [...windowRows, ...recurringRows].sort((left, right) => {
    const delta =
      conflictScanAt(left, range).getTime() - conflictScanAt(right, range).getTime();
    if (delta !== 0) return delta;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  const jobScanTruncated =
    windowRows.length > OWNER_DAILY_CONFLICT_JOBS_TAKE ||
    recurringRows.length > OWNER_DAILY_CONFLICT_JOBS_TAKE ||
    merged.length > OWNER_DAILY_CONFLICT_JOBS_TAKE;
  const scanned = jobScanTruncated
    ? merged.slice(0, OWNER_DAILY_CONFLICT_JOBS_TAKE)
    : merged;
  return {
    jobs: capacityJobsFromRows(scanned),
    jobScanTruncated,
    scannedJobCount: scanned.length,
  };
}

export async function loadOwnerDailyScheduleConflictAttention(
  db: DailyDb,
  businessId: string,
  input: { range: { start: Date; end: Date }; timeZone: string },
): Promise<OwnerDailyConflictAttention> {
  const [{ jobs, jobScanTruncated, scannedJobCount }, settings, policy, members] =
    await Promise.all([
      loadOwnerDailyConflictJobs(db, businessId, input.range),
      loadAvailabilitySettings(db, businessId),
      loadSchedulingPolicy(db, businessId),
      loadWorkforceMembers(db, businessId),
    ]);
  const recorded = detectScheduleConflicts({
    jobs,
    settings,
    policy,
    members,
    timeZone: input.timeZone,
  });
  const allItems = buildOwnerDailyScheduleConflictAttention(
    recorded,
    new Map(
      jobs.map((job) => [
        job.id,
        {
          id: job.id,
          businessId,
          customerName: job.customerName,
        },
      ]),
    ),
    businessId,
  );
  // OWNER_DAILY_CONFLICT_DISPLAY_CAP_BEGIN
  const items = allItems.slice(0, OWNER_DAILY_ATTENTION_TAKE);
  // OWNER_DAILY_CONFLICT_DISPLAY_CAP_END
  return {
    items,
    count: allItems.length,
    truncated: allItems.length > items.length || jobScanTruncated,
    scanLimited: jobScanTruncated,
    jobScanTruncated,
    scannedJobCount,
  };
}

export type OwnerDailyActionableAttention = {
  materialDeposits: OwnerDailyLoadedList<OwnerDailyAttentionItem>;
  scheduleConflicts: OwnerDailyConflictAttention;
  firstAwaitingJobs: OwnerTodayJobRecord[];
};

export async function loadOwnerDailyActionableAttention(
  db: DailyDb,
  input: {
    businessId: string;
    scope: { businessId: string };
    todayStart: Date;
    conflictRange: { start: Date; end: Date };
    timeZone: string;
    includeFirstAwaiting?: boolean;
  },
): Promise<OwnerDailyActionableAttention> {
  const includeFirstAwaiting = input.includeFirstAwaiting !== false;
  const [materialDeposits, scheduleConflicts, firstAwaitingJobs] =
    await Promise.all([
      loadOwnerDailyMaterialDepositAttention(db, input.businessId),
      loadOwnerDailyScheduleConflictAttention(db, input.businessId, {
        range: input.conflictRange,
        timeZone: input.timeZone,
      }),
      includeFirstAwaiting
        ? loadOwnerDailyFirstAwaitingJobs(db, input.scope, input.todayStart)
        : Promise.resolve([]),
    ]);
  return { materialDeposits, scheduleConflicts, firstAwaitingJobs };
}
