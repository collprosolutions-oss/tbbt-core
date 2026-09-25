/**
 * Assignee recommendations only. The owner / admin assigns.
 */
import type { AvailabilitySettings } from "@/lib/availability";
import { schedulesOverlap } from "@/lib/job-schedule";
import { formatISODate } from "@/lib/schedule";
import {
  parseSkillList,
  progressionMeets,
  type SchedulingPolicy,
  type WorkforceMember,
  type WorkforceProgression,
} from "@/lib/workforce";
import {
  availableMinutesForDay,
  calculateDailyCapacity,
  memberWindowForDay,
  type CapacityJob,
} from "@/lib/workforce-capacity";

export type AssigneeRecommendation = {
  membershipId: string;
  name: string;
  score: number;
  available: boolean;
  skillMatch: "none" | "partial" | "full" | "unneeded";
  missingSkills: string[];
  workloadMinutes: number;
  conflict: boolean;
  progression: WorkforceProgression;
  reason: string;
};

export function memberHasSkill(member: WorkforceMember, skillKey: string): boolean {
  return member.skills.some((skill) => skill.skillKey === skillKey);
}

export function missingRequiredSkills(member: WorkforceMember, required: string[]): string[] {
  return required.filter((skill) => !memberHasSkill(member, skill));
}

export function skillMatchQuality(
  member: WorkforceMember,
  required: string[],
): AssigneeRecommendation["skillMatch"] {
  if (required.length === 0) return "unneeded";
  const missing = missingRequiredSkills(member, required);
  if (missing.length === 0) return "full";
  if (missing.length < required.length) return "partial";
  return "none";
}

function workerConflicted(
  member: WorkforceMember,
  start: Date,
  durationMinutes: number | null,
  pickupMinutes: number,
  jobs: CapacityJob[],
  excludeJobId?: string,
): boolean {
  const duration = (durationMinutes ?? 0) + pickupMinutes;
  return jobs.some((job) => {
    if (!job.scheduledAt || job.status === "COMPLETED") return false;
    if (job.id === excludeJobId) return false;
    if (job.assignedMembershipId !== member.membershipId) return false;
    return schedulesOverlap(start, duration, job.scheduledAt, job.scheduledDurationMinutes);
  });
}

export function recommendAssignees(input: {
  start: Date | null;
  durationMinutes: number | null;
  pickupMinutes?: number;
  requiredSkills?: string[];
  requiredProgression?: WorkforceProgression | "";
  members: WorkforceMember[];
  jobs: CapacityJob[];
  settings: AvailabilitySettings;
  policy: SchedulingPolicy;
  excludeJobId?: string;
}): AssigneeRecommendation[] {
  const required = input.requiredSkills ?? [];
  const pickupMinutes = input.pickupMinutes ?? 0;
  const recommendations: AssigneeRecommendation[] = [];

  for (const member of input.members) {
    if (!member.active) continue;
    const match = skillMatchQuality(member, required);
    const missing = missingRequiredSkills(member, required);
    const day = input.start ?? new Date();
    const window = memberWindowForDay(day, input.settings, member);
    const conflict = input.start
      ? workerConflicted(
          member,
          input.start,
          input.durationMinutes,
          pickupMinutes,
          input.jobs,
          input.excludeJobId,
        )
      : false;
    const capacity = calculateDailyCapacity({
      day,
      settings: input.settings,
      policy: input.policy,
      jobs: input.jobs.filter((job) => job.id !== input.excludeJobId),
      member,
    });
    const available =
      member.schedulingActive &&
      window.available &&
      !conflict &&
      capacity.remainingMinutes >= (input.durationMinutes ?? 0) + pickupMinutes &&
      progressionMeets(member.progression, input.requiredProgression ?? "");

    let score = 0;
    if (member.schedulingActive) score += 10;
    if (match === "full") score += 100;
    else if (match === "partial") score += 40;
    else if (match === "unneeded") score += 20;
    if (progressionMeets(member.progression, input.requiredProgression ?? "")) score += 20;
    if (available) score += 30;
    if (conflict) score -= 80;
    if (!member.schedulingActive) score -= 40;
    score += Math.max(0, 50 - Math.round(capacity.utilizationPercent / 2));

    const reasons: string[] = [];
    if (match === "full") reasons.push("has the required skills");
    else if (match === "partial") reasons.push(`missing ${missing.join(", ")}`);
    else if (match === "none") reasons.push("does not have the required skills");
    if (conflict) reasons.push("already booked at this time");
    else if (!member.schedulingActive) reasons.push("not active for scheduling");
    else if (!window.available) reasons.push("unavailable that day");
    else if (capacity.overloaded) reasons.push("already overloaded");
    else reasons.push(`${capacity.remainingMinutes} minutes still open`);

    recommendations.push({
      membershipId: member.membershipId,
      name: member.name,
      score,
      available,
      skillMatch: match,
      missingSkills: missing,
      workloadMinutes: capacity.knownScheduledMinutes,
      conflict,
      progression: member.progression,
      reason: `${member.name}: ${reasons.join("; ")}.`,
    });
  }

  return recommendations.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

export function staffingShortage(input: {
  requiredSkills: string[];
  durationMinutes: number | null;
  pickupMinutes?: number;
  start: Date | null;
  recommendations: AssigneeRecommendation[];
}): {
  shortage: boolean;
  missingSkills: string[];
  missingMinutes: number;
  explanation: string;
} {
  const available = input.recommendations.filter((row) => row.available && row.skillMatch !== "none");
  const needed = (input.durationMinutes ?? 0) + (input.pickupMinutes ?? 0);
  if (available.length > 0) {
    return {
      shortage: false,
      missingSkills: [],
      missingMinutes: 0,
      explanation: "A team member can take this job.",
    };
  }
  const missingSkills = [
    ...new Set(input.recommendations.flatMap((row) => row.missingSkills)),
  ].filter((skill) =>
    input.recommendations.every((row) => row.missingSkills.includes(skill) || row.skillMatch === "none"),
  );
  const anySkillHolder = input.recommendations.some((row) => row.skillMatch === "full" || row.skillMatch === "partial");
  const explanation = !anySkillHolder && input.requiredSkills.length > 0
    ? `No scheduled worker has ${input.requiredSkills.join(", ")}.`
    : input.start
      ? `No worker with the right skills is free on ${formatISODate(input.start)}.`
      : "No worker with the right skills and time is available.";
  return {
    shortage: true,
    missingSkills: missingSkills.length > 0 ? missingSkills : input.requiredSkills,
    missingMinutes: needed,
    explanation,
  };
}

export function parseRequiredSkills(raw: string | string[] | null | undefined): string[] {
  if (Array.isArray(raw)) return parseSkillList(raw.join(","));
  return parseSkillList(raw);
}

export function availableMinutesOnDay(
  day: Date,
  settings: AvailabilitySettings,
  member: WorkforceMember,
) {
  return availableMinutesForDay(day, settings, member);
}
