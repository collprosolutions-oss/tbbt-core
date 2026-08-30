/**
 * Time Cards domain -- labor-hour truth.
 *
 * Job.status remains operational truth (start/complete a job). TimeEntry
 * is a separate record of clocked or manually entered labor time. This
 * module is the single source of activity types, review states, week
 * bounds, hour math, overlap rules, and approval snapshots. It has no
 * next/headers dependency so the authorization/isolation check scripts
 * can import it directly.
 *
 * Historical safety: once a TimesheetWeek is APPROVED, each entry's
 * approvedHours / approvedHourlyWage / approvedLaborCost are frozen.
 * Later wage, job, or catalog edits must not rewrite those snapshots.
 */

import { addDays, startOfWeek } from "@/lib/schedule";

export const TIME_ACTIVITY_TYPES = [
  "JOB",
  "TRAVEL",
  "MATERIAL_PICKUP",
  "BREAK",
  "OTHER",
] as const;
export type TimeActivityType = (typeof TIME_ACTIVITY_TYPES)[number];

export const TIME_ENTRY_STATUSES = [
  "RUNNING",
  "READY",
  "NEEDS_REVIEW",
  "APPROVED",
] as const;
export type TimeEntryStatus = (typeof TIME_ENTRY_STATUSES)[number];

export const TIME_ENTRY_SOURCES = ["CLOCK", "MANUAL"] as const;
export type TimeEntrySource = (typeof TIME_ENTRY_SOURCES)[number];

export const TIME_ADJUSTMENT_ACTIONS = [
  "CREATE",
  "UPDATE",
  "CORRECT",
  "CORRECTION_REQUEST",
  "APPROVE",
  "REOPEN",
] as const;
export type TimeAdjustmentAction = (typeof TIME_ADJUSTMENT_ACTIONS)[number];

export const TIMESHEET_WEEK_STATUSES = ["OPEN", "APPROVED"] as const;
export type TimesheetWeekStatus = (typeof TIMESHEET_WEEK_STATUSES)[number];

export const TIME_ACTIVITY_LABELS: Record<TimeActivityType, string> = {
  JOB: "Job",
  TRAVEL: "Travel",
  MATERIAL_PICKUP: "Material Pickup",
  BREAK: "Break",
  OTHER: "Other",
};

export const TIME_STATUS_LABELS: Record<TimeEntryStatus, string> = {
  RUNNING: "Working",
  READY: "Ready",
  NEEDS_REVIEW: "Review",
  APPROVED: "Approved",
};

/** Paid working time -- BREAK is tracked but unpaid. */
export const PAID_ACTIVITY_TYPES: readonly TimeActivityType[] = [
  "JOB",
  "TRAVEL",
  "MATERIAL_PICKUP",
  "OTHER",
];

/** Job-tied labor used for the billable footer (JOB with a jobId). */
export function isPaidActivity(activityType: string): boolean {
  return (PAID_ACTIVITY_TYPES as readonly string[]).includes(activityType);
}

export function isBillableActivity(activityType: string, jobId: string | null | undefined): boolean {
  return activityType === "JOB" && Boolean(jobId);
}

export function isTimeActivityType(value: string): value is TimeActivityType {
  return (TIME_ACTIVITY_TYPES as readonly string[]).includes(value);
}

export function isTimeEntryStatus(value: string): value is TimeEntryStatus {
  return (TIME_ENTRY_STATUSES as readonly string[]).includes(value);
}

export function jobRequiredForActivity(activityType: TimeActivityType): boolean {
  return activityType === "JOB";
}

/**
 * Sunday 00:00 local through the following Sunday 00:00, matching
 * startOfWeek() already used by Schedule.
 */
export function weekRange(date: Date): { start: Date; end: Date } {
  const start = startOfWeek(date);
  return { start, end: addDays(start, 7) };
}

export function entryOverlapsWeek(
  entry: { startedAt: Date; endedAt: Date | null },
  weekStart: Date,
  weekEnd: Date,
  now: Date = new Date(),
): boolean {
  const end = entry.endedAt ?? now;
  return entry.startedAt < weekEnd && end > weekStart;
}

export type Interval = { startedAt: Date; endedAt: Date | null };

/**
 * Two intervals overlap when both have a positive duration in common.
 * A RUNNING entry (endedAt null) is treated as open through `now`.
 * Touching at a single instant (A.endedAt === B.startedAt) is NOT an
 * overlap -- that is the defined clock-transition: close current, open next.
 */
export function intervalsOverlap(
  a: Interval,
  b: Interval,
  now: Date = new Date(),
): boolean {
  const aEnd = a.endedAt ?? now;
  const bEnd = b.endedAt ?? now;
  return a.startedAt < bEnd && b.startedAt < aEnd;
}

export function hasOverlappingEntry(
  candidate: Interval,
  existing: readonly Interval[],
  now: Date = new Date(),
): boolean {
  return existing.some((entry) => intervalsOverlap(candidate, entry, now));
}

/** Duration in hours, rounded to 2 decimals. RUNNING uses `now` as the end. */
export function hoursBetween(startedAt: Date, endedAt: Date | null, now: Date = new Date()): number {
  const end = endedAt ?? now;
  const ms = end.getTime() - startedAt.getTime();
  if (ms <= 0) return 0;
  return roundHours(ms / 3_600_000);
}

export function roundHours(value: number): number {
  return Math.round(value * 100) / 100;
}

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function sumHours(
  entries: readonly { startedAt: Date; endedAt: Date | null; activityType: string }[],
  now: Date = new Date(),
  predicate?: (entry: { activityType: string }) => boolean,
): number {
  return roundHours(
    entries.reduce((sum, entry) => {
      if (predicate && !predicate(entry)) return sum;
      return sum + hoursBetween(entry.startedAt, entry.endedAt, now);
    }, 0),
  );
}

export function paidHours(
  entries: readonly { startedAt: Date; endedAt: Date | null; activityType: string }[],
  now: Date = new Date(),
): number {
  return sumHours(entries, now, (entry) => isPaidActivity(entry.activityType));
}

export function breakHours(
  entries: readonly { startedAt: Date; endedAt: Date | null; activityType: string }[],
  now: Date = new Date(),
): number {
  return sumHours(entries, now, (entry) => entry.activityType === "BREAK");
}

export function billableHours(
  entries: readonly { startedAt: Date; endedAt: Date | null; activityType: string; jobId?: string | null }[],
  now: Date = new Date(),
): number {
  return roundHours(
    entries.reduce((sum, entry) => {
      if (!isBillableActivity(entry.activityType, entry.jobId ?? null)) return sum;
      return sum + hoursBetween(entry.startedAt, entry.endedAt, now);
    }, 0),
  );
}

/**
 * Estimated gross labor cost: paid hours × hourly wage.
 * Returns null when no wage is on file -- never invents a rate.
 * Label this as a labor-cost / gross-wage estimate, not net pay.
 */
export function estimateLaborCost(hours: number, hourlyWage: number | null | undefined): number | null {
  if (hourlyWage == null || !Number.isFinite(hourlyWage) || hourlyWage < 0) {
    return null;
  }
  return roundMoney(hours * hourlyWage);
}

export const OVERTIME_WEEKLY_THRESHOLD = 40;

export function overtimeHours(weekPaidHours: number): number {
  return roundHours(Math.max(0, weekPaidHours - OVERTIME_WEEKLY_THRESHOLD));
}

export function canEditTimeEntry(status: string): boolean {
  return status !== "APPROVED";
}

export function canApproveWeek(entries: readonly { status: string; endedAt: Date | null }[]): {
  ok: boolean;
  error?: string;
} {
  if (entries.length === 0) {
    return { ok: false, error: "There is no time to approve for this week." };
  }
  if (entries.some((entry) => entry.status === "RUNNING" || entry.endedAt == null)) {
    return { ok: false, error: "Stop every running clock before approving this week." };
  }
  return { ok: true };
}

export function approvalSnapshot(input: {
  startedAt: Date;
  endedAt: Date;
  activityType: string;
  hourlyWage: number | null | undefined;
}): { approvedHours: number; approvedHourlyWage: number | null; approvedLaborCost: number | null } {
  const hours = isPaidActivity(input.activityType)
    ? hoursBetween(input.startedAt, input.endedAt)
    : 0;
  const wage = input.hourlyWage ?? null;
  return {
    approvedHours: hours,
    approvedHourlyWage: wage,
    approvedLaborCost: estimateLaborCost(hours, wage),
  };
}

export type TimeEntryAuditSnapshot = {
  id: string;
  membershipId: string;
  jobId: string | null;
  activityType: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  note: string | null;
  source: string;
};

export function toAuditSnapshot(entry: {
  id: string;
  membershipId: string;
  jobId: string | null;
  activityType: string;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  note: string | null;
  source: string;
}): TimeEntryAuditSnapshot {
  return {
    id: entry.id,
    membershipId: entry.membershipId,
    jobId: entry.jobId,
    activityType: entry.activityType,
    status: entry.status,
    startedAt: entry.startedAt.toISOString(),
    endedAt: entry.endedAt ? entry.endedAt.toISOString() : null,
    note: entry.note,
    source: entry.source,
  };
}

export function parseHourlyWage(raw: string): number | null | { error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0 || value > 10_000) {
    return { error: "Enter a valid hourly wage." };
  }
  return roundMoney(value);
}

export function parseDateTimeInput(date: string, time: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    return null;
  }
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const value = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    value.getFullYear() !== year ||
    value.getMonth() !== month - 1 ||
    value.getDate() !== day
  ) {
    return null;
  }
  return value;
}

export function formatDurationClock(hours: number): string {
  const totalMinutes = Math.max(0, Math.round(hours * 60));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}
