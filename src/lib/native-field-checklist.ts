/**
 * Native assigned-job Cleaning checklist writes.
 *
 * Reads stay in `src/lib/native-field.ts`. This module does not invent a
 * second checklist engine. After the assigned-job authorize read, it
 * reuses `setAssignedChecklistItem` — the same Job lock, assignment
 * recheck, and `JobCrewVisit.checklistJson` write as the Field web
 * checklist. It does not record visit outcomes, create later jobs,
 * send customer messages, or write invoices.
 */
import type { PrismaClient } from "@prisma/client";
import {
  CleaningVisitError,
  cleaningVisitErrorMessage,
  setAssignedChecklistItem,
} from "@/lib/cleaning-visit-ops";
import {
  ASSIGNED_WORKER_ONLY_MESSAGE,
  parseChecklistJson,
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

export const NATIVE_CHECKLIST_JSON_MAX_BYTES = 4096;
export const NATIVE_CHECKLIST_CHOOSE_ITEM =
  "That checklist item could not be updated.";
const NATIVE_CHECKLIST_ITEM_KEY_MAX_CHARS = 128;

export type NativeRecordAssignedChecklistResult =
  | {
      ok: true;
      alreadyRecorded: boolean;
      job: NativeJobDetail;
    }
  | { ok: false; status: number; error: string };

export function parseNativeChecklistItemJson(text: string):
  | { ok: true; itemKey: string; checked: boolean }
  | { ok: false; status: 400 | 413; error: string } {
  if (!text.trim()) {
    return { ok: false, status: 400, error: NATIVE_CHECKLIST_CHOOSE_ITEM };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, error: NATIVE_CHECKLIST_CHOOSE_ITEM };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, status: 400, error: NATIVE_CHECKLIST_CHOOSE_ITEM };
  }
  const payload = parsed as Record<string, unknown>;
  const rawKey = payload.itemKey;
  if (typeof rawKey === "string" && rawKey.length > NATIVE_CHECKLIST_ITEM_KEY_MAX_CHARS) {
    return { ok: false, status: 413, error: NATIVE_SESSION_TOO_LARGE };
  }
  const itemKey = typeof rawKey === "string" ? rawKey.trim() : "";
  if (!itemKey) {
    return { ok: false, status: 400, error: NATIVE_CHECKLIST_CHOOSE_ITEM };
  }
  if (typeof payload.checked !== "boolean") {
    return { ok: false, status: 400, error: NATIVE_CHECKLIST_CHOOSE_ITEM };
  }
  return { ok: true, itemKey, checked: payload.checked };
}

function checklistWriteFailure(error: unknown): Extract<
  NativeRecordAssignedChecklistResult,
  { ok: false }
> {
  const message = cleaningVisitErrorMessage(
    error,
    "That checklist item could not be updated.",
  );
  if (message === ASSIGNED_WORKER_ONLY_MESSAGE) {
    return { ok: false, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
  }
  if (error instanceof CleaningVisitError) {
    return { ok: false, status: 409, error: message };
  }
  return { ok: false, status: 409, error: message };
}

export async function recordNativeAssignedChecklistItem(
  db: PrismaClient,
  access: NativeFieldAccess,
  jobId: string,
  input: { itemKey: string; checked: boolean },
  options?: {
    /** Proof hook: runs after the authorize read and before the Job lock. */
    afterInitialRead?: () => Promise<void>;
  },
): Promise<NativeRecordAssignedChecklistResult> {
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
    select: { checklistJson: true },
  });
  const alreadyRecorded = parseChecklistJson(existing?.checklistJson).some(
    (item) => item.key === input.itemKey && item.checked === input.checked,
  );

  try {
    await setAssignedChecklistItem(
      db,
      { businessId: access.businessId, membershipId: access.membershipId },
      {
        jobId: assigned.id,
        itemKey: input.itemKey,
        checked: input.checked,
        afterInitialRead: options?.afterInitialRead,
      },
    );
  } catch (error) {
    return checklistWriteFailure(error);
  }

  const job = await loadNativeAssignedJob(db, access, assigned.id);
  if (!job) {
    return { ok: false, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
  }
  return { ok: true, alreadyRecorded, job };
}
