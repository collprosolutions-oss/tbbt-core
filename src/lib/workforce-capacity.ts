/**
 * Deterministic daily / weekly / team capacity.
 *
 * Known scheduled time, configured buffers, and estimated/travel
 * placeholders are counted separately. Travel minutes are never GPS
 * routing — they are an owner-configured placeholder only.
 *
 * Member lanes are authoritative for assigned workers. The business
 * summary does not collapse multiple workers into one person's hours.
 */
import {
  isUnavailableDate,
  workDayLengthMinutes,
  type AvailabilitySettings,
} from "@/lib/availability";
import {
  addZonedCalendarDays,
  DEFAULT_BUSINESS_TIMEZONE,
  formatISODateInTimeZone,
  startOfZonedDay,
  zonedDateParts,
  zonedWeekday,
} from "@/lib/business-timezone";
import {
  isAssignableFieldMember,
  pickupMinutesForJob,
  type PickupKind,
  type SchedulingPolicy,
  type WorkforceMember,
} from "@/lib/workforce";
import { occupiedWindow, overlapMinutes } from "@/lib/workforce-window";
import {
  projectRecurrenceOccurrences,
  recurrenceForecastActive,
} from "@/lib/recurrence";

export type CapacityTimeKind = PickupKind;

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
  unassignedJobCount?: number;
  memberLaneCount?: number;
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
  unassignedJobCount?: number;
  memberLaneCount?: number;
  soloBusinessLane?: boolean;
};

function resolveTimeZone(timeZone?: string) {
  return timeZone || DEFAULT_BUSINESS_TIMEZONE;
}

export function schedulableMembers(members: WorkforceMember[] | undefined | null): WorkforceMember[] {
  return (members ?? []).filter(
    (member) => isAssignableFieldMember(member) && member.schedulingActive,
  );
}

export function memberWindowForDay(
  day: Date,
  settings: AvailabilitySettings,
  member?: WorkforceMember | null,
  timeZone?: string,
): { startMinutes: number; endMinutes: number; available: boolean } {
  const zone = resolveTimeZone(timeZone);
  const dateKey = formatISODateInTimeZone(day, zone);
  const weekday = zonedWeekday(day, zone);
  const businessOpen =
    settings.workingWeekdays.includes(weekday) && !settings.unavailableDates.includes(dateKey);

  if (member && (!member.active || !member.schedulingActive || !isAssignableFieldMember(member))) {
    return {
      startMinutes: settings.workStartMinutes,
      endMinutes: settings.workEndMinutes,
      available: false,
    };
  }

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
  const weekly = member?.weeklyAvailability.find((row) => row.weekday === weekday);
  if (weekly) {
    return {
      startMinutes: weekly.startMinutes,
      endMinutes: weekly.endMinutes,
      available: weekly.endMinutes > weekly.startMinutes && businessOpen,
    };
  }
  return {
    startMinutes: settings.workStartMinutes,
    endMinutes: settings.workEndMinutes,
    available: member ? businessOpen : businessOpen,
  };
}

export function availableMinutesForDay(
  day: Date,
  settings: AvailabilitySettings,
  member?: WorkforceMember | null,
  timeZone?: string,
): number {
  const window = memberWindowForDay(day, settings, member, timeZone);
  if (!window.available) return 0;
  const open = Math.max(0, window.endMinutes - window.startMinutes);
  if (member?.maxDailyJobMinutes != null) {
    return Math.min(open, member.maxDailyJobMinutes);
  }
  return open;
}

function jobsForLane(
  jobs: CapacityJob[],
  member: WorkforceMember | null | undefined,
  assignableIds: Set<string>,
): CapacityJob[] {
  if (member) {
    return jobs.filter((job) => job.assignedMembershipId === member.membershipId);
  }
  if (assignableIds.size > 0) {
    return jobs.filter(
      (job) => !job.assignedMembershipId || !assignableIds.has(job.assignedMembershipId),
    );
  }
  return jobs;
}

function allocateJobToDay(
  job: CapacityJob,
  dayStart: Date,
  dayEnd: Date,
  policy: SchedulingPolicy,
): { known: number; pickup: number; pickupKind: PickupKind; buffers: number } {
  if (job.status === "COMPLETED" || !job.scheduledAt) {
    return { known: 0, pickup: 0, pickupKind: "none", buffers: 0 };
  }
  const window = occupiedWindow({
    scheduledAt: job.scheduledAt,
    scheduledDurationMinutes: job.scheduledDurationMinutes,
    pickupDurationMinutes: job.pickupDurationMinutes,
    policy,
  });
  const known = overlapMinutes(window.appointmentStart, window.workEnd, dayStart, dayEnd);
  const pickup = overlapMinutes(window.pickupStart, window.appointmentStart, dayStart, dayEnd);
  const touches = known > 0 || pickup > 0;
  return {
    known,
    pickup,
    pickupKind: window.pickupKind,
    buffers: touches ? 1 : 0,
  };
}

export function calculateDailyCapacity(input: {
  day: Date;
  settings: AvailabilitySettings;
  policy: SchedulingPolicy;
  jobs: CapacityJob[];
  member?: WorkforceMember | null;
  forecastUntil?: Date;
  timeZone?: string;
  assignableIds?: Set<string>;
}): DailyCapacity {
  const zone = resolveTimeZone(input.timeZone);
  const dateKey = formatISODateInTimeZone(input.day, zone);
  const dayStart = startOfZonedDay(input.day, zone);
  const dayEnd = addZonedCalendarDays(dayStart, 1, zone);
  const membershipId = input.member?.membershipId ?? null;
  const window = memberWindowForDay(input.day, input.settings, input.member, zone);
  const availableMinutes = availableMinutesForDay(input.day, input.settings, input.member, zone);
  const blockedMinutes = window.available ? 0 : workDayLengthMinutes(input.settings);
  const assignableIds = input.assignableIds ?? new Set<string>();
  const dayJobs = jobsForLane(input.jobs, input.member, assignableIds);

  let knownScheduledMinutes = 0;
  let pickupMinutes = 0;
  let pickupKnown = false;
  let pickupConfigured = false;
  let touchingJobs = 0;
  for (const job of dayJobs) {
    const allocated = allocateJobToDay(job, dayStart, dayEnd, input.policy);
    if (allocated.buffers === 0) continue;
    touchingJobs += 1;
    knownScheduledMinutes += allocated.known;
    pickupMinutes += allocated.pickup;
    if (allocated.pickup > 0 && allocated.pickupKind === "known") pickupKnown = true;
    if (allocated.pickup > 0 && allocated.pickupKind === "configured") pickupConfigured = true;
  }

  const configuredBufferMinutes = touchingJobs * Math.max(input.settings.schedulingBufferMinutes, 0);
  const travelPlaceholderMinutes =
    touchingJobs * Math.max(input.policy.travelPlaceholderMinutes, 0);

  let forecastRecurringMinutes = 0;
  const forecastUntil = input.forecastUntil ?? addZonedCalendarDays(dayStart, 1, zone);
  for (const job of dayJobs) {
    if (!recurrenceForecastActive(job) || !job.scheduledAt) continue;
    const projected = projectRecurrenceOccurrences({
      jobId: job.id,
      scheduledAt: job.scheduledAt,
      cadence: job.recurrenceCadence ?? "",
      nextOccurrenceAt: job.nextOccurrenceAt ?? null,
      from: dayStart,
      until: forecastUntil,
      timeZone: zone,
    });
    for (const occurrence of projected) {
      if (formatISODateInTimeZone(occurrence.at, zone) !== dateKey) continue;
      const alreadyPresent = input.jobs.some(
        (existing) =>
          existing.scheduledAt &&
          formatISODateInTimeZone(existing.scheduledAt, zone) === dateKey &&
          (existing.id === job.id || existing.recurrenceSourceJobId === job.id),
      );
      if (alreadyPresent) continue;
      forecastRecurringMinutes += Math.max(job.scheduledDurationMinutes ?? 0, 0);
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
    touchingJobs > 0 &&
    remainingMinutes < input.policy.helperRecommendationThresholdMinutes &&
    (overloaded || remainingMinutes < input.policy.helperRecommendationThresholdMinutes);

  let pickupKind: CapacityTimeKind = "none";
  if (pickupKnown) pickupKind = "known";
  else if (pickupConfigured) pickupKind = "configured";

  return {
    date: dateKey,
    membershipId,
    availableMinutes,
    knownScheduledMinutes,
    configuredBufferMinutes,
    pickupMinutes,
    pickupKind,
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

function sumDays(days: DailyCapacity[]): Omit<WeeklyCapacity, "startDate" | "endDate" | "membershipId" | "days"> {
  const sum = (pick: (day: DailyCapacity) => number) => days.reduce((total, day) => total + pick(day), 0);
  return {
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

export function calculateWeeklyCapacity(input: {
  start: Date;
  settings: AvailabilitySettings;
  policy: SchedulingPolicy;
  jobs: CapacityJob[];
  member?: WorkforceMember | null;
  days?: number;
  timeZone?: string;
  assignableIds?: Set<string>;
}): WeeklyCapacity {
  const zone = resolveTimeZone(input.timeZone);
  const days: DailyCapacity[] = [];
  const count = input.days ?? 7;
  const weekStart = startOfZonedDay(input.start, zone);
  const weekEnd = addZonedCalendarDays(weekStart, count, zone);
  for (let offset = 0; offset < count; offset += 1) {
    days.push(
      calculateDailyCapacity({
        day: addZonedCalendarDays(weekStart, offset, zone),
        settings: input.settings,
        policy: input.policy,
        jobs: input.jobs,
        member: input.member,
        forecastUntil: weekEnd,
        timeZone: zone,
        assignableIds: input.assignableIds,
      }),
    );
  }
  return {
    startDate: days[0]?.date ?? formatISODateInTimeZone(input.start, zone),
    endDate: days[days.length - 1]?.date ?? formatISODateInTimeZone(input.start, zone),
    membershipId: input.member?.membershipId ?? null,
    days,
    ...sumDays(days),
  };
}

export function calculateTeamDailyCapacity(input: {
  day: Date;
  settings: AvailabilitySettings;
  policy: SchedulingPolicy;
  jobs: CapacityJob[];
  members: WorkforceMember[];
  timeZone?: string;
  forecastUntil?: Date;
}): DailyCapacity {
  const zone = resolveTimeZone(input.timeZone);
  const assignable = schedulableMembers(input.members);
  const assignableIds = new Set(assignable.map((member) => member.membershipId));
  const memberLanes = assignable.map((member) =>
    calculateDailyCapacity({
      ...input,
      member,
      timeZone: zone,
      assignableIds,
    }),
  );
  const unassignedLane = calculateDailyCapacity({
    ...input,
    member: null,
    timeZone: zone,
    assignableIds,
  });

  if (assignable.length === 0) {
    return {
      ...unassignedLane,
      membershipId: null,
      unassignedJobCount: unassignedLane.knownScheduledMinutes > 0 || unassignedLane.pickupMinutes > 0 ? 1 : 0,
      memberLaneCount: 0,
    };
  }

  const sum = (pick: (day: DailyCapacity) => number) =>
    memberLanes.reduce((total, day) => total + pick(day), 0);
  const availableMinutes = sum((day) => day.availableMinutes);
  const knownScheduledMinutes = sum((day) => day.knownScheduledMinutes) + unassignedLane.knownScheduledMinutes;
  const configuredBufferMinutes = sum((day) => day.configuredBufferMinutes) + unassignedLane.configuredBufferMinutes;
  const pickupMinutes = sum((day) => day.pickupMinutes) + unassignedLane.pickupMinutes;
  const travelPlaceholderMinutes =
    sum((day) => day.travelPlaceholderMinutes) + unassignedLane.travelPlaceholderMinutes;
  const forecastRecurringMinutes =
    sum((day) => day.forecastRecurringMinutes) + unassignedLane.forecastRecurringMinutes;
  const committedAssigned = sum((day) => day.committedMinutes);
  const committedMinutes = committedAssigned + unassignedLane.committedMinutes;
  const remainingMinutes = availableMinutes - committedAssigned;
  const utilizationPercent =
    availableMinutes <= 0
      ? committedAssigned > 0
        ? 100
        : 0
      : Math.round((committedAssigned / availableMinutes) * 100);
  const overloaded = memberLanes.some((lane) => lane.overloaded);
  const helperRecommended = memberLanes.some((lane) => lane.helperRecommended) || unassignedLane.helperRecommended;

  return {
    date: unassignedLane.date,
    membershipId: null,
    availableMinutes,
    knownScheduledMinutes,
    configuredBufferMinutes,
    pickupMinutes,
    pickupKind: unassignedLane.pickupKind === "known" || memberLanes.some((lane) => lane.pickupKind === "known")
      ? "known"
      : unassignedLane.pickupKind === "configured" || memberLanes.some((lane) => lane.pickupKind === "configured")
        ? "configured"
        : "none",
    travelPlaceholderMinutes,
    blockedMinutes: 0,
    forecastRecurringMinutes,
    committedMinutes,
    remainingMinutes,
    utilizationPercent,
    overloaded,
    helperRecommended,
    working: memberLanes.some((lane) => lane.working) || unassignedLane.working,
    unassignedJobCount: jobsForLane(input.jobs, null, assignableIds).filter((job) => job.status !== "COMPLETED").length,
    memberLaneCount: assignable.length,
  };
}

export function calculateTeamWeeklyCapacity(input: {
  start: Date;
  settings: AvailabilitySettings;
  policy: SchedulingPolicy;
  jobs: CapacityJob[];
  members: WorkforceMember[];
  days?: number;
  timeZone?: string;
}): WeeklyCapacity {
  const zone = resolveTimeZone(input.timeZone);
  const assignable = schedulableMembers(input.members);
  const days: DailyCapacity[] = [];
  const count = input.days ?? 7;
  const weekStart = startOfZonedDay(input.start, zone);
  const weekEnd = addZonedCalendarDays(weekStart, count, zone);
  for (let offset = 0; offset < count; offset += 1) {
    days.push(
      calculateTeamDailyCapacity({
        day: addZonedCalendarDays(weekStart, offset, zone),
        settings: input.settings,
        policy: input.policy,
        jobs: input.jobs,
        members: input.members,
        timeZone: zone,
        forecastUntil: weekEnd,
      }),
    );
  }
  return {
    startDate: days[0]?.date ?? formatISODateInTimeZone(input.start, zone),
    endDate: days[days.length - 1]?.date ?? formatISODateInTimeZone(input.start, zone),
    membershipId: null,
    days,
    ...sumDays(days),
    unassignedJobCount: days.reduce((total, day) => total + (day.unassignedJobCount ?? 0), 0),
    memberLaneCount: assignable.length,
    soloBusinessLane: assignable.length === 0,
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
  if ((day.unassignedJobCount ?? 0) > 0) parts.push(`${day.unassignedJobCount} unassigned job(s)`);
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
  timeZone?: string;
}): { fits: boolean; remainingAfter: number; capacity: DailyCapacity } {
  const zone = resolveTimeZone(input.timeZone);
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
    timeZone: zone,
  });
  const window = occupiedWindow({
    scheduledAt: input.start,
    scheduledDurationMinutes: input.durationMinutes,
    pickupDurationMinutes: input.pickupMinutes,
    policy: input.policy,
  });
  const memberWindow = memberWindowForDay(input.start, input.settings, input.member, zone);
  const parts = zonedDateParts(window.occupiedStart, zone);
  const endParts = zonedDateParts(window.occupiedEnd, zone);
  const startMinutes = parts.hour * 60 + parts.minute;
  const endMinutes = endParts.hour * 60 + endParts.minute + input.settings.schedulingBufferMinutes;
  const withinHours =
    startMinutes >= memberWindow.startMinutes && endMinutes <= memberWindow.endMinutes;
  return {
    fits: capacity.remainingMinutes >= 0 && withinHours && memberWindow.available && !capacity.overloaded,
    remainingAfter: capacity.remainingMinutes,
    capacity,
  };
}

export function laterJobsHurtByMove(input: {
  start: Date;
  durationMinutes: number | null;
  pickupMinutes: number;
  settings: AvailabilitySettings;
  policy?: SchedulingPolicy;
  existing: CapacityJob[];
  membershipId?: string | null;
}): CapacityJob[] {
  const policy = input.policy ?? {
    firstAppointmentMode: "EXACT",
    laterAppointmentMode: "WINDOW",
    defaultArrivalWindowMinutes: 120,
    dayBeforeChangeCutoffHours: 24,
    defaultPickupMinutes: 0,
    travelPlaceholderMinutes: 0,
    helperRecommendationThresholdMinutes: 60,
    overloadThresholdPercent: 90,
  } satisfies SchedulingPolicy;
  const proposed = occupiedWindow({
    scheduledAt: input.start,
    scheduledDurationMinutes: input.durationMinutes,
    pickupDurationMinutes: input.pickupMinutes,
    policy,
  });
  const proposedEnd = new Date(
    proposed.occupiedEnd.getTime() + Math.max(input.settings.schedulingBufferMinutes, 0) * 60 * 1000,
  );
  return input.existing.filter((job) => {
    if (!job.scheduledAt || job.status === "COMPLETED") return false;
    if (input.membershipId && job.assignedMembershipId !== input.membershipId) return false;
    if (job.scheduledAt.getTime() <= input.start.getTime()) return false;
    const later = occupiedWindow({
      scheduledAt: job.scheduledAt,
      scheduledDurationMinutes: job.scheduledDurationMinutes,
      pickupDurationMinutes: job.pickupDurationMinutes,
      policy,
    });
    return later.occupiedStart.getTime() < proposedEnd.getTime();
  });
}

export function dayStartForCapacity(day: Date, settings: AvailabilitySettings, member?: WorkforceMember | null, timeZone?: string) {
  const zone = resolveTimeZone(timeZone);
  const window = memberWindowForDay(day, settings, member, zone);
  const parts = zonedDateParts(startOfZonedDay(day, zone), zone);
  const hour = Math.floor(window.startMinutes / 60);
  const minute = window.startMinutes % 60;
  return new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute, 0),
  );
}

export function minutesOfZonedDay(date: Date, timeZone?: string) {
  const parts = zonedDateParts(date, resolveTimeZone(timeZone));
  return parts.hour * 60 + parts.minute;
}

export { isUnavailableDate };
