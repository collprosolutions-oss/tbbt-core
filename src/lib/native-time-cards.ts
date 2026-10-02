/**
 * Native worker time-card reads and correction requests.
 *
 * Reads stay on the caller's own recorded TimeEntry rows
 * (businessId + membershipId). The write reuses
 * `requestTimeCorrection` in `src/lib/time-card-ops.ts` and the same
 * `canRequestTimeCorrection` gate as Field Home. Active membership is
 * re-checked with FOR UPDATE inside that write transaction; the
 * `active: true` pre-read here is only a fast fail. It does not accept
 * or decline requests, rewrite approved time, or touch payroll.
 */
import type { PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { assertBusinessRecord, businessScope } from "@/lib/access-scope";
import { ForbiddenError } from "@/lib/authorization";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import { formatTime } from "@/lib/format";
import { nativeAssignedJobLabel } from "@/lib/native-assigned-stops";
import { NATIVE_SESSION_TOO_LARGE } from "@/lib/native-session-limits";
import type { NativeFieldAccess, NativeViewer, NativeWorkspace } from "@/lib/native-session";
import { addDays } from "@/lib/schedule";
import {
  TIME_ACTIVITY_LABELS,
  TIME_CORRECTION_STATUS_LABELS,
  canRequestTimeCorrection,
  formatDateInput,
  formatTimeInput,
  isTimeActivityType,
  isTimeCorrectionRequestStatus,
  parseBusinessDateTimeInput,
  weekRange,
  type TimeCorrectionRequestStatus,
} from "@/lib/time-cards";
import {
  isTimeCardError,
  requestTimeCorrection,
  timeCardErrorMessage,
} from "@/lib/time-card-ops";

export const NATIVE_TIME_CARD_JSON_MAX_BYTES = 4096;
export const NATIVE_TIME_CARD_ENTRY_LIMIT = 12;
export const NATIVE_TIME_ENTRY_NOT_AVAILABLE = "That time entry is not available.";
export const NATIVE_TIME_CORRECTION_CHOOSE_ENTRY = "Choose a recorded time entry.";
export const NATIVE_TIME_CORRECTION_REASON_REQUIRED = "Describe the correction you need.";
export const NATIVE_TIME_CORRECTION_TIMES_REQUIRED = "Enter the proposed start and end times.";
export const NATIVE_TIME_CORRECTION_REQUESTED =
  "Correction requested. The original time stays until an owner decides.";
export const NATIVE_TIME_CORRECTION_PENDING_REASON =
  "Waiting for the owner to accept or decline.";

const NATIVE_TIME_CARD_FIELD_MAX_CHARS = {
  timeEntryId: 64,
  reason: 500,
  date: 16,
  time: 16,
} as const;

export type NativeTimeCardEntry = {
  id: string;
  activityLabel: string;
  jobLabel: string | null;
  clockLabel: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  canRequest: boolean;
  blockedReason: string | null;
  requestStatus: TimeCorrectionRequestStatus | null;
  requestStatusLabel: string | null;
  requestReason: string | null;
  proposedClockLabel: string | null;
};

export type NativeTimeCardsPayload = {
  viewer: NativeViewer;
  workspace: NativeWorkspace;
  timeZone: string;
  entries: NativeTimeCardEntry[];
};

export type NativeTimeCorrectionInput = {
  timeEntryId: string;
  reason: string;
  proposedStartDate: string;
  proposedStartTime: string;
  proposedEndDate: string;
  proposedEndTime: string;
};

export type NativeRequestTimeCorrectionResult =
  | {
      ok: true;
      timeCards: NativeTimeCardsPayload;
      request: { id: string; status: TimeCorrectionRequestStatus; timeEntryId: string };
      message: string;
    }
  | { ok: false; status: number; error: string };

function readBoundedString(
  value: unknown,
  maxChars: number,
): { ok: true; value: string } | { ok: false; status: 413 } {
  if (typeof value !== "string") {
    return { ok: true, value: "" };
  }
  if (value.length > maxChars) {
    return { ok: false, status: 413 };
  }
  return { ok: true, value: value.trim() };
}

export function parseNativeTimeCorrectionJson(text: string):
  | { ok: true; input: NativeTimeCorrectionInput }
  | { ok: false; status: 400 | 413; error: string } {
  if (!text.trim()) {
    return { ok: false, status: 400, error: NATIVE_TIME_CORRECTION_CHOOSE_ENTRY };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, error: NATIVE_TIME_CORRECTION_CHOOSE_ENTRY };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, status: 400, error: NATIVE_TIME_CORRECTION_CHOOSE_ENTRY };
  }
  const payload = parsed as Record<string, unknown>;
  const timeEntryId = readBoundedString(payload.timeEntryId, NATIVE_TIME_CARD_FIELD_MAX_CHARS.timeEntryId);
  const reason = readBoundedString(payload.reason, NATIVE_TIME_CARD_FIELD_MAX_CHARS.reason);
  const proposedStartDate = readBoundedString(
    payload.proposedStartDate,
    NATIVE_TIME_CARD_FIELD_MAX_CHARS.date,
  );
  const proposedStartTime = readBoundedString(
    payload.proposedStartTime,
    NATIVE_TIME_CARD_FIELD_MAX_CHARS.time,
  );
  const proposedEndDate = readBoundedString(
    payload.proposedEndDate,
    NATIVE_TIME_CARD_FIELD_MAX_CHARS.date,
  );
  const proposedEndTime = readBoundedString(
    payload.proposedEndTime,
    NATIVE_TIME_CARD_FIELD_MAX_CHARS.time,
  );
  if (
    !timeEntryId.ok ||
    !reason.ok ||
    !proposedStartDate.ok ||
    !proposedStartTime.ok ||
    !proposedEndDate.ok ||
    !proposedEndTime.ok
  ) {
    return { ok: false, status: 413, error: NATIVE_SESSION_TOO_LARGE };
  }
  if (!timeEntryId.value) {
    return { ok: false, status: 400, error: NATIVE_TIME_CORRECTION_CHOOSE_ENTRY };
  }
  if (!reason.value) {
    return { ok: false, status: 400, error: NATIVE_TIME_CORRECTION_REASON_REQUIRED };
  }
  if (
    !proposedStartDate.value ||
    !proposedStartTime.value ||
    !proposedEndDate.value ||
    !proposedEndTime.value
  ) {
    return { ok: false, status: 400, error: NATIVE_TIME_CORRECTION_TIMES_REQUIRED };
  }
  return {
    ok: true,
    input: {
      timeEntryId: timeEntryId.value,
      reason: reason.value,
      proposedStartDate: proposedStartDate.value,
      proposedStartTime: proposedStartTime.value,
      proposedEndDate: proposedEndDate.value,
      proposedEndTime: proposedEndTime.value,
    },
  };
}

async function nativeTimeCardBusinessAccess(
  db: PrismaClient,
  access: NativeFieldAccess,
): Promise<BusinessAccess | null> {
  const [business, membership] = await Promise.all([
    db.business.findFirst({ where: { id: access.businessId } }),
    db.membership.findFirst({
      where: {
        id: access.membershipId,
        businessId: access.businessId,
        active: true,
      },
    }),
  ]);
  if (!business || !membership) return null;

  return {
    businessId: access.businessId,
    workspace: {
      user: {
        id: access.userId,
        email: access.viewer.email,
        name: access.viewer.name,
      },
      business,
      membership,
      role: access.workspace.role,
    },
    scope: businessScope(access.businessId),
    assertOwned(record) {
      return assertBusinessRecord(record, access.businessId);
    },
    assertAttachable(record) {
      return assertBusinessRecord(record, access.businessId);
    },
  };
}

function mapTimeCardError(error: unknown): { status: number; error: string } {
  if (error instanceof ForbiddenError) {
    return { status: 403, error: error.message };
  }
  const message = timeCardErrorMessage(error, NATIVE_TIME_ENTRY_NOT_AVAILABLE);
  if (isTimeCardError(error) && /could not be found/i.test(message)) {
    return { status: 404, error: NATIVE_TIME_ENTRY_NOT_AVAILABLE };
  }
  if (
    isTimeCardError(error) &&
    /describe the correction|must be after|enter the proposed|invalid|does not exist|cannot be in the future|longer than 24|too far in the past/i.test(
      message,
    )
  ) {
    return { status: 400, error: message };
  }
  return { status: 409, error: message };
}

export async function loadNativeTimeCards(
  db: PrismaClient,
  access: NativeFieldAccess,
  options?: { now?: Date },
): Promise<NativeTimeCardsPayload> {
  const timeZone = resolveBusinessTimeZone(
    await db.business.findFirst({
      where: { id: access.businessId },
      select: { timezone: true },
    }),
  );
  const now = options?.now ?? new Date();
  const { start: recentStart } = weekRange(addDays(now, -7, timeZone), timeZone);

  const [ownEntries, ownWeeks] = await Promise.all([
    db.timeEntry.findMany({
      where: {
        businessId: access.businessId,
        membershipId: access.membershipId,
        endedAt: { not: null },
        startedAt: { gte: recentStart },
      },
      include: {
        job: {
          select: {
            customer: { select: { name: true } },
            property: { select: { id: true, businessId: true, addressLine1: true } },
          },
        },
        correctionRequests: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      orderBy: { startedAt: "desc" },
      take: NATIVE_TIME_CARD_ENTRY_LIMIT,
    }),
    db.timesheetWeek.findMany({
      where: {
        businessId: access.businessId,
        membershipId: access.membershipId,
        weekStartedAt: { gte: recentStart },
      },
      take: 12,
    }),
  ]);

  return {
    viewer: access.viewer,
    workspace: access.workspace,
    timeZone,
    entries: ownEntries.flatMap((entry) => {
      if (!entry.endedAt) return [];
      const week = ownWeeks.find(
        (row) =>
          row.weekStartedAt.getTime() === weekRange(entry.startedAt, timeZone).start.getTime(),
      );
      const latest = entry.correctionRequests[0];
      const requestStatus =
        latest && isTimeCorrectionRequestStatus(latest.status) ? latest.status : null;
      const gate = canRequestTimeCorrection({
        entryStatus: entry.status,
        endedAt: entry.endedAt,
        weekStatus: week?.status,
      });
      const canRequest = gate.ok && requestStatus !== "PENDING";
      return [
        {
          id: entry.id,
          activityLabel:
            TIME_ACTIVITY_LABELS[isTimeActivityType(entry.activityType) ? entry.activityType : "OTHER"],
          jobLabel: nativeAssignedJobLabel(entry.job, access.businessId),
          clockLabel: `${formatTime(entry.startedAt, timeZone)} – ${formatTime(entry.endedAt, timeZone)}`,
          startDate: formatDateInput(entry.startedAt, timeZone),
          startTime: formatTimeInput(entry.startedAt, timeZone),
          endDate: formatDateInput(entry.endedAt, timeZone),
          endTime: formatTimeInput(entry.endedAt, timeZone),
          canRequest,
          blockedReason: canRequest
            ? null
            : requestStatus === "PENDING"
              ? NATIVE_TIME_CORRECTION_PENDING_REASON
              : (gate.error ?? null),
          requestStatus,
          requestStatusLabel: requestStatus ? TIME_CORRECTION_STATUS_LABELS[requestStatus] : null,
          requestReason: latest?.reason ?? null,
          proposedClockLabel: latest
            ? `${formatTime(latest.proposedStartedAt, timeZone)} – ${formatTime(latest.proposedEndedAt, timeZone)}`
            : null,
        },
      ];
    }),
  };
}

export async function requestNativeTimeCorrection(
  db: PrismaClient,
  access: NativeFieldAccess,
  input: NativeTimeCorrectionInput,
  options?: { afterInitialRead?: () => Promise<void> },
): Promise<NativeRequestTimeCorrectionResult> {
  const businessAccess = await nativeTimeCardBusinessAccess(db, access);
  if (!businessAccess) {
    return { ok: false, status: 404, error: NATIVE_TIME_ENTRY_NOT_AVAILABLE };
  }

  const owned = await db.timeEntry.findFirst({
    where: {
      id: input.timeEntryId,
      businessId: access.businessId,
    },
    select: {
      id: true,
      membershipId: true,
      startedAt: true,
      endedAt: true,
    },
  });
  if (!owned) {
    return { ok: false, status: 404, error: NATIVE_TIME_ENTRY_NOT_AVAILABLE };
  }
  if (owned.membershipId !== access.membershipId) {
    return { ok: false, status: 403, error: new ForbiddenError().message };
  }

  const timeZone = resolveBusinessTimeZone(businessAccess.workspace.business);
  const proposedStartedAt = parseBusinessDateTimeInput(
    input.proposedStartDate,
    input.proposedStartTime,
    timeZone,
    owned.startedAt,
  );
  const proposedEndedAt = parseBusinessDateTimeInput(
    input.proposedEndDate,
    input.proposedEndTime,
    timeZone,
    owned.endedAt,
  );
  if (!proposedStartedAt.ok) {
    return { ok: false, status: 400, error: proposedStartedAt.error };
  }
  if (!proposedEndedAt.ok) {
    return { ok: false, status: 400, error: proposedEndedAt.error };
  }

  try {
    const result = await requestTimeCorrection(
      db,
      businessAccess,
      {
        timeEntryId: owned.id,
        reason: input.reason,
        proposedStartedAt: proposedStartedAt.value,
        proposedEndedAt: proposedEndedAt.value,
        timeZone,
      },
      { afterInitialRead: options?.afterInitialRead },
    );
    const timeCards = await loadNativeTimeCards(db, access);
    const status = isTimeCorrectionRequestStatus(result.request.status)
      ? result.request.status
      : "PENDING";
    return {
      ok: true,
      timeCards,
      request: {
        id: result.request.id,
        status,
        timeEntryId: result.request.timeEntryId,
      },
      message: NATIVE_TIME_CORRECTION_REQUESTED,
    };
  } catch (error) {
    return { ok: false, ...mapTimeCardError(error) };
  }
}
