/**
 * Field Home ("MY JOBS") grouping.
 *
 * Reuses the exact same Job.status / scheduledAt fields the business-wide
 * Schedule / Jobs calendar already reads (see src/lib/schedule.ts) -- no
 * second scheduling data source. This module only groups an
 * already-assignment-scoped list of Jobs into the three buckets a mobile
 * field worker needs: TODAY, UPCOMING, COMPLETED / RECENT.
 */
import { addDays, startOfDay } from "@/lib/schedule";

export const FIELD_JOB_SELECT = {
  id: true,
  status: true,
  scheduledAt: true,
  scheduledDurationMinutes: true,
  customer: { select: { name: true } },
  property: {
    select: {
      addressLine1: true,
      addressLine2: true,
      city: true,
      region: true,
      postalCode: true,
    },
  },
} as const;

export type FieldJob = {
  id: string;
  status: string;
  scheduledAt: Date | null;
  scheduledDurationMinutes: number | null;
  customer: { name: string } | null;
  property: {
    addressLine1: string;
    addressLine2: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
  } | null;
};

export type FieldJobGroups<T extends FieldJob = FieldJob> = {
  today: T[];
  upcoming: T[];
  completed: T[];
};

function byScheduledAtAsc(a: FieldJob, b: FieldJob) {
  const aTime = a.scheduledAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bTime = b.scheduledAt?.getTime() ?? Number.POSITIVE_INFINITY;
  return aTime - bTime;
}

function byScheduledAtDesc(a: FieldJob, b: FieldJob) {
  const aTime = a.scheduledAt?.getTime() ?? 0;
  const bTime = b.scheduledAt?.getTime() ?? 0;
  return bTime - aTime;
}

/**
 * TODAY: anything actively in progress, scheduled for today, or overdue
 * (scheduled in the past and never started/completed -- still needs
 * attention today, not silently hidden).
 * UPCOMING: not completed, scheduled for a later day, or not yet
 * scheduled at all (assigned but UNSCHEDULED).
 * COMPLETED / RECENT: status COMPLETED, most-recently-scheduled first.
 */
export function groupFieldJobs<T extends FieldJob>(
  jobs: T[],
  today: Date,
): FieldJobGroups<T> {
  const start = startOfDay(today);
  const end = addDays(start, 1);

  const groups: FieldJobGroups<T> = { today: [], upcoming: [], completed: [] };

  for (const job of jobs) {
    if (job.status === "COMPLETED") {
      groups.completed.push(job);
      continue;
    }
    if (job.status === "IN_PROGRESS") {
      groups.today.push(job);
      continue;
    }
    if (job.scheduledAt && job.scheduledAt < end) {
      // Scheduled for today, or overdue -- either way it needs attention today.
      groups.today.push(job);
      continue;
    }
    groups.upcoming.push(job);
  }

  groups.today.sort(byScheduledAtAsc);
  groups.upcoming.sort(byScheduledAtAsc);
  groups.completed.sort(byScheduledAtDesc);

  return groups;
}
