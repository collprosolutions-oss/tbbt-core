/**
 * Scheduling conflict detection with severity and explanation.
 *
 * Conflicts are recommendations for the owner. Nothing here moves a Job.
 */
import {
  datesCoveredBySchedule,
  isUnavailableDate,
  workDayLengthMinutes,
  type AvailabilitySettings,
} from "@/lib/availability";
import { DEFAULT_BUSINESS_TIMEZONE, formatISODateInTimeZone } from "@/lib/business-timezone";
import {
  dayBeforeCutoffPassed,
  type SchedulingPolicy,
  type WorkforceMember,
} from "@/lib/workforce";
import {
  availableMinutesForDay,
  laterJobsHurtByMove,
  memberWindowForDay,
  minutesOfZonedDay,
  type CapacityJob,
} from "@/lib/workforce-capacity";
import { occupiedWindow, windowsOverlap, withConfiguredBuffer } from "@/lib/workforce-window";

export const CONFLICT_KINDS = [
  "OVERLAP",
  "DOUBLE_BOOKING",
  "INSUFFICIENT_TURNAROUND",
  "OUTSIDE_AVAILABILITY",
  "DURATION_EXCEEDS_DAY",
  "RESCHEDULE_CASCADE",
  "DAY_BEFORE_CUTOFF",
] as const;
export type ConflictKind = (typeof CONFLICT_KINDS)[number];

export const CONFLICT_SEVERITIES = ["ERROR", "WARNING", "INFO"] as const;
export type ConflictSeverity = (typeof CONFLICT_SEVERITIES)[number];

export type ScheduleConflict = {
  kind: ConflictKind;
  severity: ConflictSeverity;
  jobId: string;
  otherJobId?: string;
  membershipId?: string;
  explanation: string;
};

export type ConflictJob = CapacityJob & {
  customerName?: string | null;
  requiredSkills?: string[];
  requiredProgression?: string | null;
};

function labelFor(job: ConflictJob): string {
  return job.customerName ?? "another job";
}

function windowForJob(job: ConflictJob, policy: SchedulingPolicy) {
  return occupiedWindow({
    scheduledAt: job.scheduledAt,
    scheduledDurationMinutes: job.scheduledDurationMinutes,
    pickupDurationMinutes: job.pickupDurationMinutes,
    policy,
  });
}

export function detectScheduleConflicts(input: {
  jobs: ConflictJob[];
  settings: AvailabilitySettings;
  policy: SchedulingPolicy;
  members?: WorkforceMember[];
  timeZone?: string;
  proposed?: {
    jobId: string;
    start: Date;
    durationMinutes: number | null;
    pickupMinutes?: number | null;
    assignedMembershipId?: string | null;
    originalScheduledAt?: Date | null;
  };
  now?: Date;
}): ScheduleConflict[] {
  const zone = input.timeZone || DEFAULT_BUSINESS_TIMEZONE;
  const conflicts: ScheduleConflict[] = [];
  const active = input.jobs.filter((job) => job.scheduledAt && job.status !== "COMPLETED");
  const members = new Map((input.members ?? []).map((member) => [member.membershipId, member]));

  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i]!;
      const b = active[j]!;
      const aWindow = windowForJob(a, input.policy);
      const bWindow = windowForJob(b, input.policy);
      const overlap = windowsOverlap(aWindow, bWindow);
      const turnaroundOverlap = windowsOverlap(
        withConfiguredBuffer(aWindow, input.settings.schedulingBufferMinutes),
        bWindow,
      );
      const sameWorker = Boolean(
        a.assignedMembershipId && a.assignedMembershipId === b.assignedMembershipId,
      );
      if (overlap) {
        conflicts.push({
          kind: sameWorker ? "DOUBLE_BOOKING" : "OVERLAP",
          severity: sameWorker ? "ERROR" : "WARNING",
          jobId: a.id,
          otherJobId: b.id,
          membershipId: sameWorker ? a.assignedMembershipId ?? undefined : undefined,
          explanation: sameWorker
            ? `${labelFor(a)} and ${labelFor(b)} assign the same worker at overlapping times.`
            : `${labelFor(a)} overlaps ${labelFor(b)}. Jobs were not moved.`,
        });
      } else if (turnaroundOverlap && (sameWorker || !a.assignedMembershipId || !b.assignedMembershipId)) {
        conflicts.push({
          kind: "INSUFFICIENT_TURNAROUND",
          severity: "WARNING",
          jobId: a.id,
          otherJobId: b.id,
          membershipId: sameWorker ? a.assignedMembershipId ?? undefined : undefined,
          explanation: `Less than the ${input.settings.schedulingBufferMinutes}-minute configured buffer remains between ${labelFor(a)} and ${labelFor(b)}.`,
        });
      }
    }
  }

  for (const job of active) {
    const window = windowForJob(job, input.policy);
    const member = job.assignedMembershipId ? members.get(job.assignedMembershipId) : undefined;
    const memberWindow = memberWindowForDay(job.scheduledAt, input.settings, member, zone);
    const startMinutes = minutesOfZonedDay(window.occupiedStart, zone);
    const endMinutes = minutesOfZonedDay(window.occupiedEnd, zone);
    const available = availableMinutesForDay(job.scheduledAt, input.settings, member, zone);
    const duration = window.durationMinutes + window.pickupMinutes;
    if (
      !memberWindow.available ||
      startMinutes < memberWindow.startMinutes ||
      endMinutes > memberWindow.endMinutes
    ) {
      conflicts.push({
        kind: "OUTSIDE_AVAILABILITY",
        severity: "WARNING",
        jobId: job.id,
        membershipId: member?.membershipId,
        explanation: member
          ? `${labelFor(job)} occupies time outside ${member.name}'s availability.`
          : `${labelFor(job)} is outside working hours or on a blocked day.`,
      });
    }
    if (duration > 0 && duration > available && available >= 0) {
      conflicts.push({
        kind: "DURATION_EXCEEDS_DAY",
        severity: "ERROR",
        jobId: job.id,
        membershipId: member?.membershipId,
        explanation: `${labelFor(job)} needs ${duration} minutes (job + pickup) but only ${available} minutes remain on that day.`,
      });
    } else if (duration > workDayLengthMinutes(input.settings)) {
      conflicts.push({
        kind: "DURATION_EXCEEDS_DAY",
        severity: "ERROR",
        jobId: job.id,
        explanation: `${labelFor(job)} is longer than the configured working day.`,
      });
    }
    const covered = datesCoveredBySchedule(window.occupiedStart, duration);
    if (
      covered.some(
        (day) =>
          formatISODateInTimeZone(day, zone) !== formatISODateInTimeZone(job.scheduledAt, zone) &&
          (isUnavailableDate(day, input.settings) || !input.settings.workingWeekdays.includes(day.getDay())),
      )
    ) {
      conflicts.push({
        kind: "OUTSIDE_AVAILABILITY",
        severity: "WARNING",
        jobId: job.id,
        explanation: `${labelFor(job)} covers an unavailable or non-working day.`,
      });
    }
  }

  if (input.proposed) {
    const proposedPickup = input.proposed.pickupMinutes ?? 0;
    const others = active.filter((job) => job.id !== input.proposed!.jobId);
    const proposedWindow = occupiedWindow({
      scheduledAt: input.proposed.start,
      scheduledDurationMinutes: input.proposed.durationMinutes,
      pickupDurationMinutes: proposedPickup,
      policy: input.policy,
    });
    for (const other of others) {
      if (windowsOverlap(proposedWindow, windowForJob(other, input.policy))) {
        conflicts.push({
          kind: other.assignedMembershipId &&
            other.assignedMembershipId === input.proposed.assignedMembershipId
            ? "DOUBLE_BOOKING"
            : "OVERLAP",
          severity:
            other.assignedMembershipId &&
            other.assignedMembershipId === input.proposed.assignedMembershipId
              ? "ERROR"
              : "WARNING",
          jobId: input.proposed.jobId,
          otherJobId: other.id,
          membershipId: input.proposed.assignedMembershipId ?? undefined,
          explanation: `Proposed time overlaps ${labelFor(other)}. The later job was not moved.`,
        });
      }
    }
    if (input.proposed.assignedMembershipId) {
      const workerJobs = others.filter(
        (job) => job.assignedMembershipId === input.proposed!.assignedMembershipId,
      );
      const cascade = laterJobsHurtByMove({
        start: input.proposed.start,
        durationMinutes: input.proposed.durationMinutes,
        pickupMinutes: proposedPickup,
        settings: input.settings,
        policy: input.policy,
        existing: workerJobs,
        membershipId: input.proposed.assignedMembershipId,
      });
      if (cascade.length > 0) {
        conflicts.push({
          kind: "RESCHEDULE_CASCADE",
          severity: "WARNING",
          jobId: input.proposed.jobId,
          otherJobId: cascade[0]?.id,
          membershipId: input.proposed.assignedMembershipId,
          explanation: `Moving this job would press into ${cascade.length} later job${cascade.length === 1 ? "" : "s"} for the same worker. Later jobs were not moved.`,
        });
      }
    }
    const now = input.now ?? new Date();
    const cutoffAgainst = input.proposed.originalScheduledAt;
    if (
      cutoffAgainst &&
      dayBeforeCutoffPassed({
        scheduledAt: cutoffAgainst,
        now,
        cutoffHours: input.policy.dayBeforeChangeCutoffHours,
      })
    ) {
      conflicts.push({
        kind: "DAY_BEFORE_CUTOFF",
        severity: "INFO",
        jobId: input.proposed.jobId,
        explanation: `This change is inside the ${input.policy.dayBeforeChangeCutoffHours}-hour day-before cutoff for the current appointment. The owner still has to confirm it.`,
      });
    }
  }

  return dedupeConflicts(conflicts);
}

function dedupeConflicts(conflicts: ScheduleConflict[]): ScheduleConflict[] {
  const seen = new Set<string>();
  const unique: ScheduleConflict[] = [];
  for (const conflict of conflicts) {
    const key = [conflict.kind, conflict.jobId, conflict.otherJobId ?? "", conflict.explanation].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(conflict);
  }
  return unique;
}

export function highestSeverity(conflicts: ScheduleConflict[]): ConflictSeverity | null {
  if (conflicts.some((row) => row.severity === "ERROR")) return "ERROR";
  if (conflicts.some((row) => row.severity === "WARNING")) return "WARNING";
  if (conflicts.length > 0) return "INFO";
  return null;
}

export function describeConflicts(conflicts: ScheduleConflict[]): string | null {
  if (conflicts.length === 0) return null;
  return conflicts.map((row) => row.explanation).join(" ");
}
