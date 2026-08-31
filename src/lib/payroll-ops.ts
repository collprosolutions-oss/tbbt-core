/**
 * Payroll mutations -- the real write path used by server actions and
 * the check-payroll script. Every function takes an already-authorized
 * BusinessAccess and re-checks tenant + role before writing. Callers
 * must have already run requireBusinessAccess(); this module never
 * trusts a browser-supplied businessId.
 *
 * Time Cards remain labor-hour truth. This module copies APPROVED
 * TimeEntry snapshots that start inside the pay period — not the entire
 * TimesheetWeek hour total. AUTHORIZED / PROCESSED runs are locked.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, ForbiddenError, requireBusinessCapability } from "@/lib/authorization";
import { addDays } from "@/lib/schedule";
import {
  asPayrollExceptionList,
  approvedHoursInPayPeriod,
  canTransitionPayroll,
  derivePayrollRunStatus,
  evaluateItemExceptions,
  isEditablePayrollStatus,
  isFinalizedPayrollStatus,
  isLockedPayrollStatus,
  itemReadiness,
  snapshotGrossLaborAmount,
  splitRegularAndOvertime,
  toPayrollRunAuditSnapshot,
  weekOverlapsPayPeriod,
  type PayrollEventAction,
  type PayrollExceptionCode,
  type PayrollItemReadiness,
  type PayrollRunStatus,
} from "@/lib/payroll";
import { weekRange } from "@/lib/time-cards";

type Db = PrismaClient | Prisma.TransactionClient;

export class PayrollError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayrollError";
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

function asHours(value: Prisma.Decimal | number | null | undefined): number {
  return asNumber(value) ?? 0;
}

type WeekRow = {
  id: string;
  businessId: string;
  membershipId: string;
  weekStartedAt: Date;
  status: string;
  approvedHours: Prisma.Decimal | null;
  approvedHourlyWage: Prisma.Decimal | null;
  approvedLaborCost: Prisma.Decimal | null;
  membership: { id: string; active: boolean; user: { name: string } };
};

type ItemEval = {
  timesheetWeekId: string;
  membershipId: string;
  weekStartedAt: Date;
  regularHours: number;
  overtimeHours: number;
  approvedHours: number;
  approvedHourlyWage: number | null;
  grossLaborAmount: number | null;
  readiness: PayrollItemReadiness;
  exceptions: PayrollExceptionCode[];
};

async function writeEvent(
  db: Db,
  input: {
    businessId: string;
    payrollRunId: string;
    actorMembershipId: string;
    action: PayrollEventAction;
    reason?: string | null;
    previousJson?: Prisma.InputJsonValue | null;
    nextJson?: Prisma.InputJsonValue | null;
  },
) {
  await db.payrollRunEvent.create({
    data: {
      businessId: input.businessId,
      payrollRunId: input.payrollRunId,
      actorMembershipId: input.actorMembershipId,
      action: input.action,
      reason: input.reason ?? null,
      previousJson: input.previousJson ?? Prisma.JsonNull,
      nextJson: input.nextJson ?? Prisma.JsonNull,
    },
  });
}

async function loadRun(db: Db, access: BusinessAccess, payrollRunId: string) {
  const run = await db.payrollRun.findFirst({
    where: { id: payrollRunId, businessId: access.businessId },
    include: {
      items: {
        include: {
          membership: { include: { user: { select: { name: true } } } },
          timesheetWeek: true,
        },
        orderBy: { weekStartedAt: "asc" },
      },
    },
  });
  if (!run) {
    throw new PayrollError("That payroll run could not be found.");
  }
  access.assertOwned(run);
  return run;
}

async function finalizedWeekIds(
  db: Db,
  businessId: string,
  exceptRunId?: string,
): Promise<Set<string>> {
  const items = await db.payrollRunItem.findMany({
    where: {
      businessId,
      payrollRun: {
        businessId,
        status: { in: ["AUTHORIZED", "PROCESSED"] },
        ...(exceptRunId ? { id: { not: exceptRunId } } : {}),
      },
    },
    select: { timesheetWeekId: true },
  });
  return new Set(items.map((item) => item.timesheetWeekId));
}

async function approvedEntriesForWeek(
  db: Db,
  week: Pick<WeekRow, "businessId" | "membershipId" | "weekStartedAt">,
) {
  const { start, end } = weekRange(week.weekStartedAt);
  return db.timeEntry.findMany({
    where: {
      businessId: week.businessId,
      membershipId: week.membershipId,
      status: "APPROVED",
      startedAt: { gte: start, lt: end },
    },
    select: {
      startedAt: true,
      endedAt: true,
      activityType: true,
      approvedHours: true,
    },
  });
}

async function evaluateWeek(
  db: Db,
  week: WeekRow,
  periodStart: Date,
  periodEnd: Date,
  payrollStatus: string,
  alreadyFinalized: boolean,
): Promise<ItemEval> {
  const entries = await approvedEntriesForWeek(db, week);
  const approvedHours = approvedHoursInPayPeriod(
    entries.map((entry) => ({
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      activityType: entry.activityType,
      approvedHours: asNumber(entry.approvedHours),
    })),
    periodStart,
    periodEnd,
  );
  const approvedHourlyWage = asNumber(week.approvedHourlyWage);
  const split = splitRegularAndOvertime(approvedHours);
  const exceptions = evaluateItemExceptions({
    timesheetStatus: week.status,
    approvedHours,
    approvedHourlyWage,
    membershipActive: week.membership.active,
    alreadyFinalized,
    payrollStatus,
  });
  return {
    timesheetWeekId: week.id,
    membershipId: week.membershipId,
    weekStartedAt: week.weekStartedAt,
    regularHours: split.regularHours,
    overtimeHours: split.overtimeHours,
    approvedHours,
    approvedHourlyWage,
    grossLaborAmount: snapshotGrossLaborAmount(approvedHours, approvedHourlyWage),
    readiness: itemReadiness(exceptions),
    exceptions,
  };
}

async function discoverApprovedWeeksInPeriod(
  db: Db,
  businessId: string,
  periodStart: Date,
  periodEnd: Date,
) {
  const weeks = await db.timesheetWeek.findMany({
    where: {
      businessId,
      status: "APPROVED",
      weekStartedAt: { gte: addDays(periodStart, -6), lt: periodEnd },
    },
    include: { membership: { include: { user: { select: { name: true } } } } },
  });
  return weeks.filter((week) => weekOverlapsPayPeriod(week.weekStartedAt, periodStart, periodEnd));
}

function itemCreateData(businessId: string, payrollRunId: string, evalItem: ItemEval) {
  return {
    businessId,
    payrollRunId,
    membershipId: evalItem.membershipId,
    timesheetWeekId: evalItem.timesheetWeekId,
    weekStartedAt: evalItem.weekStartedAt,
    regularHours: decimal(evalItem.regularHours)!,
    overtimeHours: decimal(evalItem.overtimeHours)!,
    approvedHours: decimal(evalItem.approvedHours)!,
    approvedHourlyWage: decimal(evalItem.approvedHourlyWage),
    grossLaborAmount: decimal(evalItem.grossLaborAmount),
    readiness: evalItem.readiness,
    exceptions: evalItem.exceptions,
  };
}

function runAuditFromItems(
  run: { id: string; status: string; payPeriodStart: Date; payPeriodEnd: Date; authorizedAt: Date | null; processedAt: Date | null; providerReference: string | null },
  items: readonly { approvedHours: Prisma.Decimal | number; grossLaborAmount: Prisma.Decimal | number | null }[],
) {
  return toPayrollRunAuditSnapshot({
    ...run,
    items: items.map((item) => ({
      approvedHours: asHours(item.approvedHours),
      grossLaborAmount: asNumber(item.grossLaborAmount),
    })),
  });
}

async function persistDerivedStatus(
  db: Db,
  runId: string,
  currentStatus: string,
  items: readonly { readiness: string }[],
): Promise<PayrollRunStatus> {
  const next = derivePayrollRunStatus({
    currentStatus,
    itemCount: items.length,
    items,
  });
  if (next !== currentStatus) {
    await db.payrollRun.update({
      where: { id: runId },
      data: { status: next },
    });
  }
  return next;
}

export async function createPayrollRun(
  db: PrismaClient,
  access: BusinessAccess,
  input: { payPeriodStart: Date; payPeriodEnd: Date; notes?: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_PAYROLL);
  if (input.payPeriodStart.getTime() >= input.payPeriodEnd.getTime()) {
    throw new PayrollError("Pay period end must be after the start.");
  }
  const actorMembershipId = access.workspace.membership.id;

  return db.$transaction(async (tx) => {
    const consumed = await finalizedWeekIds(tx, access.businessId);
    const weeks = await discoverApprovedWeeksInPeriod(
      tx,
      access.businessId,
      input.payPeriodStart,
      input.payPeriodEnd,
    );

    const run = await tx.payrollRun.create({
      data: {
        businessId: access.businessId,
        payPeriodStart: input.payPeriodStart,
        payPeriodEnd: input.payPeriodEnd,
        status: "DRAFT",
        notes: input.notes?.trim() || null,
      },
    });

    const evals: ItemEval[] = [];
    for (const week of weeks) {
      if (consumed.has(week.id)) continue;
      const evalItem = await evaluateWeek(tx, week, input.payPeriodStart, input.payPeriodEnd, "DRAFT", false);
      if (evalItem.approvedHours <= 0) continue;
      evals.push(evalItem);
    }
    if (evals.length > 0) {
      await tx.payrollRunItem.createMany({
        data: evals.map((item) => itemCreateData(access.businessId, run.id, item)),
      });
    }

    const status = await persistDerivedStatus(tx, run.id, "DRAFT", evals);
    const created = await tx.payrollRun.findUniqueOrThrow({
      where: { id: run.id },
      include: { items: true },
    });
    await writeEvent(tx, {
      businessId: access.businessId,
      payrollRunId: run.id,
      actorMembershipId,
      action: "CREATE",
      nextJson: runAuditFromItems({ ...created, status }, created.items),
    });
    return created;
  });
}

export async function changePayrollPeriod(
  db: PrismaClient,
  access: BusinessAccess,
  input: { payrollRunId: string; payPeriodStart: Date; payPeriodEnd: Date },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_PAYROLL);
  if (input.payPeriodStart.getTime() >= input.payPeriodEnd.getTime()) {
    throw new PayrollError("Pay period end must be after the start.");
  }

  return db.$transaction(async (tx) => {
    const run = await loadRun(tx, access, input.payrollRunId);
    if (!isEditablePayrollStatus(run.status)) {
      throw new PayrollError("This payroll run is locked and cannot change its pay period.");
    }
    const previous = runAuditFromItems(run, run.items);
    const consumed = await finalizedWeekIds(tx, access.businessId, run.id);
    const weeks = await discoverApprovedWeeksInPeriod(
      tx,
      access.businessId,
      input.payPeriodStart,
      input.payPeriodEnd,
    );
    await tx.payrollRunItem.deleteMany({ where: { payrollRunId: run.id, businessId: access.businessId } });
    const evals: ItemEval[] = [];
    for (const week of weeks) {
      if (consumed.has(week.id)) continue;
      const evalItem = await evaluateWeek(tx, week, input.payPeriodStart, input.payPeriodEnd, "DRAFT", false);
      if (evalItem.approvedHours <= 0) continue;
      evals.push(evalItem);
    }
    if (evals.length > 0) {
      await tx.payrollRunItem.createMany({
        data: evals.map((item) => itemCreateData(access.businessId, run.id, item)),
      });
    }
    const updated = await tx.payrollRun.update({
      where: { id: run.id },
      data: {
        payPeriodStart: input.payPeriodStart,
        payPeriodEnd: input.payPeriodEnd,
        status: "DRAFT",
        reviewedAt: null,
        reviewedByMembershipId: null,
      },
      include: { items: true },
    });
    const status = await persistDerivedStatus(tx, run.id, "DRAFT", evals);
    await writeEvent(tx, {
      businessId: access.businessId,
      payrollRunId: run.id,
      actorMembershipId: access.workspace.membership.id,
      action: "CHANGE_PERIOD",
      previousJson: previous,
      nextJson: runAuditFromItems({ ...updated, status }, updated.items),
    });
    return updated;
  });
}

export async function addPayrollItem(
  db: PrismaClient,
  access: BusinessAccess,
  input: { payrollRunId: string; timesheetWeekId: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_PAYROLL);

  return db.$transaction(async (tx) => {
    const run = await loadRun(tx, access, input.payrollRunId);
    if (!isEditablePayrollStatus(run.status)) {
      throw new PayrollError("This payroll run is locked and cannot add workers.");
    }
    const week = await tx.timesheetWeek.findFirst({
      where: { id: input.timesheetWeekId, businessId: access.businessId },
      include: { membership: { include: { user: { select: { name: true } } } } },
    });
    if (!week) {
      throw new PayrollError("That timesheet week could not be found.");
    }
    access.assertOwned(week);
    if (week.status !== "APPROVED") {
      throw new PayrollError("Only approved timesheets can be added to payroll.");
    }
    if (!weekOverlapsPayPeriod(week.weekStartedAt, run.payPeriodStart, run.payPeriodEnd)) {
      throw new PayrollError("That approved week does not overlap this pay period.");
    }
    if (run.items.some((item) => item.timesheetWeekId === week.id)) {
      throw new PayrollError("That approved week is already on this payroll run.");
    }
    const consumed = await finalizedWeekIds(tx, access.businessId, run.id);
    if (consumed.has(week.id)) {
      throw new PayrollError("That approved week was already included in a finalized payroll run.");
    }
    const previous = runAuditFromItems(run, run.items);
    const evalItem = await evaluateWeek(
      tx,
      week,
      run.payPeriodStart,
      run.payPeriodEnd,
      run.status,
      false,
    );
    if (evalItem.approvedHours <= 0) {
      throw new PayrollError("That approved week has no approved hours inside this pay period.");
    }
    await tx.payrollRunItem.create({
      data: itemCreateData(access.businessId, run.id, evalItem),
    });
    const items = [...run.items, evalItem];
    const status = await persistDerivedStatus(
      tx,
      run.id,
      run.status === "REVIEWED" ? "READY_FOR_REVIEW" : run.status,
      items,
    );
    if (run.status === "REVIEWED") {
      await tx.payrollRun.update({
        where: { id: run.id },
        data: { reviewedAt: null, reviewedByMembershipId: null },
      });
    }
    const next = await tx.payrollRun.findUniqueOrThrow({
      where: { id: run.id },
      include: { items: true },
    });
    await writeEvent(tx, {
      businessId: access.businessId,
      payrollRunId: run.id,
      actorMembershipId: access.workspace.membership.id,
      action: "ADD_ITEM",
      reason: week.id,
      previousJson: previous,
      nextJson: runAuditFromItems({ ...next, status }, next.items),
    });
    return next;
  });
}

export async function removePayrollItem(
  db: PrismaClient,
  access: BusinessAccess,
  input: { payrollRunItemId: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_PAYROLL);

  return db.$transaction(async (tx) => {
    const item = await tx.payrollRunItem.findFirst({
      where: { id: input.payrollRunItemId, businessId: access.businessId },
    });
    if (!item) {
      throw new PayrollError("That payroll worker could not be found.");
    }
    access.assertOwned(item);
    const run = await loadRun(tx, access, item.payrollRunId);
    if (!isEditablePayrollStatus(run.status)) {
      throw new PayrollError("This payroll run is locked and cannot remove workers.");
    }
    const previous = runAuditFromItems(run, run.items);
    await tx.payrollRunItem.delete({ where: { id: item.id } });
    const remaining = run.items.filter((row) => row.id !== item.id);
    if (run.status === "REVIEWED") {
      await tx.payrollRun.update({
        where: { id: run.id },
        data: { reviewedAt: null, reviewedByMembershipId: null },
      });
    }
    const status = await persistDerivedStatus(
      tx,
      run.id,
      run.status === "REVIEWED" ? "READY_FOR_REVIEW" : run.status,
      remaining,
    );
    const next = await tx.payrollRun.findUniqueOrThrow({
      where: { id: run.id },
      include: { items: true },
    });
    await writeEvent(tx, {
      businessId: access.businessId,
      payrollRunId: run.id,
      actorMembershipId: access.workspace.membership.id,
      action: "REMOVE_ITEM",
      reason: item.timesheetWeekId,
      previousJson: previous,
      nextJson: runAuditFromItems({ ...next, status }, next.items),
    });
    return next;
  });
}

export async function reviewPayrollRun(
  db: PrismaClient,
  access: BusinessAccess,
  input: { payrollRunId: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_PAYROLL);

  return db.$transaction(async (tx) => {
    const run = await loadRun(tx, access, input.payrollRunId);
    await refreshUnlockedRunItems(tx, access.businessId, run.id);
    const fresh = await loadRun(tx, access, input.payrollRunId);
    if (fresh.status !== "READY_FOR_REVIEW") {
      throw new PayrollError("Every included worker must have an approved, ready timesheet before review.");
    }
    if (!canTransitionPayroll(fresh.status, "REVIEWED")) {
      throw new PayrollError("This payroll run cannot be marked reviewed.");
    }
    const previous = runAuditFromItems(fresh, fresh.items);
    const updated = await tx.payrollRun.update({
      where: { id: fresh.id },
      data: {
        status: "REVIEWED",
        reviewedAt: new Date(),
        reviewedByMembershipId: access.workspace.membership.id,
      },
      include: { items: true },
    });
    await writeEvent(tx, {
      businessId: access.businessId,
      payrollRunId: fresh.id,
      actorMembershipId: access.workspace.membership.id,
      action: "REVIEW",
      previousJson: previous,
      nextJson: runAuditFromItems(updated, updated.items),
    });
    return updated;
  });
}

export async function authorizePayrollRun(
  db: PrismaClient,
  access: BusinessAccess,
  input: { payrollRunId: string; confirmed: boolean },
) {
  requireBusinessCapability(access, CAPABILITIES.AUTHORIZE_PAYROLL);
  if (!input.confirmed) {
    throw new PayrollError("Owner authorization requires explicit confirmation.");
  }

  return db.$transaction(async (tx) => {
    const run = await loadRun(tx, access, input.payrollRunId);
    await refreshUnlockedRunItems(tx, access.businessId, run.id);
    const fresh = await loadRun(tx, access, input.payrollRunId);
    if (fresh.status !== "REVIEWED") {
      throw new PayrollError("Payroll must be reviewed before the owner can authorize it.");
    }
    if (fresh.items.length === 0) {
      throw new PayrollError("There are no approved workers to authorize.");
    }
    if (fresh.items.some((item) => item.readiness !== "READY")) {
      throw new PayrollError("Resolve every Needs Attention item before authorizing payroll.");
    }
    const consumed = await finalizedWeekIds(tx, access.businessId, fresh.id);
    for (const item of fresh.items) {
      if (consumed.has(item.timesheetWeekId)) {
        throw new PayrollError("An approved week on this run was already included in a finalized payroll run.");
      }
      if (item.timesheetWeek.status !== "APPROVED") {
        throw new PayrollError("An included timesheet is no longer approved.");
      }
    }
    const previous = runAuditFromItems(fresh, fresh.items);
    const approvedHours = fresh.items.reduce((sum, item) => sum + asHours(item.approvedHours), 0);
    const hasGross = fresh.items.some((item) => item.grossLaborAmount != null);
    const gross = hasGross
      ? fresh.items.reduce((sum, item) => sum + (asNumber(item.grossLaborAmount) ?? 0), 0)
      : null;
    const updated = await tx.payrollRun.update({
      where: { id: fresh.id },
      data: {
        status: "AUTHORIZED",
        authorizedAt: new Date(),
        authorizedByMembershipId: access.workspace.membership.id,
        authorizedWorkerCount: fresh.items.length,
        authorizedApprovedHours: decimal(approvedHours),
        authorizedGrossLaborAmount: decimal(gross),
      },
      include: { items: true },
    });
    await writeEvent(tx, {
      businessId: access.businessId,
      payrollRunId: fresh.id,
      actorMembershipId: access.workspace.membership.id,
      action: "AUTHORIZE",
      previousJson: previous,
      nextJson: runAuditFromItems(updated, updated.items),
    });
    return updated;
  });
}

export async function reopenPayrollRun(
  db: PrismaClient,
  access: BusinessAccess,
  input: { payrollRunId: string; reason: string },
) {
  const reason = input.reason.trim();
  if (!reason) {
    throw new PayrollError("A reason is required to reopen a payroll run.");
  }

  return db.$transaction(async (tx) => {
    const run = await loadRun(tx, access, input.payrollRunId);
    if (run.status === "AUTHORIZED") {
      requireBusinessCapability(access, CAPABILITIES.AUTHORIZE_PAYROLL);
    } else if (run.status === "REVIEWED" || run.status === "READY_FOR_REVIEW") {
      requireBusinessCapability(access, CAPABILITIES.MANAGE_PAYROLL);
    } else if (run.status === "PROCESSED") {
      throw new PayrollError("A processed payroll run cannot be reopened.");
    } else {
      throw new PayrollError("Only a reviewed or authorized payroll run can be reopened.");
    }
    const previous = runAuditFromItems(run, run.items);
    const updated = await tx.payrollRun.update({
      where: { id: run.id },
      data: {
        status: "DRAFT",
        reviewedAt: null,
        reviewedByMembershipId: null,
        authorizedAt: null,
        authorizedByMembershipId: null,
        authorizedWorkerCount: null,
        authorizedApprovedHours: null,
        authorizedGrossLaborAmount: null,
      },
      include: { items: true },
    });
    await refreshUnlockedRunItems(tx, access.businessId, run.id);
    const refreshed = await loadRun(tx, access, run.id);
    const status = await persistDerivedStatus(tx, run.id, "DRAFT", refreshed.items);
    await writeEvent(tx, {
      businessId: access.businessId,
      payrollRunId: run.id,
      actorMembershipId: access.workspace.membership.id,
      action: "REOPEN",
      reason,
      previousJson: previous,
      nextJson: runAuditFromItems({ ...updated, status }, refreshed.items),
    });
    return refreshed;
  });
}

export async function cancelPayrollRun(
  db: PrismaClient,
  access: BusinessAccess,
  input: { payrollRunId: string; reason: string },
) {
  const reason = input.reason.trim();
  if (!reason) {
    throw new PayrollError("A reason is required to cancel a payroll run.");
  }
  const run = await loadRun(db, access, input.payrollRunId);
  if (run.status === "PROCESSED") {
    requireBusinessCapability(access, CAPABILITIES.AUTHORIZE_PAYROLL);
    throw new PayrollError("A processed payroll run cannot be cancelled.");
  }
  if (isLockedPayrollStatus(run.status)) {
    requireBusinessCapability(access, CAPABILITIES.AUTHORIZE_PAYROLL);
  } else {
    requireBusinessCapability(access, CAPABILITIES.MANAGE_PAYROLL);
  }
  if (run.status === "CANCELLED") {
    throw new PayrollError("That payroll run is already cancelled.");
  }
  if (!canTransitionPayroll(run.status, "CANCELLED")) {
    throw new PayrollError("This payroll run cannot be cancelled.");
  }

  return db.$transaction(async (tx) => {
    const previous = runAuditFromItems(run, run.items);
    const updated = await tx.payrollRun.update({
      where: { id: run.id },
      data: { status: "CANCELLED" },
      include: { items: true },
    });
    await writeEvent(tx, {
      businessId: access.businessId,
      payrollRunId: run.id,
      actorMembershipId: access.workspace.membership.id,
      action: "CANCEL",
      reason,
      previousJson: previous,
      nextJson: runAuditFromItems(updated, updated.items),
    });
    return updated;
  });
}

export async function markPayrollProcessedExternally(
  db: PrismaClient,
  access: BusinessAccess,
  input: { payrollRunId: string; confirmed: boolean; providerReference?: string; processedAt?: Date },
) {
  requireBusinessCapability(access, CAPABILITIES.AUTHORIZE_PAYROLL);
  if (!input.confirmed) {
    throw new PayrollError("Recording an external payroll result requires explicit confirmation.");
  }

  return db.$transaction(async (tx) => {
    const run = await loadRun(tx, access, input.payrollRunId);
    if (run.status !== "AUTHORIZED") {
      throw new PayrollError("Only an authorized payroll run can be marked processed externally.");
    }
    const previous = runAuditFromItems(run, run.items);
    const updated = await tx.payrollRun.update({
      where: { id: run.id },
      data: {
        status: "PROCESSED",
        processedAt: input.processedAt ?? new Date(),
        processedByMembershipId: access.workspace.membership.id,
        processedSource: "MANUAL_EXTERNAL",
        providerReference: input.providerReference?.trim() || null,
      },
      include: { items: true },
    });
    await writeEvent(tx, {
      businessId: access.businessId,
      payrollRunId: run.id,
      actorMembershipId: access.workspace.membership.id,
      action: "MARK_PROCESSED",
      reason: "Processed externally / recorded manually",
      previousJson: previous,
      nextJson: runAuditFromItems(updated, updated.items),
    });
    return updated;
  });
}

/**
 * Re-evaluate unlocked payroll items after a Time Cards reopen/approve.
 * Locked AUTHORIZED / PROCESSED snapshots are never rewritten.
 */
export async function refreshPayrollAfterTimesheetChange(
  db: Db,
  businessId: string,
  timesheetWeekId: string,
) {
  const items = await db.payrollRunItem.findMany({
    where: { businessId, timesheetWeekId },
    include: {
      payrollRun: true,
      timesheetWeek: { include: { membership: { include: { user: { select: { name: true } } } } } },
    },
  });
  for (const item of items) {
    if (isLockedPayrollStatus(item.payrollRun.status) || item.payrollRun.status === "CANCELLED") {
      continue;
    }
    await refreshUnlockedRunItems(db, businessId, item.payrollRunId);
  }
}

async function refreshUnlockedRunItems(db: Db, businessId: string, payrollRunId: string) {
  const run = await db.payrollRun.findFirst({
    where: { id: payrollRunId, businessId },
    include: {
      items: {
        include: {
          timesheetWeek: { include: { membership: { include: { user: { select: { name: true } } } } } },
        },
      },
    },
  });
  if (!run || isLockedPayrollStatus(run.status) || run.status === "CANCELLED") {
    return;
  }
  const consumed = await finalizedWeekIds(db, businessId, run.id);
  for (const item of run.items) {
    const evalItem = await evaluateWeek(
      db,
      item.timesheetWeek,
      run.payPeriodStart,
      run.payPeriodEnd,
      run.status,
      consumed.has(item.timesheetWeekId),
    );
    await db.payrollRunItem.update({
      where: { id: item.id },
      data: {
        regularHours: decimal(evalItem.regularHours)!,
        overtimeHours: decimal(evalItem.overtimeHours)!,
        approvedHours: decimal(evalItem.approvedHours)!,
        approvedHourlyWage: decimal(evalItem.approvedHourlyWage),
        grossLaborAmount: decimal(evalItem.grossLaborAmount),
        readiness: evalItem.readiness,
        exceptions: evalItem.exceptions,
      },
    });
  }
  const refreshed = await db.payrollRunItem.findMany({ where: { payrollRunId: run.id } });
  const nextStatus = derivePayrollRunStatus({
    currentStatus: run.status === "REVIEWED" ? "REVIEWED" : "DRAFT",
    itemCount: refreshed.length,
    items: refreshed,
  });
  if (nextStatus !== run.status) {
    await db.payrollRun.update({
      where: { id: run.id },
      data: {
        status: nextStatus,
        ...(nextStatus !== "REVIEWED"
          ? { reviewedAt: null, reviewedByMembershipId: null }
          : {}),
      },
    });
  }
}

export async function refreshPayrollRunIfUnlocked(
  db: PrismaClient,
  access: BusinessAccess,
  payrollRunId: string,
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_PAYROLL);
  const run = await loadRun(db, access, payrollRunId);
  await refreshUnlockedRunItems(db, access.businessId, run.id);
  return loadRun(db, access, payrollRunId);
}

export function isPayrollError(error: unknown): error is PayrollError {
  return error instanceof PayrollError;
}

export function payrollErrorMessage(error: unknown, fallback = "That payroll action could not be completed.") {
  if (error instanceof PayrollError) return error.message;
  if (error instanceof ForbiddenError) return error.message;
  return fallback;
}

export function payrollItemExceptions(value: unknown): PayrollExceptionCode[] {
  return asPayrollExceptionList(value);
}

export function isFinalizedPayrollRun(status: string) {
  return isFinalizedPayrollStatus(status);
}
