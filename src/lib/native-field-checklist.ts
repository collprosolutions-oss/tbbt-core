/**
 * Native assigned-job checklist writes.
 *
 * Reads stay in `src/lib/native-field.ts`. This module does not invent a
 * second checklist engine. Immediate item taps reuse `setAssignedChecklistItem`
 * — the same Job lock, assignment recheck, and `JobCrewVisit.checklistJson`
 * write as the Field web checklist. Explicit draft sync uses that same
 * lock / assignment recheck / `checklistJson` write, and is trade-neutral
 * when the Job already has checklist items. It does not record visit
 * outcomes, complete jobs, write time, send messages, or write invoices.
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
  serializeChecklist,
  toggleChecklistItem,
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
import { lockTenantOwnedJob } from "@/lib/time-card-ops";

export const NATIVE_CHECKLIST_JSON_MAX_BYTES = 4096;
/**
 * Compact sync body: fingerprint + changed items (with base values).
 * 4096 bytes holds a large cuid-keyed change set; the phone draft is 2048.
 */
export const NATIVE_CHECKLIST_SYNC_JSON_MAX_BYTES = 4096;
export const NATIVE_CHECKLIST_CHOOSE_ITEM =
  "That checklist item could not be updated.";
export const NATIVE_CHECKLIST_STALE_MESSAGE =
  "This checklist changed after your draft. Sync was not applied.";
export const NATIVE_CHECKLIST_NO_ITEMS_MESSAGE =
  "This job has no checklist items.";
export const NATIVE_CHECKLIST_CLOSED_MESSAGE =
  "This job's checklist can no longer be updated.";
export const NATIVE_CHECKLIST_ITEM_KEY_MAX_CHARS = 128;
/** Parse guard. The 4096-byte body cap is the real size limit. */
export const NATIVE_CHECKLIST_MAX_CHANGED_ITEMS = 64;
export const NATIVE_CHECKLIST_FINGERPRINT_PATTERN = /^[0-9a-f]{8}$/;

export type NativeRecordAssignedChecklistResult =
  | {
      ok: true;
      alreadyRecorded: boolean;
      job: NativeJobDetail;
    }
  | { ok: false; status: number; error: string };

export type NativeChecklistDraftItem = {
  itemKey: string;
  checked: boolean;
  baseChecked: boolean;
};
export type NativeChecklistExpectedItem = { key: string; checked: boolean };

/** FNV-1a of `key:0|key:1` rows. Must stay identical to the native draft copy. */
export function checklistStateFingerprint(
  items: Array<{ key: string; checked: boolean }>,
): string {
  const canonical = items
    .map((item) => `${item.key.trim()}:${item.checked ? "1" : "0"}`)
    .sort()
    .join("|");
  let hash = 2166136261;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export type NativeSyncAssignedChecklistResult =
  | {
      ok: true;
      alreadySynced: boolean;
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

function readChecklistItemKey(value: unknown): string | null | "too-large" {
  if (typeof value !== "string") return null;
  if (value.length > NATIVE_CHECKLIST_ITEM_KEY_MAX_CHARS) return "too-large";
  const key = value.trim();
  return key || null;
}

function parseExpectedFingerprint(
  value: unknown,
): { ok: true; expectedFingerprint: string } | { ok: false; status: 400; error: string } {
  if (typeof value !== "string") {
    return { ok: false, status: 400, error: NATIVE_CHECKLIST_CHOOSE_ITEM };
  }
  const expectedFingerprint = value.trim().toLowerCase();
  if (!NATIVE_CHECKLIST_FINGERPRINT_PATTERN.test(expectedFingerprint)) {
    return { ok: false, status: 400, error: NATIVE_CHECKLIST_CHOOSE_ITEM };
  }
  return { ok: true, expectedFingerprint };
}

function parseDraftItems(
  value: unknown,
):
  | { ok: true; items: NativeChecklistDraftItem[] }
  | { ok: false; status: 400 | 413; error: string } {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > NATIVE_CHECKLIST_MAX_CHANGED_ITEMS
  ) {
    return { ok: false, status: 400, error: NATIVE_CHECKLIST_CHOOSE_ITEM };
  }
  const items: NativeChecklistDraftItem[] = [];
  const seen = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return { ok: false, status: 400, error: NATIVE_CHECKLIST_CHOOSE_ITEM };
    }
    const payload = row as Record<string, unknown>;
    const itemKey = readChecklistItemKey(payload.itemKey);
    if (itemKey === "too-large") {
      return { ok: false, status: 413, error: NATIVE_SESSION_TOO_LARGE };
    }
    if (
      !itemKey ||
      typeof payload.checked !== "boolean" ||
      typeof payload.baseChecked !== "boolean" ||
      seen.has(itemKey)
    ) {
      return { ok: false, status: 400, error: NATIVE_CHECKLIST_CHOOSE_ITEM };
    }
    seen.add(itemKey);
    items.push({
      itemKey,
      checked: payload.checked,
      baseChecked: payload.baseChecked,
    });
  }
  return { ok: true, items };
}

export function parseNativeChecklistSyncJson(text: string):
  | {
      ok: true;
      expectedFingerprint: string;
      items: NativeChecklistDraftItem[];
    }
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
  const fingerprint = parseExpectedFingerprint(payload.expectedFingerprint);
  if (!fingerprint.ok) return fingerprint;
  const items = parseDraftItems(payload.items);
  if (!items.ok) return items;
  return {
    ok: true,
    expectedFingerprint: fingerprint.expectedFingerprint,
    items: items.items,
  };
}

export function checklistDraftMatchesCurrent(
  current: Array<{ key: string; checked: boolean }>,
  expected: Array<{ key: string; checked: boolean }>,
): boolean {
  if (current.length !== expected.length) return false;
  const expectedByKey = new Map(expected.map((item) => [item.key, item.checked]));
  if (expectedByKey.size !== expected.length) return false;
  return current.every(
    (item) => expectedByKey.has(item.key) && expectedByKey.get(item.key) === item.checked,
  );
}

export function jobChecklistIsClosed(
  status: string,
  outcomeStatus: string | null | undefined,
) {
  return (
    status === "COMPLETED" ||
    status === "CANCELED" ||
    status === "CANCELLED" ||
    (typeof outcomeStatus === "string" && outcomeStatus !== "NONE")
  );
}

export function reconstructExpectedChecklist(
  current: Array<{ key: string; checked: boolean }>,
  items: NativeChecklistDraftItem[],
): NativeChecklistExpectedItem[] {
  const bases = new Map(items.map((item) => [item.itemKey, item.baseChecked]));
  return current.map((item) =>
    bases.has(item.key)
      ? { key: item.key, checked: bases.get(item.key) === true }
      : { key: item.key, checked: item.checked },
  );
}

export function applyChecklistDraftChanges(
  current: Array<{ key: string; checked: boolean }>,
  items: NativeChecklistDraftItem[],
): NativeChecklistExpectedItem[] {
  let next = current.map((item) => ({ key: item.key, checked: item.checked }));
  for (const change of items) {
    if (!next.some((item) => item.key === change.itemKey)) {
      throw new CleaningVisitError("That checklist item is not on this visit.");
    }
    next = next.map((item) =>
      item.key === change.itemKey ? { ...item, checked: change.checked } : item,
    );
  }
  return next;
}

export async function syncNativeAssignedChecklistDraft(
  db: PrismaClient,
  access: NativeFieldAccess,
  jobId: string,
  input: {
    expectedFingerprint: string;
    items: NativeChecklistDraftItem[];
  },
  options?: {
    /** Proof hook: runs after the authorize read and before the Job lock. */
    afterInitialRead?: () => Promise<void>;
  },
): Promise<NativeSyncAssignedChecklistResult> {
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
  const currentItems = parseChecklistJson(existing?.checklistJson);
  if (currentItems.length === 0) {
    return { ok: false, status: 409, error: NATIVE_CHECKLIST_NO_ITEMS_MESSAGE };
  }

  if (options?.afterInitialRead) {
    await options.afterInitialRead();
  }

  let alreadySynced = false;
  try {
    alreadySynced = await db.$transaction(async (tx) => {
      const locked = await lockTenantOwnedJob(tx, access.businessId, assigned.id);
      if (!locked || locked.assignedMembershipId !== access.membershipId) {
        throw new CleaningVisitError(ASSIGNED_WORKER_ONLY_MESSAGE);
      }

      const lockedVisit = await tx.jobCrewVisit.findFirst({
        where: { jobId: assigned.id, businessId: access.businessId },
      });
      const lockedItems = parseChecklistJson(lockedVisit?.checklistJson);
      if (!lockedVisit || lockedItems.length === 0) {
        throw new CleaningVisitError(NATIVE_CHECKLIST_NO_ITEMS_MESSAGE);
      }
      if (jobChecklistIsClosed(locked.status, lockedVisit.outcomeStatus)) {
        throw new CleaningVisitError(NATIVE_CHECKLIST_CLOSED_MESSAGE);
      }

      const currentFingerprint = checklistStateFingerprint(lockedItems);
      const reconstructedExpected = reconstructExpectedChecklist(lockedItems, input.items);
      const reconstructedFingerprint = checklistStateFingerprint(reconstructedExpected);
      const desiredKeysPresent = input.items.every((change) =>
        lockedItems.some((item) => item.key === change.itemKey),
      );
      const desired = desiredKeysPresent
        ? applyChecklistDraftChanges(lockedItems, input.items)
        : null;

      if (currentFingerprint === input.expectedFingerprint) {
        const baseMatches = input.items.every((change) => {
          const current = lockedItems.find((item) => item.key === change.itemKey);
          return current?.checked === change.baseChecked;
        });
        if (!baseMatches || !desired) {
          throw new CleaningVisitError(NATIVE_CHECKLIST_STALE_MESSAGE);
        }
        if (checklistDraftMatchesCurrent(lockedItems, desired)) {
          return true;
        }
      } else if (
        desired &&
        reconstructedFingerprint === input.expectedFingerprint &&
        checklistDraftMatchesCurrent(lockedItems, desired)
      ) {
        return true;
      } else {
        throw new CleaningVisitError(NATIVE_CHECKLIST_STALE_MESSAGE);
      }

      let next = lockedItems;
      for (const change of input.items) {
        if (!next.some((item) => item.key === change.itemKey)) {
          throw new CleaningVisitError("That checklist item is not on this visit.");
        }
        next = toggleChecklistItem(next, change.itemKey, change.checked);
      }

      const updated = await tx.jobCrewVisit.updateMany({
        where: { id: lockedVisit.id, checklistJson: lockedVisit.checklistJson },
        data: { checklistJson: serializeChecklist(next) },
      });
      if (updated.count !== 1) {
        throw new CleaningVisitError(NATIVE_CHECKLIST_STALE_MESSAGE);
      }
      return false;
    });
  } catch (error) {
    return checklistWriteFailure(error);
  }

  const job = await loadNativeAssignedJob(db, access, assigned.id);
  if (!job) {
    return { ok: false, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
  }
  return { ok: true, alreadySynced, job };
}
