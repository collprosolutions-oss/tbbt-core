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
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { requireOperatingProductCapability } from "@/lib/product-entitlements";
import { evaluateCompleteJob } from "@/lib/job-lifecycle";
import {
  approvalSnapshot,
  canApproveWeek,
  canEditTimeEntry,
  coerceHourlyWage,
  missingApprovalSnapshotPatch,
  hasOverlappingEntry,
  isTimeActivityType,
  jobRequiredForActivity,
  paidHours,
  parseHourlyWage,
  toAuditSnapshot,
  weekRange,
  type TimeActivityType,
  type TimeAdjustmentAction,
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

const COMPLETED_JOB_CLOCK_IN_ERROR = "This job is completed. Job time cannot be started.";
const APPROVED_WEEK_COMPLETION_ERROR =
  "This job cannot be completed while approved job time is still running. Reopen the timesheet week first.";
const MISSING_COMPLETION_ACTOR_ERROR = "That job could not be completed.";
const COMPLETION_CLOCK_ORDER_ERROR =
  "Job time cannot be closed because the completion time is not after the clock-in start.";

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
async function lockTenantOwnedJob(
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
) {
  const { start } = weekRange(at);
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
) {
  const week = await loadOpenWeek(db, businessId, membershipId, at);
  if (week?.status === "APPROVED") {
    throw new TimeCardError("That week is approved. Reopen it before changing time.");
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
        reason: "Closed automatically when a new activity started.",
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

/** MEMBER (own entry) or owner/admin: flag an unapproved entry for review. */
export async function requestTimeCorrection(
  db: PrismaClient,
  access: BusinessAccess,
  input: { timeEntryId: string; reason: string },
) {
  await requireOperatingProductCapability(db, access, PRODUCT_CAPABILITIES.TIME_TRACKING);
  const reason = input.reason.trim();
  if (!reason) {
    throw new TimeCardError("Describe the correction you need.");
  }
  const actorMembershipId = access.workspace.membership.id;
  const actorRole = access.workspace.role;

  return db.$transaction(async (tx) => {
    const entry = await tx.timeEntry.findFirst({
      where: { id: input.timeEntryId, businessId: access.businessId },
    });
    if (!entry) {
      throw new TimeCardError("That time entry could not be found.");
    }
    access.assertOwned(entry);
    if (actorRole === "MEMBER" && entry.membershipId !== actorMembershipId) {
      throw new ForbiddenError();
    }
    if (actorRole !== "MEMBER") {
      requireBusinessCapability(access, CAPABILITIES.MANAGE_TIME_CARDS);
    }
    if (!canEditTimeEntry(entry.status)) {
      throw new TimeCardError("Approved time cannot be changed. Ask an owner to reopen the week.");
    }

    const previous = toAuditSnapshot(entry);
    const updated = await tx.timeEntry.update({
      where: { id: entry.id },
      data: {
        status: "NEEDS_REVIEW",
        note: entry.note ? `${entry.note}\nCorrection requested: ${reason}` : reason,
      },
    });
    await writeAdjustment(tx, {
      businessId: access.businessId,
      timeEntryId: updated.id,
      actorMembershipId,
      action: "CORRECTION_REQUEST",
      reason,
      previous,
      next: toAuditSnapshot(updated),
    });
    return updated;
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

    const entries = await tx.timeEntry.findMany({
      where: {
        businessId: access.businessId,
        membershipId: input.membershipId,
        startedAt: { lt: end },
        OR: [{ endedAt: null }, { endedAt: { gt: start } }],
      },
    });
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

async function closeLockedJobRunningTime(
  db: Db,
  job: Pick<TenantJobRow, "id" | "businessId">,
  input: CloseRunningJobTimeForCompletionInput,
): Promise<ClosedJobTimeEntry[]> {
  const endedAt = input.endedAt ?? new Date();
  const running = await db.timeEntry.findMany({
    where: {
      businessId: job.businessId,
      jobId: job.id,
      activityType: "JOB",
      status: "RUNNING",
      endedAt: null,
    },
    orderBy: { startedAt: "asc" },
  });
  if (running.length === 0) {
    return [];
  }
  if (!input.actorMembershipId) {
    throw new TimeCardError(MISSING_COMPLETION_ACTOR_ERROR);
  }
  await loadMembershipInBusiness(db, job.businessId, input.actorMembershipId);

  const closed: ClosedJobTimeEntry[] = [];
  for (const entry of running) {
    if (!canEditTimeEntry(entry.status)) {
      throw new TimeCardError(APPROVED_WEEK_COMPLETION_ERROR);
    }
    try {
      await assertWeekEditable(db, job.businessId, entry.membershipId, entry.startedAt);
      await assertWeekEditable(db, job.businessId, entry.membershipId, endedAt);
    } catch (error) {
      if (isTimeCardError(error)) {
        throw new TimeCardError(APPROVED_WEEK_COMPLETION_ERROR);
      }
      throw error;
    }
    if (endedAt <= entry.startedAt) {
      throw new TimeCardError(COMPLETION_CLOCK_ORDER_ERROR);
    }

    const previous = toAuditSnapshot(entry);
    const updated = await db.timeEntry.updateMany({
      where: {
        id: entry.id,
        businessId: job.businessId,
        jobId: job.id,
        activityType: "JOB",
        status: "RUNNING",
        endedAt: null,
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
      reason: JOB_COMPLETION_TIME_CLOSED_REASON,
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
    return await db.$transaction(async (tx) => {
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
    });
  } catch (error) {
    if (isTimeCardError(error) || error instanceof ForbiddenError) {
      return { ok: false, error: timeCardErrorMessage(error, MISSING_COMPLETION_ACTOR_ERROR) };
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
