/**
 * Deterministic daily / weekly capacity.
 *
 * Known scheduled time, configured buffers, and estimated/travel
 * placeholders are counted separately. Travel minutes are never GPS
 * routing — they are an owner-configured placeholder only.
 */
import {
  datesCoveredBySchedule,
  isUnavailableDate,
  isWorkingWeekday,
  minutesOfDay,
  workDayLengthMinutes,
  type AvailabilitySettings,
} from "@/lib/availability";
import { addDays, formatISODate, startOfDay } from "@/lib/schedule";
import {
  pickupMinutesForJob,
  type SchedulingPolicy,
  type WorkforceMember,
} from "@/lib/workforce";
import {
  projectRecurrenceOccurrences,
  recurrenceForecastActive,
} from "@/lib/recurrence";

export type CapacityTimeKind = "known" | "configured" | "estimated";

export type CapacityJob = {
  id: string;
  scheduledAt: Date;
  scheduledDurationMinutes: number | null;
  pickupDurationMinutes?: number | null;
  assignedMembershipId?: string | null;
  status?: string | null;
  serviceIntent?: string | null;
  recurrenceCadence?: string | null;
  recurrenceStatus?: string | null;
  nextOccurrenceAt?: Date | null;
  recurrenceSourceJobId?: string | null;
};

export type DailyCapacity = {
  date: string;
  membershipId: string | null;
  availableMinutes: number;
  knownScheduledMinutes: number;
  configuredBufferMinutes: number;
  pickupMinutes: number;
  pickupKind: CapacityTimeKind;
  travelPlaceholderMinutes: number;
  blockedMinutes: number;
  forecastRecurringMinutes: number;
  committedMinutes: number;
  remainingMinutes: number;
  utilizationPercent: number;
  overloaded: boolean;
  helperRecommended: boolean;
  working: boolean;
};

export type WeeklyCapacity = {
  startDate: string;
  endDate: string;
  membershipId: string | null;
  days: DailyCapacity[];
  availableMinutes: number;
  knownScheduledMinutes: number;
  configuredBufferMinutes: number;
  pickupMinutes: number;
  travelPlaceholderMinutes: number;
  forecastRecurringMinutes: number;
  committedMinutes: number;
  remainingMinutes: number;
  overloadedDays: number;
};

function atMinutesOnDay(day: Date, minutes: number): Date {
  return new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    Math.floor(minutes / 60),
    minutes % 60,
    0,
    0,
  );
}

export function memberWindowForDay(
  day: Date,
  settings: AvailabilitySettings,
  member?: WorkforceMember | null,
): { startMinutes: number; endMinutes: number; available: boolean } {
  const dateKey = formatISODate(day);
  const exception = member?.exceptions.find((row) => row.date === dateKey);
  if (exception?.kind === "UNAVAILABLE") {
    return { startMinutes: settings.workStartMinutes, endMinutes: settings.workEndMinutes, available: false };
  }
  if (exception?.kind === "AVAILABLE" && exception.startMinutes != null && exception.endMinutes != null) {
    return {
      startMinutes: exception.startMinutes,
      endMinutes: exception.endMinutes,
      available: exception.endMinutes > exception.startMinutes,
    };
  }
  const weekly = member?.weeklyAvailability.find((row) => row.weekday === day.getDay());
  if (weekly) {
    return {
      startMinutes: weekly.startMinutes,
      endMinutes: weekly.endMinutes,
      available: weekly.endMinutes > weekly.startMinutes,
    };
  }
  if (!member) {
    return {
      startMinutes: settings.workStartMinutes,
      endMinutes: settings.workEndMinutes,
      available: isWorkingWeekday(day, settings) && !isUnavailableDate(day, settings),
    };
  }
  return {
    startMinutes: settings.workStartMinutes,
    endMinutes: settings.workEndMinutes,
    available:
      Boolean(member.active && member.schedulingActive) &&
      isWorkingWeekday(day, settings) &&
      !isUnavailableDate(day, settings),
  };
}

export function availableMinutesForDay(
  day: Date,
  settings: AvailabilitySettings,
  member?: WorkforceMember | null,
): number {
  const window = memberWindowForDay(day, settings, member);
  if (!window.available) return 0;
  const open = Math.max(0, window.endMinutes - window.startMinutes);
  if (member?.maxDailyJobMinutes != null) {
    return Math.min(open, member.maxDailyJobMinutes);
  }
  return open;
}

function jobOnDate(job: CapacityJob, dateKey: string): boolean {
  if (job.status === "COMPLETED" || !job.scheduledAt) return false;
  return datesCoveredBySchedule(job.scheduledAt, job.scheduledDurationMinutes).some(
    (day) => formatISODate(day) === dateKey,
  );
}

function knownDuration(job: CapacityJob): number {
  return Math.max(job.scheduledDurationMinutes ?? 0, 0);
}

export function calculateDailyCapacity(input: {
  day: Date;
  settings: AvailabilitySettings;
  policy: SchedulingPolicy;
  jobs: CapacityJob[];
  member?: WorkforceMember | null;
  forecastUntil?: Date;
}): DailyCapacity {
  const dateKey = formatISODate(input.day);
  const membershipId = input.member?.membershipId ?? null;
  const window = memberWindowForDay(input.day, input.settings, input.member);
  const availableMinutes = availableMinutesForDay(input.day, input.settings, input.member);
  const blockedMinutes = window.available ? 0 : workDayLengthMinutes(input.settings);

  const dayJobs = input.jobs.filter((job) => {
    if (!jobOnDate(job, dateKey)) return false;
    if (membershipId) return job.assignedMembershipId === membershipId;
    return true;
  });

  let knownScheduledMinutes = 0;
  let pickupMinutes = 0;
  let pickupKnown = false;
  let pickupConfigured = false;
  for (const job of dayJobs) {
    knownScheduledMinutes += knownDuration(job);
    const pickup = pickupMinutesForJob(job.pickupDurationMinutes, input.policy);
    pickupMinutes += pickup.minutes;
    if (pickup.minutes > 0 && pickup.kind === "known") pickupKnown = true;
    if (pickup.minutes > 0 && pickup.kind === "configured") pickupConfigured = true;
  }

  const configuredBufferMinutes = dayJobs.length * Math.max(input.settings.schedulingBufferMinutes, 0);
  const travelPlaceholderMinutes =
    dayJobs.length * Math.max(input.policy.travelPlaceholderMinutes, 0);

  let forecastRecurringMinutes = 0;
  const forecastUntil = input.forecastUntil ?? addDays(startOfDay(input.day), 1);
  for (const job of input.jobs) {
    if (!recurrenceForecastActive(job) || !job.scheduledAt) continue;
    if (membershipId && job.assignedMembershipId !== membershipId) continue;
    const projected = projectRecurrenceOccurrences({
      jobId: job.id,
      scheduledAt: job.scheduledAt,
      cadence: job.recurrenceCadence ?? "",
      nextOccurrenceAt: job.nextOccurrenceAt ?? null,
      from: startOfDay(input.day),
      until: forecastUntil,
    });
    for (const occurrence of projected) {
      if (formatISODate(occurrence.at) !== dateKey) continue;
      const alreadyPresent = input.jobs.some(
        (existing) =>
          existing.scheduledAt &&
          formatISODate(existing.scheduledAt) === dateKey &&
          (existing.id === job.id || existing.recurrenceSourceJobId === job.id),
      );
      if (alreadyPresent) continue;
      forecastRecurringMinutes += knownDuration(job);
    }
  }

  const committedMinutes =
    knownScheduledMinutes +
    configuredBufferMinutes +
    pickupMinutes +
    travelPlaceholderMinutes +
    forecastRecurringMinutes;
  const remainingMinutes = availableMinutes - committedMinutes;
  const utilizationPercent =
    availableMinutes <= 0 ? (committedMinutes > 0 ? 100 : 0) : Math.round((committedMinutes / availableMinutes) * 100);
  const overloaded =
    availableMinutes > 0
      ? committedMinutes > availableMinutes || utilizationPercent >= input.policy.overloadThresholdPercent
      : committedMinutes > 0 && !window.available;
  const helperRecommended =
    dayJobs.length > 0 &&
    remainingMinutes < input.policy.helperRecommendationThresholdMinutes &&
    (overloaded || remainingMinutes < input.policy.helperRecommendationThresholdMinutes);

  return {
    date: dateKey,
    membershipId,
    availableMinutes,
    knownScheduledMinutes,
    configuredBufferMinutes,
    pickupMinutes,
    pickupKind: pickupKnown && !pickupConfigured ? "known" : pickupKnown ? "known" : "configured",
    travelPlaceholderMinutes,
    blockedMinutes,
    forecastRecurringMinutes,
    committedMinutes,
    remainingMinutes,
    utilizationPercent,
    overloaded,
    helperRecommended,
    working: window.available,
  };
}

export function calculateWeeklyCapacity(input: {
  start: Date;
  settings: AvailabilitySettings;
  policy: SchedulingPolicy;
  jobs: CapacityJob[];
  member?: WorkforceMember | null;
  days?: number;
}): WeeklyCapacity {
  const days: DailyCapacity[] = [];
  const count = input.days ?? 7;
  const weekEnd = addDays(startOfDay(input.start), count);
  for (let offset = 0; offset < count; offset += 1) {
    days.push(
      calculateDailyCapacity({
        day: addDays(startOfDay(input.start), offset),
        settings: input.settings,
        policy: input.policy,
        jobs: input.jobs,
        member: input.member,
        forecastUntil: weekEnd,
      }),
    );
  }
  const sum = (pick: (day: DailyCapacity) => number) => days.reduce((total, day) => total + pick(day), 0);
  return {
    startDate: days[0]?.date ?? formatISODate(input.start),
    endDate: days[days.length - 1]?.date ?? formatISODate(input.start),
    membershipId: input.member?.membershipId ?? null,
    days,
    availableMinutes: sum((day) => day.availableMinutes),
    knownScheduledMinutes: sum((day) => day.knownScheduledMinutes),
    configuredBufferMinutes: sum((day) => day.configuredBufferMinutes),
    pickupMinutes: sum((day) => day.pickupMinutes),
    travelPlaceholderMinutes: sum((day) => day.travelPlaceholderMinutes),
    forecastRecurringMinutes: sum((day) => day.forecastRecurringMinutes),
    committedMinutes: sum((day) => day.committedMinutes),
    remainingMinutes: sum((day) => day.remainingMinutes),
    overloadedDays: days.filter((day) => day.overloaded).length,
  };
}

export function describeCapacity(day: DailyCapacity): string {
  const parts = [
    `Known scheduled ${day.knownScheduledMinutes} min`,
    `configured buffer ${day.configuredBufferMinutes} min`,
    `pickup ${day.pickupMinutes} min (${day.pickupKind})`,
    `travel placeholder ${day.travelPlaceholderMinutes} min (estimated, not GPS)`,
  ];
  if (day.forecastRecurringMinutes > 0) {
    parts.push(`forecast recurring ${day.forecastRecurringMinutes} min (estimated)`);
  }
  parts.push(`${day.remainingMinutes} min remaining of ${day.availableMinutes}`);
  if (day.overloaded) parts.push("day is overloaded");
  if (day.helperRecommended) parts.push("another helper may be needed");
  return parts.join("; ") + ".";
}

export function jobFitsDay(input: {
  start: Date;
  durationMinutes: number | null;
  pickupMinutes: number;
  settings: AvailabilitySettings;
  policy: SchedulingPolicy;
  existing: CapacityJob[];
  member?: WorkforceMember | null;
}): { fits: boolean; remainingAfter: number; capacity: DailyCapacity } {
  const proposed: CapacityJob = {
    id: "__proposed__",
    scheduledAt: input.start,
    scheduledDurationMinutes: input.durationMinutes,
    pickupDurationMinutes: input.pickupMinutes,
    assignedMembershipId: input.member?.membershipId ?? null,
    status: "SCHEDULED",
  };
  const capacity = calculateDailyCapacity({
    day: input.start,
    settings: input.settings,
    policy: input.policy,
    jobs: [...input.existing.filter((job) => job.id !== "__proposed__"), proposed],
    member: input.member,
  });
  const startMinutes = minutesOfDay(input.start);
  const window = memberWindowForDay(input.start, input.settings, input.member);
  const duration = Math.max(input.durationMinutes ?? 0, 0) + input.pickupMinutes;
  const endsAt = startMinutes + duration + input.settings.schedulingBufferMinutes;
  const withinHours = startMinutes >= window.startMinutes && endsAt <= window.endMinutes;
  return {
    fits: capacity.remainingMinutes >= 0 && withinHours && window.available && !capacity.overloaded,
    remainingAfter: capacity.remainingMinutes,
    capacity,
  };
}

export function laterJobsHurtByMove(input: {
  start: Date;
  durationMinutes: number | null;
  pickupMinutes: number;
  settings: AvailabilitySettings;
  existing: CapacityJob[];
  membershipId?: string | null;
}): CapacityJob[] {
  const end = new Date(
    input.start.getTime() +
      (Math.max(input.durationMinutes ?? 0, 0) + input.pickupMinutes + input.settings.schedulingBufferMinutes) *
        60 *
        1000,
  );
  return input.existing.filter((job) => {
    if (!job.scheduledAt || job.status === "COMPLETED") return false;
    if (input.membershipId && job.assignedMembershipId !== input.membershipId) return false;
    if (job.scheduledAt.getTime() <= input.start.getTime()) return false;
    return job.scheduledAt.getTime() < end.getTime();
  });
}

export function dayStartForCapacity(day: Date, settings: AvailabilitySettings, member?: WorkforceMember | null) {
  const window = memberWindowForDay(day, settings, member);
  return atMinutesOnDay(day, window.startMinutes);
}
