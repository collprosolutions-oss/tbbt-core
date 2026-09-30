/**
 * Native assigned-job TRAVEL / MATERIAL_PICKUP time writes.
 *
 * Reads stay in `src/lib/native-field.ts`. After the assigned-job
 * authorize read, this module locks the Job, rechecks businessId and
 * assignedMembershipId, then reuses the canonical activity-time writes
 * in `src/lib/time-card-ops.ts`. It does not change Job.status, start
 * JOB time, complete a job, or send an invoice.
 */
import type { PrismaClient } from "@prisma/client";
import {
  loadNativeAssignedJob,
  nativeAssignedJobWhere,
  type NativeJobDetail,
} from "@/lib/native-field";
import { exactActiveMembershipHeld } from "@/lib/exact-active-membership";
import {
  assignmentStillHeld,
  NATIVE_JOB_NOT_AVAILABLE,
} from "@/lib/native-field-ops";
import type { NativeFieldAccess } from "@/lib/native-session";
import { NATIVE_SESSION_TOO_LARGE } from "@/lib/native-session-limits";
import {
  requireSaasOperatingEntitlement,
  saasOperatingErrorMessage,
  SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE,
} from "@/lib/saas-billing/entitlement";
import {
  isAssignedFieldActivityType,
  type AssignedFieldActivityType,
} from "@/lib/time-cards";
import {
  isTimeCardError,
  lockTenantOwnedJob,
  startAssignedActivityTimeInTransaction,
  stopAssignedActivityTimeInTransaction,
  timeCardErrorMessage,
} from "@/lib/time-card-ops";

export const NATIVE_ACTIVITY_JSON_MAX_BYTES = 4096;
export const NATIVE_ACTIVITY_CHOOSE_TYPE = "Choose travel or material pickup.";
const NATIVE_ACTIVITY_TYPE_MAX_CHARS = 32;

export type NativeStartAssignedActivityResult =
  | {
      ok: true;
      alreadyStarted: boolean;
      alreadyRunningTime: boolean;
      job: NativeJobDetail;
    }
  | { ok: false; status: number; error: string };

export type NativeStopAssignedActivityResult =
  | { ok: true; alreadyStopped: boolean; job: NativeJobDetail }
  | { ok: false; status: number; error: string };

export function parseNativeActivityTypeJson(text: string):
  | { ok: true; activityType: AssignedFieldActivityType }
  | { ok: false; status: 400 | 413; error: string } {
  if (!text.trim()) {
    return { ok: false, status: 400, error: NATIVE_ACTIVITY_CHOOSE_TYPE };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, error: NATIVE_ACTIVITY_CHOOSE_TYPE };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, status: 400, error: NATIVE_ACTIVITY_CHOOSE_TYPE };
  }
  const payload = parsed as Record<string, unknown>;
  const raw = payload.activityType;
  if (typeof raw === "string" && raw.length > NATIVE_ACTIVITY_TYPE_MAX_CHARS) {
    return { ok: false, status: 413, error: NATIVE_SESSION_TOO_LARGE };
  }
  if (typeof raw !== "string" || !isAssignedFieldActivityType(raw)) {
    return { ok: false, status: 400, error: NATIVE_ACTIVITY_CHOOSE_TYPE };
  }
  return { ok: true, activityType: raw };
}

async function authorizeAssignedActivityJob(
  db: PrismaClient,
  access: NativeFieldAccess,
  jobId: string,
): Promise<
  | { ok: true; jobId: string }
  | { ok: false; status: number; error: string }
> {
  const assigned = await db.job.findFirst({
    where: nativeAssignedJobWhere(jobId, access),
    select: { id: true },
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

  return { ok: true, jobId: assigned.id };
}

export async function startNativeAssignedActivityTime(
  db: PrismaClient,
  access: NativeFieldAccess,
  jobId: string,
  activityType: AssignedFieldActivityType,
  options?: {
    /** Proof hook: runs after the authorize read and before the Job lock. */
    afterInitialRead?: () => Promise<void>;
  },
): Promise<NativeStartAssignedActivityResult> {
  const authorized = await authorizeAssignedActivityJob(db, access, jobId);
  if (!authorized.ok) {
    return authorized;
  }

  if (options?.afterInitialRead) {
    await options.afterInitialRead();
  }

  let started: Extract<
    Awaited<ReturnType<typeof startAssignedActivityTimeInTransaction>>,
    { ok: true }
  >;
  try {
    const written = await db.$transaction(async (tx) => {
      const locked = await lockTenantOwnedJob(tx, access.businessId, authorized.jobId);
      if (!assignmentStillHeld(locked, access)) {
        return { ok: false as const, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
      }
      if (!(await exactActiveMembershipHeld(tx, access))) {
        return { ok: false as const, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
      }

      const result = await startAssignedActivityTimeInTransaction(tx, {
        businessId: locked.businessId,
        jobId: locked.id,
        activityType,
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

  const job = await loadNativeAssignedJob(db, access, authorized.jobId);
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

export async function stopNativeAssignedActivityTime(
  db: PrismaClient,
  access: NativeFieldAccess,
  jobId: string,
  activityType: AssignedFieldActivityType,
  options?: {
    /** Proof hook: runs after the authorize read and before the Job lock. */
    afterInitialRead?: () => Promise<void>;
  },
): Promise<NativeStopAssignedActivityResult> {
  const authorized = await authorizeAssignedActivityJob(db, access, jobId);
  if (!authorized.ok) {
    return authorized;
  }

  if (options?.afterInitialRead) {
    await options.afterInitialRead();
  }

  let stopped: Extract<
    Awaited<ReturnType<typeof stopAssignedActivityTimeInTransaction>>,
    { ok: true }
  >;
  try {
    const written = await db.$transaction(async (tx) => {
      const locked = await lockTenantOwnedJob(tx, access.businessId, authorized.jobId);
      if (!assignmentStillHeld(locked, access)) {
        return { ok: false as const, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
      }
      if (!(await exactActiveMembershipHeld(tx, access))) {
        return { ok: false as const, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
      }

      const result = await stopAssignedActivityTimeInTransaction(tx, {
        businessId: locked.businessId,
        jobId: locked.id,
        activityType,
        actorMembershipId: access.membershipId,
        membershipId: access.membershipId,
      });
      if (!result.ok) {
        return { ok: false as const, status: 409, error: result.error };
      }
      return { ok: true as const, result };
    });

    if (!written.ok) {
      return written;
    }
    stopped = written.result;
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

  const job = await loadNativeAssignedJob(db, access, authorized.jobId);
  if (!job) {
    return { ok: false, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
  }
  return { ok: true, alreadyStopped: stopped.alreadyStopped, job };
}
