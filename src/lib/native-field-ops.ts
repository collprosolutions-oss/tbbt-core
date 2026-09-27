/**
 * Native assigned-job mutations.
 *
 * Reads stay in `src/lib/native-field.ts`. Assigned-worker writes are
 * Start job and Complete job on the caller's own assigned Job.
 *
 * Authorization is the same compound clause as Field Home and native
 * reads (`nativeAssignedJobWhere`: businessId + assignedMembershipId).
 * After that authorize read, the write locks the Job and rechecks
 * businessId, assignedMembershipId, and status — the same assignment-
 * change protection Cleaning `recordAssignedVisitOutcome` uses — then
 * reuses the canonical start/complete time-safe writes. This is not a
 * second lifecycle and does not send invoices.
 */
import type { PrismaClient } from "@prisma/client";
import {
  CUSTOMER_HAS_NOT_CONFIRMED_APPOINTMENT,
  startJobRequiresCustomerConfirmation,
} from "@/lib/appointment-confirmation";
import { emitAndProcessBusinessEvent } from "@/lib/automation/events";
import { evaluateCompleteJob, evaluateStartJob } from "@/lib/job-lifecycle";
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
  startJobWithRunningTimeSafetyInTransaction,
  timeCardErrorMessage,
} from "@/lib/time-card-ops";

export const NATIVE_JOB_NOT_AVAILABLE = "That job is not available.";

const START_AUTHORIZE_SELECT = {
  id: true,
  businessId: true,
  customerId: true,
  status: true,
  scheduledAt: true,
  scheduledDurationMinutes: true,
  appointmentConfirmationStatus: true,
  appointmentProposalId: true,
  appointmentConfirmedForProposalId: true,
  appointmentConfirmationSource: true,
  appointmentChangeRequestNote: true,
  propertyAccessMethod: true,
  propertyAccessInstructions: true,
  propertyAccessContactName: true,
  propertyAccessContactInfo: true,
  propertyAccessPickupLocation: true,
  propertyAccessNote: true,
} as const;

export type NativeStartAssignedJobResult =
  | { ok: true; alreadyStarted: boolean; alreadyRunningTime: boolean; job: NativeJobDetail }
  | { ok: false; status: number; error: string };

export type NativeCompleteAssignedJobResult =
  | { ok: true; alreadyCompleted: boolean; job: NativeJobDetail }
  | { ok: false; status: number; error: string };

function assignmentStillHeld<T extends { businessId: string; assignedMembershipId: string | null }>(
  locked: T | null,
  access: NativeFieldAccess,
): locked is T & { assignedMembershipId: string } {
  return (
    locked != null &&
    locked.businessId === access.businessId &&
    locked.assignedMembershipId === access.membershipId
  );
}

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
      if (!assignmentStillHeld(locked, access)) {
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

export async function startNativeAssignedJob(
  db: PrismaClient,
  access: NativeFieldAccess,
  jobId: string,
  options?: {
    /** Proof hook: runs after the authorize read and before the Job lock. */
    afterInitialRead?: () => Promise<void>;
  },
): Promise<NativeStartAssignedJobResult> {
  const assigned = await db.job.findFirst({
    where: nativeAssignedJobWhere(jobId, access),
    select: START_AUTHORIZE_SELECT,
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

  let started: Extract<
    Awaited<ReturnType<typeof startJobWithRunningTimeSafetyInTransaction>>,
    { ok: true }
  >;
  try {
    const written = await db.$transaction(async (tx) => {
      const locked = await lockTenantOwnedJob(tx, access.businessId, assigned.id);
      if (!assignmentStillHeld(locked, access)) {
        return { ok: false as const, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
      }

      const current = await tx.job.findFirst({
        where: { id: locked.id, businessId: locked.businessId },
        select: START_AUTHORIZE_SELECT,
      });
      if (!current) {
        return { ok: false as const, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
      }

      const lifecycle = evaluateStartJob(current.status);
      if (!lifecycle.ok) {
        return { ok: false as const, status: 409, error: lifecycle.error };
      }
      if (lifecycle.nextStatus && startJobRequiresCustomerConfirmation(current)) {
        return { ok: false as const, status: 409, error: CUSTOMER_HAS_NOT_CONFIRMED_APPOINTMENT };
      }

      const result = await startJobWithRunningTimeSafetyInTransaction(tx, {
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
    started = written.result;
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

  if (!started.alreadyStarted) {
    await emitAndProcessBusinessEvent(db, {
      businessId: assigned.businessId,
      type: "JOB_STARTED",
      subjectType: "JOB",
      subjectId: assigned.id,
      payload: { customerId: started.customerId ?? assigned.customerId },
      idempotencyKey: `JOB_STARTED:${assigned.id}`,
    });
  }

  const job = await loadNativeAssignedJob(db, access, assigned.id);
  if (!job) {
    return { ok: false, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
  }
  return {
    ok: true,
    alreadyStarted: started.alreadyStarted,
    alreadyRunningTime: started.alreadyRunningTime,
    job,
  };
}
