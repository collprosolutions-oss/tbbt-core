/**
 * Deep WORKFORCE specialist. Same specialist identity as PR1.
 *
 * Reuses the Workforce snapshot already loaded for the canonical catalog.
 * Does not assign workers, rewrite schedules, write profiles, create
 * outreach tasks, or send communications.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { PRODUCT_CAPABILITIES, type ProductCapabilityCode } from "@/lib/product-catalog/codes";
import { hasProductCapability } from "@/lib/product-entitlements";
import {
  formatISODateInTimeZone,
  addZonedCalendarDays,
  startOfZonedDay,
  zonedWeekday,
} from "@/lib/business-timezone";
import {
  isAssignableFieldMember,
  isWorkforceProgression,
  parseSkillList,
  pickupMinutesForJob,
  progressionMeets,
  type PickupKind,
  type WorkforceMember,
} from "@/lib/workforce";
import { WORKFORCE_RECOMMENDATION_KEYS } from "@/lib/workforce-agent";
import {
  laterJobsHurtByMove,
  memberWindowForDay,
  type DailyCapacity,
} from "@/lib/workforce-capacity";
import type { ConflictJob, ScheduleConflict } from "@/lib/workforce-conflicts";
import { recommendAssignees, skillMatchQuality, staffingShortage } from "@/lib/workforce-matching";
import {
  loadOwnedWorkforceJob,
  ownedJobToConflictJob,
  type OwnedWorkforceJob,
  type WorkforceSnapshot,
} from "@/lib/workforce-data";
import type { CanonicalRecommendationCatalog } from "@/lib/chief-of-staff/recommendations";
import type {
  CosEntityHints,
  SpecialistFinding,
  SpecialistResult,
} from "@/lib/chief-of-staff/types";

type Db = PrismaClient | Prisma.TransactionClient;

export const WORKFORCE_CONTEXT_CAPS = {
  MAX_JOBS: 20,
  MAX_ASSIGNEE_SUGGESTIONS: 5,
  MAX_CONFLICTS: 8,
  MAX_NAME_SEARCH: 6,
} as const;

export type WorkforceAvailabilitySource = "exception" | "weekly" | "business-hours-fallback";

export type WorkforceTeamAttention = {
  overloadedDates: string[];
  openCapacityDates: string[];
  unassignedCount: number;
  doubleBookingCount: number;
  staffingShortageCount: number;
  poorSkillMatchCount: number;
  helperRecommendedDates: string[];
};

export type WorkforceTeamSummary = {
  assignableCount: number;
  unschedulableCount: number;
  skillRecordCompleteCount: number;
  skillRecordIncompleteCount: number;
  availabilityConfiguredCount: number;
  availabilityInheritedCount: number;
  maxDailyCapConfiguredCount: number;
  benchExists: boolean;
  benchCount: number;
};

export type WorkforceJobProjection = {
  id: string;
  scheduledDate: string | null;
  status: string;
  assigned: boolean;
  displayLabel: string;
  requiredSkills: string[];
  requiredProgression: string;
  durationKnown: boolean;
  pickupMinutes: number;
  pickupKind: PickupKind;
};

export type WorkforceAssigneeSuggestion = {
  membershipId: string;
  name: string;
  skillMatch: "none" | "partial" | "full" | "unneeded";
  available: boolean;
  meetsProgression: boolean;
  conflict: boolean;
  availabilitySource: WorkforceAvailabilitySource;
  reason: string;
};

export type WorkforceTargetedJob = {
  job: WorkforceJobProjection;
  suggestions: WorkforceAssigneeSuggestion[];
  recordedSkillMatch: "none" | "partial" | "full" | "unneeded" | "unassigned";
  availabilitySource: WorkforceAvailabilitySource | "unassigned" | "unknown-member";
  meetsProgression: boolean | null;
  conflict: boolean;
  shortage: boolean;
  shortageExplanation: string;
  nextJobThreat: boolean;
  durationUnknown: boolean;
};

export type WorkforceConflictProjection = {
  kind: string;
  severity: "ERROR" | "WARNING" | "INFO";
  jobId: string;
  otherJobId?: string;
  explanation: string;
};

export type WorkforceTargetResolution =
  | { status: "none" }
  | { status: "resolved"; job: ConflictJob | OwnedWorkforceJob; scopedLookup: boolean }
  | { status: "ambiguous"; matchCount: number }
  | { status: "unauthorized" };

export type WorkforceProjection = {
  attention: WorkforceTeamAttention;
  teamSummary: WorkforceTeamSummary | null;
  jobs: WorkforceJobProjection[];
  targeted: WorkforceTargetedJob | null;
  targeting: WorkforceTargetResolution["status"];
  conflicts: WorkforceConflictProjection[];
  snapshotReused: true;
  scopedLookup: boolean;
  canTargetAssignments: boolean;
};

let lastWorkforceProjection: WorkforceProjection | null = null;

export function resetLastWorkforceProjection() {
  lastWorkforceProjection = null;
}

export function getLastWorkforceProjection() {
  return lastWorkforceProjection;
}

const WAGE_OR_SECRET_KEYS = [
  "hourlyWage",
  "wage",
  "laborDollars",
  "contactValue",
  "workforceNotes",
  "accessInstructions",
  "email",
  "phone",
  "address",
];

export type WorkforceSpecialistInput = {
  db: Db;
  access: BusinessAccess;
  catalog: CanonicalRecommendationCatalog;
  question: string;
  entityHints?: CosEntityHints;
  denyProductCapabilities?: ProductCapabilityCode[];
};

function hasCapability(
  allowed: Set<ProductCapabilityCode>,
  capability: ProductCapabilityCode,
  deny?: ProductCapabilityCode[],
) {
  if (deny?.includes(capability)) return false;
  return allowed.has(capability);
}

async function loadAllowedCapabilities(
  db: Db,
  businessId: string,
  deny?: ProductCapabilityCode[],
) {
  const codes = [
    PRODUCT_CAPABILITIES.SCHEDULING,
    PRODUCT_CAPABILITIES.TEAM_MANAGEMENT,
    PRODUCT_CAPABILITIES.JOBS_TASKS,
  ] as const;
  const allowed = new Set<ProductCapabilityCode>();
  for (const code of codes) {
    if (deny?.includes(code)) continue;
    if (await hasProductCapability(db, businessId, code)) allowed.add(code);
  }
  return allowed;
}

export function availabilitySourceForMember(
  member: WorkforceMember | undefined,
  day: Date,
  snapshot: WorkforceSnapshot,
): WorkforceAvailabilitySource {
  if (!member) return "business-hours-fallback";
  const zone = snapshot.timeZone;
  const dateKey = formatISODateInTimeZone(day, zone);
  const exception = member.exceptions.find((row) => row.date === dateKey);
  if (exception) return "exception";
  const weekday = zonedWeekday(day, zone);
  const weekly = member.weeklyAvailability.find((row) => row.weekday === weekday);
  if (weekly) return "weekly";
  return "business-hours-fallback";
}

function safeDisplayLabel(job: { customerName?: string | null; status?: string | null; assignedMembershipId?: string | null }) {
  if (job.customerName?.trim()) return job.customerName.trim();
  if (!job.assignedMembershipId) return "Unassigned job";
  return job.status === "COMPLETED" ? "Completed job" : "Scheduled job";
}

function projectJob(
  job: ConflictJob | OwnedWorkforceJob,
  snapshot: WorkforceSnapshot,
): WorkforceJobProjection {
  const scheduledAt = "scheduledAt" in job ? job.scheduledAt : null;
  const requiredSkills = Array.isArray((job as ConflictJob).requiredSkills)
    ? ((job as ConflictJob).requiredSkills ?? [])
    : parseSkillList((job as OwnedWorkforceJob).requiredSkills);
  const requiredProgression = (job as ConflictJob).requiredProgression ?? (job as OwnedWorkforceJob).requiredProgression ?? "";
  const pickup = pickupMinutesForJob(job.pickupDurationMinutes, snapshot.policy);
  return {
    id: job.id,
    scheduledDate: scheduledAt ? formatISODateInTimeZone(scheduledAt, snapshot.timeZone) : null,
    status: job.status ?? "UNKNOWN",
    assigned: Boolean(job.assignedMembershipId),
    displayLabel: safeDisplayLabel({
      customerName: "customerName" in job ? job.customerName : null,
      status: job.status,
      assignedMembershipId: job.assignedMembershipId,
    }),
    requiredSkills,
    requiredProgression,
    durationKnown: job.scheduledDurationMinutes != null,
    pickupMinutes: pickup.minutes,
    pickupKind: pickup.kind,
  };
}

function conflictJobFromTarget(target: ConflictJob | OwnedWorkforceJob): ConflictJob | null {
  if ("businessId" in target) return ownedJobToConflictJob(target);
  return target.scheduledAt ? target : null;
}

function countStaffingShortages(snapshot: WorkforceSnapshot) {
  const now = new Date();
  return snapshot.jobs.filter((job) => {
    if (job.status === "COMPLETED" || !job.scheduledAt || job.scheduledAt < now) return false;
    const recs = recommendAssignees({
      start: job.scheduledAt,
      durationMinutes: job.scheduledDurationMinutes,
      pickupMinutes: job.pickupDurationMinutes ?? 0,
      requiredSkills: job.requiredSkills ?? [],
      requiredProgression: isWorkforceProgression(job.requiredProgression) ? job.requiredProgression : "",
      members: snapshot.members,
      jobs: snapshot.jobs,
      settings: snapshot.settings,
      policy: snapshot.policy,
      excludeJobId: job.id,
      timeZone: snapshot.timeZone,
    });
    return staffingShortage({
      requiredSkills: job.requiredSkills ?? [],
      durationMinutes: job.scheduledDurationMinutes,
      pickupMinutes: job.pickupDurationMinutes ?? 0,
      start: job.scheduledAt,
      recommendations: recs,
      timeZone: snapshot.timeZone,
    }).shortage;
  }).length;
}

function countPoorSkillMatches(snapshot: WorkforceSnapshot) {
  return snapshot.jobs.filter((job) => {
    if (!job.assignedMembershipId || job.status === "COMPLETED") return false;
    const required = job.requiredSkills ?? [];
    if (required.length === 0) return false;
    const member = snapshot.members.find((row) => row.membershipId === job.assignedMembershipId);
    if (!member) return true;
    return skillMatchQuality(member, required) === "none" || skillMatchQuality(member, required) === "partial";
  }).length;
}

function openCapacityDates(days: DailyCapacity[]) {
  return days
    .filter(
      (day) =>
        day.working &&
        !day.overloaded &&
        day.knownScheduledMinutes === 0 &&
        day.forecastRecurringMinutes === 0,
    )
    .map((day) => day.date);
}

function projectConflicts(snapshot: WorkforceSnapshot): WorkforceConflictProjection[] {
  const rank = { ERROR: 0, WARNING: 1, INFO: 2 } as const;
  return [...snapshot.conflicts]
    .sort((a, b) => rank[a.severity] - rank[b.severity] || a.jobId.localeCompare(b.jobId))
    .slice(0, WORKFORCE_CONTEXT_CAPS.MAX_CONFLICTS)
    .map((row: ScheduleConflict) => ({
      kind: row.kind,
      severity: row.severity,
      jobId: row.jobId,
      otherJobId: row.otherJobId,
      explanation: row.explanation,
    }));
}

function selectJobs(
  snapshot: WorkforceSnapshot,
  targetedId: string | null,
): WorkforceJobProjection[] {
  const conflictIds = new Set(snapshot.conflicts.map((row) => row.jobId));
  for (const row of snapshot.conflicts) {
    if (row.otherJobId) conflictIds.add(row.otherJobId);
  }
  const now = new Date();
  const ordered: ConflictJob[] = [];
  const seen = new Set<string>();
  const push = (job: ConflictJob | undefined) => {
    if (!job || seen.has(job.id)) return;
    seen.add(job.id);
    ordered.push(job);
  };
  if (targetedId) push(snapshot.jobs.find((job) => job.id === targetedId));
  for (const job of snapshot.jobs) {
    if (conflictIds.has(job.id)) push(job);
  }
  for (const job of snapshot.jobs) {
    if (job.status !== "COMPLETED" && !job.assignedMembershipId && job.scheduledAt) push(job);
  }
  for (const job of snapshot.jobs) {
    if (job.status !== "COMPLETED" && job.scheduledAt && job.scheduledAt >= now) push(job);
  }
  return ordered.slice(0, WORKFORCE_CONTEXT_CAPS.MAX_JOBS).map((job) => projectJob(job, snapshot));
}

function extractHintedJobIds(question: string, hints?: CosEntityHints) {
  const ids: string[] = [];
  if (hints?.jobId) ids.push(hints.jobId);
  const matches = question.match(/\bc[a-z0-9]{20,}\b/gi) ?? [];
  ids.push(...matches);
  return [...new Set(ids)];
}

function extractDisplayNameHint(question: string, hints?: CosEntityHints) {
  if (hints?.customerDisplayName?.trim()) return hints.customerDisplayName.trim();
  const quoted = question.match(/"([^"]{2,80})"/) ?? question.match(/'([^']{2,80})'/);
  if (quoted?.[1]) return quoted[1].trim();
  const forMatch = question.match(/\bfor ([A-Z][\w' .-]{1,60})(?:\s+on\b|\s+tomorrow\b|\s+today\b|[?.,]|$)/);
  return forMatch?.[1]?.trim() ?? null;
}

function extractDateHint(question: string, timeZone: string, hints?: CosEntityHints, now = new Date()) {
  if (hints?.scheduledDate) return hints.scheduledDate;
  if (/\btoday\b/i.test(question)) return formatISODateInTimeZone(now, timeZone);
  if (/\btomorrow\b/i.test(question)) {
    return formatISODateInTimeZone(addZonedCalendarDays(startOfZonedDay(now, timeZone), 1, timeZone), timeZone);
  }
  const iso = question.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  return iso?.[1] ?? null;
}

async function resolveTargetedJob(input: {
  db: Db;
  access: BusinessAccess;
  snapshot: WorkforceSnapshot;
  question: string;
  hints?: CosEntityHints;
}): Promise<WorkforceTargetResolution> {
  const hintedIds = extractHintedJobIds(input.question, input.hints);
  for (const jobId of hintedIds) {
    const inSnapshot = input.snapshot.jobs.find((job) => job.id === jobId);
    if (inSnapshot) return { status: "resolved", job: inSnapshot, scopedLookup: false };
    const owned = await loadOwnedWorkforceJob(input.db, input.access.businessId, jobId);
    if (!owned) {
      if (input.hints?.jobId === jobId) return { status: "unauthorized" };
      continue;
    }
    return { status: "resolved", job: owned, scopedLookup: true };
  }

  const name = extractDisplayNameHint(input.question, input.hints);
  const dateKey = extractDateHint(input.question, input.snapshot.timeZone, input.hints);
  if (!name && !dateKey) return { status: "none" };

  const snapshotMatches = input.snapshot.jobs.filter((job) => {
    const sameName = name ? (job.customerName ?? "").toLowerCase() === name.toLowerCase() : true;
    const sameDate = dateKey
      ? Boolean(job.scheduledAt) && formatISODateInTimeZone(job.scheduledAt, input.snapshot.timeZone) === dateKey
      : true;
    return sameName && sameDate && job.status !== "COMPLETED";
  });
  if (snapshotMatches.length === 1) return { status: "resolved", job: snapshotMatches[0]!, scopedLookup: false };
  if (snapshotMatches.length > 1) return { status: "ambiguous", matchCount: snapshotMatches.length };

  if (!name) return { status: "none" };

  const rows = await input.db.job.findMany({
    where: {
      businessId: input.access.businessId,
      status: { not: "COMPLETED" },
      customer: { name: { equals: name, mode: "insensitive" } },
    },
    select: {
      id: true,
      scheduledAt: true,
      customer: { select: { name: true } },
    },
    take: WORKFORCE_CONTEXT_CAPS.MAX_NAME_SEARCH,
  });
  const dated = dateKey
    ? rows.filter(
        (row) =>
          row.scheduledAt &&
          formatISODateInTimeZone(row.scheduledAt, input.snapshot.timeZone) === dateKey,
      )
    : rows;
  if (dated.length === 1) {
    const owned = await loadOwnedWorkforceJob(input.db, input.access.businessId, dated[0]!.id);
    if (!owned) return { status: "unauthorized" };
    return { status: "resolved", job: owned, scopedLookup: true };
  }
  if (dated.length > 1) return { status: "ambiguous", matchCount: dated.length };
  return { status: "none" };
}

function buildTargetedJob(
  target: ConflictJob | OwnedWorkforceJob,
  snapshot: WorkforceSnapshot,
  canSuggest: boolean,
): WorkforceTargetedJob {
  const job = projectJob(target, snapshot);
  const conflictJob = conflictJobFromTarget(target);
  const assigned = snapshot.members.find((row) => row.membershipId === target.assignedMembershipId);
  const required = job.requiredSkills;
  const requiredProgression = isWorkforceProgression(job.requiredProgression) ? job.requiredProgression : "";
  const day = target.scheduledAt ?? new Date();
  const recordedSkillMatch = assigned
    ? skillMatchQuality(assigned, required)
    : target.assignedMembershipId
      ? "none"
      : "unassigned";
  const availabilitySource = assigned
    ? availabilitySourceForMember(assigned, day, snapshot)
    : target.assignedMembershipId
      ? "unknown-member"
      : "unassigned";
  const meetsProgression = assigned ? progressionMeets(assigned.progression, requiredProgression) : null;
  const jobConflicts = snapshot.conflicts.filter((row) => row.jobId === job.id || row.otherJobId === job.id);
  const suggestions = canSuggest && conflictJob
    ? recommendAssignees({
        start: conflictJob.scheduledAt,
        durationMinutes: conflictJob.scheduledDurationMinutes,
        pickupMinutes: conflictJob.pickupDurationMinutes ?? 0,
        requiredSkills: required,
        requiredProgression,
        members: snapshot.members,
        jobs: snapshot.jobs.filter((row) => row.id !== job.id).concat(conflictJob),
        settings: snapshot.settings,
        policy: snapshot.policy,
        excludeJobId: job.id,
        timeZone: snapshot.timeZone,
      })
        .slice(0, WORKFORCE_CONTEXT_CAPS.MAX_ASSIGNEE_SUGGESTIONS)
        .map((row) => {
          const member = snapshot.members.find((item) => item.membershipId === row.membershipId);
          return {
            membershipId: row.membershipId,
            name: row.name,
            skillMatch: row.skillMatch,
            available: row.available,
            meetsProgression: row.meetsProgression,
            conflict: row.conflict,
            availabilitySource: availabilitySourceForMember(member, day, snapshot),
            reason: row.reason,
          } satisfies WorkforceAssigneeSuggestion;
        })
    : [];
  const shortageInput = canSuggest && conflictJob
    ? recommendAssignees({
        start: conflictJob.scheduledAt,
        durationMinutes: conflictJob.scheduledDurationMinutes,
        pickupMinutes: conflictJob.pickupDurationMinutes ?? 0,
        requiredSkills: required,
        requiredProgression,
        members: snapshot.members,
        jobs: snapshot.jobs.filter((row) => row.id !== job.id).concat(conflictJob),
        settings: snapshot.settings,
        policy: snapshot.policy,
        excludeJobId: job.id,
        timeZone: snapshot.timeZone,
      })
    : [];
  const shortage = conflictJob
    ? staffingShortage({
        requiredSkills: required,
        durationMinutes: conflictJob.scheduledDurationMinutes,
        pickupMinutes: conflictJob.pickupDurationMinutes ?? 0,
        start: conflictJob.scheduledAt,
        recommendations: shortageInput,
        timeZone: snapshot.timeZone,
      })
    : { shortage: false, explanation: "This job has no recorded start time, so assignment fit stays unknown." };
  const later = conflictJob
    ? laterJobsHurtByMove({
        start: conflictJob.scheduledAt,
        durationMinutes: conflictJob.scheduledDurationMinutes,
        pickupMinutes: pickupMinutesForJob(conflictJob.pickupDurationMinutes, snapshot.policy).minutes,
        settings: snapshot.settings,
        policy: snapshot.policy,
        existing: snapshot.jobs,
        membershipId: conflictJob.assignedMembershipId,
      }).filter((row) => row.id !== job.id)
    : [];
  return {
    job,
    suggestions,
    recordedSkillMatch,
    availabilitySource,
    meetsProgression,
    conflict: jobConflicts.some((row) => row.kind === "DOUBLE_BOOKING" || row.severity === "ERROR"),
    shortage: shortage.shortage,
    shortageExplanation: shortage.explanation,
    nextJobThreat: later.length > 0,
    durationUnknown: !job.durationKnown,
  };
}

function teamSummaryFromSnapshot(snapshot: WorkforceSnapshot): WorkforceTeamSummary {
  const assignable = snapshot.members.filter((member) => isAssignableFieldMember(member));
  const unschedulable = snapshot.members.filter(
    (member) => !isAssignableFieldMember(member) || !member.schedulingActive || !member.active,
  );
  const bench = snapshot.bench.filter((row) => row.approved && row.active);
  return {
    assignableCount: assignable.length,
    unschedulableCount: unschedulable.length,
    skillRecordCompleteCount: assignable.filter((member) => member.skills.length > 0).length,
    skillRecordIncompleteCount: assignable.filter((member) => member.skills.length === 0).length,
    availabilityConfiguredCount: assignable.filter((member) => member.weeklyAvailability.length > 0).length,
    availabilityInheritedCount: assignable.filter((member) => member.weeklyAvailability.length === 0).length,
    maxDailyCapConfiguredCount: assignable.filter((member) => member.maxDailyJobMinutes != null).length,
    benchExists: bench.length > 0,
    benchCount: bench.length,
  };
}

function attentionFromSnapshot(snapshot: WorkforceSnapshot): WorkforceTeamAttention {
  const days = snapshot.week.days;
  const overloadedDates = days.filter((day) => day.overloaded).map((day) => day.date);
  const open = openCapacityDates(days).filter((date) => !overloadedDates.includes(date));
  return {
    overloadedDates,
    openCapacityDates: open,
    unassignedCount: snapshot.jobs.filter(
      (job) => job.status !== "COMPLETED" && !job.assignedMembershipId && job.scheduledAt,
    ).length,
    doubleBookingCount: snapshot.conflicts.filter((row) => row.kind === "DOUBLE_BOOKING").length,
    staffingShortageCount: countStaffingShortages(snapshot),
    poorSkillMatchCount: countPoorSkillMatches(snapshot),
    helperRecommendedDates: days.filter((day) => day.helperRecommended).map((day) => day.date),
  };
}

function findingsFromProjection(
  projection: WorkforceProjection,
  catalogKeys: string[],
): SpecialistFinding[] {
  const findings: SpecialistFinding[] = [];
  const rec = (key: string) => (catalogKeys.includes(key) ? [key] : []);
  const factKeys = ["available-capacity", "unscheduled-jobs", "workforce-attention"];

  if (projection.attention.doubleBookingCount > 0) {
    findings.push({
      key: "workforce-double-booked",
      title: "A worker is double-booked",
      summary:
        `${projection.attention.doubleBookingCount} double-booking conflict${projection.attention.doubleBookingCount === 1 ? "" : "s"} are recorded. Jobs were not moved.`,
      recommendationKeys: rec("workforce-double-booked"),
      factKeys,
    });
  }

  if (projection.attention.overloadedDates.length > 0) {
    findings.push({
      key: "workforce-overloaded-day",
      title: "A scheduled day is overloaded",
      summary: `Overloaded dates: ${projection.attention.overloadedDates.join(", ")}. Filling open capacity must not add work onto those dates.`,
      recommendationKeys: rec("workforce-overloaded-day"),
      factKeys,
    });
  }

  if (projection.attention.staffingShortageCount > 0) {
    findings.push({
      key: "workforce-staffing-shortage",
      title: "Staffing is short for upcoming work",
      summary:
        `${projection.attention.staffingShortageCount} upcoming job${projection.attention.staffingShortageCount === 1 ? "" : "s"} need skill or time the current team cannot cover. No worker was assigned.`,
      recommendationKeys: rec("workforce-staffing-shortage"),
      factKeys,
    });
  }

  if (projection.attention.unassignedCount > 0) {
    const noQualified =
      projection.targeted?.shortage ||
      (projection.teamSummary?.assignableCount === 0);
    findings.push({
      key: "workforce-unassigned-job",
      title: "Scheduled jobs are unassigned",
      summary: noQualified
        ? `${projection.attention.unassignedCount} scheduled job${projection.attention.unassignedCount === 1 ? "" : "s"} have no assigned worker, and no qualified available worker is recorded. Unassigned is a valid owner decision.`
        : `${projection.attention.unassignedCount} scheduled job${projection.attention.unassignedCount === 1 ? "" : "s"} have no assigned worker. Unassigned is a valid recorded state. The Coach cannot assign anyone.`,
      recommendationKeys: rec("workforce-unassigned-job"),
      factKeys,
    });
  }

  if (projection.attention.poorSkillMatchCount > 0) {
    findings.push({
      key: "workforce-poor-skill-match",
      title: "Review jobs assigned without the required skills",
      summary: `${projection.attention.poorSkillMatchCount} assigned job${projection.attention.poorSkillMatchCount === 1 ? "" : "s"} are missing one or more owner-recorded required skills.`,
      recommendationKeys: rec("workforce-poor-skill-match"),
      factKeys,
    });
  }

  const configuredPickup = projection.jobs.filter((job) => job.pickupKind === "configured");
  if (configuredPickup.length > 0) {
    findings.push({
      key: "workforce-pickup-configured",
      title: "Pickup time is a configured default",
      summary:
        "At least one job uses the business pickup default. That is a configured assumption, not a known supplier pickup.",
      recommendationKeys: [],
      factKeys,
    });
  }

  if (projection.targeted?.nextJobThreat) {
    findings.push({
      key: "workforce-later-job-threat",
      title: "A schedule change would press a later job",
      summary:
        "Moving this job would press into a later job for the same worker. This is a warning only. Later jobs were not moved.",
      recommendationKeys: [],
      factKeys,
      entityIds: [projection.targeted.job.id],
    });
  }

  if (projection.targeted && !projection.targeted.job.assigned) {
    findings.push({
      key: "workforce-unassigned-owner-decision",
      title: "Assignment stays an owner decision",
      summary:
        "The targeted job is unassigned. That is valid recorded state. Review assignment in the existing workspace; the Coach does not assign a worker.",
      recommendationKeys: rec("workforce-unassigned-job"),
      factKeys,
      entityIds: [projection.targeted.job.id],
    });
  }

  if (projection.targeted?.durationUnknown) {
    findings.push({
      key: "workforce-duration-unknown",
      title: "Job duration is not recorded",
      summary: "Duration is missing, so schedule fit stays unknown. No worker was assumed to fit.",
      recommendationKeys: [],
      factKeys,
      entityIds: [projection.targeted.job.id],
    });
  }

  if (projection.targeted && projection.targeted.job.requiredSkills.length === 0) {
    findings.push({
      key: "workforce-skill-unneeded",
      title: "No required skills are recorded",
      summary: "This job has no required skills, so skill match is unneeded — not unqualified.",
      recommendationKeys: [],
      factKeys,
      entityIds: [projection.targeted.job.id],
    });
  }

  if (projection.teamSummary && projection.teamSummary.assignableCount === 0) {
    findings.push({
      key: "workforce-no-assignable-workers",
      title: "No assignable field workers are on file",
      summary: "An empty assignable roster is not the same as everyone being available.",
      recommendationKeys: [],
      factKeys,
    });
  }

  if (projection.teamSummary && projection.teamSummary.availabilityInheritedCount > 0) {
    findings.push({
      key: "workforce-availability-inherited",
      title: "Some workers inherit business hours",
      summary:
        `${projection.teamSummary.availabilityInheritedCount} assignable worker${projection.teamSummary.availabilityInheritedCount === 1 ? "" : "s"} have empty weekly availability and inherit the configured business-hour fallback. That is not explicit worker availability.`,
      recommendationKeys: [],
      factKeys,
    });
  }

  if (projection.targeting === "ambiguous") {
    findings.push({
      key: "workforce-target-ambiguous",
      title: "More than one job matches that description",
      summary: "Multiple jobs match the customer display name or date. No winner was invented.",
      recommendationKeys: [],
      factKeys,
    });
  }

  if (projection.canTargetAssignments && projection.targeted && !projection.targeted.job.assigned) {
    findings.push({
      key: "workforce-review-assignment",
      title: "Owner-safe next step: review assignment",
      summary: "REVIEW_ASSIGNMENT is a non-executable hint. Open the existing assignment workspace. Nothing was assigned.",
      recommendationKeys: rec("workforce-unassigned-job"),
      factKeys,
      entityIds: [projection.targeted.job.id],
    });
  }

  if (projection.attention.staffingShortageCount > 0 && projection.teamSummary?.benchExists) {
    findings.push({
      key: "workforce-prepare-outreach-hint",
      title: "Owner-safe next step: prepare an outreach task",
      summary:
        "PREPARE_OUTREACH_TASK is a non-executable hint. Approved Fill-In Bench workers exist as a count only. No outreach task was created and no one was contacted.",
      recommendationKeys: rec("workforce-staffing-shortage"),
      factKeys,
    });
  }

  if (projection.targeted?.nextJobThreat || projection.attention.doubleBookingCount > 0) {
    findings.push({
      key: "workforce-review-schedule-change",
      title: "Owner-safe next step: review the schedule",
      summary: "REVIEW_SCHEDULE_CHANGE is a non-executable hint. The Coach does not move jobs.",
      recommendationKeys: rec("workforce-double-booked"),
      factKeys,
    });
  }

  return findings;
}

function assertSafeProjection(projection: WorkforceProjection) {
  const raw = JSON.stringify(projection);
  for (const key of WAGE_OR_SECRET_KEYS) {
    if (raw.includes(`"${key}"`)) {
      throw new Error("Workforce projection leaked a forbidden field.");
    }
  }
}

export function projectWorkforceFromSnapshot(input: {
  snapshot: WorkforceSnapshot;
  catalogKeys: string[];
  target: WorkforceTargetResolution;
  includeTeamSummary: boolean;
  canTargetAssignments: boolean;
}): WorkforceProjection {
  const targeted =
    input.target.status === "resolved"
      ? buildTargetedJob(input.target.job, input.snapshot, input.canTargetAssignments)
      : null;
  const jobs = selectJobs(input.snapshot, targeted?.job.id ?? null);
  if (targeted && !jobs.some((job) => job.id === targeted.job.id)) {
    jobs.unshift(targeted.job);
    if (jobs.length > WORKFORCE_CONTEXT_CAPS.MAX_JOBS) jobs.length = WORKFORCE_CONTEXT_CAPS.MAX_JOBS;
  }
  const projection: WorkforceProjection = {
    attention: attentionFromSnapshot(input.snapshot),
    teamSummary: input.includeTeamSummary ? teamSummaryFromSnapshot(input.snapshot) : null,
    jobs,
    targeted,
    targeting: input.target.status,
    conflicts: projectConflicts(input.snapshot),
    snapshotReused: true,
    scopedLookup: input.target.status === "resolved" ? input.target.scopedLookup : false,
    canTargetAssignments: input.canTargetAssignments,
  };
  assertSafeProjection(projection);
  return projection;
}

export async function runWorkforceSpecialist(input: WorkforceSpecialistInput): Promise<SpecialistResult> {
  const catalogKeys = input.catalog.activeRecommendations
    .map((item) => item.key)
    .filter((key) => (WORKFORCE_RECOMMENDATION_KEYS as readonly string[]).includes(key));
  const allowed = await loadAllowedCapabilities(
    input.db,
    input.access.businessId,
    input.denyProductCapabilities,
  );

  if (!hasCapability(allowed, PRODUCT_CAPABILITIES.SCHEDULING, input.denyProductCapabilities)) {
    lastWorkforceProjection = null;
    return {
      specialistId: "WORKFORCE",
      status: "SKIPPED",
      findings: [],
      factKeys: [],
      recommendationKeys: [],
      limitation:
        "Scheduling is not on this plan, so a schedule/capacity/conflict snapshot cannot be explained. That is not the same as zero workers.",
    };
  }

  const snapshot = input.catalog.workforceSnapshot;
  if (!snapshot) {
    lastWorkforceProjection = null;
    return {
      specialistId: "WORKFORCE",
      status: "FAILED",
      findings: [],
      factKeys: [],
      recommendationKeys: [],
      limitation:
        "The recorded Workforce snapshot could not be loaded. No empty roster or capacity was invented.",
      failure: {
        specialistId: "WORKFORCE",
        message: input.catalog.workforceLoadError ?? "Workforce snapshot could not be loaded.",
      },
    };
  }

  const includeTeamSummary = hasCapability(
    allowed,
    PRODUCT_CAPABILITIES.TEAM_MANAGEMENT,
    input.denyProductCapabilities,
  );
  const canTargetAssignments = hasCapability(
    allowed,
    PRODUCT_CAPABILITIES.JOBS_TASKS,
    input.denyProductCapabilities,
  );

  const target = canTargetAssignments
    ? await resolveTargetedJob({
        db: input.db,
        access: input.access,
        snapshot,
        question: input.question,
        hints: input.entityHints,
      })
    : { status: "none" as const };

  const projection = projectWorkforceFromSnapshot({
    snapshot,
    catalogKeys,
    target,
    includeTeamSummary,
    canTargetAssignments,
  });
  lastWorkforceProjection = projection;

  const findings = findingsFromProjection(projection, catalogKeys);
  const limitations: string[] = [];
  if (!includeTeamSummary) {
    limitations.push("Team management is not on this plan, so worker skill, availability, and bench slices stay hidden.");
  }
  if (!canTargetAssignments) {
    limitations.push("Jobs are not on this plan, so named assignment targeting is not available.");
  }
  if (target.status === "unauthorized") {
    limitations.push("That job is not in this business workspace, so it was not targeted.");
  }

  return {
    specialistId: "WORKFORCE",
    status: "OK",
    findings,
    factKeys: ["available-capacity", "unscheduled-jobs", "workforce-attention"],
    recommendationKeys: catalogKeys,
    limitation: limitations.join(" ") || undefined,
  };
}

export function workforceProjectionHasForbiddenFields(value: unknown) {
  const raw = JSON.stringify(value);
  return WAGE_OR_SECRET_KEYS.some((key) => raw.includes(`"${key}"`) || new RegExp(`"${key}":`, "i").test(raw));
}

/** Test helper: same window check used by memberWindowForDay. */
export function describeInheritedAvailability(member: WorkforceMember, day: Date, snapshot: WorkforceSnapshot) {
  const source = availabilitySourceForMember(member, day, snapshot);
  const window = memberWindowForDay(day, snapshot.settings, member, snapshot.timeZone);
  return { source, window };
}
