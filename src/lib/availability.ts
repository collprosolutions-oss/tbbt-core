/**
 * Business-scoped scheduling availability.
 *
 * Job remains the only scheduled-work record (scheduledAt +
 * scheduledDurationMinutes). This module adds working days, working hours,
 * unavailable dates, and the travel/material-pickup buffer on top of that
 * existing window math — it does not introduce a second calendar source.
 *
 * Pure functions only. Database loading lives in availability-data.ts.
 */
import { schedulesOverlapWithBuffer } from "@/lib/job-schedule";
import { addDays, formatISODate, startOfDay } from "@/lib/schedule";

export const DEFAULT_WORKING_WEEKDAYS = [1, 2, 3, 4, 5];
export const DEFAULT_WORK_START_MINUTES = 8 * 60;
export const DEFAULT_WORK_END_MINUTES = 17 * 60;
export const DEFAULT_SCHEDULING_BUFFER_MINUTES = 30;
export const MAX_SCHEDULING_BUFFER_MINUTES = 240;
export const AVAILABILITY_SLOT_STEP_MINUTES = 30;
export const AVAILABILITY_SEARCH_DAYS = 60;
export const PUBLIC_NEXT_AVAILABLE_DURATION_MINUTES = 120;

export const WEEKDAY_OPTIONS = [
  { value: 0, label: "Sunday", short: "Sun" },
  { value: 1, label: "Monday", short: "Mon" },
  { value: 2, label: "Tuesday", short: "Tue" },
  { value: 3, label: "Wednesday", short: "Wed" },
  { value: 4, label: "Thursday", short: "Thu" },
  { value: 5, label: "Friday", short: "Fri" },
  { value: 6, label: "Saturday", short: "Sat" },
] as const;

export type AvailabilitySettings = {
  workingWeekdays: number[];
  workStartMinutes: number;
  workEndMinutes: number;
  schedulingBufferMinutes: number;
  unavailableDates: string[];
};

export const DEFAULT_AVAILABILITY_SETTINGS: AvailabilitySettings = {
  workingWeekdays: [...DEFAULT_WORKING_WEEKDAYS],
  workStartMinutes: DEFAULT_WORK_START_MINUTES,
  workEndMinutes: DEFAULT_WORK_END_MINUTES,
  schedulingBufferMinutes: DEFAULT_SCHEDULING_BUFFER_MINUTES,
  unavailableDates: [],
};

export type OccupiedJob = {
  id?: string;
  scheduledAt: Date;
  scheduledDurationMinutes: number | null;
  customerName?: string | null;
};

export type AvailabilitySnapshot = {
  settings: AvailabilitySettings;
  jobs: Array<{
    id: string;
    scheduledAt: string;
    scheduledDurationMinutes: number | null;
  }>;
};

export type ScheduleEvaluation = {
  overlap: { customerName: string | null; scheduledAt: Date } | null;
  nonWorkingDay: boolean;
  unavailableDate: boolean;
  coversUnavailableDate: boolean;
  outsideWorkingHours: boolean;
  extendsPastWorkingHours: boolean;
};

export function parseWorkingWeekdays(raw: string | null | undefined): number[] {
  if (!raw || !raw.trim()) {
    return [...DEFAULT_WORKING_WEEKDAYS];
  }
  const days = [
    ...new Set(
      raw
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6),
    ),
  ].sort((a, b) => a - b);
  return days.length > 0 ? days : [...DEFAULT_WORKING_WEEKDAYS];
}

export function serializeWorkingWeekdays(days: number[]): string {
  return [...new Set(days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))]
    .sort((a, b) => a - b)
    .join(",");
}

export function parseWorkingWeekdaysInput(
  values: string[],
): { ok: true; days: number[] } | { ok: false; error: string } {
  const days = [
    ...new Set(
      values
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6),
    ),
  ].sort((a, b) => a - b);
  if (days.length === 0) {
    return { ok: false, error: "Choose at least one working day." };
  }
  return { ok: true, days };
}

export function parseTimeToMinutes(value: string): number | null {
  if (!/^\d{1,2}:\d{2}$/.test(value)) {
    return null;
  }
  const [hoursRaw, minutesRaw] = value.split(":");
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);
  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return null;
  }
  return hours * 60 + minutes;
}

export function minutesToTimeInput(minutes: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(minutes)));
  const hours = Math.floor(clamped / 60);
  const rest = clamped % 60;
  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

export function parseBufferMinutes(
  raw: string,
): { ok: true; minutes: number } | { ok: false; error: string } {
  const value = Number(raw);
  if (!raw.trim() || !Number.isInteger(value) || value < 0 || value > MAX_SCHEDULING_BUFFER_MINUTES) {
    return {
      ok: false,
      error: `Enter a scheduling buffer between 0 and ${MAX_SCHEDULING_BUFFER_MINUTES} minutes.`,
    };
  }
  return { ok: true, minutes: value };
}

export function parseUnavailableDate(raw: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return null;
  }
  const [year, month, day] = raw.split("-").map(Number);
  const candidate = new Date(year, month - 1, day);
  if (
    candidate.getFullYear() !== year ||
    candidate.getMonth() !== month - 1 ||
    candidate.getDate() !== day
  ) {
    return null;
  }
  return raw;
}

export function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

export function isWorkingWeekday(date: Date, settings: AvailabilitySettings): boolean {
  return settings.workingWeekdays.includes(date.getDay());
}

export function isUnavailableDate(date: Date, settings: AvailabilitySettings): boolean {
  return settings.unavailableDates.includes(formatISODate(date));
}

export function workDayLengthMinutes(settings: AvailabilitySettings): number {
  return Math.max(0, settings.workEndMinutes - settings.workStartMinutes);
}

export function durationFitsWorkingDay(
  durationMinutes: number | null,
  settings: AvailabilitySettings,
): boolean {
  const minutes = Math.max(durationMinutes ?? 0, 0);
  if (minutes === 0) {
    return true;
  }
  return minutes <= workDayLengthMinutes(settings);
}

export function datesCoveredBySchedule(start: Date, durationMinutes: number | null): Date[] {
  const windowMinutes = Math.max(durationMinutes ?? 0, 1);
  const end = new Date(start.getTime() + windowMinutes * 60 * 1000);
  const days: Date[] = [];
  let cursor = startOfDay(start);
  const last = startOfDay(new Date(end.getTime() - 1));
  while (cursor.getTime() <= last.getTime()) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

export function evaluateProposedSchedule(input: {
  start: Date;
  durationMinutes: number | null;
  settings: AvailabilitySettings;
  existing: OccupiedJob[];
}): ScheduleEvaluation {
  const { start, durationMinutes, settings, existing } = input;
  const overlapJob = existing.find((job) =>
    schedulesOverlapWithBuffer(
      start,
      durationMinutes,
      job.scheduledAt,
      job.scheduledDurationMinutes,
      settings.schedulingBufferMinutes,
    ),
  );
  const covered = datesCoveredBySchedule(start, durationMinutes);
  const startMinutes = minutesOfDay(start);
  const duration = Math.max(durationMinutes ?? 0, 0);
  const endsAt = startMinutes + Math.max(duration, 1);
  const fitsDay = durationFitsWorkingDay(durationMinutes, settings);

  return {
    overlap: overlapJob
      ? {
          customerName: overlapJob.customerName ?? null,
          scheduledAt: overlapJob.scheduledAt,
        }
      : null,
    nonWorkingDay: !isWorkingWeekday(start, settings),
    unavailableDate: isUnavailableDate(start, settings),
    coversUnavailableDate: covered.some((day) => {
      if (formatISODate(day) === formatISODate(start)) {
        return false;
      }
      return isUnavailableDate(day, settings) || !isWorkingWeekday(day, settings);
    }),
    outsideWorkingHours:
      startMinutes < settings.workStartMinutes || startMinutes >= settings.workEndMinutes,
    extendsPastWorkingHours: Boolean(
      fitsDay && duration > 0 && endsAt > settings.workEndMinutes && workDayLengthMinutes(settings) > 0,
    ),
  };
}

export function hasScheduleWarning(evaluation: ScheduleEvaluation): boolean {
  return Boolean(
    evaluation.overlap ||
      evaluation.nonWorkingDay ||
      evaluation.unavailableDate ||
      evaluation.coversUnavailableDate ||
      evaluation.outsideWorkingHours ||
      evaluation.extendsPastWorkingHours,
  );
}

export function describeScheduleWarning(
  evaluation: ScheduleEvaluation,
  start: Date,
  formatOverlapTime: (value: Date) => string,
  settings: AvailabilitySettings,
): string | null {
  if (!hasScheduleWarning(evaluation)) {
    return null;
  }
  const parts: string[] = [];
  if (evaluation.overlap) {
    const who = evaluation.overlap.customerName ?? "another job";
    parts.push(
      `This time overlaps ${who} at ${formatOverlapTime(evaluation.overlap.scheduledAt)} (including the ${settings.schedulingBufferMinutes}-minute travel/pickup buffer).`,
    );
  }
  if (evaluation.unavailableDate) {
    parts.push(`${formatNextAvailableDate(start)} is marked unavailable.`);
  }
  if (evaluation.nonWorkingDay) {
    const weekday = WEEKDAY_OPTIONS.find((option) => option.value === start.getDay());
    parts.push(`${weekday?.label ?? "That day"} is not a working day.`);
  }
  if (evaluation.coversUnavailableDate) {
    parts.push("This duration covers an unavailable or non-working day.");
  }
  if (evaluation.outsideWorkingHours) {
    parts.push(
      `Start time is outside working hours (${formatMinutesAsClock(settings.workStartMinutes)}–${formatMinutesAsClock(settings.workEndMinutes)}).`,
    );
  }
  if (evaluation.extendsPastWorkingHours) {
    parts.push(
      `This duration extends past closing time (${formatMinutesAsClock(settings.workEndMinutes)}).`,
    );
  }
  parts.push("You can schedule anyway if needed.");
  return parts.join(" ");
}

export function formatMinutesAsClock(minutes: number): string {
  const hours24 = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const period = hours24 >= 12 ? "PM" : "AM";
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return rest === 0 ? `${hours12}:00 ${period}` : `${hours12}:${String(rest).padStart(2, "0")} ${period}`;
}

export function formatWorkingDaysSummary(weekdays: number[]): string {
  const unique = [...new Set(weekdays)].sort((a, b) => a - b);
  if (unique.length === 7) {
    return "Every day";
  }
  if (unique.length === 5 && unique.join(",") === "1,2,3,4,5") {
    return "Mon–Fri";
  }
  if (unique.length === 2 && unique.join(",") === "0,6") {
    return "Weekends";
  }
  return unique
    .map((day) => WEEKDAY_OPTIONS.find((option) => option.value === day)?.short ?? String(day))
    .join(", ");
}

export function formatAvailabilitySummary(settings: AvailabilitySettings): string {
  const days = formatWorkingDaysSummary(settings.workingWeekdays);
  const hours = `${formatMinutesAsClock(settings.workStartMinutes)}–${formatMinutesAsClock(settings.workEndMinutes)}`;
  const buffer = `${settings.schedulingBufferMinutes}-minute travel/pickup buffer`;
  const blocked =
    settings.unavailableDates.length === 0
      ? "no blocked dates"
      : `${settings.unavailableDates.length} blocked date${settings.unavailableDates.length === 1 ? "" : "s"}`;
  return `${days}, ${hours}, ${buffer}, ${blocked}.`;
}

export function formatNextAvailableDate(value: Date): string {
  return value.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

export function formatNextAvailableDateTime(value: Date): string {
  return `${formatNextAvailableDate(value)} at ${value.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

export function occupiedJobsFromSnapshot(
  snapshot: AvailabilitySnapshot,
  excludeJobId?: string,
): OccupiedJob[] {
  return snapshot.jobs
    .filter((job) => job.id !== excludeJobId)
    .map((job) => ({
      id: job.id,
      scheduledAt: new Date(job.scheduledAt),
      scheduledDurationMinutes: job.scheduledDurationMinutes,
    }));
}

function atMinutesOnDay(day: Date, minutes: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(minutes / 60), minutes % 60, 0, 0);
}

function ceilToStepMinutes(date: Date, stepMinutes: number): Date {
  const total = date.getHours() * 60 + date.getMinutes() + (date.getSeconds() > 0 || date.getMilliseconds() > 0 ? 1 : 0);
  const rounded = Math.ceil(total / stepMinutes) * stepMinutes;
  if (rounded >= 24 * 60) {
    return atMinutesOnDay(addDays(startOfDay(date), 1), 0);
  }
  return atMinutesOnDay(date, rounded);
}

function slotOverlapsExisting(
  start: Date,
  durationMinutes: number | null,
  settings: AvailabilitySettings,
  existing: OccupiedJob[],
): boolean {
  return existing.some((job) =>
    schedulesOverlapWithBuffer(
      start,
      durationMinutes,
      job.scheduledAt,
      job.scheduledDurationMinutes,
      settings.schedulingBufferMinutes,
    ),
  );
}

export function findNextAvailableStart(input: {
  from: Date;
  durationMinutes: number | null;
  settings: AvailabilitySettings;
  existing: OccupiedJob[];
  searchDays?: number;
}): Date | null {
  const { from, settings, existing } = input;
  const durationMinutes = input.durationMinutes;
  const searchDays = input.searchDays ?? AVAILABILITY_SEARCH_DAYS;
  const duration = Math.max(durationMinutes ?? 60, 1);
  const fitsDay = durationFitsWorkingDay(duration, settings);
  const workLength = workDayLengthMinutes(settings);
  if (workLength <= 0 || settings.workingWeekdays.length === 0) {
    return null;
  }

  const startDay = startOfDay(from);
  for (let offset = 0; offset < searchDays; offset += 1) {
    const day = addDays(startDay, offset);
    if (!isWorkingWeekday(day, settings) || isUnavailableDate(day, settings)) {
      continue;
    }

    if (!fitsDay) {
      const candidate = atMinutesOnDay(day, settings.workStartMinutes);
      if (candidate < from) {
        continue;
      }
      if (slotOverlapsExisting(candidate, duration, settings, existing)) {
        continue;
      }
      const covered = datesCoveredBySchedule(candidate, duration);
      if (covered.some((coveredDay) => isUnavailableDate(coveredDay, settings))) {
        continue;
      }
      return candidate;
    }

    const lastStartMinutes = settings.workEndMinutes - duration;
    if (lastStartMinutes < settings.workStartMinutes) {
      continue;
    }

    let slotMinutes = settings.workStartMinutes;
    if (formatISODate(day) === formatISODate(from)) {
      const rounded = ceilToStepMinutes(from, AVAILABILITY_SLOT_STEP_MINUTES);
      if (formatISODate(rounded) !== formatISODate(day)) {
        continue;
      }
      slotMinutes = Math.max(settings.workStartMinutes, minutesOfDay(rounded));
      const rem = slotMinutes % AVAILABILITY_SLOT_STEP_MINUTES;
      if (rem !== 0) {
        slotMinutes += AVAILABILITY_SLOT_STEP_MINUTES - rem;
      }
    }

    for (
      let minutes = slotMinutes;
      minutes <= lastStartMinutes;
      minutes += AVAILABILITY_SLOT_STEP_MINUTES
    ) {
      const candidate = atMinutesOnDay(day, minutes);
      if (candidate < from) {
        continue;
      }
      if (slotOverlapsExisting(candidate, duration, settings, existing)) {
        continue;
      }
      return candidate;
    }
  }

  return null;
}
