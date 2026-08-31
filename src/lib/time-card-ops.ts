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
import {
  approvalSnapshot,
  canApproveWeek,
  canEditTimeEntry,
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

function decimal(value: number | null | undefined): Prisma.Decimal | null {
  if (value == null) return null;
  return new Prisma.Decimal(value);
}

function asNumber(value: Prisma.Decimal | number | null | undefined): number | null {
  if (value == null) return null;
  return Number(value.toString());
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
    select: { id: true, assignedMembershipId: true, businessId: true },
  });
  if (!job) {
    throw new TimeCardError("That job is not in this business.");
  }
  return job;
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
  input: { membershipId: string; weekStartedAt: Date },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_TIME_CARDS);
  const actorMembershipId = access.workspace.membership.id;
  const { start, end } = weekRange(input.weekStartedAt);

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

    const wage = asNumber(membership.hourlyWage);
    let totalCost = 0;
    let hasCost = false;

    for (const entry of entries) {
      if (entry.status === "APPROVED") continue;
      if (!entry.endedAt) {
        throw new TimeCardError("Stop every running clock before approving this week.");
      }
      const snapshot = approvalSnapshot({
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        activityType: entry.activityType,
        hourlyWage: wage,
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
        approvedLaborCost: hasCost ? decimal(Math.round((totalCost + Number.EPSILON) * 100) / 100) : null,
      },
      update: {
        status: "APPROVED",
        approvedAt: new Date(),
        approvedByMembershipId: actorMembershipId,
        approvedHours: decimal(approvedHours),
        approvedHourlyWage: decimal(wage),
        approvedLaborCost: hasCost ? decimal(Math.round((totalCost + Number.EPSILON) * 100) / 100) : null,
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
  input: { membershipId: string; weekStartedAt: Date; reason: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_TIME_CARDS);
  const reason = input.reason.trim();
  if (!reason) {
    throw new TimeCardError("A reason is required to reopen an approved week.");
  }
  const actorMembershipId = access.workspace.membership.id;
  const { start, end } = weekRange(input.weekStartedAt);

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

export function isTimeCardError(error: unknown): error is TimeCardError {
  return error instanceof TimeCardError;
}

export function timeCardErrorMessage(error: unknown, fallback = "That time card action could not be completed.") {
  if (error instanceof TimeCardError) return error.message;
  if (error instanceof ForbiddenError) return error.message;
  return fallback;
}
