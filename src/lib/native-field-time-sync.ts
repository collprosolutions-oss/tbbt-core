/**
 * Native assigned-job time-card draft sync.
 *
 * Reads stay in `src/lib/native-field.ts`. Live Start/Stop routes stay
 * in `src/lib/native-field-ops.ts` and `src/lib/native-field-activity.ts`.
 * This module applies an explicit offline start/stop draft through those
 * same canonical time-card writes. It does not invent a second clock,
 * approve weeks, or write payroll. A matching replay is alreadySynced;
 * a stale, reassigned, approved, overlapping, or duplicate draft is
 * refused instead of creating approved server time.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  CUSTOMER_HAS_NOT_CONFIRMED_APPOINTMENT,
  startJobRequiresCustomerConfirmation,
} from "@/lib/appointment-confirmation";
import { emitAndProcessBusinessEvent } from "@/lib/automation/events";
import { evaluateStartJob } from "@/lib/job-lifecycle";
import { exactActiveMembershipHeld } from "@/lib/exact-active-membership";
import {
  loadNativeAssignedJob,
  nativeAssignedJobWhere,
  type NativeJobDetail,
} from "@/lib/native-field";
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
  isTimeCardError,
  lockTenantOwnedJob,
  startAssignedActivityTimeInTransaction,
  startJobWithRunningTimeSafetyInTransaction,
  stopAssignedActivityTimeInTransaction,
  stopRunningAssignedJobTimeInTransaction,
  TIME_CORRECTION_FUTURE_SLACK_MS,
  TIME_CORRECTION_MAX_DURATION_MS,
  timeCardErrorMessage,
} from "@/lib/time-card-ops";

export const NATIVE_TIME_CARD_SYNC_JSON_MAX_BYTES = 4096;
export const NATIVE_TIME_CARD_MAX_INTENTS = 4;
export const NATIVE_TIME_CARD_CHOOSE_INTENT = "Choose a start or stop to sync.";
export const NATIVE_TIME_CARD_STALE_MESSAGE =
  "This time changed after your draft. Sync was not applied.";
export const NATIVE_TIME_CARD_DUPLICATE_MESSAGE =
  "That start or stop was already recorded.";
export const NATIVE_TIME_CARD_LOOKBACK_MS = TIME_CORRECTION_MAX_DURATION_MS;
export const NATIVE_TIME_CARD_OUT_OF_ORDER =
  "Sync start and stop times must be in order.";
export const NATIVE_TIME_CARD_START_TOO_OLD =
  "That start is too old to sync. Request a time correction instead.";
export const NATIVE_TIME_CARD_DURATION_TOO_LONG =
  "That time is longer than 24 hours. Request a time correction instead.";
export const NATIVE_TIME_CARD_FINGERPRINT_PATTERN = /^[0-9a-f]{8}$/;
export const NATIVE_TIME_CARD_ACTION_MAX_CHARS = 32;
export const NATIVE_TIME_CARD_INTENDED_AT_MAX_CHARS = 40;

export const TIME_CARD_DRAFT_ACTIONS = [
  "START_JOB",
  "STOP_JOB_TIME",
  "START_TRAVEL",
  "STOP_TRAVEL",
  "START_PICKUP",
  "STOP_PICKUP",
] as const;

export type NativeTimeCardDraftAction = (typeof TIME_CARD_DRAFT_ACTIONS)[number];

export type NativeTimeCardDraftIntent = {
  action: NativeTimeCardDraftAction;
  intendedAt: string;
};

export type TimeCardClockState = {
  running: boolean;
  startedAt: string | null;
  endedAt: string | null;
};

export type TimeCardClockSnapshot = {
  jobStatus: string;
  assignmentId: string;
  clocks: {
    JOB: TimeCardClockState;
    TRAVEL: TimeCardClockState;
    MATERIAL_PICKUP: TimeCardClockState;
  };
};

export type NativeSyncAssignedTimeCardResult =
  | {
      ok: true;
      alreadySynced: boolean;
      job: NativeJobDetail;
    }
  | { ok: false; status: number; error: string };

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

type Db = PrismaClient | Prisma.TransactionClient;

export function isNativeTimeCardDraftAction(
  value: string,
): value is NativeTimeCardDraftAction {
  return (TIME_CARD_DRAFT_ACTIONS as readonly string[]).includes(value);
}

function idleClock(): TimeCardClockState {
  return { running: false, startedAt: null, endedAt: null };
}

function clockCanonical(state: TimeCardClockState) {
  return `${state.running ? "1" : "0"}:${state.startedAt ?? ""}:${state.endedAt ?? ""}`;
}

export function timeCardStateCanonical(snapshot: TimeCardClockSnapshot) {
  return [
    `status:${snapshot.jobStatus.trim()}`,
    `assign:${snapshot.assignmentId.trim()}`,
    `JOB:${clockCanonical(snapshot.clocks.JOB)}`,
    `TRAVEL:${clockCanonical(snapshot.clocks.TRAVEL)}`,
    `PICKUP:${clockCanonical(snapshot.clocks.MATERIAL_PICKUP)}`,
  ].join("|");
}

/** FNV-1a of the canonical clock snapshot. Must stay identical to the native draft copy. */
export function timeCardStateFingerprint(snapshot: TimeCardClockSnapshot): string {
  const canonical = timeCardStateCanonical(snapshot);
  let hash = 2166136261;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function clockTypeForAction(
  action: NativeTimeCardDraftAction,
): keyof TimeCardClockSnapshot["clocks"] {
  if (action === "START_JOB" || action === "STOP_JOB_TIME") return "JOB";
  if (action === "START_TRAVEL" || action === "STOP_TRAVEL") return "TRAVEL";
  return "MATERIAL_PICKUP";
}

function isStartAction(action: NativeTimeCardDraftAction) {
  return action === "START_JOB" || action === "START_TRAVEL" || action === "START_PICKUP";
}

export function applyTimeCardIntentsToSnapshot(
  snapshot: TimeCardClockSnapshot,
  intents: NativeTimeCardDraftIntent[],
): TimeCardClockSnapshot {
  const next: TimeCardClockSnapshot = {
    jobStatus: snapshot.jobStatus,
    assignmentId: snapshot.assignmentId,
    clocks: {
      JOB: { ...snapshot.clocks.JOB },
      TRAVEL: { ...snapshot.clocks.TRAVEL },
      MATERIAL_PICKUP: { ...snapshot.clocks.MATERIAL_PICKUP },
    },
  };
  for (const intent of intents) {
    const clock = clockTypeForAction(intent.action);
    if (isStartAction(intent.action)) {
      for (const key of ["JOB", "TRAVEL", "MATERIAL_PICKUP"] as const) {
        if (next.clocks[key].running) {
          next.clocks[key] = {
            running: false,
            startedAt: next.clocks[key].startedAt,
            endedAt: intent.intendedAt,
          };
        }
      }
      next.clocks[clock] = {
        running: true,
        startedAt: intent.intendedAt,
        endedAt: null,
      };
      if (intent.action === "START_JOB" && next.jobStatus !== "COMPLETED") {
        next.jobStatus = "IN_PROGRESS";
      }
    } else {
      next.clocks[clock] = {
        running: false,
        startedAt: next.clocks[clock].startedAt,
        endedAt: intent.intendedAt,
      };
    }
  }
  return next;
}

function parseExpectedFingerprint(
  value: unknown,
): { ok: true; expectedFingerprint: string } | { ok: false; status: 400; error: string } {
  if (typeof value !== "string") {
    return { ok: false, status: 400, error: NATIVE_TIME_CARD_CHOOSE_INTENT };
  }
  const expectedFingerprint = value.trim().toLowerCase();
  if (!NATIVE_TIME_CARD_FINGERPRINT_PATTERN.test(expectedFingerprint)) {
    return { ok: false, status: 400, error: NATIVE_TIME_CARD_CHOOSE_INTENT };
  }
  return { ok: true, expectedFingerprint };
}

function parseIntendedAt(
  value: unknown,
  now: Date,
): { ok: true; intendedAt: string } | { ok: false; status: 400 | 413; error: string } {
  if (typeof value !== "string") {
    return { ok: false, status: 400, error: NATIVE_TIME_CARD_CHOOSE_INTENT };
  }
  if (value.length > NATIVE_TIME_CARD_INTENDED_AT_MAX_CHARS) {
    return { ok: false, status: 413, error: NATIVE_SESSION_TOO_LARGE };
  }
  const intendedAt = value.trim();
  const parsed = Date.parse(intendedAt);
  if (!intendedAt || Number.isNaN(parsed)) {
    return { ok: false, status: 400, error: NATIVE_TIME_CARD_CHOOSE_INTENT };
  }
  if (parsed > now.getTime() + TIME_CORRECTION_FUTURE_SLACK_MS) {
    return { ok: false, status: 400, error: NATIVE_TIME_CARD_CHOOSE_INTENT };
  }
  if (parsed < now.getTime() - NATIVE_TIME_CARD_LOOKBACK_MS) {
    return { ok: false, status: 400, error: NATIVE_TIME_CARD_START_TOO_OLD };
  }
  return { ok: true, intendedAt: new Date(parsed).toISOString() };
}

function parseIntents(
  value: unknown,
  now: Date,
):
  | { ok: true; intents: NativeTimeCardDraftIntent[] }
  | { ok: false; status: 400 | 413; error: string } {
  if (!Array.isArray(value) || value.length === 0 || value.length > NATIVE_TIME_CARD_MAX_INTENTS) {
    return { ok: false, status: 400, error: NATIVE_TIME_CARD_CHOOSE_INTENT };
  }
  const intents: NativeTimeCardDraftIntent[] = [];
  const seen = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return { ok: false, status: 400, error: NATIVE_TIME_CARD_CHOOSE_INTENT };
    }
    const payload = row as Record<string, unknown>;
    const rawAction = payload.action;
    if (typeof rawAction === "string" && rawAction.length > NATIVE_TIME_CARD_ACTION_MAX_CHARS) {
      return { ok: false, status: 413, error: NATIVE_SESSION_TOO_LARGE };
    }
    if (typeof rawAction !== "string" || !isNativeTimeCardDraftAction(rawAction)) {
      return { ok: false, status: 400, error: NATIVE_TIME_CARD_CHOOSE_INTENT };
    }
    if (seen.has(rawAction)) {
      return { ok: false, status: 400, error: NATIVE_TIME_CARD_DUPLICATE_MESSAGE };
    }
    const intended = parseIntendedAt(payload.intendedAt, now);
    if (!intended.ok) return intended;
    const previous = intents[intents.length - 1];
    if (previous && Date.parse(intended.intendedAt) <= Date.parse(previous.intendedAt)) {
      return { ok: false, status: 400, error: NATIVE_TIME_CARD_OUT_OF_ORDER };
    }
    seen.add(rawAction);
    intents.push({ action: rawAction, intendedAt: intended.intendedAt });
  }
  return { ok: true, intents };
}

export function parseNativeTimeCardSyncJson(
  text: string,
  now: Date = new Date(),
):
  | {
      ok: true;
      expectedFingerprint: string;
      intents: NativeTimeCardDraftIntent[];
    }
  | { ok: false; status: 400 | 413; error: string } {
  if (!text.trim()) {
    return { ok: false, status: 400, error: NATIVE_TIME_CARD_CHOOSE_INTENT };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, error: NATIVE_TIME_CARD_CHOOSE_INTENT };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, status: 400, error: NATIVE_TIME_CARD_CHOOSE_INTENT };
  }
  const payload = parsed as Record<string, unknown>;
  const fingerprint = parseExpectedFingerprint(payload.expectedFingerprint);
  if (!fingerprint.ok) return fingerprint;
  const intents = parseIntents(payload.intents, now);
  if (!intents.ok) return intents;
  return {
    ok: true,
    expectedFingerprint: fingerprint.expectedFingerprint,
    intents: intents.intents,
  };
}

class TimeCardSyncError extends Error {
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = "TimeCardSyncError";
    this.status = status;
  }
}

function isoOrNull(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

async function loadClockSnapshot(
  db: Db,
  access: NativeFieldAccess,
  job: { id: string; status: string; assignedMembershipId: string | null },
): Promise<TimeCardClockSnapshot> {
  const clocks = {
    JOB: idleClock(),
    TRAVEL: idleClock(),
    MATERIAL_PICKUP: idleClock(),
  };
  for (const activityType of ["JOB", "TRAVEL", "MATERIAL_PICKUP"] as const) {
    const running = await db.timeEntry.findFirst({
      where: {
        businessId: access.businessId,
        membershipId: access.membershipId,
        jobId: job.id,
        activityType,
        status: "RUNNING",
        endedAt: null,
      },
      select: { startedAt: true },
      orderBy: { startedAt: "desc" },
    });
    if (running) {
      clocks[activityType] = {
        running: true,
        startedAt: running.startedAt.toISOString(),
        endedAt: null,
      };
      continue;
    }
    const latest = await db.timeEntry.findFirst({
      where: {
        businessId: access.businessId,
        membershipId: access.membershipId,
        jobId: job.id,
        activityType,
        endedAt: { not: null },
      },
      select: { startedAt: true, endedAt: true },
      orderBy: [{ endedAt: "desc" }, { startedAt: "desc" }],
    });
    clocks[activityType] = latest?.endedAt
      ? {
          running: false,
          startedAt: latest.startedAt.toISOString(),
          endedAt: isoOrNull(latest.endedAt),
        }
      : idleClock();
  }
  return {
    jobStatus: job.status,
    assignmentId: job.assignedMembershipId ?? "",
    clocks,
  };
}

function assertSyncIntendedAt(intendedAt: Date, now: Date) {
  if (intendedAt.getTime() > now.getTime() + TIME_CORRECTION_FUTURE_SLACK_MS) {
    throw new TimeCardSyncError(NATIVE_TIME_CARD_CHOOSE_INTENT, 400);
  }
  if (intendedAt.getTime() < now.getTime() - NATIVE_TIME_CARD_LOOKBACK_MS) {
    throw new TimeCardSyncError(NATIVE_TIME_CARD_START_TOO_OLD, 400);
  }
}

function assertStrictlyIncreasingIntents(intents: NativeTimeCardDraftIntent[]) {
  for (let index = 1; index < intents.length; index += 1) {
    if (Date.parse(intents[index].intendedAt) <= Date.parse(intents[index - 1].intendedAt)) {
      throw new TimeCardSyncError(NATIVE_TIME_CARD_OUT_OF_ORDER, 400);
    }
  }
}

async function assertStopDurationAllowed(
  tx: Db,
  access: NativeFieldAccess,
  jobId: string,
  activityType: "JOB" | "TRAVEL" | "MATERIAL_PICKUP",
  endedAt: Date,
) {
  const running = await tx.timeEntry.findFirst({
    where: {
      businessId: access.businessId,
      membershipId: access.membershipId,
      jobId,
      activityType,
      status: "RUNNING",
      endedAt: null,
    },
    select: { startedAt: true },
    orderBy: { startedAt: "desc" },
  });
  if (!running) return;
  if (endedAt.getTime() - running.startedAt.getTime() > TIME_CORRECTION_MAX_DURATION_MS) {
    throw new TimeCardSyncError(NATIVE_TIME_CARD_DURATION_TOO_LONG);
  }
}

async function applyIntent(
  tx: Db,
  access: NativeFieldAccess,
  jobId: string,
  intent: NativeTimeCardDraftIntent,
  now: Date,
): Promise<{ startedJob: boolean }> {
  const intendedAt = new Date(intent.intendedAt);
  assertSyncIntendedAt(intendedAt, now);
  if (intent.action === "START_JOB") {
    const current = await tx.job.findFirst({
      where: { id: jobId, businessId: access.businessId },
      select: START_AUTHORIZE_SELECT,
    });
    if (!current) {
      throw new TimeCardSyncError(NATIVE_JOB_NOT_AVAILABLE, 404);
    }
    const lifecycle = evaluateStartJob(current.status);
    if (!lifecycle.ok) {
      throw new TimeCardSyncError(lifecycle.error);
    }
    if (lifecycle.nextStatus && startJobRequiresCustomerConfirmation(current)) {
      throw new TimeCardSyncError(CUSTOMER_HAS_NOT_CONFIRMED_APPOINTMENT);
    }
    const result = await startJobWithRunningTimeSafetyInTransaction(tx, {
      businessId: access.businessId,
      jobId,
      actorMembershipId: access.membershipId,
      startedAt: intendedAt,
    });
    if (!result.ok) {
      throw new TimeCardSyncError(result.error);
    }
    if (result.alreadyRunningTime) {
      throw new TimeCardSyncError(NATIVE_TIME_CARD_DUPLICATE_MESSAGE);
    }
    return { startedJob: !result.alreadyStarted };
  }
  if (intent.action === "STOP_JOB_TIME") {
    await assertStopDurationAllowed(tx, access, jobId, "JOB", intendedAt);
    const result = await stopRunningAssignedJobTimeInTransaction(tx, {
      businessId: access.businessId,
      jobId,
      actorMembershipId: access.membershipId,
      membershipId: access.membershipId,
      endedAt: intendedAt,
    });
    if (!result.ok) {
      throw new TimeCardSyncError(result.error);
    }
    if (result.alreadyStopped) {
      throw new TimeCardSyncError(NATIVE_TIME_CARD_DUPLICATE_MESSAGE);
    }
    return { startedJob: false };
  }
  const activityType = intent.action === "START_TRAVEL" || intent.action === "STOP_TRAVEL"
    ? "TRAVEL"
    : "MATERIAL_PICKUP";
  if (isStartAction(intent.action)) {
    const result = await startAssignedActivityTimeInTransaction(tx, {
      businessId: access.businessId,
      jobId,
      activityType,
      actorMembershipId: access.membershipId,
      startedAt: intendedAt,
    });
    if (!result.ok) {
      throw new TimeCardSyncError(result.error);
    }
    if (result.alreadyRunningTime) {
      throw new TimeCardSyncError(NATIVE_TIME_CARD_DUPLICATE_MESSAGE);
    }
    return { startedJob: false };
  }
  await assertStopDurationAllowed(tx, access, jobId, activityType, intendedAt);
  const result = await stopAssignedActivityTimeInTransaction(tx, {
    businessId: access.businessId,
    jobId,
    activityType,
    actorMembershipId: access.membershipId,
    membershipId: access.membershipId,
    endedAt: intendedAt,
  });
  if (!result.ok) {
    throw new TimeCardSyncError(result.error);
  }
  if (result.alreadyStopped) {
    throw new TimeCardSyncError(NATIVE_TIME_CARD_DUPLICATE_MESSAGE);
  }
  return { startedJob: false };
}

function syncFailure(error: unknown): Extract<NativeSyncAssignedTimeCardResult, { ok: false }> {
  if (error instanceof TimeCardSyncError) {
    return { ok: false, status: error.status, error: error.message };
  }
  if (isTimeCardError(error)) {
    return {
      ok: false,
      status: 409,
      error: timeCardErrorMessage(error, NATIVE_JOB_NOT_AVAILABLE),
    };
  }
  throw error;
}

export async function syncNativeAssignedTimeCardDraft(
  db: PrismaClient,
  access: NativeFieldAccess,
  jobId: string,
  input: {
    expectedFingerprint: string;
    intents: NativeTimeCardDraftIntent[];
  },
  options?: {
    /** Proof hook: runs after the authorize read and before the Job lock. */
    afterInitialRead?: () => Promise<void>;
    now?: Date;
  },
): Promise<NativeSyncAssignedTimeCardResult> {
  const now = options?.now ?? new Date();
  try {
    assertStrictlyIncreasingIntents(input.intents);
    for (const intent of input.intents) {
      assertSyncIntendedAt(new Date(intent.intendedAt), now);
    }
  } catch (error) {
    return syncFailure(error);
  }

  const assigned = await db.job.findFirst({
    where: nativeAssignedJobWhere(jobId, access),
    select: { id: true, customerId: true },
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

  let alreadySynced = false;
  let startedJob = false;
  try {
    const written = await db.$transaction(async (tx) => {
      const locked = await lockTenantOwnedJob(tx, access.businessId, assigned.id);
      if (!assignmentStillHeld(locked, access)) {
        throw new TimeCardSyncError(NATIVE_JOB_NOT_AVAILABLE, 404);
      }
      if (!(await exactActiveMembershipHeld(tx, access))) {
        throw new TimeCardSyncError(NATIVE_JOB_NOT_AVAILABLE, 404);
      }

      const current = await loadClockSnapshot(tx, access, locked);
      const currentFingerprint = timeCardStateFingerprint(current);
      const desired = applyTimeCardIntentsToSnapshot(current, input.intents);
      const desiredFingerprint = timeCardStateFingerprint(desired);

      if (currentFingerprint === input.expectedFingerprint) {
        if (desiredFingerprint === currentFingerprint) {
          throw new TimeCardSyncError(NATIVE_TIME_CARD_DUPLICATE_MESSAGE);
        }
      } else if (desiredFingerprint === currentFingerprint) {
        return { alreadySynced: true, startedJob: false };
      } else {
        throw new TimeCardSyncError(NATIVE_TIME_CARD_STALE_MESSAGE);
      }

      let didStartJob = false;
      for (const intent of input.intents) {
        const applied = await applyIntent(tx, access, locked.id, intent, now);
        if (applied.startedJob) didStartJob = true;
      }
      return { alreadySynced: false, startedJob: didStartJob };
    });
    alreadySynced = written.alreadySynced;
    startedJob = written.startedJob;
  } catch (error) {
    return syncFailure(error);
  }

  if (startedJob) {
    await emitAndProcessBusinessEvent(db, {
      businessId: access.businessId,
      type: "JOB_STARTED",
      subjectType: "JOB",
      subjectId: assigned.id,
      payload: { customerId: assigned.customerId },
      idempotencyKey: `JOB_STARTED:${assigned.id}`,
    });
  }

  const job = await loadNativeAssignedJob(db, access, assigned.id);
  if (!job) {
    return { ok: false, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
  }
  return { ok: true, alreadySynced, job };
}
