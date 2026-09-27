/**
 * Native assigned-job mutations.
 *
 * Reads stay in `src/lib/native-field.ts`. This module is the one
 * assigned-worker write: complete the caller's own assigned Job.
 *
 * Authorization is the same compound clause as Field Home and native
 * reads (`nativeAssignedJobWhere`: businessId + assignedMembershipId).
 * The status and running-time write is the existing canonical helper
 * used by Field `completeAssignedJob` and Cleaning
 * `recordAssignedVisitOutcome` (`completeJobWithRunningTimeSafety`).
 * This is not a second lifecycle and does not send invoices.
 */
import type { PrismaClient } from "@prisma/client";
import { emitAndProcessBusinessEvent } from "@/lib/automation/events";
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
import { completeJobWithRunningTimeSafety } from "@/lib/time-card-ops";

export const NATIVE_JOB_NOT_AVAILABLE = "That job is not available.";

export type NativeCompleteAssignedJobResult =
  | { ok: true; alreadyCompleted: boolean; job: NativeJobDetail }
  | { ok: false; status: number; error: string };

export async function completeNativeAssignedJob(
  db: PrismaClient,
  access: NativeFieldAccess,
  jobId: string,
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

  const result = await completeJobWithRunningTimeSafety(db, {
    businessId: assigned.businessId,
    jobId: assigned.id,
    actorMembershipId: access.membershipId,
  });
  if (!result.ok) {
    return { ok: false, status: 409, error: result.error };
  }

  if (!result.alreadyCompleted) {
    await emitAndProcessBusinessEvent(db, {
      businessId: assigned.businessId,
      type: "JOB_COMPLETED",
      subjectType: "JOB",
      subjectId: assigned.id,
      payload: { customerId: result.customerId ?? assigned.customerId },
      idempotencyKey: `JOB_COMPLETED:${assigned.id}`,
    });
  }

  const job = await loadNativeAssignedJob(db, access, assigned.id);
  if (!job) {
    return { ok: false, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
  }
  return { ok: true, alreadyCompleted: result.alreadyCompleted, job };
}
