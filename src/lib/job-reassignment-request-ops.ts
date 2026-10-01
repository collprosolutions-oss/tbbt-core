/**
 * Worker-requested reassignment of one currently assigned upcoming job.
 *
 * MEMBER may request only for a job currently assigned to themselves.
 * OWNER accepts or declines from a bounded queue. Request create never
 * writes Job.assignedMembershipId or scheduledAt. Only ACCEPT unassigns
 * through writeAssignedMembershipAndLaneWindows, which takes the
 * schedule-reservation lock then the Job FOR UPDATE lock and runs the
 * conflict checks before the assignment write. Decline does not change
 * the job. These paths never send a customer message.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, ForbiddenError, requireBusinessCapability, requireBusinessRole } from "@/lib/authorization";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import { writeAssignedMembershipAndLaneWindows } from "@/lib/job-assignment-ops";
import {
  JOB_REASSIGNMENT_REQUEST_ALREADY_REASSIGNED_MESSAGE,
  JOB_REASSIGNMENT_REQUEST_CANCELLED_MESSAGE,
  JOB_REASSIGNMENT_REQUEST_COMPLETED_MESSAGE,
  JOB_REASSIGNMENT_REQUEST_DECIDE_CONFLICT_MESSAGE,
  JOB_REASSIGNMENT_REQUEST_INACTIVE_MESSAGE,
  JOB_REASSIGNMENT_REQUEST_NOT_UPCOMING_MESSAGE,
  JOB_REASSIGNMENT_REQUEST_PENDING_EXISTS_MESSAGE,
  JOB_REASSIGNMENT_REQUEST_PENDING_LIST_LIMIT,
  JOB_REASSIGNMENT_REQUEST_RECENT_LIST_LIMIT,
  JOB_REASSIGNMENT_REQUEST_SELF_LIST_LIMIT,
  JOB_REASSIGNMENT_REQUEST_STALE_MESSAGE,
  JobReassignmentRequestError,
  isRequestableUpcomingAssignedJob,
  jobReassignmentRefusalMessage,
  requireJobReassignmentRequestDecision,
  requireJobReassignmentRequestReason,
  type JobReassignmentRequestDecision,
  type JobReassignmentRequestRecord,
} from "@/lib/job-reassignment-request";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { requireProductCapability } from "@/lib/product-entitlements";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Test-only barriers. Production never sets these.
 * - beforeRequestCreate: both creates have passed the pending lookup
 *   before either inserts.
 * - beforeAcceptAssignment: accept has validated the request and is
 *   about to take the canonical assignment locks.
 * - beforeDecideClaims: both decide transactions have read PENDING
 *   before either writes.
 */
export const jobReassignmentRequestTestHooks: {
  beforeRequestCreate?: (input: { membershipId: string; jobId: string }) => Promise<void> | void;
  beforeAcceptAssignment?: (input: { requestId: string; jobId: string }) => Promise<void> | void;
  beforeDecideClaims?: (input: {
    requestId: string;
    decision: JobReassignmentRequestDecision;
  }) => Promise<void> | void;
} = {};

function isPendingJobConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  const target = error.meta?.target;
  if (Array.isArray(target)) {
    return target.includes("jobId");
  }
  if (typeof target === "string") {
    return target.includes("jobId");
  }
  return error.meta?.modelName === "JobReassignmentRequest";
}

function asRequestWriteError(error: unknown): never {
  if (error instanceof JobReassignmentRequestError) throw error;
  if (error instanceof ForbiddenError) throw error;
  if (isPendingJobConflict(error)) {
    throw new JobReassignmentRequestError(JOB_REASSIGNMENT_REQUEST_PENDING_EXISTS_MESSAGE);
  }
  throw error;
}

function asDecideWriteError(error: unknown): never {
  if (error instanceof JobReassignmentRequestError) throw error;
  if (error instanceof ForbiddenError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    throw new JobReassignmentRequestError(JOB_REASSIGNMENT_REQUEST_DECIDE_CONFLICT_MESSAGE);
  }
  throw error;
}

const REQUEST_SELECT = {
  id: true,
  businessId: true,
  jobId: true,
  membershipId: true,
  reason: true,
  status: true,
  requestedAt: true,
  decidedAt: true,
  decidedByMembershipId: true,
  updatedAt: true,
  membership: { select: { user: { select: { name: true } } } },
  job: {
    select: {
      scheduledAt: true,
      customer: { select: { name: true } },
      property: { select: { addressLine1: true } },
    },
  },
} as const;

function toRequestRecord(row: {
  id: string;
  businessId: string;
  jobId: string;
  membershipId: string;
  reason: string;
  status: string;
  requestedAt: Date;
  decidedAt: Date | null;
  decidedByMembershipId: string | null;
  updatedAt: Date;
  membership?: { user?: { name?: string | null } | null } | null;
  job?: {
    scheduledAt: Date | null;
    customer?: { name?: string | null } | null;
    property?: { addressLine1?: string | null } | null;
  } | null;
}): JobReassignmentRequestRecord {
  return {
    id: row.id,
    businessId: row.businessId,
    jobId: row.jobId,
    membershipId: row.membershipId,
    workerName: row.membership?.user?.name ?? "Worker",
    jobLabel: row.job?.customer?.name ?? row.job?.property?.addressLine1 ?? "Assigned job",
    scheduledAt: row.job?.scheduledAt ?? null,
    reason: row.reason,
    status:
      row.status === "ACCEPTED" ? "ACCEPTED" : row.status === "DECLINED" ? "DECLINED" : "PENDING",
    requestedAt: row.requestedAt,
    decidedAt: row.decidedAt,
    decidedByMembershipId: row.decidedByMembershipId,
    updatedAt: row.updatedAt,
  };
}

export function jobReassignmentRequestErrorMessage(error: unknown, fallback: string) {
  if (error instanceof JobReassignmentRequestError) return error.message;
  if (error instanceof ForbiddenError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  return fallback;
}

export async function loadSelfJobReassignmentRequests(
  db: Db,
  input: { businessId: string; membershipId: string },
): Promise<JobReassignmentRequestRecord[]> {
  await requireProductCapability(db, input.businessId, PRODUCT_CAPABILITIES.JOBS_TASKS);
  const rows = await db.jobReassignmentRequest.findMany({
    where: {
      businessId: input.businessId,
      membershipId: input.membershipId,
    },
    select: REQUEST_SELECT,
    orderBy: [{ requestedAt: "desc" }],
    take: JOB_REASSIGNMENT_REQUEST_SELF_LIST_LIMIT,
  });
  return rows.map((row) => toRequestRecord(row));
}

export async function loadOwnedJobReassignmentRequests(
  db: Db,
  access: BusinessAccess,
): Promise<{
  pending: JobReassignmentRequestRecord[];
  recent: JobReassignmentRequestRecord[];
  canDecide: boolean;
  timeZone: string;
}> {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_JOBS);
  await requireProductCapability(db, access.businessId, PRODUCT_CAPABILITIES.JOBS_TASKS);
  const business = await db.business.findUnique({
    where: { id: access.businessId },
    select: { timezone: true },
  });
  const [pendingRows, recentRows] = await Promise.all([
    db.jobReassignmentRequest.findMany({
      where: { businessId: access.businessId, status: "PENDING" },
      select: REQUEST_SELECT,
      orderBy: [{ requestedAt: "asc" }],
      take: JOB_REASSIGNMENT_REQUEST_PENDING_LIST_LIMIT,
    }),
    db.jobReassignmentRequest.findMany({
      where: { businessId: access.businessId, status: { in: ["ACCEPTED", "DECLINED"] } },
      select: REQUEST_SELECT,
      orderBy: [{ decidedAt: "desc" }, { requestedAt: "desc" }],
      take: JOB_REASSIGNMENT_REQUEST_RECENT_LIST_LIMIT,
    }),
  ]);
  return {
    pending: pendingRows.map((row) => toRequestRecord(row)),
    recent: recentRows.map((row) => toRequestRecord(row)),
    canDecide: access.workspace.role === "OWNER",
    timeZone: resolveBusinessTimeZone(business),
  };
}

export async function requestJobReassignmentOp(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    jobId: string;
    reason: string;
    now?: Date;
  },
) {
  if (access.workspace.role !== "MEMBER") {
    throw new ForbiddenError();
  }
  await requireProductCapability(db, access.businessId, PRODUCT_CAPABILITIES.JOBS_TASKS);

  const membership = await db.membership.findFirst({
    where: {
      id: access.workspace.membership.id,
      businessId: access.businessId,
      role: "MEMBER",
    },
    select: { id: true, businessId: true, active: true, role: true },
  });
  if (!membership) throw new ForbiddenError();
  access.assertOwned(membership);
  if (!membership.active) {
    throw new JobReassignmentRequestError(JOB_REASSIGNMENT_REQUEST_INACTIVE_MESSAGE);
  }

  const job = await db.job.findFirst({
    where: {
      id: input.jobId,
      businessId: access.businessId,
    },
    select: {
      id: true,
      businessId: true,
      assignedMembershipId: true,
      status: true,
      scheduledAt: true,
    },
  });
  if (!job) throw new ForbiddenError();
  access.assertOwned(job);
  if (job.assignedMembershipId !== membership.id) {
    throw new JobReassignmentRequestError(JOB_REASSIGNMENT_REQUEST_ALREADY_REASSIGNED_MESSAGE);
  }
  if (job.status === "COMPLETED") {
    throw new JobReassignmentRequestError(JOB_REASSIGNMENT_REQUEST_COMPLETED_MESSAGE);
  }
  if (job.status === "CANCELLED") {
    throw new JobReassignmentRequestError(JOB_REASSIGNMENT_REQUEST_CANCELLED_MESSAGE);
  }

  const business = await db.business.findUnique({
    where: { id: access.businessId },
    select: { timezone: true },
  });
  const timeZone = resolveBusinessTimeZone(business);
  const now = input.now ?? new Date();
  if (!isRequestableUpcomingAssignedJob(job, now, timeZone)) {
    throw new JobReassignmentRequestError(JOB_REASSIGNMENT_REQUEST_NOT_UPCOMING_MESSAGE);
  }

  const reason = requireJobReassignmentRequestReason(input.reason);

  const pending = await db.jobReassignmentRequest.findFirst({
    where: {
      businessId: access.businessId,
      jobId: job.id,
      status: "PENDING",
    },
    select: { id: true },
  });
  if (pending) {
    throw new JobReassignmentRequestError(JOB_REASSIGNMENT_REQUEST_PENDING_EXISTS_MESSAGE);
  }

  try {
    await jobReassignmentRequestTestHooks.beforeRequestCreate?.({
      membershipId: membership.id,
      jobId: job.id,
    });
    const created = await db.jobReassignmentRequest.create({
      data: {
        businessId: access.businessId,
        jobId: job.id,
        membershipId: membership.id,
        reason,
        status: "PENDING",
      },
      select: REQUEST_SELECT,
    });
    return toRequestRecord(created);
  } catch (error) {
    asRequestWriteError(error);
  }
}

export async function decideJobReassignmentRequestOp(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    requestId: string;
    decision: JobReassignmentRequestDecision | string;
    expectedUpdatedAt: Date;
    now?: Date;
  },
) {
  requireBusinessRole(access, "OWNER");
  requireBusinessCapability(access, CAPABILITIES.MANAGE_JOBS);
  await requireProductCapability(db, access.businessId, PRODUCT_CAPABILITIES.JOBS_TASKS);

  const decision = requireJobReassignmentRequestDecision(input.decision);
  if (Number.isNaN(input.expectedUpdatedAt.getTime())) {
    throw new JobReassignmentRequestError(JOB_REASSIGNMENT_REQUEST_STALE_MESSAGE);
  }

  const request = await db.jobReassignmentRequest.findFirst({
    where: { id: input.requestId, businessId: access.businessId },
    select: {
      id: true,
      businessId: true,
      jobId: true,
      membershipId: true,
      reason: true,
      status: true,
      updatedAt: true,
      job: {
        select: {
          id: true,
          businessId: true,
          scheduledAt: true,
          assignedMembershipId: true,
          status: true,
        },
      },
    },
  });
  if (!request) throw new ForbiddenError();
  access.assertOwned(request);
  if (request.status !== "PENDING") {
    throw new JobReassignmentRequestError(JOB_REASSIGNMENT_REQUEST_STALE_MESSAGE);
  }
  if (request.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
    throw new JobReassignmentRequestError(JOB_REASSIGNMENT_REQUEST_STALE_MESSAGE);
  }
  if (!request.job || request.job.businessId !== access.businessId) {
    throw new ForbiddenError();
  }

  if (decision === "DECLINE") {
    try {
      return await db.$transaction(async (tx) => {
        await jobReassignmentRequestTestHooks.beforeDecideClaims?.({
          requestId: request.id,
          decision,
        });
        const claimed = await tx.jobReassignmentRequest.updateMany({
          where: {
            id: request.id,
            businessId: access.businessId,
            status: "PENDING",
            updatedAt: input.expectedUpdatedAt,
          },
          data: {
            status: "DECLINED",
            decidedAt: new Date(),
            decidedByMembershipId: access.workspace.membership.id,
          },
        });
        if (claimed.count !== 1) {
          throw new JobReassignmentRequestError(JOB_REASSIGNMENT_REQUEST_STALE_MESSAGE);
        }
        const updated = await tx.jobReassignmentRequest.findFirst({
          where: { id: request.id, businessId: access.businessId },
          select: REQUEST_SELECT,
        });
        if (!updated) throw new ForbiddenError();
        return { decision, request: toRequestRecord(updated) };
      }, { timeout: 15000, maxWait: 10000 });
    } catch (error) {
      if (error instanceof ForbiddenError || error instanceof JobReassignmentRequestError) {
        throw error;
      }
      asDecideWriteError(error);
    }
  }

  await jobReassignmentRequestTestHooks.beforeAcceptAssignment?.({
    requestId: request.id,
    jobId: request.jobId,
  });

  try {
    const assigned = await writeAssignedMembershipAndLaneWindows(db, {
      businessId: access.businessId,
      job: request.job,
      nextAssignedMembershipId: null,
      actorMembershipId: access.workspace.membership.id,
      afterJobLocked: async (tx, lockedJob) => {
        if (lockedJob.businessId !== access.businessId) {
          throw new ForbiddenError();
        }
        const refusal = jobReassignmentRefusalMessage(
          lockedJob.status,
          lockedJob.assignedMembershipId,
          request.membershipId,
        );
        if (refusal) {
          throw new JobReassignmentRequestError(refusal);
        }
        await jobReassignmentRequestTestHooks.beforeDecideClaims?.({
          requestId: request.id,
          decision,
        });
        const claimed = await tx.jobReassignmentRequest.updateMany({
          where: {
            id: request.id,
            businessId: access.businessId,
            jobId: request.jobId,
            membershipId: request.membershipId,
            status: "PENDING",
            updatedAt: input.expectedUpdatedAt,
          },
          data: {
            status: "ACCEPTED",
            decidedAt: new Date(),
            decidedByMembershipId: access.workspace.membership.id,
          },
        });
        if (claimed.count !== 1) {
          throw new JobReassignmentRequestError(JOB_REASSIGNMENT_REQUEST_STALE_MESSAGE);
        }
      },
    });
    if (assigned?.error) {
      throw new JobReassignmentRequestError(assigned.error);
    }
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof JobReassignmentRequestError) {
      throw error;
    }
    asDecideWriteError(error);
  }

  const updated = await db.jobReassignmentRequest.findFirst({
    where: { id: request.id, businessId: access.businessId },
    select: REQUEST_SELECT,
  });
  if (!updated) throw new ForbiddenError();
  return { decision, request: toRequestRecord(updated) };
}
