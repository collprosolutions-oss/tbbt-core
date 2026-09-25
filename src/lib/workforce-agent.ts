/**
 * Deterministic Workforce Agent recommendations.
 *
 * These may feed BSOS. AI may explain them later but cannot assign
 * workers or rewrite schedules from this layer.
 */
import type { AvailabilitySettings } from "@/lib/availability";
import { addZonedCalendarDays, DEFAULT_BUSINESS_TIMEZONE, formatISODateInTimeZone, startOfZonedDay } from "@/lib/business-timezone";
import type { BsosRecommendation } from "@/lib/bsos";
import {
  type FillInBenchRecord,
  type SchedulingPolicy,
  type WorkforceMember,
} from "@/lib/workforce";
import {
  calculateTeamWeeklyCapacity,
  type CapacityJob,
} from "@/lib/workforce-capacity";
import { detectScheduleConflicts, type ConflictJob } from "@/lib/workforce-conflicts";
import {
  recommendAssignees,
  staffingShortage,
  type AssigneeRecommendation,
} from "@/lib/workforce-matching";

export const WORKFORCE_RECOMMENDATION_KEYS = [
  "workforce-overloaded-day",
  "workforce-unassigned-job",
  "workforce-poor-skill-match",
  "workforce-double-booked",
  "workforce-capacity-gap",
  "workforce-staffing-shortage",
] as const;

export type WorkforceAgentContext = {
  now: Date;
  settings: AvailabilitySettings;
  policy: SchedulingPolicy;
  jobs: ConflictJob[];
  members: WorkforceMember[];
  bench: FillInBenchRecord[];
  timeZone?: string;
};

export function buildWorkforceRecommendations(
  context: WorkforceAgentContext,
): BsosRecommendation[] {
  const items: BsosRecommendation[] = [];
  const zone = context.timeZone || DEFAULT_BUSINESS_TIMEZONE;
  const weekStart = startOfZonedDay(context.now, zone);
  const week = calculateTeamWeeklyCapacity({
    start: weekStart,
    settings: context.settings,
    policy: context.policy,
    jobs: context.jobs,
    members: context.members,
    timeZone: zone,
  });
  const conflicts = detectScheduleConflicts({
    jobs: context.jobs,
    settings: context.settings,
    policy: context.policy,
    members: context.members,
    timeZone: zone,
  });

  const overloaded = week.days.filter((day) => day.overloaded && day.working);
  if (overloaded.length > 0) {
    items.push({
      key: "workforce-overloaded-day",
      title: "A scheduled day is overloaded",
      kind: "recommendation",
      priority: 18,
      why: `${overloaded.length} working day${overloaded.length === 1 ? "" : "s"} in the next week commit more known + configured + estimated time than available hours.`,
      facts: [
        {
          key: "overloaded-days",
          label: "Overloaded days",
          value: overloaded.map((day) => day.date).join(", "),
          href: "/jobs",
        },
      ],
      href: "/jobs",
    });
  }

  const unassigned = context.jobs.filter(
    (job) => job.status !== "COMPLETED" && !job.assignedMembershipId && job.scheduledAt,
  );
  if (unassigned.length > 0) {
    items.push({
      key: "workforce-unassigned-job",
      title: "Assign a worker to scheduled jobs",
      kind: "recommendation",
      priority: 21,
      why: "Scheduled work has no assigned membership. The Workforce Agent does not assign anyone.",
      facts: [
        {
          key: "unassigned",
          label: "Unassigned scheduled jobs",
          value: String(unassigned.length),
          href: "/jobs",
        },
      ],
      href: "/jobs",
    });
  }

  const poorMatches = context.jobs.filter((job) => {
    if (!job.assignedMembershipId || job.status === "COMPLETED") return false;
    const required = job.requiredSkills ?? [];
    if (required.length === 0) return false;
    const member = context.members.find((row) => row.membershipId === job.assignedMembershipId);
    if (!member) return true;
    return required.some((skill) => !member.skills.some((row) => row.skillKey === skill));
  });
  if (poorMatches.length > 0) {
    items.push({
      key: "workforce-poor-skill-match",
      title: "Review jobs assigned without the required skills",
      kind: "recommendation",
      priority: 23,
      why: "An assigned worker is missing one or more owner-recorded required skills.",
      facts: [
        {
          key: "poor-match",
          label: "Poor skill matches",
          value: String(poorMatches.length),
          href: "/jobs",
        },
      ],
      href: "/jobs",
    });
  }

  const doubleBooked = conflicts.filter((row) => row.kind === "DOUBLE_BOOKING");
  if (doubleBooked.length > 0) {
    items.push({
      key: "workforce-double-booked",
      title: "A worker is double-booked",
      kind: "recommendation",
      priority: 12,
      why: "Two jobs assign the same membership at overlapping times. Nothing was auto-moved.",
      facts: [
        {
          key: "double-booked",
          label: "Double-booking conflicts",
          value: String(doubleBooked.length),
          href: "/jobs",
        },
      ],
      href: "/jobs",
    });
  }

  const gapDays = week.days.filter(
    (day) =>
      day.working &&
      !day.overloaded &&
      day.knownScheduledMinutes === 0 &&
      day.forecastRecurringMinutes === 0 &&
      day.date >= formatISODateInTimeZone(weekStart, zone) &&
      day.date < formatISODateInTimeZone(addZonedCalendarDays(weekStart, 7, zone), zone),
  );
  if (gapDays.length > 0) {
    items.push({
      key: "workforce-capacity-gap",
      title: "Upcoming days still have open capacity",
      kind: "recommendation",
      priority: 41,
      why: "Working days in the next week have no known scheduled or forecast recurring work.",
      facts: [
        {
          key: "capacity-gap",
          label: "Open working days",
          value: String(gapDays.length),
          href: "/jobs",
        },
      ],
      href: "/jobs",
    });
  }

  const upcoming = context.jobs.filter(
    (job) => job.status !== "COMPLETED" && job.scheduledAt && job.scheduledAt >= context.now,
  );
  const shortageJobs = upcoming.filter((job) => {
    const recs = recommendAssignees({
      start: job.scheduledAt,
      durationMinutes: job.scheduledDurationMinutes,
      pickupMinutes: job.pickupDurationMinutes ?? 0,
      requiredSkills: job.requiredSkills ?? [],
      requiredProgression: (job.requiredProgression as "" | undefined) ?? "",
      members: context.members,
      timeZone: zone,
      jobs: context.jobs,
      settings: context.settings,
      policy: context.policy,
      excludeJobId: job.id,
    });
    return staffingShortage({
      requiredSkills: job.requiredSkills ?? [],
      durationMinutes: job.scheduledDurationMinutes,
      pickupMinutes: job.pickupDurationMinutes ?? 0,
      start: job.scheduledAt,
      recommendations: recs,
    }).shortage;
  });
  if (shortageJobs.length > 0) {
    const benchHint = context.bench.filter((row) => row.approved && row.active).length;
    items.push({
      key: "workforce-staffing-shortage",
      title: "Staffing is short for upcoming work",
      kind: "recommendation",
      priority: 16,
      why:
        benchHint > 0
          ? `${shortageJobs.length} upcoming job${shortageJobs.length === 1 ? "" : "s"} need skill or time the current team cannot cover. ${benchHint} approved Fill-In Bench worker${benchHint === 1 ? "" : "s"} are on file. Outreach is owner-approved only.`
          : `${shortageJobs.length} upcoming job${shortageJobs.length === 1 ? "" : "s"} need skill or time the current team cannot cover. The agent does not contact anyone.`,
      facts: [
        {
          key: "shortage",
          label: "Jobs with a staffing shortage",
          value: String(shortageJobs.length),
          href: "/team",
        },
      ],
      href: "/team",
    });
  }

  return items.sort((a, b) => a.priority - b.priority);
}

export function suggestBenchForShortage(input: {
  requiredSkills: string[];
  bench: FillInBenchRecord[];
}): FillInBenchRecord[] {
  const required = input.requiredSkills;
  return input.bench
    .filter((row) => row.approved && row.active)
    .filter((row) => required.length === 0 || required.some((skill) => row.skills.includes(skill)))
    .sort((a, b) => {
      const aHits = required.filter((skill) => a.skills.includes(skill)).length;
      const bHits = required.filter((skill) => b.skills.includes(skill)).length;
      return bHits - aHits || a.displayName.localeCompare(b.displayName);
    });
}

export function assigneeSuggestionsForJob(input: {
  start: Date | null;
  durationMinutes: number | null;
  pickupMinutes?: number;
  requiredSkills?: string[];
  members: WorkforceMember[];
  jobs: CapacityJob[];
  settings: AvailabilitySettings;
  policy: SchedulingPolicy;
  excludeJobId?: string;
}): AssigneeRecommendation[] {
  return recommendAssignees(input);
}
