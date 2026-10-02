/**
 * Canonical Membership.active write for OWNER/ADMIN deactivate and
 * reactivate. This is not a new workflow — setTeamMemberActive stays
 * the only owner action.
 *
 * Lock order matches assignment (#251): tenant schedule-reservation
 * advisory lock, then tenant-owned Job rows in id order, then
 * Membership rows in id order. Deactivation closes RUNNING time after
 * those locks so a concurrent OWNER reassignment cannot 40P01 and
 * cannot leave RUNNING time for an inactive worker, a non-assignee, or
 * a completed job.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { lockTenantOwnedMemberships } from "@/lib/exact-active-membership";
import { lockBusinessScheduleReservation } from "@/lib/schedule-reservation";
import {
  MEMBERSHIP_DEACTIVATED_TIME_CLOSED_REASON,
  TimeCardError,
  closeRunningTimeForMembershipInTransaction,
  isTimeCardError,
  lockJobsForMembershipClockClose,
  timeCardErrorMessage,
} from "@/lib/time-card-ops";

type ActiveDb = PrismaClient;
type ActiveTx = Prisma.TransactionClient;

export type TeamMemberActiveWriteResult = { error?: string };

export const teamMemberActiveTestHooks: {
  beforeLock?: (input: { membershipId: string }) => Promise<void> | void;
  afterJobsBeforeMembership?: (input: {
    membershipId: string;
    jobIds: string[];
  }) => Promise<void> | void;
} = {};

export async function writeTeamMemberActive(
  db: ActiveDb,
  input: {
    businessId: string;
    membershipId: string;
    actorMembershipId: string;
    active: boolean;
    afterJobsBeforeMembership?: (
      tx: ActiveTx,
      jobIds: string[],
    ) => Promise<void> | void;
  },
): Promise<TeamMemberActiveWriteResult | void> {
  try {
    await db.$transaction(
      async (tx) => {
        await teamMemberActiveTestHooks.beforeLock?.({
          membershipId: input.membershipId,
        });
        await lockBusinessScheduleReservation(tx, input.businessId);
        const jobIds = await lockJobsForMembershipClockClose(
          tx,
          input.businessId,
          input.membershipId,
        );
        await teamMemberActiveTestHooks.afterJobsBeforeMembership?.({
          membershipId: input.membershipId,
          jobIds,
        });
        await input.afterJobsBeforeMembership?.(tx, jobIds);
        const locked = await lockTenantOwnedMemberships(tx, input.businessId, [
          input.actorMembershipId,
          input.membershipId,
        ]);
        const target = locked.find((row) => row.id === input.membershipId);
        if (!target || target.role !== "MEMBER") {
          throw new TimeCardError("That team member could not be found.");
        }
        if (!input.active) {
          await closeRunningTimeForMembershipInTransaction(tx, {
            businessId: input.businessId,
            membershipId: input.membershipId,
            actorMembershipId: input.actorMembershipId,
            reason: MEMBERSHIP_DEACTIVATED_TIME_CLOSED_REASON,
          });
        }
        await tx.membership.update({
          where: { id: input.membershipId },
          data: { active: input.active },
        });
      },
      { maxWait: 10_000, timeout: 20_000 },
    );
  } catch (error) {
    if (isTimeCardError(error) || error instanceof TimeCardError) {
      return {
        error: timeCardErrorMessage(
          error,
          "That team member could not be updated while approved time is still running.",
        ),
      };
    }
    throw error;
  }
}
