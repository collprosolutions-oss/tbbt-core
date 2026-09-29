/**
 * Native assigned-job material pickup item writes.
 *
 * Reads stay in `src/lib/native-field.ts` and reuse
 * `listAssignedJobPickupView`. After the assigned-job authorize read,
 * this module reuses `recordAssignedJobPickup` — the same Job lock,
 * assignment recheck, and MaterialPurchaseListItem write. It does not
 * purchase items, alter supplier prices, create expenses, or start
 * MATERIAL_PICKUP time.
 */
import type { PrismaClient } from "@prisma/client";
import {
  ASSIGNED_PICKUP_ONLY_MESSAGE,
  recordAssignedJobPickup,
} from "@/lib/materials/pickup";
import { MaterialsError, materialsErrorMessage } from "@/lib/materials/errors";
import {
  isPickupException,
  type PickupException,
} from "@/lib/materials/types";
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

export const NATIVE_PICKUP_JSON_MAX_BYTES = 4096;
export const NATIVE_PICKUP_CHOOSE_RECORD =
  "Enter a picked-up quantity or an exception.";
const NATIVE_PICKUP_ITEM_ID_MAX_CHARS = 128;
const NATIVE_PICKUP_EXCEPTION_MAX_CHARS = 32;
const NATIVE_PICKUP_NOTE_MAX_CHARS = 280;
const NATIVE_PICKUP_QUANTITY_MAX_CHARS = 32;

export type NativeRecordAssignedPickupResult =
  | {
      ok: true;
      alreadyRecorded: boolean;
      job: NativeJobDetail;
    }
  | { ok: false; status: number; error: string };

export type NativePickupRecordInput = {
  itemId: string;
  quantityPickedUp?: string | null;
  pickupException?: PickupException | null;
  pickupExceptionNote?: string | null;
};

export function parseNativePickupRecordJson(text: string):
  | { ok: true; input: NativePickupRecordInput }
  | { ok: false; status: 400 | 413; error: string } {
  if (!text.trim()) {
    return { ok: false, status: 400, error: NATIVE_PICKUP_CHOOSE_RECORD };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, error: NATIVE_PICKUP_CHOOSE_RECORD };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, status: 400, error: NATIVE_PICKUP_CHOOSE_RECORD };
  }
  const payload = parsed as Record<string, unknown>;
  const rawItemId = payload.itemId;
  if (typeof rawItemId === "string" && rawItemId.length > NATIVE_PICKUP_ITEM_ID_MAX_CHARS) {
    return { ok: false, status: 413, error: NATIVE_SESSION_TOO_LARGE };
  }
  const itemId = typeof rawItemId === "string" ? rawItemId.trim() : "";
  if (!itemId) {
    return { ok: false, status: 400, error: NATIVE_PICKUP_CHOOSE_RECORD };
  }

  const rawQuantity = payload.quantityPickedUp;
  if (typeof rawQuantity === "string" && rawQuantity.length > NATIVE_PICKUP_QUANTITY_MAX_CHARS) {
    return { ok: false, status: 413, error: NATIVE_SESSION_TOO_LARGE };
  }
  if (rawQuantity != null && typeof rawQuantity !== "string" && typeof rawQuantity !== "number") {
    return { ok: false, status: 400, error: NATIVE_PICKUP_CHOOSE_RECORD };
  }

  const rawException = payload.pickupException;
  if (typeof rawException === "string" && rawException.length > NATIVE_PICKUP_EXCEPTION_MAX_CHARS) {
    return { ok: false, status: 413, error: NATIVE_SESSION_TOO_LARGE };
  }
  if (rawException != null && rawException !== "" && !isPickupException(rawException)) {
    return { ok: false, status: 400, error: NATIVE_PICKUP_CHOOSE_RECORD };
  }

  const rawNote = payload.pickupExceptionNote;
  if (typeof rawNote === "string" && rawNote.length > NATIVE_PICKUP_NOTE_MAX_CHARS) {
    return { ok: false, status: 413, error: NATIVE_SESSION_TOO_LARGE };
  }
  if (rawNote != null && typeof rawNote !== "string") {
    return { ok: false, status: 400, error: NATIVE_PICKUP_CHOOSE_RECORD };
  }

  const quantityPickedUp =
    rawQuantity == null || rawQuantity === ""
      ? null
      : String(rawQuantity).trim() || null;
  const pickupException = isPickupException(rawException) ? rawException : null;
  const pickupExceptionNote = typeof rawNote === "string" ? rawNote.trim() || null : null;

  if (!quantityPickedUp && !pickupException) {
    return { ok: false, status: 400, error: NATIVE_PICKUP_CHOOSE_RECORD };
  }

  return {
    ok: true,
    input: {
      itemId,
      quantityPickedUp,
      pickupException,
      pickupExceptionNote,
    },
  };
}

function pickupWriteFailure(error: unknown): Extract<
  NativeRecordAssignedPickupResult,
  { ok: false }
> {
  const message = materialsErrorMessage(
    error,
    "That pickup item could not be recorded.",
  );
  if (message === ASSIGNED_PICKUP_ONLY_MESSAGE) {
    return { ok: false, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
  }
  if (error instanceof MaterialsError) {
    return { ok: false, status: 409, error: message };
  }
  return { ok: false, status: 409, error: message };
}

export async function recordNativeAssignedPickupItem(
  db: PrismaClient,
  access: NativeFieldAccess,
  jobId: string,
  input: NativePickupRecordInput,
  options?: {
    /** Proof hook: runs after the authorize read and before the Job lock. */
    afterInitialRead?: () => Promise<void>;
  },
): Promise<NativeRecordAssignedPickupResult> {
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

  let alreadyRecorded = false;
  try {
    const written = await recordAssignedJobPickup(
      db,
      { businessId: access.businessId, membershipId: access.membershipId },
      {
        jobId: assigned.id,
        itemId: input.itemId,
        quantityPickedUp: input.quantityPickedUp,
        pickupException: input.pickupException,
        pickupExceptionNote: input.pickupExceptionNote,
        afterInitialRead: options?.afterInitialRead,
      },
    );
    alreadyRecorded = written.alreadyRecorded;
  } catch (error) {
    return pickupWriteFailure(error);
  }

  const job = await loadNativeAssignedJob(db, access, assigned.id);
  if (!job) {
    return { ok: false, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
  }
  return { ok: true, alreadyRecorded, job };
}
