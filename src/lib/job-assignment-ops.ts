/**
 * Canonical Job assignment write.
 *
 * Lock order matches deactivation (#251): tenant schedule-reservation
 * advisory lock, then the tenant-owned Job row FOR UPDATE, then
 * Membership rows in id order. Conflict checks run after those locks
 * and before assignedMembershipId changes. Reassignment closes the
 * previous worker's RUNNING JOB time, then persistLaneArrivalWindows
 * re-reads under the same reservation. This path never sends a customer
 * message and never changes scheduledAt. After commit, an opted-in
 * native worker may receive an informational assignment alert.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { lockTenantOwnedMemberships } from "@/lib/exact-active-membership";
import { jobAssignmentRefusalMessage } from "@/lib/job-lifecycle";
import { lockBusinessScheduleReservation } from "@/lib/schedule-reservation";
import {
  JOB_REASSIGNMENT_TIME_CLOSED_REASON,
  TimeCardError,
  isTimeCardError,
  lockTenantOwnedJob,
  stopRunningAssignedJobTimeInTransaction,
  timeCardErrorMessage,
} from "@/lib/time-card-ops";
import { notifyHandymanJobAssigned } from "@/lib/native-push/notify";
import {
  loadSchedulingPolicy,
  loadWorkforceTimeZone,
  persistLaneArrivalWindows,
} from "@/lib/workforce-data";

type AssignmentDb = PrismaClient;
type AssignmentTx = Prisma.TransactionClient;

export type AssignedJobSnapshot = {
  id: string;
  scheduledAt: Date | null;
  assignedMembershipId: string | null;
  status: string;
};

export type AssignmentWriteResult = { error?: string };

export const jobAssignmentTestHooks: {
  beforeAssignmentLock?: (input: { jobId: string }) => Promise<void> | void;
} = {};

export type LockedAssignedJob = {
  id: string;
  businessId: string;
  assignedMembershipId: string | null;
  status: string;
  customerId: string | null;
};

/**
 * Apply an assignment change after the caller has taken the schedule
 * reservation lock and the Job FOR UPDATE lock. Used by assignJobMember
 * and by OWNER accept of a worker reassignment request.
 */
export async function applyAssignedMembershipChangeInTransaction(
  tx: AssignmentTx,
  input: {
    businessId: string;
    job: AssignedJobSnapshot;
    lockedJob: LockedAssignedJob;
    nextAssignedMembershipId: string | null;
    actorMembershipId: string;
  },
) {
  const previousAssignee = input.lockedJob.assignedMembershipId;
  const nextAssignee = input.nextAssignedMembershipId;
  // Previous assignee first so unsorted lock order inverts against
  // deactivate's [actor, worker] and id sorting stays load-bearing.
  await lockTenantOwnedMemberships(tx, input.businessId, [
    previousAssignee,
    nextAssignee,
    input.actorMembershipId,
  ]);
  await tx.job.update({
    where: { id: input.job.id },
    data: { assignedMembershipId: nextAssignee },
  });
  if (previousAssignee !== nextAssignee) {
    const schemaRows = await tx.$queryRaw<Array<{ present: boolean | string | null }>>`
      SELECT to_regclass('"JobReassignmentRequest"') IS NOT NULL AS present
    `;
    const present = schemaRows[0]?.present;
    if (present === true || present === "t") {
      await tx.jobReassignmentRequest.updateMany({
        where: {
          businessId: input.businessId,
          jobId: input.job.id,
          status: "PENDING",
          ...(nextAssignee ? { membershipId: { not: nextAssignee } } : {}),
        },
        data: {
          status: "DECLINED",
          decidedAt: new Date(),
        },
      });
    }
  }
  if (previousAssignee && previousAssignee !== nextAssignee) {
    const stopped = await stopRunningAssignedJobTimeInTransaction(tx, {
      businessId: input.businessId,
      jobId: input.job.id,
      actorMembershipId: input.actorMembershipId,
      membershipId: previousAssignee,
      reason: JOB_REASSIGNMENT_TIME_CLOSED_REASON,
    });
    if (!stopped.ok) {
      throw new TimeCardError(stopped.error);
    }
  }
  await syncAssignedJobArrivalWindows(tx, input.businessId, input.job);
}

export async function writeAssignedMembershipAndLaneWindows(
  db: AssignmentDb,
  input: {
    businessId: string;
    job: AssignedJobSnapshot;
    nextAssignedMembershipId: string | null;
    actorMembershipId: string;
    afterJobLocked?: (
      tx: AssignmentTx,
      lockedJob: LockedAssignedJob,
    ) => Promise<void> | void;
  },
): Promise<AssignmentWriteResult | void> {
  const committed: {
    previousMembershipId: string | null;
    nextMembershipId: string | null;
    wrote: boolean;
  } = {
    previousMembershipId: null,
    nextMembershipId: null,
    wrote: false,
  };
  try {
    await db.$transaction(
      async (tx) => {
        await jobAssignmentTestHooks.beforeAssignmentLock?.({ jobId: input.job.id });
        await lockBusinessScheduleReservation(tx, input.businessId);
        const lockedJob = await lockTenantOwnedJob(tx, input.businessId, input.job.id);
        if (!lockedJob) {
          throw new TimeCardError("That job could not be found.");
        }
        await input.afterJobLocked?.(tx, lockedJob);
        const assignmentRefusal = jobAssignmentRefusalMessage(lockedJob.status);
        if (assignmentRefusal) {
          throw new TimeCardError(assignmentRefusal);
        }
        await applyAssignedMembershipChangeInTransaction(tx, {
          businessId: input.businessId,
          job: input.job,
          lockedJob,
          nextAssignedMembershipId: input.nextAssignedMembershipId,
          actorMembershipId: input.actorMembershipId,
        });
        committed.previousMembershipId = lockedJob.assignedMembershipId;
        committed.nextMembershipId = input.nextAssignedMembershipId;
        committed.wrote = true;
      },
      { maxWait: 10_000, timeout: 20_000 },
    );
  } catch (error) {
    if (isTimeCardError(error)) {
      return {
        error: timeCardErrorMessage(error, "That assignment could not be changed."),
      };
    }
    throw error;
  }
  if (
    committed.wrote &&
    committed.nextMembershipId &&
    committed.previousMembershipId !== committed.nextMembershipId
  ) {
    await notifyHandymanJobAssigned(db, {
      businessId: input.businessId,
      jobId: input.job.id,
      previousMembershipId: committed.previousMembershipId,
      nextMembershipId: committed.nextMembershipId,
      actorMembershipId: input.actorMembershipId,
    }).catch(() => undefined);
  }
}

export async function syncAssignedJobArrivalWindows(
  db: Parameters<typeof persistLaneArrivalWindows>[0],
  businessId: string,
  previous: {
    id: string;
    scheduledAt: Date | null;
    assignedMembershipId: string | null;
  },
) {
  if (!previous.scheduledAt) {
    return;
  }
  const [policy, timeZone] = await Promise.all([
    loadSchedulingPolicy(db, businessId),
    loadWorkforceTimeZone(db, businessId),
  ]);
  await persistLaneArrivalWindows(db, {
    businessId,
    timeZone,
    policy,
    touchedJobIds: [previous.id],
    previousLanes: [
      {
        assignedMembershipId: previous.assignedMembershipId,
        scheduledAt: previous.scheduledAt,
      },
    ],
  });
}
