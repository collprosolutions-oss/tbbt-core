/**
 * Owner-reviewable staffing recommendations.
 *
 * Built from the same deterministic Workforce snapshot as the Workforce
 * Agent and Fill-In Bench. Each card shows the exact recorded
 * availability, skills, and schedule facts. Accept / dismiss only write
 * existing BsosRecommendationState / BusinessActionItem rows after a
 * live fact recheck. This module never assigns, contacts, hires, or
 * reschedules anyone.
 */
import { formatMinutesAsClock } from "@/lib/availability";
import type { BsosRecommendation, RecordedFact } from "@/lib/bsos";
import { recommendationEvidenceKey } from "@/lib/bsos-actions";
import {
  DEFAULT_BUSINESS_TIMEZONE,
  formatISODateInTimeZone,
  zonedWeekday,
} from "@/lib/business-timezone";
import { describeRecordedBenchSkillFacts } from "@/lib/fill-in-bench";
import { formatTime } from "@/lib/format";
import {
  formatProgression,
  isAssignableFieldMember,
  isWorkforceProgression,
  pickupMinutesForJob,
  skillLabel,
  type WorkforceMember,
} from "@/lib/workforce";
import { memberWindowForDay } from "@/lib/workforce-capacity";
import type { ConflictJob } from "@/lib/workforce-conflicts";
import {
  recommendAssignees,
  skillMatchQuality,
  staffingShortage,
} from "@/lib/workforce-matching";
import type { WorkforceSnapshot } from "@/lib/workforce-data";

export const STAFFING_REVIEW_KEY_PREFIX = "workforce-staffing:";
export const STAFFING_REVIEW_LIMIT = 20;

export const STAFFING_REVIEW_DECISIONS = ["ACCEPT", "DISMISS"] as const;
export type StaffingReviewDecision = (typeof STAFFING_REVIEW_DECISIONS)[number];

export function isStaffingReviewKey(value: string | null | undefined): boolean {
  return Boolean(value?.startsWith(STAFFING_REVIEW_KEY_PREFIX));
}

export function staffingReviewKeyForJob(jobId: string) {
  return `${STAFFING_REVIEW_KEY_PREFIX}${jobId}`;
}

export function jobIdFromStaffingReviewKey(key: string): string | null {
  if (!isStaffingReviewKey(key)) return null;
  const jobId = key.slice(STAFFING_REVIEW_KEY_PREFIX.length).trim();
  return jobId.length > 0 ? jobId : null;
}

function availabilitySourceForMember(
  member: WorkforceMember | undefined,
  day: Date,
  snapshot: WorkforceSnapshot,
): "exception" | "weekly" | "business-hours-fallback" {
  if (!member) return "business-hours-fallback";
  const zone = snapshot.timeZone || DEFAULT_BUSINESS_TIMEZONE;
  const dateKey = formatISODateInTimeZone(day, zone);
  if (member.exceptions.some((row) => row.date === dateKey)) return "exception";
  const weekday = zonedWeekday(day, zone);
  if (member.weeklyAvailability.some((row) => row.weekday === weekday)) return "weekly";
  return "business-hours-fallback";
}

function availabilitySourceLabel(source: ReturnType<typeof availabilitySourceForMember>) {
  if (source === "exception") return "date exception";
  if (source === "weekly") return "weekly hours";
  return "business-hours fallback";
}

function formatMemberAvailability(
  member: WorkforceMember,
  day: Date,
  snapshot: WorkforceSnapshot,
) {
  const source = availabilitySourceForMember(member, day, snapshot);
  const window = memberWindowForDay(day, snapshot.settings, member, snapshot.timeZone);
  if (!window.available) {
    return `${member.name}: unavailable (${availabilitySourceLabel(source)})`;
  }
  return `${member.name}: ${formatMinutesAsClock(window.startMinutes)}–${formatMinutesAsClock(window.endMinutes)} (${availabilitySourceLabel(source)})`;
}

function formatMemberSkills(member: WorkforceMember) {
  if (member.skills.length === 0) return `${member.name}: no skills recorded`;
  return `${member.name}: ${member.skills
    .map((skill) => `${skillLabel(skill.skillKey)} (${formatProgression(skill.proficiency)})`)
    .join(", ")}`;
}

function scheduleFactValue(job: ConflictJob, snapshot: WorkforceSnapshot) {
  const zone = snapshot.timeZone || DEFAULT_BUSINESS_TIMEZONE;
  const pickup = pickupMinutesForJob(job.pickupDurationMinutes, snapshot.policy);
  const duration =
    job.scheduledDurationMinutes == null
      ? "duration not recorded"
      : `${job.scheduledDurationMinutes} minutes`;
  const pickupLabel =
    pickup.kind === "known"
      ? `${pickup.minutes} known pickup minutes`
      : pickup.kind === "configured"
        ? `${pickup.minutes} configured pickup minutes`
        : "no pickup time recorded";
  return `${formatISODateInTimeZone(job.scheduledAt, zone)} ${formatTime(job.scheduledAt, zone)}; ${duration}; ${pickupLabel}`;
}

function attentionKind(input: {
  job: ConflictJob;
  snapshot: WorkforceSnapshot;
  shortage: boolean;
}): "double-booked" | "shortage" | "unassigned" | "poor-skill-match" | null {
  const doubleBooked = input.snapshot.conflicts.some(
    (row) =>
      row.kind === "DOUBLE_BOOKING" &&
      (row.jobId === input.job.id || row.otherJobId === input.job.id),
  );
  if (doubleBooked) return "double-booked";
  if (input.shortage) return "shortage";
  if (!input.job.assignedMembershipId) return "unassigned";
  const required = input.job.requiredSkills ?? [];
  if (required.length === 0) return null;
  const member = input.snapshot.members.find(
    (row) => row.membershipId === input.job.assignedMembershipId,
  );
  if (!member) return "poor-skill-match";
  const match = skillMatchQuality(member, required);
  return match === "none" || match === "partial" ? "poor-skill-match" : null;
}

function titleForKind(kind: NonNullable<ReturnType<typeof attentionKind>>) {
  if (kind === "double-booked") return "A recorded worker is double-booked";
  if (kind === "shortage") return "Staffing is short for this scheduled job";
  if (kind === "poor-skill-match") return "Assigned worker is missing a required skill";
  return "Scheduled job has no assigned worker";
}

function whyForKind(
  kind: NonNullable<ReturnType<typeof attentionKind>>,
  shortageExplanation: string | null,
) {
  if (kind === "double-booked") {
    return "Two jobs assign the same membership at overlapping times. Accepting this records an owner plan item only. No job was moved.";
  }
  if (kind === "shortage") {
    return `${shortageExplanation ?? "No worker with the right skills and time is available."} Accepting this records an owner plan item only. No worker was assigned or contacted.`;
  }
  if (kind === "poor-skill-match") {
    return "The assigned worker is missing one or more owner-recorded required skills. Accepting this records an owner plan item only. The assignment was not changed.";
  }
  return "This scheduled job has no assigned membership. Unassigned is a valid owner decision. Accepting this records an owner plan item only. No worker was assigned.";
}

export function buildStaffingReviewRecommendations(
  snapshot: WorkforceSnapshot,
  now = new Date(),
): BsosRecommendation[] {
  const zone = snapshot.timeZone || DEFAULT_BUSINESS_TIMEZONE;
  const assignable = snapshot.members.filter((member) => isAssignableFieldMember(member));
  const items: BsosRecommendation[] = [];

  for (const job of snapshot.jobs) {
    if (items.length >= STAFFING_REVIEW_LIMIT) break;
    if (job.status === "COMPLETED" || !job.scheduledAt) continue;
    const requiredSkills = job.requiredSkills ?? [];
    const requiredProgression = isWorkforceProgression(job.requiredProgression)
      ? job.requiredProgression
      : "";
    const recs = recommendAssignees({
      start: job.scheduledAt,
      durationMinutes: job.scheduledDurationMinutes,
      pickupMinutes: job.pickupDurationMinutes ?? 0,
      requiredSkills,
      requiredProgression,
      members: snapshot.members,
      jobs: snapshot.jobs,
      settings: snapshot.settings,
      policy: snapshot.policy,
      excludeJobId: job.id,
      timeZone: zone,
    });
    const shortage = staffingShortage({
      requiredSkills,
      durationMinutes: job.scheduledDurationMinutes,
      pickupMinutes: job.pickupDurationMinutes ?? 0,
      start: job.scheduledAt,
      recommendations: recs,
      timeZone: zone,
    });
    const kind = attentionKind({ job, snapshot, shortage: shortage.shortage });
    if (!kind) continue;
    if (job.scheduledAt < now && (kind === "unassigned" || kind === "shortage")) continue;

    const assigned = snapshot.members.find(
      (member) => member.membershipId === job.assignedMembershipId,
    );
    const benchFact = describeRecordedBenchSkillFacts(snapshot.bench, requiredSkills);
    const facts: RecordedFact[] = [
      {
        key: "schedule",
        label: "Schedule",
        value: scheduleFactValue(job, snapshot),
        href: `/jobs/${job.id}`,
      },
      {
        key: "required-skills",
        label: "Required skills",
        value:
          requiredSkills.length > 0
            ? requiredSkills.map(skillLabel).join(", ")
            : "No required skills recorded",
        href: `/jobs/${job.id}`,
      },
      {
        key: "required-progression",
        label: "Required progression",
        value: requiredProgression ? formatProgression(requiredProgression) : "None recorded",
        href: `/jobs/${job.id}`,
      },
      {
        key: "assignment",
        label: "Current assignment",
        value: assigned ? assigned.name : "Unassigned",
        href: `/jobs/${job.id}`,
      },
      {
        key: "availability",
        label: "Recorded availability",
        value:
          assignable.length === 0
            ? "No assignable field workers are on file"
            : assignable
                .map((member) => formatMemberAvailability(member, job.scheduledAt, snapshot))
                .join("; "),
        href: "/team",
      },
      {
        key: "skills",
        label: "Recorded skills",
        value:
          assignable.length === 0
            ? "No assignable field workers are on file"
            : assignable.map(formatMemberSkills).join("; "),
        href: "/team",
      },
      {
        key: "bench",
        label: "Fill-In Bench",
        value:
          benchFact ??
          (requiredSkills.length === 0
            ? "No required skills, so bench skill match is unneeded"
            : "No active Fill-In Bench worker has the required recorded skill."),
        href: "/team/bench",
      },
    ];

    items.push({
      key: staffingReviewKeyForJob(job.id),
      title: titleForKind(kind),
      kind: "recommendation",
      priority: kind === "double-booked" ? 11 : kind === "shortage" ? 15 : kind === "poor-skill-match" ? 22 : 20,
      why: whyForKind(kind, shortage.explanation),
      facts,
      href: `/jobs/${job.id}`,
    });
  }

  return items.sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key));
}

export function findLiveStaffingRecommendation(
  snapshot: WorkforceSnapshot,
  recommendationKey: string,
  now = new Date(),
) {
  return (
    buildStaffingReviewRecommendations(snapshot, now).find((item) => item.key === recommendationKey) ??
    null
  );
}

export function staffingReviewEvidenceKey(recommendation: BsosRecommendation) {
  return recommendationEvidenceKey(recommendation);
}
