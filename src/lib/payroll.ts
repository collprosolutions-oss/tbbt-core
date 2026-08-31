/**
 * Payroll domain -- operating workspace and durable payroll-run records.
 *
 * Time Cards remain labor-hour truth. This module consumes APPROVED
 * TimesheetWeek snapshots, never RUNNING / READY / NEEDS_REVIEW time,
 * and never silently rewrites an authorized or processed run after later
 * wage / time / membership edits.
 *
 * TBBT prepares, reviews, authorizes, tracks, and records. It is not a
 * payroll processor: no tax engine, no ACH, no bank movement, no fake
 * net pay. This module has no next/headers dependency so authorization
 * and isolation check scripts can import it directly.
 */

import { addDays, startOfDay, startOfWeek } from "@/lib/schedule";
import { estimateLaborCost, overtimeHours, roundHours, roundMoney } from "@/lib/time-cards";

export const PAYROLL_RUN_STATUSES = [
  "DRAFT",
  "READY_FOR_REVIEW",
  "REVIEWED",
  "AUTHORIZED",
  "PROCESSED",
  "CANCELLED",
] as const;
export type PayrollRunStatus = (typeof PAYROLL_RUN_STATUSES)[number];

export const PAYROLL_ITEM_READINESS = ["READY", "NEEDS_ATTENTION"] as const;
export type PayrollItemReadiness = (typeof PAYROLL_ITEM_READINESS)[number];

export const PAYROLL_EVENT_ACTIONS = [
  "CREATE",
  "CHANGE_PERIOD",
  "ADD_ITEM",
  "REMOVE_ITEM",
  "REVIEW",
  "AUTHORIZE",
  "REOPEN",
  "CANCEL",
  "MARK_PROCESSED",
] as const;
export type PayrollEventAction = (typeof PAYROLL_EVENT_ACTIONS)[number];

export const PAYROLL_PROCESSED_SOURCES = ["MANUAL_EXTERNAL", "PROVIDER"] as const;
export type PayrollProcessedSource = (typeof PAYROLL_PROCESSED_SOURCES)[number];

export const PAYROLL_EXCEPTIONS = [
  "TIMESHEET_NOT_APPROVED",
  "TIMESHEET_REOPENED",
  "TIMESHEET_REOPENED_AFTER_AUTHORIZATION",
  "MISSING_WAGE",
  "MISSING_WORKER",
  "DUPLICATE_INCLUSION",
  "INVALID_DATE_RANGE",
  "NO_APPROVED_HOURS",
  "WORKER_INACTIVE_WITH_HOURS",
] as const;
export type PayrollExceptionCode = (typeof PAYROLL_EXCEPTIONS)[number];

export const PAYROLL_STATUS_LABELS: Record<PayrollRunStatus, string> = {
  DRAFT: "Draft",
  READY_FOR_REVIEW: "Ready for Review",
  REVIEWED: "Reviewed",
  AUTHORIZED: "Authorized",
  PROCESSED: "Processed",
  CANCELLED: "Cancelled",
};

export const PAYROLL_EXCEPTION_LABELS: Record<PayrollExceptionCode, string> = {
  TIMESHEET_NOT_APPROVED: "Timesheet not approved",
  TIMESHEET_REOPENED: "Timesheet reopened",
  TIMESHEET_REOPENED_AFTER_AUTHORIZATION: "Timesheet reopened after authorization",
  MISSING_WAGE: "Missing wage",
  MISSING_WORKER: "Missing approved timesheet",
  DUPLICATE_INCLUSION: "Already included in a finalized payroll run",
  INVALID_DATE_RANGE: "Invalid pay period",
  NO_APPROVED_HOURS: "No approved hours",
  WORKER_INACTIVE_WITH_HOURS: "Worker inactive — historical approved hours",
};

/** Exceptions that block READY_FOR_REVIEW / authorization. */
export const BLOCKING_PAYROLL_EXCEPTIONS: readonly PayrollExceptionCode[] = [
  "TIMESHEET_NOT_APPROVED",
  "TIMESHEET_REOPENED",
  "MISSING_WAGE",
  "DUPLICATE_INCLUSION",
  "INVALID_DATE_RANGE",
  "NO_APPROVED_HOURS",
];

export function isPayrollRunStatus(value: string): value is PayrollRunStatus {
  return (PAYROLL_RUN_STATUSES as readonly string[]).includes(value);
}

export function isPayrollExceptionCode(value: string): value is PayrollExceptionCode {
  return (PAYROLL_EXCEPTIONS as readonly string[]).includes(value);
}

export function isLockedPayrollStatus(status: string): boolean {
  return status === "AUTHORIZED" || status === "PROCESSED";
}

export function isEditablePayrollStatus(status: string): boolean {
  return status === "DRAFT" || status === "READY_FOR_REVIEW" || status === "REVIEWED";
}

export function isFinalizedPayrollStatus(status: string): boolean {
  return status === "AUTHORIZED" || status === "PROCESSED";
}

/**
 * Default V1 period is the Time Cards week (Sunday 00:00 through the
 * following Sunday). Callers may pass any start/end; discovery is
 * range-based so biweekly periods work without a weekly hardcode.
 */
export function defaultPayPeriod(date: Date = new Date()): { start: Date; end: Date } {
  const start = startOfWeek(date);
  return { start, end: addDays(start, 7) };
}

export function parsePayPeriodDates(
  startRaw: string,
  endRaw: string,
): { start: Date; end: Date } | { error: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startRaw) || !/^\d{4}-\d{2}-\d{2}$/.test(endRaw)) {
    return { error: "Enter a valid pay-period start and end." };
  }
  const [sy, sm, sd] = startRaw.split("-").map(Number);
  const [ey, em, ed] = endRaw.split("-").map(Number);
  const start = startOfDay(new Date(sy, sm - 1, sd));
  const endInclusive = startOfDay(new Date(ey, em - 1, ed));
  if (
    start.getFullYear() !== sy ||
    start.getMonth() !== sm - 1 ||
    start.getDate() !== sd ||
    endInclusive.getFullYear() !== ey ||
    endInclusive.getMonth() !== em - 1 ||
    endInclusive.getDate() !== ed
  ) {
    return { error: "Enter a valid pay-period start and end." };
  }
  const end = addDays(endInclusive, 1);
  if (start.getTime() >= end.getTime()) {
    return { error: "Pay period end must be after the start." };
  }
  return { start, end };
}

export function weekStartsInPayPeriod(weekStartedAt: Date, periodStart: Date, periodEnd: Date): boolean {
  return weekStartedAt >= periodStart && weekStartedAt < periodEnd;
}

/**
 * Regular vs overtime split for display. OT is informational only --
 * no overtime pay multiplier exists in the data model.
 */
export function splitRegularAndOvertime(approvedHours: number): {
  regularHours: number;
  overtimeHours: number;
} {
  const hours = roundHours(Math.max(0, approvedHours));
  const ot = overtimeHours(hours);
  return {
    regularHours: roundHours(hours - ot),
    overtimeHours: ot,
  };
}

/**
 * Gross labor cost from approved Time Cards snapshots.
 * BREAK is already excluded from TimesheetWeek.approvedHours.
 * Returns null when no wage was snapshotted -- never invents a rate
 * and never applies an OT multiplier.
 */
export function snapshotGrossLaborAmount(
  approvedHours: number,
  approvedHourlyWage: number | null | undefined,
  approvedLaborCost?: number | null,
): number | null {
  if (approvedLaborCost != null && Number.isFinite(approvedLaborCost)) {
    return roundMoney(approvedLaborCost);
  }
  return estimateLaborCost(approvedHours, approvedHourlyWage);
}

export function evaluateItemExceptions(input: {
  timesheetStatus: string;
  approvedHours: number;
  approvedHourlyWage: number | null | undefined;
  membershipActive: boolean;
  alreadyFinalized: boolean;
  payrollStatus: string;
}): PayrollExceptionCode[] {
  const exceptions: PayrollExceptionCode[] = [];
  if (input.alreadyFinalized) {
    exceptions.push("DUPLICATE_INCLUSION");
  }
  if (input.timesheetStatus !== "APPROVED") {
    if (isLockedPayrollStatus(input.payrollStatus)) {
      exceptions.push("TIMESHEET_REOPENED_AFTER_AUTHORIZATION");
    } else if (input.timesheetStatus === "OPEN") {
      exceptions.push("TIMESHEET_REOPENED");
    } else {
      exceptions.push("TIMESHEET_NOT_APPROVED");
    }
  }
  if (input.approvedHourlyWage == null || !Number.isFinite(input.approvedHourlyWage)) {
    exceptions.push("MISSING_WAGE");
  }
  if (input.approvedHours <= 0) {
    exceptions.push("NO_APPROVED_HOURS");
  }
  if (!input.membershipActive && input.approvedHours > 0) {
    exceptions.push("WORKER_INACTIVE_WITH_HOURS");
  }
  return exceptions;
}

export function itemReadiness(exceptions: readonly PayrollExceptionCode[]): PayrollItemReadiness {
  return exceptions.some((code) => BLOCKING_PAYROLL_EXCEPTIONS.includes(code))
    ? "NEEDS_ATTENTION"
    : "READY";
}

export function derivePayrollRunStatus(input: {
  currentStatus: string;
  itemCount: number;
  items: readonly { readiness: string }[];
}): PayrollRunStatus {
  if (input.currentStatus === "AUTHORIZED") return "AUTHORIZED";
  if (input.currentStatus === "PROCESSED") return "PROCESSED";
  if (input.currentStatus === "CANCELLED") return "CANCELLED";
  if (input.itemCount === 0) return "DRAFT";
  const allReady = input.items.length > 0 && input.items.every((item) => item.readiness === "READY");
  if (input.currentStatus === "REVIEWED" && allReady) return "REVIEWED";
  if (allReady) return "READY_FOR_REVIEW";
  return "DRAFT";
}

export function canTransitionPayroll(from: string, to: string): boolean {
  const allowed: Record<string, readonly string[]> = {
    DRAFT: ["READY_FOR_REVIEW", "CANCELLED"],
    READY_FOR_REVIEW: ["DRAFT", "REVIEWED", "CANCELLED"],
    REVIEWED: ["DRAFT", "READY_FOR_REVIEW", "AUTHORIZED", "CANCELLED"],
    AUTHORIZED: ["PROCESSED", "CANCELLED"],
    PROCESSED: [],
    CANCELLED: [],
  };
  return (allowed[from] ?? []).includes(to);
}

export type PayrollRunAuditSnapshot = {
  id: string;
  status: string;
  payPeriodStart: string;
  payPeriodEnd: string;
  itemCount: number;
  approvedHours: number;
  grossLaborAmount: number | null;
  authorizedAt: string | null;
  processedAt: string | null;
  providerReference: string | null;
};

export function toPayrollRunAuditSnapshot(run: {
  id: string;
  status: string;
  payPeriodStart: Date;
  payPeriodEnd: Date;
  authorizedAt: Date | null;
  processedAt: Date | null;
  providerReference: string | null;
  items: readonly { approvedHours: number; grossLaborAmount: number | null }[];
}): PayrollRunAuditSnapshot {
  const approvedHours = roundHours(run.items.reduce((sum, item) => sum + item.approvedHours, 0));
  const hasGross = run.items.some((item) => item.grossLaborAmount != null);
  const grossLaborAmount = hasGross
    ? roundMoney(run.items.reduce((sum, item) => sum + (item.grossLaborAmount ?? 0), 0))
    : null;
  return {
    id: run.id,
    status: run.status,
    payPeriodStart: run.payPeriodStart.toISOString(),
    payPeriodEnd: run.payPeriodEnd.toISOString(),
    itemCount: run.items.length,
    approvedHours,
    grossLaborAmount,
    authorizedAt: run.authorizedAt ? run.authorizedAt.toISOString() : null,
    processedAt: run.processedAt ? run.processedAt.toISOString() : null,
    providerReference: run.providerReference,
  };
}

export function asPayrollExceptionList(value: unknown): PayrollExceptionCode[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is PayrollExceptionCode => typeof item === "string" && isPayrollExceptionCode(item));
}
