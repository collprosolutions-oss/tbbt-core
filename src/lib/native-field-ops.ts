/**
 * Native assigned-job mutations.
 *
 * Reads stay in `src/lib/native-field.ts`. This module is the one
 * assigned-worker write: complete the caller's own assigned Job.
 *
 * Authorization is the same compound clause as Field Home and native
 * reads (`nativeAssignedJobWhere`: businessId + assignedMembershipId).
 * After that authorize read, the write locks the Job and rechecks
 * businessId, assignedMembershipId, and status — the same assignment-
 * change protection Cleaning `recordAssignedVisitOutcome` uses — then
 * reuses `completeJobWithRunningTimeSafetyInTransaction`. This is not
 * a second lifecycle and does not send invoices.
 */
import type { PrismaClient } from "@prisma/client";
import { emitAndProcessBusinessEvent } from "@/lib/automation/events";
import { evaluateCompleteJob } from "@/lib/job-lifecycle";
import {
  loadNativeAssignedJob,
  nativeAssignedJobWhere,
  type NativeJobDetail,
} from "@/lib/native-field";
import type { NativeFieldAccess } from "@/lib/native-session";
import {
  requireSaasOperatingEntitlement,
  saasOperatingErrorMessage,
  SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE,
} from "@/lib/saas-billing/entitlement";
import {
  completeJobWithRunningTimeSafetyInTransaction,
  isTimeCardError,
  lockTenantOwnedJob,
  timeCardErrorMessage,
} from "@/lib/time-card-ops";

export const NATIVE_JOB_NOT_AVAILABLE = "That job is not available.";

export type NativeCompleteAssignedJobResult =
  | { ok: true; alreadyCompleted: boolean; job: NativeJobDetail }
  | { ok: false; status: number; error: string };

export async function completeNativeAssignedJob(
  db: PrismaClient,
  access: NativeFieldAccess,
  jobId: string,
  options?: {
    /** Proof hook: runs after the authorize read and before the Job lock. */
    afterInitialRead?: () => Promise<void>;
  },
): Promise<NativeCompleteAssignedJobResult> {
  const assigned = await db.job.findFirst({
    where: nativeAssignedJobWhere(jobId, access),
    select: { id: true, businessId: true, customerId: true, status: true },
  });
  if (!assigned) {
    return { ok: false, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
  }

  try {
    await requireSaasOperatingEntitlement(db, {
      businessId: access.businessId,
      workspace: { role: access.workspace.role },
    });
  } catch (error) {
    return {
      ok: false,
      status: 403,
      error: saasOperatingErrorMessage(error) ?? SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE,
    };
  }

  if (options?.afterInitialRead) {
    await options.afterInitialRead();
  }

  let completed: Extract<
    Awaited<ReturnType<typeof completeJobWithRunningTimeSafetyInTransaction>>,
    { ok: true }
  >;
  try {
    const written = await db.$transaction(async (tx) => {
      const locked = await lockTenantOwnedJob(tx, access.businessId, assigned.id);
      if (
        !locked ||
        locked.businessId !== access.businessId ||
        locked.assignedMembershipId !== access.membershipId
      ) {
        return { ok: false as const, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
      }

      const lifecycle = evaluateCompleteJob(locked.status);
      if (!lifecycle.ok) {
        return { ok: false as const, status: 409, error: lifecycle.error };
      }

      const result = await completeJobWithRunningTimeSafetyInTransaction(tx, {
        businessId: locked.businessId,
        jobId: locked.id,
        actorMembershipId: access.membershipId,
      });
      if (!result.ok) {
        return { ok: false as const, status: 409, error: result.error };
      }
      return { ok: true as const, result };
    });

    if (!written.ok) {
      return written;
    }
    completed = written.result;
  } catch (error) {
    if (isTimeCardError(error)) {
      return {
        ok: false,
        status: 409,
        error: timeCardErrorMessage(error, NATIVE_JOB_NOT_AVAILABLE),
      };
    }
    throw error;
  }

  if (!completed.alreadyCompleted) {
    await emitAndProcessBusinessEvent(db, {
      businessId: assigned.businessId,
      type: "JOB_COMPLETED",
      subjectType: "JOB",
      subjectId: assigned.id,
      payload: { customerId: completed.customerId ?? assigned.customerId },
      idempotencyKey: `JOB_COMPLETED:${assigned.id}`,
    });
  }

  const job = await loadNativeAssignedJob(db, access, assigned.id);
  if (!job) {
    return { ok: false, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
  }
  return { ok: true, alreadyCompleted: completed.alreadyCompleted, job };
}
