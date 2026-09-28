/**
 * Native assigned-job Cleaning visit outcome writes.
 *
 * Reads stay in `src/lib/native-field.ts`. This module does not invent a
 * second visit engine. After the assigned-job authorize read, it reuses
 * `recordAssignedVisitOutcome` — the same Job lock, assignment recheck,
 * atomic VISIT_COMPLETED + Job completion, and running-time rollback as
 * the Field web checklist. It does not toggle checklist items, create
 * later jobs, send customer messages, or write invoices.
 */
import type { PrismaClient } from "@prisma/client";
import {
  CleaningVisitError,
  cleaningVisitErrorMessage,
  recordAssignedVisitOutcome,
} from "@/lib/cleaning-visit-ops";
import {
  ASSIGNED_WORKER_ONLY_MESSAGE,
  parseRecordedVisitOutcome,
  type RecordedVisitOutcomeStatus,
} from "@/lib/cleaning-visit-workflow";
import {
  loadNativeAssignedJob,
  nativeAssignedJobWhere,
  type NativeJobDetail,
} from "@/lib/native-field";
import { NATIVE_JOB_NOT_AVAILABLE } from "@/lib/native-field-ops";
import type { NativeFieldAccess } from "@/lib/native-session";
import { NATIVE_SESSION_TOO_LARGE } from "@/lib/native-session-limits";
import {
  requireSaasOperatingEntitlement,
  saasOperatingErrorMessage,
  SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE,
} from "@/lib/saas-billing/entitlement";

export const NATIVE_VISIT_JSON_MAX_BYTES = 4096;
export const NATIVE_VISIT_CHOOSE_OUTCOME =
  "Choose visit completed or requested re-clean.";
const NATIVE_VISIT_OUTCOME_MAX_CHARS = 32;

export type NativeRecordAssignedVisitResult =
  | {
      ok: true;
      alreadyRecorded: boolean;
      job: NativeJobDetail;
    }
  | { ok: false; status: number; error: string };

export function parseNativeVisitOutcomeJson(text: string):
  | { ok: true; outcomeStatus: RecordedVisitOutcomeStatus }
  | { ok: false; status: 400 | 413; error: string } {
  if (!text.trim()) {
    return { ok: false, status: 400, error: NATIVE_VISIT_CHOOSE_OUTCOME };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, error: NATIVE_VISIT_CHOOSE_OUTCOME };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, status: 400, error: NATIVE_VISIT_CHOOSE_OUTCOME };
  }
  const payload = parsed as Record<string, unknown>;
  const raw = payload.outcomeStatus;
  if (typeof raw === "string" && raw.length > NATIVE_VISIT_OUTCOME_MAX_CHARS) {
    return { ok: false, status: 413, error: NATIVE_SESSION_TOO_LARGE };
  }
  const outcomeStatus = parseRecordedVisitOutcome(typeof raw === "string" ? raw : "");
  if (!outcomeStatus) {
    return { ok: false, status: 400, error: NATIVE_VISIT_CHOOSE_OUTCOME };
  }
  return { ok: true, outcomeStatus };
}

function visitWriteFailure(error: unknown): Extract<
  NativeRecordAssignedVisitResult,
  { ok: false }
> {
  const message = cleaningVisitErrorMessage(
    error,
    "That visit outcome could not be recorded.",
  );
  if (message === ASSIGNED_WORKER_ONLY_MESSAGE) {
    return { ok: false, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
  }
  if (error instanceof CleaningVisitError) {
    return { ok: false, status: 409, error: message };
  }
  return { ok: false, status: 409, error: message };
}

export async function recordNativeAssignedVisitOutcome(
  db: PrismaClient,
  access: NativeFieldAccess,
  jobId: string,
  outcomeStatus: RecordedVisitOutcomeStatus,
  options?: {
    /** Proof hook: runs after the authorize read and before the Job lock. */
    afterInitialRead?: () => Promise<void>;
  },
): Promise<NativeRecordAssignedVisitResult> {
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

  const existing = await db.jobCrewVisit.findFirst({
    where: { jobId: assigned.id, businessId: access.businessId },
    select: { outcomeStatus: true },
  });
  const alreadyRecorded = existing?.outcomeStatus === outcomeStatus;

  try {
    await recordAssignedVisitOutcome(
      db,
      { businessId: access.businessId, membershipId: access.membershipId },
      {
        jobId: assigned.id,
        outcomeStatus,
        afterInitialRead: options?.afterInitialRead,
      },
    );
  } catch (error) {
    return visitWriteFailure(error);
  }

  const job = await loadNativeAssignedJob(db, access, assigned.id);
  if (!job) {
    return { ok: false, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
  }
  return { ok: true, alreadyRecorded, job };
}
