/**
 * Time Cards mutations -- the real write path used by server actions and
 * the check-time-cards script. Every function takes an already-authorized
 * BusinessAccess (or a field-scoped membership id) and re-checks tenant
 * + role + assignment before writing. Callers must have already run
 * requireBusinessAccess() / requireFieldWorkspace(); this module never
 * trusts a browser-supplied businessId.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, ForbiddenError, requireBusinessCapability } from "@/lib/authorization";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { requireOperatingProductCapability } from "@/lib/product-entitlements";
import { evaluateCompleteJob, evaluateStartJob } from "@/lib/job-lifecycle";
import {
  approvalSnapshot,
  canApproveWeek,
  canEditTimeEntry,
  canRequestTimeCorrection,
  coerceHourlyWage,
  missingApprovalSnapshotPatch,
  hasOverlappingEntry,
  isAssignedFieldActivityType,
  isTimeActivityType,
  jobRequiredForActivity,
  paidHours,
  parseHourlyWage,
  toAuditSnapshot,
  weekRange,
  type AssignedFieldActivityType,
  type TimeActivityType,
  type TimeAdjustmentAction,
  type TimeCorrectionDecisionValue,
  type TimeEntrySource,
} from "@/lib/time-cards";

type Db = PrismaClient | Prisma.TransactionClient;

export class TimeCardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeCardError";
  }
}

/** Audit reason written when completion closes a RUNNING JOB TimeEntry. */
export const JOB_COMPLETION_TIME_CLOSED_REASON = "Closed because the job was completed.";

/** Audit reason written when Start job opens RUNNING JOB TimeEntry. */
export const JOB_START_TIME_STARTED_REASON = "Started because the job was started.";

/** Audit reason written when the assigned worker stops RUNNING JOB time. */
export const JOB_STOP_TIME_CLOSED_REASON = "Stopped job time from the field app.";

/** Audit reason written when the assigned worker starts TRAVEL time. */
export const TRAVEL_START_TIME_STARTED_REASON = "Started travel time from the field app.";

/** Audit reason written when the assigned worker stops TRAVEL time. */
export const TRAVEL_STOP_TIME_CLOSED_REASON = "Stopped travel time from the field app.";

/** Audit reason written when the assigned worker starts MATERIAL_PICKUP time. */
export const MATERIAL_PICKUP_START_TIME_STARTED_REASON =
  "Started material pickup time from the field app.";

/** Audit reason written when the assigned worker stops MATERIAL_PICKUP time. */
export const MATERIAL_PICKUP_STOP_TIME_CLOSED_REASON =
  "Stopped material pickup time from the field app.";

const COMPLETED_JOB_CLOCK_IN_ERROR = "This job is completed. Job time cannot be started.";
const APPROVED_WEEK_COMPLETION_ERROR =
  "This job cannot be completed while approved job time is still running. Reopen the timesheet week first.";
const APPROVED_WEEK_STOP_ERROR =
  "Job time cannot be stopped while that timesheet week is approved. Reopen the timesheet week first.";
const APPROVED_WEEK_ACTIVITY_START_ERROR =
  "This time cannot be started while that timesheet week is approved. Reopen the timesheet week first.";
const APPROVED_WEEK_ACTIVITY_STOP_ERROR =
  "This time cannot be stopped while that timesheet week is approved. Reopen the timesheet week first.";
const MISSING_COMPLETION_ACTOR_ERROR = "That job could not be completed.";
const MISSING_START_ACTOR_ERROR = "That job could not be started.";
const MISSING_STOP_ACTOR_ERROR = "That job time could not be stopped.";
const MISSING_ACTIVITY_START_ACTOR_ERROR = "That time could not be started.";
const MISSING_ACTIVITY_STOP_ACTOR_ERROR = "That time could not be stopped.";
const INVALID_FIELD_ACTIVITY_ERROR = "Choose travel or material pickup.";
const COMPLETION_CLOCK_ORDER_ERROR =
  "Job time cannot be closed because the completion time is not after the clock-in start.";
const STOP_CLOCK_ORDER_ERROR =
  "Job time cannot be stopped because the stop time is not after the clock-in start.";
const AUTOMATIC_CLOCK_TRANSITION_REASON = "Closed automatically when a new activity started.";
const APPROVED_WEEK_CORRECTION_REQUEST_ERROR =
  "That week is approved. Ask an owner to reopen it before requesting a correction.";
const APPROVED_WEEK_CORRECTION_DECIDE_ERROR =
  "That week is approved. Reopen it before accepting a time correction.";
const DUPLICATE_PENDING_CORRECTION_ERROR =
  "A correction request is already waiting for the owner.";
const DUPLICATE_CORRECTION_DECISION_ERROR =
  "That correction request already has an owner decision.";
const MISSING_CORRECTION_REQUEST_ERROR = "That correction request could not be found.";
export const ENTRY_CHANGED_SINCE_REQUEST_ERROR =
  "The entry changed since this request. Ask the worker to resubmit.";

type TenantTimeCorrectionRequestRow = {
  id: string;
  businessId: string;
  timeEntryId: string;
  requestedByMembershipId: string;
  status: string;
  reason: string;
  originalStartedAt: Date;
  originalEndedAt: Date;
  proposedStartedAt: Date;
  proposedEndedAt: Date;
};

type TenantJobRow = {
  id: string;
  businessId: string;
  assignedMembershipId: string | null;
  status: string;
  customerId: string | null;
};

function decimal(value: number | null | undefined): Prisma.Decimal | null {
  if (value == null || !Number.isFinite(value)) return null;
  return new Prisma.Decimal(value);
}

async function loadMembershipInBusiness(
  db: Db,
  businessId: string,
  membershipId: string,
) {
  const membership = await db.membership.findFirst({
    where: { id: membershipId, businessId },
    include: { user: { select: { name: true } } },
  });
  if (!membership) {
    throw new TimeCardError("That worker is not in this business.");
  }
  return membership;
}

async function loadJobInBusiness(db: Db, businessId: string, jobId: string) {
  const job = await db.job.findFirst({
    where: { id: jobId, businessId },
    select: {
      id: true,
      assignedMembershipId: true,
      businessId: true,
      status: true,
      customerId: true,
    },
  });
  if (!job) {
    throw new TimeCardError("That job is not in this business.");
  }
  return job;
}

/**
 * Tenant/job-scoped row lock. Different jobs and tenants stay independent;
 * this never serializes the whole TimeEntry or Job table.
 */
export async function lockTenantOwnedJob(
  db: Db,
  businessId: string,
  jobId: string,
): Promise<TenantJobRow | null> {
  const rows = await db.$queryRaw<TenantJobRow[]>`
    SELECT id, "businessId", "assignedMembershipId", status, "customerId"
    FROM "Job"
    WHERE id = ${jobId}
      AND "businessId" = ${businessId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

export function workerTimesheetWeekLockKey(
  businessId: string,
  membershipId: string,
  weekStartedAt: Date,
) {
  return `time-cards-week:${businessId}:${membershipId}:${weekStartedAt.toISOString()}`;
}

/**
 * Shared per-worker-week lock for approve and accept. Taken first in both
 * paths so an approval that commits first makes accept refuse, and an
 * accept that commits first is included in the approval snapshot.
 */
export async function lockWorkerTimesheetWeek(
  db: Db,
  businessId: string,
  membershipId: string,
  weekStartedAt: Date,
) {
  const lockKey = workerTimesheetWeekLockKey(businessId, membershipId, weekStartedAt);
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
}

async function lockWorkerTimesheetWeeks(
  db: Db,
  businessId: string,
  membershipId: string,
  at: readonly Date[],
  timeZone: string,
) {
  const starts = [
    ...new Map(
      at.map((value) => {
        const start = weekRange(value, timeZone).start;
        return [start.toISOString(), start] as const;
      }),
    ).values(),
  ].sort((left, right) => left.getTime() - right.getTime());
  for (const start of starts) {
    await lockWorkerTimesheetWeek(db, businessId, membershipId, start);
  }
}

type TenantTimeEntryLockRow = {
  id: string;
  businessId: string;
  membershipId: string;
};

async function lockTenantOwnedTimeEntry(
  db: Db,
  businessId: string,
  timeEntryId: string,
): Promise<TenantTimeEntryLockRow | null> {
  const rows = await db.$queryRaw<TenantTimeEntryLockRow[]>`
    SELECT id, "businessId", "membershipId"
    FROM "TimeEntry"
    WHERE id = ${timeEntryId}
      AND "businessId" = ${businessId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function lockWorkerWeekTimeEntries(
  db: Db,
  businessId: string,
  membershipId: string,
  start: Date,
  end: Date,
) {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM "TimeEntry"
    WHERE "businessId" = ${businessId}
      AND "membershipId" = ${membershipId}
      AND "startedAt" < ${end}
      AND ("endedAt" IS NULL OR "endedAt" > ${start})
    ORDER BY id
    FOR UPDATE
  `;
  if (rows.length === 0) return [];
  return db.timeEntry.findMany({
    where: {
      businessId,
      membershipId,
      id: { in: rows.map((row) => row.id) },
    },
  });
}

function isPendingCorrectionUniqueError(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return true;
  }
  return error instanceof Error && /TimeCorrectionRequest_timeEntryId_pending/i.test(error.message);
}

function entryTimesMatchRequest(
  entry: { startedAt: Date; endedAt: Date | null },
  request: { originalStartedAt: Date; originalEndedAt: Date },
) {
  return (
    entry.startedAt.getTime() === request.originalStartedAt.getTime() &&
    entry.endedAt != null &&
    entry.endedAt.getTime() === request.originalEndedAt.getTime()
  );
}

async function assertJobClockAccess(input: {
  db: Db;
  businessId: string;
  actorRole: string;
  actorMembershipId: string;
  workerMembershipId: string;
  jobId: string | null;
  activityType: TimeActivityType;
}) {
  if (jobRequiredForActivity(input.activityType)) {
    if (!input.jobId) {
      throw new TimeCardError("Job time must be tied to a job.");
    }
  }
  if (!input.jobId) return;

  const job = await loadJobInBusiness(input.db, input.businessId, input.jobId);
  if (input.actorRole === "MEMBER") {
    if (input.workerMembershipId !== input.actorMembershipId) {
      throw new ForbiddenError();
    }
    if (job.assignedMembershipId !== input.actorMembershipId) {
      throw new TimeCardError("You can only clock time on a job assigned to you.");
    }
  }
}

async function loadOpenWeek(
  db: Db,
  businessId: string,
  membershipId: string,
  at: Date,
  timeZone?: string,
) {
  const { start } = weekRange(at, timeZone);
  return db.timesheetWeek.findUnique({
    where: {
      businessId_membershipId_weekStartedAt: {
        businessId,
        membershipId,
        weekStartedAt: start,
      },
    },
  });
}

async function assertWeekEditable(
  db: Db,
  businessId: string,
  membershipId: string,
  at: Date,
  timeZone?: string,
) {
  const week = await loadOpenWeek(db, businessId, membershipId, at, timeZone);
  if (week?.status === "APPROVED") {
    throw new TimeCardError("That week is approved. Reopen it before changing time.");
  }
}

function correctionWeekInstants(at: ReadonlyArray<Date | null | undefined>) {
  return at.filter((value): value is Date => value instanceof Date);
}

async function assertCorrectionWeeksEditable(
  db: Db,
  businessId: string,
  membershipId: string,
  at: ReadonlyArray<Date | null | undefined>,
  timeZone: string,
) {
  const starts = [
    ...new Map(
      correctionWeekInstants(at).map((value) => {
        const start = weekRange(value, timeZone).start;
        return [start.toISOString(), start] as const;
      }),
    ).values(),
  ];
  for (const start of starts) {
    await assertWeekEditable(db, businessId, membershipId, start, timeZone);
  }
}

/**
 * Clock-in transition must not close a RUNNING entry whose own week is
 * approved, even when the new start falls in an open week.
 */
async function assertRunningEntriesEditable(
  db: Db,
  businessId: string,
  membershipId: string,
  running: readonly { startedAt: Date }[],
  at: Date,
  approvedWeekError?: string,
) {
  for (const current of running) {
    try {
      await assertWeekEditable(db, businessId, membershipId, current.startedAt);
      await assertWeekEditable(db, businessId, membershipId, at);
    } catch (error) {
      if (isTimeCardError(error)) {
        throw new TimeCardError(approvedWeekError ?? error.message);
      }
      throw error;
    }
  }
}

async function overlappingEntries(
  db: Db,
  businessId: string,
  membershipId: string,
  startedAt: Date,
  endedAt: Date | null,
  excludeId?: string,
) {
  const others = await db.timeEntry.findMany({
    where: {
      businessId,
      membershipId,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true, startedAt: true, endedAt: true },
  });
  return others.filter((entry) =>
    hasOverlappingEntry({ startedAt, endedAt }, [entry]),
  );
}

async function writeAdjustment(
  db: Db,
  input: {
    businessId: string;
    timeEntryId: string;
    actorMembershipId: string;
    action: TimeAdjustmentAction;
    reason?: string | null;
    previous: ReturnType<typeof toAuditSnapshot> | null;
    next: ReturnType<typeof toAuditSnapshot> | null;
  },
) {
  return db.timeEntryAdjustment.create({
    data: {
      businessId: input.businessId,
      timeEntryId: input.timeEntryId,
      actorMembershipId: input.actorMembershipId,
      action: input.action,
      reason: input.reason ?? null,
      previousJson: input.previous ?? undefined,
      nextJson: input.next ?? undefined,
    },
  });
}

export type ClockInInput = {
  membershipId: string;
  activityType: string;
  jobId?: string | null;
  note?: string | null;
  startedAt?: Date;
};

/**
 * Clock a worker into a new activity. Defined transition: if they already
 * have a RUNNING entry, that entry is closed at the new start time (no
 * overlap, no silent dual-clock). MEMBER may only clock themselves, and
 * only onto a Job assigned to them.
 */
export async function clockInTime(
  db: PrismaClient,
  access: BusinessAccess,
  input: ClockInInput,
) {
  await requireOperatingProductCapability(db, access, PRODUCT_CAPABILITIES.TIME_TRACKING);
  const actorRole = access.workspace.role;
  const actorMembershipId = access.workspace.membership.id;
  const workerMembershipId = input.membershipId;
  const startedAt = input.startedAt ?? new Date();

  if (!isTimeActivityType(input.activityType)) {
    throw new TimeCardError("Choose a valid activity.");
  }
  const activityType = input.activityType;
  if (actorRole === "MEMBER") {
    if (workerMembershipId !== actorMembershipId) {
      throw new ForbiddenError();
    }
  } else {
    requireBusinessCapability(access, CAPABILITIES.MANAGE_TIME_CARDS);
  }

  return db.$transaction(async (tx) => {
    await loadMembershipInBusiness(tx, access.businessId, workerMembershipId);
    await assertWeekEditable(tx, access.businessId, workerMembershipId, startedAt);
    await assertJobClockAccess({
      db: tx,
      businessId: access.businessId,
      actorRole,
      actorMembershipId,
      workerMembershipId,
      jobId: input.jobId ?? null,
      activityType,
    });

    if (activityType === "JOB" && input.jobId) {
      const locked = await lockTenantOwnedJob(tx, access.businessId, input.jobId);
      if (!locked) {
        throw new TimeCardError("That job is not in this business.");
      }
      if (locked.status === "COMPLETED") {
        throw new TimeCardError(COMPLETED_JOB_CLOCK_IN_ERROR);
      }
    }

    const running = await tx.timeEntry.findMany({
      where: {
        businessId: access.businessId,
        membershipId: workerMembershipId,
        status: "RUNNING",
        endedAt: null,
      },
    });
    await assertRunningEntriesEditable(
      tx,
      access.businessId,
      workerMembershipId,
      running,
      startedAt,
    );

    for (const current of running) {
      const previous = toAuditSnapshot(current);
      const closed = await tx.timeEntry.update({
        where: { id: current.id },
        data: { endedAt: startedAt, status: "READY" },
      });
      await writeAdjustment(tx, {
        businessId: access.businessId,
        timeEntryId: closed.id,
        actorMembershipId,
        action: "UPDATE",
        reason: AUTOMATIC_CLOCK_TRANSITION_REASON,
        previous,
        next: toAuditSnapshot(closed),
      });
    }

    const overlaps = await overlappingEntries(
      tx,
      access.businessId,
      workerMembershipId,
      startedAt,
      null,
    );
    if (overlaps.length > 0) {
      throw new TimeCardError("That clock-in overlaps existing time.");
    }

    const created = await tx.timeEntry.create({
      data: {
        businessId: access.businessId,
        membershipId: workerMembershipId,
        jobId: input.jobId ?? null,
        activityType,
        status: "RUNNING",
        startedAt,
        endedAt: null,
        note: input.note?.trim() || null,
        source: "CLOCK",
      },
    });
    await writeAdjustment(tx, {
      businessId: access.businessId,
      timeEntryId: created.id,
      actorMembershipId,
      action: "CREATE",
      reason: input.note?.trim() || null,
      previous: null,
      next: toAuditSnapshot(created),
    });
    return created;
  });
}

export async function clockOutTime(
  db: PrismaClient,
  access: BusinessAccess,
  input: { membershipId: string; endedAt?: Date; note?: string | null },
) {
  await requireOperatingProductCapability(db, access, PRODUCT_CAPABILITIES.TIME_TRACKING);
  const actorRole = access.workspace.role;
  const actorMembershipId = access.workspace.membership.id;
  const endedAt = input.endedAt ?? new Date();

  if (actorRole === "MEMBER" && input.membershipId !== actorMembershipId) {
    throw new ForbiddenError();
  }
  if (actorRole !== "MEMBER") {
    requireBusinessCapability(access, CAPABILITIES.MANAGE_TIME_CARDS);
  }

  return db.$transaction(async (tx) => {
    await loadMembershipInBusiness(tx, access.businessId, input.membershipId);
    await assertWeekEditable(tx, access.businessId, input.membershipId, endedAt);

    const running = await tx.timeEntry.findFirst({
      where: {
        businessId: access.businessId,
        membershipId: input.membershipId,
        status: "RUNNING",
        endedAt: null,
      },
      orderBy: { startedAt: "desc" },
    });
    if (!running) {
      throw new TimeCardError("No active clock to stop.");
    }
    if (endedAt <= running.startedAt) {
      throw new TimeCardError("Clock-out must be after the start time.");
    }

    const previous = toAuditSnapshot(running);
    const updated = await tx.timeEntry.update({
      where: { id: running.id },
      data: {
        endedAt,
        status: "READY",
        note: input.note?.trim() ? input.note.trim() : running.note,
      },
    });
    await writeAdjustment(tx, {
      businessId: access.businessId,
      timeEntryId: updated.id,
      actorMembershipId,
      action: "UPDATE",
      reason: input.note?.trim() || "Clocked out.",
      previous,
      next: toAuditSnapshot(updated),
    });
    return updated;
  });
}

export type ManualEntryInput = {
  membershipId: string;
  activityType: string;
  jobId?: string | null;
  startedAt: Date;
  endedAt: Date;
  note?: string | null;
  needsReview?: boolean;
};

export async function createManualTimeEntry(
  db: PrismaClient,
  access: BusinessAccess,
  input: ManualEntryInput,
) {
  await requireOperatingProductCapability(db, access, PRODUCT_CAPABILITIES.TIME_TRACKING);
  requireBusinessCapability(access, CAPABILITIES.MANAGE_TIME_CARDS);
  if (!isTimeActivityType(input.activityType)) {
    throw new TimeCardError("Choose a valid activity.");
  }
  const activityType = input.activityType;
  if (input.endedAt <= input.startedAt) {
    throw new TimeCardError("End time must be after start time.");
  }

  const actorMembershipId = access.workspace.membership.id;

  return db.$transaction(async (tx) => {
    await loadMembershipInBusiness(tx, access.businessId, input.membershipId);
    await assertWeekEditable(tx, access.businessId, input.membershipId, input.startedAt);
    await assertJobClockAccess({
      db: tx,
      businessId: access.businessId,
      actorRole: access.workspace.role,
      actorMembershipId,
      workerMembershipId: input.membershipId,
      jobId: input.jobId ?? null,
      activityType,
    });

    const overlaps = await overlappingEntries(
      tx,
      access.businessId,
      input.membershipId,
      input.startedAt,
      input.endedAt,
    );
    if (overlaps.length > 0) {
      throw new TimeCardError("That time overlaps another entry for this worker.");
    }

    const created = await tx.timeEntry.create({
      data: {
        businessId: access.businessId,
        membershipId: input.membershipId,
        jobId: input.jobId ?? null,
        activityType,
        status: input.needsReview ? "NEEDS_REVIEW" : "READY",
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        note: input.note?.trim() || null,
        source: "MANUAL" satisfies TimeEntrySource,
      },
    });
    await writeAdjustment(tx, {
      businessId: access.businessId,
      timeEntryId: created.id,
      actorMembershipId,
      action: "CREATE",
      reason: input.note?.trim() || "Manual time entry.",
      previous: null,
      next: toAuditSnapshot(created),
    });
    return created;
  });
}

export type CorrectEntryInput = {
  timeEntryId: string;
  startedAt?: Date;
  endedAt?: Date | null;
  activityType?: string;
  jobId?: string | null;
  note?: string | null;
  reason: string;
};

export async function correctTimeEntry(
  db: PrismaClient,
  access: BusinessAccess,
  input: CorrectEntryInput,
) {
  await requireOperatingProductCapability(db, access, PRODUCT_CAPABILITIES.TIME_TRACKING);
  requireBusinessCapability(access, CAPABILITIES.MANAGE_TIME_CARDS);
  const reason = input.reason.trim();
  if (!reason) {
    throw new TimeCardError("A reason is required to correct time.");
  }
  if (input.activityType && !isTimeActivityType(input.activityType)) {
    throw new TimeCardError("Choose a valid activity.");
  }

  const actorMembershipId = access.workspace.membership.id;

  return db.$transaction(async (tx) => {
    const entry = await tx.timeEntry.findFirst({
      where: { id: input.timeEntryId, businessId: access.businessId },
    });
    if (!entry) {
      throw new TimeCardError("That time entry could not be found.");
    }
    access.assertOwned(entry);
    if (!canEditTimeEntry(entry.status)) {
      throw new TimeCardError("Approved time cannot be edited. Reopen the week first.");
    }

    const startedAt = input.startedAt ?? entry.startedAt;
    const endedAt = input.endedAt === undefined ? entry.endedAt : input.endedAt;
    const activityType = (input.activityType ?? entry.activityType) as TimeActivityType;
    const jobId = input.jobId === undefined ? entry.jobId : input.jobId;

    if (endedAt && endedAt <= startedAt) {
      throw new TimeCardError("End time must be after start time.");
    }
    await assertWeekEditable(tx, access.businessId, entry.membershipId, startedAt);
    await assertJobClockAccess({
      db: tx,
      businessId: access.businessId,
      actorRole: access.workspace.role,
      actorMembershipId,
      workerMembershipId: entry.membershipId,
      jobId,
      activityType,
    });

    const overlaps = await overlappingEntries(
      tx,
      access.businessId,
      entry.membershipId,
      startedAt,
      endedAt,
      entry.id,
    );
    if (overlaps.length > 0) {
      throw new TimeCardError("That correction would overlap another entry.");
    }

    const previous = toAuditSnapshot(entry);
    const updated = await tx.timeEntry.update({
      where: { id: entry.id },
      data: {
        startedAt,
        endedAt,
        activityType,
        jobId,
        note: input.note === undefined ? entry.note : (input.note?.trim() || null),
        status: endedAt ? "NEEDS_REVIEW" : "RUNNING",
      },
    });
    await writeAdjustment(tx, {
      businessId: access.businessId,
      timeEntryId: updated.id,
      actorMembershipId,
      action: "CORRECT",
      reason,
      previous,
      next: toAuditSnapshot(updated),
    });
    return updated;
  });
}

export type RequestTimeCorrectionInput = {
  timeEntryId: string;
  reason: string;
  proposedStartedAt: Date;
  proposedEndedAt: Date;
  timeZone: string;
};

/**
 * Worker request to correct their own recorded time. Proposed times and
 * the original clock are stored on TimeCorrectionRequest. The TimeEntry
 * itself is not rewritten here -- an OWNER must accept or decline.
 */
export async function requestTimeCorrection(
  db: PrismaClient,
  access: BusinessAccess,
  input: RequestTimeCorrectionInput,
) {
  await requireOperatingProductCapability(db, access, PRODUCT_CAPABILITIES.TIME_TRACKING);
  const reason = input.reason.trim();
  if (!reason) {
    throw new TimeCardError("Describe the correction you need.");
  }
  if (input.proposedEndedAt <= input.proposedStartedAt) {
    throw new TimeCardError("Proposed end time must be after the proposed start time.");
  }
  const timeZone = input.timeZone || resolveBusinessTimeZone(access.workspace.business);
  const actorMembershipId = access.workspace.membership.id;

  return db.$transaction(async (tx) => {
    const locked = await lockTenantOwnedTimeEntry(tx, access.businessId, input.timeEntryId);
    if (!locked) {
      throw new TimeCardError("That time entry could not be found.");
    }
    const entry = await tx.timeEntry.findFirst({
      where: { id: locked.id, businessId: access.businessId },
    });
    if (!entry) {
      throw new TimeCardError("That time entry could not be found.");
    }
    access.assertOwned(entry);
    if (entry.membershipId !== actorMembershipId) {
      throw new ForbiddenError();
    }
    const gate = canRequestTimeCorrection({
      entryStatus: entry.status,
      endedAt: entry.endedAt,
    });
    if (!gate.ok) {
      throw new TimeCardError(gate.error ?? APPROVED_WEEK_CORRECTION_REQUEST_ERROR);
    }
    if (!entry.endedAt) {
      throw new TimeCardError("Stop the clock before requesting a correction.");
    }
    try {
      await assertCorrectionWeeksEditable(
        tx,
        access.businessId,
        entry.membershipId,
        [entry.startedAt, entry.endedAt, input.proposedStartedAt, input.proposedEndedAt],
        timeZone,
      );
    } catch (error) {
      if (isTimeCardError(error)) {
        throw new TimeCardError(APPROVED_WEEK_CORRECTION_REQUEST_ERROR);
      }
      throw error;
    }

    const pending = await tx.timeCorrectionRequest.findFirst({
      where: {
        businessId: access.businessId,
        timeEntryId: entry.id,
        status: "PENDING",
      },
    });
    if (pending) {
      throw new TimeCardError(DUPLICATE_PENDING_CORRECTION_ERROR);
    }

    const overlaps = await overlappingEntries(
      tx,
      access.businessId,
      entry.membershipId,
      input.proposedStartedAt,
      input.proposedEndedAt,
      entry.id,
    );
    if (overlaps.length > 0) {
      throw new TimeCardError("That correction would overlap another entry.");
    }

    const previous = toAuditSnapshot(entry);
    let request;
    try {
      request = await tx.timeCorrectionRequest.create({
        data: {
          businessId: access.businessId,
          timeEntryId: entry.id,
          requestedByMembershipId: actorMembershipId,
          status: "PENDING",
          reason,
          originalStartedAt: entry.startedAt,
          originalEndedAt: entry.endedAt,
          proposedStartedAt: input.proposedStartedAt,
          proposedEndedAt: input.proposedEndedAt,
        },
      });
    } catch (error) {
      if (isPendingCorrectionUniqueError(error)) {
        throw new TimeCardError(DUPLICATE_PENDING_CORRECTION_ERROR);
      }
      throw error;
    }
    await writeAdjustment(tx, {
      businessId: access.businessId,
      timeEntryId: entry.id,
      actorMembershipId,
      action: "CORRECTION_REQUEST",
      reason,
      previous,
      next: {
        ...previous,
        startedAt: input.proposedStartedAt.toISOString(),
        endedAt: input.proposedEndedAt.toISOString(),
      },
    });
    const unchanged = await tx.timeEntry.findFirst({
      where: { id: entry.id, businessId: access.businessId },
    });
    if (!unchanged) {
      throw new TimeCardError("That time entry could not be found.");
    }
    return { request, entry: unchanged };
  });
}

async function lockTenantOwnedTimeCorrectionRequest(
  db: Db,
  businessId: string,
  requestId: string,
): Promise<TenantTimeCorrectionRequestRow | null> {
  const rows = await db.$queryRaw<TenantTimeCorrectionRequestRow[]>`
    SELECT id, "businessId", "timeEntryId", "requestedByMembershipId", status, reason,
           "originalStartedAt", "originalEndedAt", "proposedStartedAt", "proposedEndedAt"
    FROM "TimeCorrectionRequest"
    WHERE id = ${requestId}
      AND "businessId" = ${businessId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

export type DecideTimeCorrectionRequestInput = {
  requestId: string;
  decision: string;
  reason?: string | null;
  timeZone: string;
};

/**
 * OWNER accept or decline. Accept applies the stored proposed times only
 * when the week is still open. Decline leaves the original TimeEntry
 * untouched. A second decision is refused. Approved weeks and locked
 * payroll snapshots are never rewritten from this path.
 */
export async function decideTimeCorrectionRequest(
  db: PrismaClient,
  access: BusinessAccess,
  input: DecideTimeCorrectionRequestInput,
) {
  await requireOperatingProductCapability(db, access, PRODUCT_CAPABILITIES.TIME_TRACKING);
  requireBusinessCapability(access, CAPABILITIES.DECIDE_TIME_CORRECTIONS);
  if (input.decision !== "ACCEPTED" && input.decision !== "DECLINED") {
    throw new TimeCardError("Choose accept or decline.");
  }
  const decision = input.decision as TimeCorrectionDecisionValue;
  const decisionReason = input.reason?.trim() || null;
  const timeZone = input.timeZone || resolveBusinessTimeZone(access.workspace.business);
  const actorMembershipId = access.workspace.membership.id;

  return db.$transaction(async (tx) => {
    const request = await lockTenantOwnedTimeCorrectionRequest(tx, access.businessId, input.requestId);
    if (!request) {
      throw new TimeCardError(MISSING_CORRECTION_REQUEST_ERROR);
    }
    access.assertOwned(request);
    if (request.status !== "PENDING") {
      throw new TimeCardError(DUPLICATE_CORRECTION_DECISION_ERROR);
    }

    const existingDecision = await tx.timeCorrectionDecision.findUnique({
      where: { requestId: request.id },
    });
    if (existingDecision) {
      throw new TimeCardError(DUPLICATE_CORRECTION_DECISION_ERROR);
    }

    const entry = await tx.timeEntry.findFirst({
      where: { id: request.timeEntryId, businessId: access.businessId },
    });
    if (!entry) {
      throw new TimeCardError("That time entry could not be found.");
    }
    access.assertOwned(entry);

    if (decision === "ACCEPTED") {
      await lockWorkerTimesheetWeeks(
        tx,
        access.businessId,
        entry.membershipId,
        [
          request.originalStartedAt,
          request.originalEndedAt,
          request.proposedStartedAt,
          request.proposedEndedAt,
          entry.startedAt,
          entry.endedAt,
        ].filter((value): value is Date => value instanceof Date),
        timeZone,
      );
      const lockedEntry = await lockTenantOwnedTimeEntry(tx, access.businessId, entry.id);
      if (!lockedEntry) {
        throw new TimeCardError("That time entry could not be found.");
      }
      const current = await tx.timeEntry.findFirst({
        where: { id: entry.id, businessId: access.businessId },
      });
      if (!current) {
        throw new TimeCardError("That time entry could not be found.");
      }
      access.assertOwned(current);
      if (current.status === "RUNNING" || current.endedAt == null) {
        throw new TimeCardError(ENTRY_CHANGED_SINCE_REQUEST_ERROR);
      }
      if (!entryTimesMatchRequest(current, request)) {
        throw new TimeCardError(ENTRY_CHANGED_SINCE_REQUEST_ERROR);
      }
      if (!canEditTimeEntry(current.status)) {
        throw new TimeCardError(APPROVED_WEEK_CORRECTION_DECIDE_ERROR);
      }
      try {
        await assertCorrectionWeeksEditable(
          tx,
          access.businessId,
          current.membershipId,
          [
            current.startedAt,
            current.endedAt,
            request.originalStartedAt,
            request.originalEndedAt,
            request.proposedStartedAt,
            request.proposedEndedAt,
          ],
          timeZone,
        );
      } catch (error) {
        if (isTimeCardError(error)) {
          throw new TimeCardError(APPROVED_WEEK_CORRECTION_DECIDE_ERROR);
        }
        throw error;
      }
      if (request.proposedEndedAt <= request.proposedStartedAt) {
        throw new TimeCardError("Proposed end time must be after the proposed start time.");
      }
      const overlaps = await overlappingEntries(
        tx,
        access.businessId,
        current.membershipId,
        request.proposedStartedAt,
        request.proposedEndedAt,
        current.id,
      );
      if (overlaps.length > 0) {
        throw new TimeCardError("That correction would overlap another entry.");
      }

      const previous = toAuditSnapshot(current);
      const applied = await tx.timeEntry.updateMany({
        where: {
          id: current.id,
          businessId: access.businessId,
          startedAt: request.originalStartedAt,
          endedAt: request.originalEndedAt,
          status: { notIn: ["APPROVED", "RUNNING"] },
        },
        data: {
          startedAt: request.proposedStartedAt,
          endedAt: request.proposedEndedAt,
        },
      });
      if (applied.count !== 1) {
        const fresh = await tx.timeEntry.findFirst({
          where: { id: current.id, businessId: access.businessId },
        });
        if (fresh?.status === "APPROVED") {
          throw new TimeCardError(APPROVED_WEEK_CORRECTION_DECIDE_ERROR);
        }
        throw new TimeCardError(ENTRY_CHANGED_SINCE_REQUEST_ERROR);
      }
      const updated = await tx.timeEntry.findFirst({
        where: { id: current.id, businessId: access.businessId },
      });
      if (!updated) {
        throw new TimeCardError("That time entry could not be found.");
      }
      await writeAdjustment(tx, {
        businessId: access.businessId,
        timeEntryId: updated.id,
        actorMembershipId,
        action: "CORRECT",
        reason: decisionReason ?? request.reason,
        previous,
        next: toAuditSnapshot(updated),
      });
    } else {
      const snapshot = toAuditSnapshot(entry);
      await writeAdjustment(tx, {
        businessId: access.businessId,
        timeEntryId: entry.id,
        actorMembershipId,
        action: "CORRECTION_DECLINED",
        reason: decisionReason ?? "Owner declined the requested time correction.",
        previous: snapshot,
        next: snapshot,
      });
    }

    const decided = await tx.timeCorrectionRequest.update({
      where: { id: request.id },
      data: { status: decision },
    });
    const decisionRow = await tx.timeCorrectionDecision.create({
      data: {
        businessId: access.businessId,
        requestId: request.id,
        actorMembershipId,
        decision,
        reason: decisionReason,
      },
    });
    const nextEntry = await tx.timeEntry.findFirst({
      where: { id: entry.id, businessId: access.businessId },
    });
    if (!nextEntry) {
      throw new TimeCardError("That time entry could not be found.");
    }
    return { request: decided, decision: decisionRow, entry: nextEntry };
  });
}

export async function updateMembershipWage(
  db: PrismaClient,
  access: BusinessAccess,
  input: { membershipId: string; hourlyWage: string },
) {
  await requireOperatingProductCapability(db, access, PRODUCT_CAPABILITIES.TIME_TRACKING);
  requireBusinessCapability(access, CAPABILITIES.MANAGE_TIME_CARDS);
  const parsed = parseHourlyWage(input.hourlyWage);
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    throw new TimeCardError(parsed.error);
  }

  const membership = await loadMembershipInBusiness(db, access.businessId, input.membershipId);
  access.assertOwned(membership);

  return db.membership.update({
    where: { id: membership.id },
    data: { hourlyWage: decimal(parsed) },
  });
}

export async function approveTimesheetWeek(
  db: PrismaClient,
  access: BusinessAccess,
  input: { membershipId: string; weekStartedAt: Date; timeZone?: string },
) {
  await requireOperatingProductCapability(db, access, PRODUCT_CAPABILITIES.TIME_TRACKING);
  requireBusinessCapability(access, CAPABILITIES.MANAGE_TIME_CARDS);
  const actorMembershipId = access.workspace.membership.id;
  const { start, end } = weekRange(input.weekStartedAt, input.timeZone);

  return db.$transaction(async (tx) => {
    const membership = await loadMembershipInBusiness(tx, access.businessId, input.membershipId);
    access.assertOwned(membership);
    await lockWorkerTimesheetWeek(tx, access.businessId, input.membershipId, start);

    const entries = await lockWorkerWeekTimeEntries(
      tx,
      access.businessId,
      input.membershipId,
      start,
      end,
    );
    const gate = canApproveWeek(entries);
    if (!gate.ok) {
      throw new TimeCardError(gate.error ?? "This week is not ready to approve.");
    }

    const wage = coerceHourlyWage(membership.hourlyWage);
    let totalCost = 0;
    let hasCost = false;

    for (const entry of entries) {
      if (!entry.endedAt) {
        throw new TimeCardError("Stop every running clock before approving this week.");
      }

      if (entry.status === "APPROVED") {
        const repair = missingApprovalSnapshotPatch({
          startedAt: entry.startedAt,
          endedAt: entry.endedAt,
          activityType: entry.activityType,
          approvedHours: entry.approvedHours,
          approvedHourlyWage: entry.approvedHourlyWage,
          approvedLaborCost: entry.approvedLaborCost,
          hourlyWage: membership.hourlyWage,
        });
        if (repair.cost != null) {
          totalCost += repair.cost;
          hasCost = true;
        }
        if (!repair.changed) continue;
        const previous = toAuditSnapshot(entry);
        const updated = await tx.timeEntry.update({
          where: { id: entry.id },
          data: {
            ...(repair.patch.approvedHours !== undefined
              ? { approvedHours: decimal(repair.patch.approvedHours) }
              : {}),
            ...(repair.patch.approvedHourlyWage !== undefined
              ? { approvedHourlyWage: decimal(repair.patch.approvedHourlyWage) }
              : {}),
            ...(repair.patch.approvedLaborCost !== undefined
              ? { approvedLaborCost: decimal(repair.patch.approvedLaborCost) }
              : {}),
          },
        });
        await writeAdjustment(tx, {
          businessId: access.businessId,
          timeEntryId: updated.id,
          actorMembershipId,
          action: "APPROVE",
          reason: "Week approved — payroll ready.",
          previous,
          next: toAuditSnapshot(updated),
        });
        continue;
      }

      const snapshot = approvalSnapshot({
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        activityType: entry.activityType,
        hourlyWage: membership.hourlyWage,
      });
      if (snapshot.approvedLaborCost != null) {
        totalCost += snapshot.approvedLaborCost;
        hasCost = true;
      }
      const previous = toAuditSnapshot(entry);
      const updated = await tx.timeEntry.update({
        where: { id: entry.id },
        data: {
          status: "APPROVED",
          approvedHours: decimal(snapshot.approvedHours),
          approvedHourlyWage: decimal(snapshot.approvedHourlyWage),
          approvedLaborCost: decimal(snapshot.approvedLaborCost),
        },
      });
      await writeAdjustment(tx, {
        businessId: access.businessId,
        timeEntryId: updated.id,
        actorMembershipId,
        action: "APPROVE",
        reason: "Week approved — payroll ready.",
        previous,
        next: toAuditSnapshot(updated),
      });
    }

    const approvedHours = paidHours(
      entries.map((entry) => ({
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        activityType: entry.activityType,
      })),
    );

    const existingWeek = await tx.timesheetWeek.findUnique({
      where: {
        businessId_membershipId_weekStartedAt: {
          businessId: access.businessId,
          membershipId: input.membershipId,
          weekStartedAt: start,
        },
      },
    });
    const weekWage = coerceHourlyWage(existingWeek?.approvedHourlyWage) ?? wage;
    const weekCost = hasCost
      ? Math.round((totalCost + Number.EPSILON) * 100) / 100
      : coerceHourlyWage(existingWeek?.approvedLaborCost);

    const week = await tx.timesheetWeek.upsert({
      where: {
        businessId_membershipId_weekStartedAt: {
          businessId: access.businessId,
          membershipId: input.membershipId,
          weekStartedAt: start,
        },
      },
      create: {
        businessId: access.businessId,
        membershipId: input.membershipId,
        weekStartedAt: start,
        status: "APPROVED",
        approvedAt: new Date(),
        approvedByMembershipId: actorMembershipId,
        approvedHours: decimal(approvedHours),
        approvedHourlyWage: decimal(wage),
        approvedLaborCost: hasCost ? decimal(weekCost) : null,
      },
      update: {
        status: "APPROVED",
        approvedAt: new Date(),
        approvedByMembershipId: actorMembershipId,
        approvedHours: decimal(approvedHours),
        approvedHourlyWage: decimal(weekWage),
        approvedLaborCost: weekCost != null ? decimal(weekCost) : null,
      },
    });
    const { refreshPayrollAfterTimesheetChange } = await import("@/lib/payroll-ops");
    await refreshPayrollAfterTimesheetChange(tx, access.businessId, week.id);
    return week;
  });
}

export async function reopenTimesheetWeek(
  db: PrismaClient,
  access: BusinessAccess,
  input: { membershipId: string; weekStartedAt: Date; reason: string; timeZone?: string },
) {
  await requireOperatingProductCapability(db, access, PRODUCT_CAPABILITIES.TIME_TRACKING);
  requireBusinessCapability(access, CAPABILITIES.MANAGE_TIME_CARDS);
  const reason = input.reason.trim();
  if (!reason) {
    throw new TimeCardError("A reason is required to reopen an approved week.");
  }
  const actorMembershipId = access.workspace.membership.id;
  const { start, end } = weekRange(input.weekStartedAt, input.timeZone);

  return db.$transaction(async (tx) => {
    const week = await tx.timesheetWeek.findUnique({
      where: {
        businessId_membershipId_weekStartedAt: {
          businessId: access.businessId,
          membershipId: input.membershipId,
          weekStartedAt: start,
        },
      },
    });
    if (!week || week.businessId !== access.businessId) {
      throw new TimeCardError("That timesheet week could not be found.");
    }
    access.assertOwned(week);
    if (week.status !== "APPROVED") {
      throw new TimeCardError("That week is not approved.");
    }

    const entries = await tx.timeEntry.findMany({
      where: {
        businessId: access.businessId,
        membershipId: input.membershipId,
        status: "APPROVED",
        startedAt: { lt: end },
        endedAt: { gt: start },
      },
    });

    for (const entry of entries) {
      const previous = toAuditSnapshot(entry);
      const updated = await tx.timeEntry.update({
        where: { id: entry.id },
        data: { status: "READY" },
      });
      await writeAdjustment(tx, {
        businessId: access.businessId,
        timeEntryId: updated.id,
        actorMembershipId,
        action: "REOPEN",
        reason,
        previous,
        next: toAuditSnapshot(updated),
      });
    }

    const reopened = await tx.timesheetWeek.update({
      where: { id: week.id },
      data: {
        status: "OPEN",
        approvedAt: null,
        approvedByMembershipId: null,
      },
    });
    const { refreshPayrollAfterTimesheetChange } = await import("@/lib/payroll-ops");
    await refreshPayrollAfterTimesheetChange(tx, access.businessId, week.id);
    return reopened;
  });
}

export type CloseRunningJobTimeForCompletionInput = {
  businessId: string;
  jobId: string;
  /** Trusted server-derived membership that is writing the audit row. */
  actorMembershipId?: string | null;
  endedAt?: Date;
};

export type ClosedJobTimeEntry = {
  id: string;
  membershipId: string;
  startedAt: Date;
  endedAt: Date;
};

type CloseLockedJobRunningTimeInput = CloseRunningJobTimeForCompletionInput & {
  /** When set, only that worker's matching RUNNING entries are closed. */
  membershipId?: string;
  /** Defaults to JOB so completion and Stop job time stay JOB-only. */
  activityType?: TimeActivityType;
  reason?: string;
  approvedWeekError?: string;
  clockOrderError?: string;
  missingActorError?: string;
};

async function closeLockedJobRunningTime(
  db: Db,
  job: Pick<TenantJobRow, "id" | "businessId">,
  input: CloseLockedJobRunningTimeInput,
): Promise<ClosedJobTimeEntry[]> {
  const endedAt = input.endedAt ?? new Date();
  const approvedWeekError = input.approvedWeekError ?? APPROVED_WEEK_COMPLETION_ERROR;
  const clockOrderError = input.clockOrderError ?? COMPLETION_CLOCK_ORDER_ERROR;
  const missingActorError = input.missingActorError ?? MISSING_COMPLETION_ACTOR_ERROR;
  const reason = input.reason ?? JOB_COMPLETION_TIME_CLOSED_REASON;
  const activityType = input.activityType ?? "JOB";
  const running = await db.timeEntry.findMany({
    where: {
      businessId: job.businessId,
      jobId: job.id,
      activityType,
      status: "RUNNING",
      endedAt: null,
      ...(input.membershipId ? { membershipId: input.membershipId } : {}),
    },
    orderBy: { startedAt: "asc" },
  });
  if (running.length === 0) {
    return [];
  }
  if (!input.actorMembershipId) {
    throw new TimeCardError(missingActorError);
  }
  await loadMembershipInBusiness(db, job.businessId, input.actorMembershipId);

  const closed: ClosedJobTimeEntry[] = [];
  for (const entry of running) {
    if (!canEditTimeEntry(entry.status)) {
      throw new TimeCardError(approvedWeekError);
    }
    try {
      await assertWeekEditable(db, job.businessId, entry.membershipId, entry.startedAt);
      await assertWeekEditable(db, job.businessId, entry.membershipId, endedAt);
    } catch (error) {
      if (isTimeCardError(error)) {
        throw new TimeCardError(approvedWeekError);
      }
      throw error;
    }
    if (endedAt <= entry.startedAt) {
      throw new TimeCardError(clockOrderError);
    }

    const previous = toAuditSnapshot(entry);
    const updated = await db.timeEntry.updateMany({
      where: {
        id: entry.id,
        businessId: job.businessId,
        jobId: job.id,
        activityType,
        status: "RUNNING",
        endedAt: null,
        ...(input.membershipId ? { membershipId: input.membershipId } : {}),
      },
      data: {
        endedAt,
        status: "READY",
      },
    });
    if (updated.count !== 1) {
      continue;
    }

    const next = await db.timeEntry.findFirst({
      where: { id: entry.id, businessId: job.businessId },
    });
    if (!next || !next.endedAt) {
      continue;
    }

    await writeAdjustment(db, {
      businessId: job.businessId,
      timeEntryId: next.id,
      actorMembershipId: input.actorMembershipId,
      action: "UPDATE",
      reason,
      previous,
      next: toAuditSnapshot(next),
    });
    closed.push({
      id: next.id,
      membershipId: next.membershipId,
      startedAt: next.startedAt,
      endedAt: next.endedAt,
    });
  }
  return closed;
}

/**
 * Close RUNNING JOB labor for one tenant-owned Job as part of completion.
 *
 * Only entries matching all of: businessId, jobId, activityType JOB,
 * status RUNNING, endedAt null. TRAVEL / MATERIAL_PICKUP / BREAK / OTHER
 * and other jobs / tenants are left untouched.
 */
export async function closeRunningJobTimeForCompletion(
  db: Db,
  input: CloseRunningJobTimeForCompletionInput,
): Promise<{ job: TenantJobRow; closed: ClosedJobTimeEntry[] }> {
  const run = async (tx: Db) => {
    const job = await lockTenantOwnedJob(tx, input.businessId, input.jobId);
    if (!job) {
      throw new TimeCardError("That job is not in this business.");
    }
    const closed = await closeLockedJobRunningTime(tx, job, input);
    return { job, closed };
  };

  if (typeof (db as PrismaClient).$transaction === "function") {
    return (db as PrismaClient).$transaction((tx) => run(tx));
  }
  return run(db);
}

export type CompleteJobWithRunningTimeSafetyResult =
  | {
      ok: true;
      alreadyCompleted: boolean;
      jobCompleted: true;
      customerId: string | null;
      closed: ClosedJobTimeEntry[];
    }
  | { ok: false; error: string };

/**
 * Job completion writes for an already-open transaction. Callers that
 * must commit or roll back adjacent records with the Job status change
 * use this instead of opening a second transaction.
 *
 * Returns `{ ok: false }` for lifecycle refusals. TimeCardError from
 * approved-week running time still throws so the surrounding transaction
 * rolls back.
 */
export async function completeJobWithRunningTimeSafetyInTransaction(
  tx: Db,
  input: CloseRunningJobTimeForCompletionInput,
): Promise<CompleteJobWithRunningTimeSafetyResult> {
  const job = await lockTenantOwnedJob(tx, input.businessId, input.jobId);
  if (!job) {
    return { ok: false, error: "That job could not be completed." };
  }

  const lifecycle = evaluateCompleteJob(job.status);
  if (!lifecycle.ok) {
    return { ok: false, error: lifecycle.error };
  }

  const closed = await closeLockedJobRunningTime(tx, job, input);

  if (lifecycle.nextStatus) {
    const updated = await tx.job.updateMany({
      where: {
        id: job.id,
        businessId: input.businessId,
        status: job.status,
      },
      data: { status: lifecycle.nextStatus },
    });
    if (updated.count !== 1 && job.status !== "COMPLETED") {
      const current = await tx.job.findFirst({
        where: { id: job.id, businessId: input.businessId },
        select: { status: true },
      });
      if (current?.status !== "COMPLETED") {
        throw new TimeCardError("That job could not be completed.");
      }
    }
  }

  return {
    ok: true,
    alreadyCompleted: lifecycle.nextStatus == null,
    jobCompleted: true as const,
    customerId: job.customerId,
    closed,
  };
}

/**
 * Canonical completion write: lock the tenant-owned Job, refuse when the
 * lifecycle does not allow COMPLETED, close matching RUNNING JOB time,
 * then persist COMPLETED in the same transaction. Owner invoice/send and
 * Field event emission stay in their existing callers.
 */
export async function completeJobWithRunningTimeSafety(
  db: PrismaClient,
  input: CloseRunningJobTimeForCompletionInput,
): Promise<CompleteJobWithRunningTimeSafetyResult> {
  try {
    return await db.$transaction((tx) =>
      completeJobWithRunningTimeSafetyInTransaction(tx, input),
    );
  } catch (error) {
    if (isTimeCardError(error) || error instanceof ForbiddenError) {
      return { ok: false, error: timeCardErrorMessage(error, MISSING_COMPLETION_ACTOR_ERROR) };
    }
    throw error;
  }
}

export type StartJobWithRunningTimeInput = {
  businessId: string;
  jobId: string;
  /** Trusted server-derived membership that is writing the clock-in. */
  actorMembershipId?: string | null;
  startedAt?: Date;
};

export type StartedJobTimeEntry = {
  id: string;
  membershipId: string;
  activityType: string;
  startedAt: Date;
};

export type StartJobWithRunningTimeSafetyResult =
  | {
      ok: true;
      alreadyStarted: boolean;
      alreadyRunningTime: boolean;
      jobStarted: true;
      customerId: string | null;
      timeEntry: StartedJobTimeEntry;
    }
  | { ok: false; error: string };

async function ensureRunningAssignedActivityTimeInTransaction(
  db: Db,
  input: {
    businessId: string;
    jobId: string;
    membershipId: string;
    actorMembershipId: string;
    startedAt: Date;
    activityType: TimeActivityType;
    createReason: string;
    approvedWeekError?: string;
  },
): Promise<{ created: boolean; entry: StartedJobTimeEntry }> {
  await loadMembershipInBusiness(db, input.businessId, input.membershipId);
  try {
    await assertWeekEditable(db, input.businessId, input.membershipId, input.startedAt);
  } catch (error) {
    if (isTimeCardError(error) && input.approvedWeekError) {
      throw new TimeCardError(input.approvedWeekError);
    }
    throw error;
  }

  const existing = await db.timeEntry.findFirst({
    where: {
      businessId: input.businessId,
      membershipId: input.membershipId,
      jobId: input.jobId,
      activityType: input.activityType,
      status: "RUNNING",
      endedAt: null,
    },
    orderBy: { startedAt: "desc" },
  });
  if (existing) {
    return {
      created: false,
      entry: {
        id: existing.id,
        membershipId: existing.membershipId,
        activityType: existing.activityType,
        startedAt: existing.startedAt,
      },
    };
  }

  const running = await db.timeEntry.findMany({
    where: {
      businessId: input.businessId,
      membershipId: input.membershipId,
      status: "RUNNING",
      endedAt: null,
    },
  });
  await assertRunningEntriesEditable(
    db,
    input.businessId,
    input.membershipId,
    running,
    input.startedAt,
    input.approvedWeekError,
  );

  for (const current of running) {
    const previous = toAuditSnapshot(current);
    const closed = await db.timeEntry.update({
      where: { id: current.id },
      data: { endedAt: input.startedAt, status: "READY" },
    });
    await writeAdjustment(db, {
      businessId: input.businessId,
      timeEntryId: closed.id,
      actorMembershipId: input.actorMembershipId,
      action: "UPDATE",
      reason: AUTOMATIC_CLOCK_TRANSITION_REASON,
      previous,
      next: toAuditSnapshot(closed),
    });
  }

  const overlaps = await overlappingEntries(
    db,
    input.businessId,
    input.membershipId,
    input.startedAt,
    null,
  );
  if (overlaps.length > 0) {
    throw new TimeCardError("That clock-in overlaps existing time.");
  }

  const created = await db.timeEntry.create({
    data: {
      businessId: input.businessId,
      membershipId: input.membershipId,
      jobId: input.jobId,
      activityType: input.activityType,
      status: "RUNNING",
      startedAt: input.startedAt,
      endedAt: null,
      note: null,
      source: "CLOCK",
    },
  });
  await writeAdjustment(db, {
    businessId: input.businessId,
    timeEntryId: created.id,
    actorMembershipId: input.actorMembershipId,
    action: "CREATE",
    reason: input.createReason,
    previous: null,
    next: toAuditSnapshot(created),
  });
  return {
    created: true,
    entry: {
      id: created.id,
      membershipId: created.membershipId,
      activityType: created.activityType,
      startedAt: created.startedAt,
    },
  };
}

async function ensureRunningAssignedJobTimeInTransaction(
  db: Db,
  input: {
    businessId: string;
    jobId: string;
    membershipId: string;
    actorMembershipId: string;
    startedAt: Date;
  },
): Promise<{ created: boolean; entry: StartedJobTimeEntry }> {
  return ensureRunningAssignedActivityTimeInTransaction(db, {
    ...input,
    activityType: "JOB",
    createReason: JOB_START_TIME_STARTED_REASON,
  });
}

/**
 * Job start writes for an already-open transaction. Callers that must
 * commit or roll back adjacent records with the Job status change use
 * this instead of opening a second transaction.
 *
 * Returns `{ ok: false }` for lifecycle refusals. TimeCardError from an
 * approved week or overlapping time still throws so the surrounding
 * transaction rolls back and Job.status stays unchanged.
 */
export async function startJobWithRunningTimeSafetyInTransaction(
  tx: Db,
  input: StartJobWithRunningTimeInput,
): Promise<StartJobWithRunningTimeSafetyResult> {
  const job = await lockTenantOwnedJob(tx, input.businessId, input.jobId);
  if (!job) {
    return { ok: false, error: MISSING_START_ACTOR_ERROR };
  }

  const lifecycle = evaluateStartJob(job.status);
  if (!lifecycle.ok) {
    return { ok: false, error: lifecycle.error };
  }
  if (!input.actorMembershipId) {
    throw new TimeCardError(MISSING_START_ACTOR_ERROR);
  }

  const time = await ensureRunningAssignedJobTimeInTransaction(tx, {
    businessId: job.businessId,
    jobId: job.id,
    membershipId: input.actorMembershipId,
    actorMembershipId: input.actorMembershipId,
    startedAt: input.startedAt ?? new Date(),
  });

  if (lifecycle.nextStatus) {
    const updated = await tx.job.updateMany({
      where: {
        id: job.id,
        businessId: input.businessId,
        status: job.status,
      },
      data: { status: lifecycle.nextStatus },
    });
    if (updated.count !== 1 && job.status !== "IN_PROGRESS") {
      const current = await tx.job.findFirst({
        where: { id: job.id, businessId: input.businessId },
        select: { status: true },
      });
      if (current?.status !== "IN_PROGRESS") {
        throw new TimeCardError(MISSING_START_ACTOR_ERROR);
      }
    }
  }

  return {
    ok: true,
    alreadyStarted: lifecycle.nextStatus == null,
    alreadyRunningTime: !time.created,
    jobStarted: true as const,
    customerId: job.customerId,
    timeEntry: time.entry,
  };
}

/**
 * Canonical start write: lock the tenant-owned Job, refuse when the
 * lifecycle does not allow IN_PROGRESS, open matching RUNNING JOB time
 * if none is already running, then persist IN_PROGRESS in the same
 * transaction. Field event emission stays in the native/Field callers.
 */
export async function startJobWithRunningTimeSafety(
  db: PrismaClient,
  input: StartJobWithRunningTimeInput,
): Promise<StartJobWithRunningTimeSafetyResult> {
  try {
    return await db.$transaction((tx) => startJobWithRunningTimeSafetyInTransaction(tx, input));
  } catch (error) {
    if (isTimeCardError(error) || error instanceof ForbiddenError) {
      return { ok: false, error: timeCardErrorMessage(error, MISSING_START_ACTOR_ERROR) };
    }
    throw error;
  }
}

export type StopRunningAssignedJobTimeInput = {
  businessId: string;
  jobId: string;
  /** Trusted server-derived membership that is writing the audit row. */
  actorMembershipId?: string | null;
  /** Worker whose RUNNING JOB time is stopped. Defaults to the actor. */
  membershipId?: string;
  endedAt?: Date;
};

export type StopRunningAssignedJobTimeResult =
  | {
      ok: true;
      alreadyStopped: boolean;
      jobStatus: string;
      customerId: string | null;
      closed: ClosedJobTimeEntry[];
    }
  | { ok: false; error: string };

/**
 * Stop writes for an already-open transaction. Closes the actor's (or
 * named worker's) RUNNING JOB time on one tenant-owned Job. Job.status
 * is left unchanged — this is not completion.
 *
 * Returns `{ ok: false }` only when the Job is missing. TimeCardError
 * from an approved week still throws so the surrounding transaction
 * rolls back and the RUNNING entry stays open.
 */
export async function stopRunningAssignedJobTimeInTransaction(
  tx: Db,
  input: StopRunningAssignedJobTimeInput,
): Promise<StopRunningAssignedJobTimeResult> {
  const job = await lockTenantOwnedJob(tx, input.businessId, input.jobId);
  if (!job) {
    return { ok: false, error: MISSING_STOP_ACTOR_ERROR };
  }
  if (!input.actorMembershipId) {
    throw new TimeCardError(MISSING_STOP_ACTOR_ERROR);
  }

  const closed = await closeLockedJobRunningTime(tx, job, {
    businessId: job.businessId,
    jobId: job.id,
    actorMembershipId: input.actorMembershipId,
    membershipId: input.membershipId ?? input.actorMembershipId,
    endedAt: input.endedAt,
    reason: JOB_STOP_TIME_CLOSED_REASON,
    approvedWeekError: APPROVED_WEEK_STOP_ERROR,
    clockOrderError: STOP_CLOCK_ORDER_ERROR,
    missingActorError: MISSING_STOP_ACTOR_ERROR,
  });

  return {
    ok: true,
    alreadyStopped: closed.length === 0,
    jobStatus: job.status,
    customerId: job.customerId,
    closed,
  };
}

/**
 * Canonical stop write: lock the tenant-owned Job, close matching
 * RUNNING JOB time for the actor, and leave Job.status unchanged.
 * TRAVEL / MATERIAL_PICKUP / BREAK / OTHER and other workers' time
 * stay untouched.
 */
export async function stopRunningAssignedJobTime(
  db: PrismaClient,
  input: StopRunningAssignedJobTimeInput,
): Promise<StopRunningAssignedJobTimeResult> {
  try {
    return await db.$transaction((tx) => stopRunningAssignedJobTimeInTransaction(tx, input));
  } catch (error) {
    if (isTimeCardError(error) || error instanceof ForbiddenError) {
      return { ok: false, error: timeCardErrorMessage(error, MISSING_STOP_ACTOR_ERROR) };
    }
    throw error;
  }
}

export type StartAssignedActivityTimeInput = {
  businessId: string;
  jobId: string;
  activityType: string;
  /** Trusted server-derived membership that is writing the clock-in. */
  actorMembershipId?: string | null;
  startedAt?: Date;
};

export type StartAssignedActivityTimeResult =
  | {
      ok: true;
      alreadyStarted: boolean;
      alreadyRunningTime: boolean;
      jobStatus: string;
      customerId: string | null;
      timeEntry: StartedJobTimeEntry;
    }
  | { ok: false; error: string };

export type StopAssignedActivityTimeInput = {
  businessId: string;
  jobId: string;
  activityType: string;
  /** Trusted server-derived membership that is writing the audit row. */
  actorMembershipId?: string | null;
  membershipId?: string;
  endedAt?: Date;
};

export type StopAssignedActivityTimeResult =
  | {
      ok: true;
      alreadyStopped: boolean;
      jobStatus: string;
      customerId: string | null;
      closed: ClosedJobTimeEntry[];
    }
  | { ok: false; error: string };

function assignedActivityStartReason(activityType: AssignedFieldActivityType) {
  return activityType === "TRAVEL"
    ? TRAVEL_START_TIME_STARTED_REASON
    : MATERIAL_PICKUP_START_TIME_STARTED_REASON;
}

function assignedActivityStopReason(activityType: AssignedFieldActivityType) {
  return activityType === "TRAVEL"
    ? TRAVEL_STOP_TIME_CLOSED_REASON
    : MATERIAL_PICKUP_STOP_TIME_CLOSED_REASON;
}

/**
 * Assigned-worker TRAVEL / MATERIAL_PICKUP start for an already-open
 * transaction. Locks the tenant-owned Job, opens matching RUNNING time
 * if none is already running, and leaves Job.status unchanged.
 *
 * TimeCardError from an approved week or overlapping time still throws
 * so the surrounding transaction rolls back and no Job or time write
 * commits.
 */
export async function startAssignedActivityTimeInTransaction(
  tx: Db,
  input: StartAssignedActivityTimeInput,
): Promise<StartAssignedActivityTimeResult> {
  if (!isAssignedFieldActivityType(input.activityType)) {
    return { ok: false, error: INVALID_FIELD_ACTIVITY_ERROR };
  }
  const job = await lockTenantOwnedJob(tx, input.businessId, input.jobId);
  if (!job) {
    return { ok: false, error: MISSING_ACTIVITY_START_ACTOR_ERROR };
  }
  if (!input.actorMembershipId) {
    throw new TimeCardError(MISSING_ACTIVITY_START_ACTOR_ERROR);
  }

  const time = await ensureRunningAssignedActivityTimeInTransaction(tx, {
    businessId: job.businessId,
    jobId: job.id,
    membershipId: input.actorMembershipId,
    actorMembershipId: input.actorMembershipId,
    startedAt: input.startedAt ?? new Date(),
    activityType: input.activityType,
    createReason: assignedActivityStartReason(input.activityType),
    approvedWeekError: APPROVED_WEEK_ACTIVITY_START_ERROR,
  });

  return {
    ok: true,
    alreadyStarted: !time.created,
    alreadyRunningTime: !time.created,
    jobStatus: job.status,
    customerId: job.customerId,
    timeEntry: time.entry,
  };
}

/**
 * Canonical assigned-worker TRAVEL / MATERIAL_PICKUP start: lock the
 * tenant-owned Job, open matching RUNNING activity time if none is
 * already running, and leave Job.status unchanged. JOB time is only
 * closed when a different activity is already running (the defined
 * clock transition). A running entry from an approved week refuses
 * that close and rolls the transaction back.
 */
export async function startAssignedActivityTime(
  db: PrismaClient,
  input: StartAssignedActivityTimeInput,
): Promise<StartAssignedActivityTimeResult> {
  try {
    return await db.$transaction((tx) => startAssignedActivityTimeInTransaction(tx, input));
  } catch (error) {
    if (isTimeCardError(error) || error instanceof ForbiddenError) {
      return { ok: false, error: timeCardErrorMessage(error, MISSING_ACTIVITY_START_ACTOR_ERROR) };
    }
    throw error;
  }
}

/**
 * Assigned-worker TRAVEL / MATERIAL_PICKUP stop for an already-open
 * transaction. Closes only that activity on the tenant-owned Job.
 * Job.status and JOB time stay unchanged.
 *
 * TimeCardError from an approved week still throws so the surrounding
 * transaction rolls back and the RUNNING entry stays open.
 */
export async function stopAssignedActivityTimeInTransaction(
  tx: Db,
  input: StopAssignedActivityTimeInput,
): Promise<StopAssignedActivityTimeResult> {
  if (!isAssignedFieldActivityType(input.activityType)) {
    return { ok: false, error: INVALID_FIELD_ACTIVITY_ERROR };
  }
  const job = await lockTenantOwnedJob(tx, input.businessId, input.jobId);
  if (!job) {
    return { ok: false, error: MISSING_ACTIVITY_STOP_ACTOR_ERROR };
  }
  if (!input.actorMembershipId) {
    throw new TimeCardError(MISSING_ACTIVITY_STOP_ACTOR_ERROR);
  }

  const closed = await closeLockedJobRunningTime(tx, job, {
    businessId: job.businessId,
    jobId: job.id,
    actorMembershipId: input.actorMembershipId,
    membershipId: input.membershipId ?? input.actorMembershipId,
    activityType: input.activityType,
    endedAt: input.endedAt,
    reason: assignedActivityStopReason(input.activityType),
    approvedWeekError: APPROVED_WEEK_ACTIVITY_STOP_ERROR,
    clockOrderError: STOP_CLOCK_ORDER_ERROR,
    missingActorError: MISSING_ACTIVITY_STOP_ACTOR_ERROR,
  });

  return {
    ok: true,
    alreadyStopped: closed.length === 0,
    jobStatus: job.status,
    customerId: job.customerId,
    closed,
  };
}

/**
 * Canonical assigned-worker TRAVEL / MATERIAL_PICKUP stop: lock the
 * tenant-owned Job, close matching RUNNING activity time for the
 * actor, and leave Job.status and JOB time unchanged.
 */
export async function stopAssignedActivityTime(
  db: PrismaClient,
  input: StopAssignedActivityTimeInput,
): Promise<StopAssignedActivityTimeResult> {
  try {
    return await db.$transaction((tx) => stopAssignedActivityTimeInTransaction(tx, input));
  } catch (error) {
    if (isTimeCardError(error) || error instanceof ForbiddenError) {
      return { ok: false, error: timeCardErrorMessage(error, MISSING_ACTIVITY_STOP_ACTOR_ERROR) };
    }
    throw error;
  }
}

export function isTimeCardError(error: unknown): error is TimeCardError {
  return error instanceof TimeCardError;
}

export function timeCardErrorMessage(error: unknown, fallback = "That time card action could not be completed.") {
  if (error instanceof TimeCardError) return error.message;
  if (error instanceof ForbiddenError) return error.message;
  if (error instanceof Error && error.name === "SaasSubscriptionRequiredError") {
    return error.message;
  }
  return fallback;
}
