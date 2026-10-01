/**
 * Native assigned-job milestone reads.
 *
 * After the assigned-job authorize read (`businessId` +
 * `assignedMembershipId`), this module lists OWNER-recorded
 * JobMilestone rows for that job only. Completion stays the existing
 * OWNER action. This module never writes milestones, Job.status,
 * invoices, checklists, or customer messages.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { formatDateTime } from "@/lib/format";
import {
  MAX_JOB_MILESTONES,
  resolveRecordedMilestoneStatus,
  type JobMilestoneStatus,
} from "@/lib/job-milestones";
import type { NativeFieldAccess } from "@/lib/native-session";

type Db = PrismaClient | Prisma.TransactionClient;

export const NATIVE_JOB_MILESTONE_LIMIT = MAX_JOB_MILESTONES;

export const NATIVE_JOB_MILESTONE_STATUS_LABELS: Record<JobMilestoneStatus, string> = {
  OPEN: "Open",
  COMPLETED: "Completed",
};

export const NATIVE_JOB_MILESTONE_OWNER_COMPLETE_MESSAGE =
  "Only the owner can mark milestones complete.";

export type NativeJobMilestone = {
  id: string;
  title: string;
  sortOrder: number;
  status: JobMilestoneStatus;
  statusLabel: string;
  recordedAt: string;
  recordedAtLabel: string;
  completedAt: string | null;
  completedAtLabel: string | null;
};

export type NativeJobMilestones = {
  items: NativeJobMilestone[];
  count: number;
  limit: number;
  truncated: boolean;
  truncatedNotice: string | null;
};

export function nativeJobMilestoneTruncatedNotice(
  limit = NATIVE_JOB_MILESTONE_LIMIT,
) {
  return `Showing the first ${limit} milestones. More are on this job; this list is capped.`;
}

export function emptyNativeJobMilestones(): NativeJobMilestones {
  return {
    items: [],
    count: 0,
    limit: NATIVE_JOB_MILESTONE_LIMIT,
    truncated: false,
    truncatedNotice: null,
  };
}

/** Same assignment clause as `nativeAssignedJobWhere()`. */
export function nativeAssignedJobMilestoneAuthorizeWhere(
  jobId: string,
  field: Pick<NativeFieldAccess, "businessId" | "membershipId">,
) {
  return {
    id: jobId,
    businessId: field.businessId,
    assignedMembershipId: field.membershipId,
  } as const;
}

/** Milestone rows are tenant-scoped to the already-authorized job. */
export function nativeAssignedJobMilestoneWhere(jobId: string, businessId: string) {
  return { jobId, businessId } as const;
}

export function toNativeJobMilestone(
  row: {
    id: string;
    title: string;
    sortOrder: number;
    status: string;
    createdAt: Date;
    completedAt: Date | null;
  },
  timeZone: string,
): NativeJobMilestone {
  const status = resolveRecordedMilestoneStatus(row);
  const completedAt = status === "COMPLETED" && row.completedAt ? row.completedAt : null;
  return {
    id: row.id,
    title: row.title,
    sortOrder: row.sortOrder,
    status,
    statusLabel: NATIVE_JOB_MILESTONE_STATUS_LABELS[status],
    recordedAt: row.createdAt.toISOString(),
    recordedAtLabel: formatDateTime(row.createdAt, timeZone),
    completedAt: completedAt ? completedAt.toISOString() : null,
    completedAtLabel: completedAt ? formatDateTime(completedAt, timeZone) : null,
  };
}

export function boundNativeJobMilestones<T>(
  rows: readonly T[],
  limit = NATIVE_JOB_MILESTONE_LIMIT,
): { items: T[]; truncated: boolean } {
  const truncated = rows.length > limit;
  return {
    items: truncated ? rows.slice(0, limit) : [...rows],
    truncated,
  };
}

export async function loadNativeAssignedJobMilestones(
  db: Db,
  access: Pick<NativeFieldAccess, "businessId" | "membershipId">,
  jobId: string,
  timeZone: string,
): Promise<NativeJobMilestones> {
  const assigned = await db.job.findFirst({
    where: nativeAssignedJobMilestoneAuthorizeWhere(jobId, access),
    select: { id: true },
  });
  if (!assigned) {
    return emptyNativeJobMilestones();
  }

  const where = nativeAssignedJobMilestoneWhere(assigned.id, access.businessId);
  const [count, rows] = await Promise.all([
    db.jobMilestone.count({ where }),
    db.jobMilestone.findMany({
      where,
      select: {
        id: true,
        title: true,
        sortOrder: true,
        status: true,
        createdAt: true,
        completedAt: true,
      },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      take: NATIVE_JOB_MILESTONE_LIMIT + 1,
    }),
  ]);
  const bound = boundNativeJobMilestones(rows);
  return {
    items: bound.items.map((row) => toNativeJobMilestone(row, timeZone)),
    count,
    limit: NATIVE_JOB_MILESTONE_LIMIT,
    truncated: bound.truncated,
    truncatedNotice: bound.truncated ? nativeJobMilestoneTruncatedNotice() : null,
  };
}
