/**
 * Native assigned-job time-correction requests.
 *
 * Reads stay in `src/lib/native-field.ts`. After the assigned-job
 * authorize read, this module locks the Job, rechecks businessId and
 * assignedMembershipId plus the exact active Membership, then reuses
 * `requestTimeCorrection` from `src/lib/time-card-ops.ts`. It never
 * decides a request, rewrites TimeEntry times, sends an invoice, or
 * exposes another worker's entries.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { assertBusinessRecord, businessScope } from "@/lib/access-scope";
import { formatDateTime } from "@/lib/format";
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
import { productEntitlementErrorMessage } from "@/lib/product-entitlements/errors";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import {
  TIME_ACTIVITY_LABELS,
  TIME_CORRECTION_STATUS_LABELS,
  canRequestTimeCorrection,
  formatDateInput,
  formatDurationClock,
  formatTimeInput,
  hoursBetween,
  isTimeActivityType,
  isTimeCorrectionRequestStatus,
  parseBusinessDateTimeInput,
  weekRange,
  type TimeCorrectionRequestStatus,
} from "@/lib/time-cards";
import {
  isTimeCardError,
  lockTenantOwnedJob,
  requestTimeCorrection,
  timeCardErrorMessage,
} from "@/lib/time-card-ops";
import { ForbiddenError } from "@/lib/authorization";

type Db = PrismaClient | Prisma.TransactionClient;

export const NATIVE_TIME_CORRECTION_JSON_MAX_BYTES = 4096;
export const NATIVE_TIME_CORRECTION_LIMIT = 12;
export const NATIVE_TIME_CORRECTION_INVALID =
  "Describe the correction and the proposed start and end times.";
export const NATIVE_TIME_CORRECTION_ENTRY_MISSING = "That time entry could not be found.";
export const NATIVE_TIME_CORRECTION_PENDING_WAIT =
  "Waiting for the owner to accept or decline.";

const NATIVE_TIME_ENTRY_ID_MAX_CHARS = 128;
const NATIVE_TIME_CORRECTION_REASON_MAX_CHARS = 500;
const NATIVE_TIME_CORRECTION_INSTANT_MAX_CHARS = 64;
const NATIVE_TIME_CORRECTION_DATE_MAX_CHARS = 16;
const NATIVE_TIME_CORRECTION_TIME_MAX_CHARS = 16;

export type NativeTimeCorrectionEntry = {
  id: string;
  activityType: string;
  activityLabel: string;
  startedAt: string;
  startedAtLabel: string;
  endedAt: string;
  endedAtLabel: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  hours: number;
  hoursLabel: string;
  canRequest: boolean;
  blockedReason: string | null;
  requestStatus: TimeCorrectionRequestStatus | null;
  requestStatusLabel: string | null;
  requestReason: string | null;
  proposedStartedAt: string | null;
  proposedEndedAt: string | null;
  proposedClockLabel: string | null;
};

export type NativeJobTimeCorrections = {
  entries: NativeTimeCorrectionEntry[];
  truncated: boolean;
  limit: number;
  truncatedNotice: string | null;
};

export type NativeTimeCorrectionRequestInput = {
  timeEntryId: string;
  reason: string;
  proposedStartedAt?: string | null;
  proposedEndedAt?: string | null;
  proposedStartDate?: string | null;
  proposedStartTime?: string | null;
  proposedEndDate?: string | null;
  proposedEndTime?: string | null;
};

export type NativeRequestAssignedTimeCorrectionResult =
  | { ok: true; job: NativeJobDetail }
  | { ok: false; status: number; error: string };

export type NativeReadAssignedTimeCorrectionsResult =
  | { ok: true; timeCorrections: NativeJobTimeCorrections }
  | { ok: false; status: number; error: string };

export function nativeTimeCorrectionTruncatedNotice(
  limit = NATIVE_TIME_CORRECTION_LIMIT,
) {
  return `Showing the first ${limit} recorded time entries. More are on this job; this list is capped.`;
}

export function emptyNativeJobTimeCorrections(): NativeJobTimeCorrections {
  return {
    entries: [],
    truncated: false,
    limit: NATIVE_TIME_CORRECTION_LIMIT,
    truncatedNotice: null,
  };
}

export function parseNativeTimeCorrectionJson(text: string):
  | { ok: true; input: NativeTimeCorrectionRequestInput }
  | { ok: false; status: 400 | 413; error: string } {
  if (!text.trim()) {
    return { ok: false, status: 400, error: NATIVE_TIME_CORRECTION_INVALID };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, error: NATIVE_TIME_CORRECTION_INVALID };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, status: 400, error: NATIVE_TIME_CORRECTION_INVALID };
  }
  const payload = parsed as Record<string, unknown>;
  if (oversizedString(payload.timeEntryId, NATIVE_TIME_ENTRY_ID_MAX_CHARS)) {
    return { ok: false, status: 413, error: NATIVE_SESSION_TOO_LARGE };
  }
  if (oversizedString(payload.reason, NATIVE_TIME_CORRECTION_REASON_MAX_CHARS)) {
    return { ok: false, status: 413, error: NATIVE_SESSION_TOO_LARGE };
  }
  for (const key of ["proposedStartedAt", "proposedEndedAt"] as const) {
    if (oversizedString(payload[key], NATIVE_TIME_CORRECTION_INSTANT_MAX_CHARS)) {
      return { ok: false, status: 413, error: NATIVE_SESSION_TOO_LARGE };
    }
  }
  for (const key of [
    "proposedStartDate",
    "proposedEndDate",
  ] as const) {
    if (oversizedString(payload[key], NATIVE_TIME_CORRECTION_DATE_MAX_CHARS)) {
      return { ok: false, status: 413, error: NATIVE_SESSION_TOO_LARGE };
    }
  }
  for (const key of ["proposedStartTime", "proposedEndTime"] as const) {
    if (oversizedString(payload[key], NATIVE_TIME_CORRECTION_TIME_MAX_CHARS)) {
      return { ok: false, status: 413, error: NATIVE_SESSION_TOO_LARGE };
    }
  }

  const timeEntryId = typeof payload.timeEntryId === "string" ? payload.timeEntryId.trim() : "";
  const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
  if (!timeEntryId || !reason) {
    return { ok: false, status: 400, error: NATIVE_TIME_CORRECTION_INVALID };
  }

  return {
    ok: true,
    input: {
      timeEntryId,
      reason,
      proposedStartedAt: optionalTrimmedString(payload.proposedStartedAt),
      proposedEndedAt: optionalTrimmedString(payload.proposedEndedAt),
      proposedStartDate: optionalTrimmedString(payload.proposedStartDate),
      proposedStartTime: optionalTrimmedString(payload.proposedStartTime),
      proposedEndDate: optionalTrimmedString(payload.proposedEndDate),
      proposedEndTime: optionalTrimmedString(payload.proposedEndTime),
    },
  };
}

export function resolveNativeTimeCorrectionTimes(
  input: NativeTimeCorrectionRequestInput,
  timeZone: string,
): { ok: true; proposedStartedAt: Date; proposedEndedAt: Date } | { ok: false; status: 400; error: string } {
  const fromParts = resolveProposedTimesFromParts(input, timeZone);
  if (fromParts) return fromParts;

  const proposedStartedAt = parseIsoInstant(input.proposedStartedAt);
  const proposedEndedAt = parseIsoInstant(input.proposedEndedAt);
  if (!proposedStartedAt || !proposedEndedAt) {
    return { ok: false, status: 400, error: NATIVE_TIME_CORRECTION_INVALID };
  }
  return { ok: true, proposedStartedAt, proposedEndedAt };
}

export async function readNativeAssignedJobTimeCorrections(
  db: PrismaClient,
  access: NativeFieldAccess,
  jobId: string,
): Promise<NativeReadAssignedTimeCorrectionsResult> {
  const assigned = await db.job.findFirst({
    where: nativeAssignedJobWhere(jobId, access),
    select: { id: true },
  });
  if (!assigned) {
    return { ok: false, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
  }
  const timeZone = await loadAccessTimeZone(db, access.businessId);
  return {
    ok: true,
    timeCorrections: await loadNativeAssignedJobTimeCorrections(db, access, assigned.id, timeZone),
  };
}

export async function loadNativeAssignedJobTimeCorrections(
  db: Db,
  access: Pick<NativeFieldAccess, "businessId" | "membershipId">,
  jobId: string,
  timeZone: string,
): Promise<NativeJobTimeCorrections> {
  const rows = await db.timeEntry.findMany({
    where: {
      businessId: access.businessId,
      membershipId: access.membershipId,
      jobId,
      endedAt: { not: null },
    },
    include: {
      correctionRequests: {
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: NATIVE_TIME_CORRECTION_LIMIT + 1,
  });
  const truncated = rows.length > NATIVE_TIME_CORRECTION_LIMIT;
  const listed = truncated ? rows.slice(0, NATIVE_TIME_CORRECTION_LIMIT) : rows;
  const weekStarts = uniqueWeekStarts(
    listed.map((entry) => weekRange(entry.startedAt, timeZone).start),
  );
  const weeks =
    weekStarts.length === 0
      ? []
      : await db.timesheetWeek.findMany({
          where: {
            businessId: access.businessId,
            membershipId: access.membershipId,
            weekStartedAt: { in: weekStarts },
          },
          select: { weekStartedAt: true, status: true },
        });

  return {
    entries: listed.flatMap((entry) => {
      if (!entry.endedAt) return [];
      return [toNativeTimeCorrectionEntry(entry, weeks, timeZone)];
    }),
    truncated,
    limit: NATIVE_TIME_CORRECTION_LIMIT,
    truncatedNotice: truncated ? nativeTimeCorrectionTruncatedNotice() : null,
  };
}

export async function requestNativeAssignedJobTimeCorrection(
  db: PrismaClient,
  access: NativeFieldAccess,
  jobId: string,
  input: NativeTimeCorrectionRequestInput,
  options?: {
    /** Proof hook: runs after the authorize read and before the Job lock. */
    afterInitialRead?: () => Promise<void>;
  },
): Promise<NativeRequestAssignedTimeCorrectionResult> {
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

  const businessAccess = await loadNativeBusinessAccess(db, access);
  if (!businessAccess.ok) {
    return businessAccess;
  }
  const times = resolveNativeTimeCorrectionTimes(input, businessAccess.timeZone);
  if (!times.ok) {
    return times;
  }

  if (options?.afterInitialRead) {
    await options.afterInitialRead();
  }

  const authorized = await db.$transaction(async (tx) => {
    const locked = await lockTenantOwnedJob(tx, access.businessId, assigned.id);
    if (!assignmentStillHeld(locked, access)) {
      return { ok: false as const, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
    }
    if (!(await exactActiveMembershipHeld(tx, access))) {
      return { ok: false as const, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
    }
    const entry = await tx.timeEntry.findFirst({
      where: {
        id: input.timeEntryId,
        businessId: access.businessId,
        membershipId: access.membershipId,
        jobId: locked.id,
        endedAt: { not: null },
      },
      select: { id: true },
    });
    if (!entry) {
      return { ok: false as const, status: 404, error: NATIVE_TIME_CORRECTION_ENTRY_MISSING };
    }
    return { ok: true as const, timeEntryId: entry.id };
  });
  if (!authorized.ok) {
    return authorized;
  }

  try {
    await requestTimeCorrection(db, businessAccess.access, {
      timeEntryId: authorized.timeEntryId,
      reason: input.reason,
      proposedStartedAt: times.proposedStartedAt,
      proposedEndedAt: times.proposedEndedAt,
      timeZone: businessAccess.timeZone,
    });
  } catch (error) {
    return mapTimeCorrectionWriteError(error);
  }

  const job = await loadNativeAssignedJob(db, access, assigned.id);
  if (!job) {
    return { ok: false, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
  }
  return { ok: true, job };
}

function toNativeTimeCorrectionEntry(
  entry: {
    id: string;
    activityType: string;
    status: string;
    startedAt: Date;
    endedAt: Date | null;
    correctionRequests: Array<{
      status: string;
      reason: string;
      proposedStartedAt: Date;
      proposedEndedAt: Date;
    }>;
  },
  weeks: Array<{ weekStartedAt: Date; status: string }>,
  timeZone: string,
): NativeTimeCorrectionEntry {
  const endedAt = entry.endedAt;
  if (!endedAt) {
    throw new Error("Ended time is required for a native correction entry.");
  }
  const week = weeks.find(
    (row) => row.weekStartedAt.getTime() === weekRange(entry.startedAt, timeZone).start.getTime(),
  );
  const latest = entry.correctionRequests[0];
  const requestStatus =
    latest && isTimeCorrectionRequestStatus(latest.status) ? latest.status : null;
  const gate = canRequestTimeCorrection({
    entryStatus: entry.status,
    endedAt,
    weekStatus: week?.status,
  });
  const canRequest = gate.ok && requestStatus !== "PENDING";
  const activityType = isTimeActivityType(entry.activityType) ? entry.activityType : "OTHER";
  const hours = hoursBetween(entry.startedAt, endedAt);
  return {
    id: entry.id,
    activityType,
    activityLabel: TIME_ACTIVITY_LABELS[activityType],
    startedAt: entry.startedAt.toISOString(),
    startedAtLabel: formatDateTime(entry.startedAt, timeZone),
    endedAt: endedAt.toISOString(),
    endedAtLabel: formatDateTime(endedAt, timeZone),
    startDate: formatDateInput(entry.startedAt, timeZone),
    startTime: formatTimeInput(entry.startedAt, timeZone),
    endDate: formatDateInput(endedAt, timeZone),
    endTime: formatTimeInput(endedAt, timeZone),
    hours,
    hoursLabel: formatDurationClock(hours),
    canRequest,
    blockedReason: canRequest
      ? null
      : requestStatus === "PENDING"
        ? NATIVE_TIME_CORRECTION_PENDING_WAIT
        : (gate.error ?? null),
    requestStatus,
    requestStatusLabel: requestStatus ? TIME_CORRECTION_STATUS_LABELS[requestStatus] : null,
    requestReason: latest?.reason ?? null,
    proposedStartedAt: latest?.proposedStartedAt.toISOString() ?? null,
    proposedEndedAt: latest?.proposedEndedAt.toISOString() ?? null,
    proposedClockLabel: latest
      ? `${formatDateTime(latest.proposedStartedAt, timeZone)} – ${formatDateTime(latest.proposedEndedAt, timeZone)}`
      : null,
  };
}

async function loadNativeBusinessAccess(
  db: PrismaClient,
  access: NativeFieldAccess,
): Promise<
  | { ok: true; access: BusinessAccess; timeZone: string }
  | { ok: false; status: number; error: string }
> {
  const membership = await db.membership.findFirst({
    where: {
      id: access.membershipId,
      businessId: access.businessId,
      userId: access.userId,
    },
    include: { business: true },
  });
  if (!membership) {
    return { ok: false, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
  }
  const businessId = access.businessId;
  return {
    ok: true,
    timeZone: resolveBusinessTimeZone(membership.business),
    access: {
      businessId,
      workspace: {
        user: {
          id: access.userId,
          email: access.viewer.email,
          name: access.viewer.name,
        },
        business: membership.business,
        membership,
        role: access.workspace.role,
      },
      scope: businessScope(businessId),
      assertOwned: (record) => assertBusinessRecord(record, businessId),
      assertAttachable: (record) => assertBusinessRecord(record, businessId),
    },
  };
}

async function loadAccessTimeZone(db: Db, businessId: string) {
  return resolveBusinessTimeZone(
    await db.business.findFirst({
      where: { id: businessId },
      select: { timezone: true },
    }),
  );
}

function resolveProposedTimesFromParts(
  input: NativeTimeCorrectionRequestInput,
  timeZone: string,
):
  | { ok: true; proposedStartedAt: Date; proposedEndedAt: Date }
  | { ok: false; status: 400; error: string }
  | null {
  const hasStartParts = Boolean(input.proposedStartDate && input.proposedStartTime);
  const hasEndParts = Boolean(input.proposedEndDate && input.proposedEndTime);
  if (!hasStartParts && !hasEndParts) return null;
  if (!hasStartParts || !hasEndParts) {
    return { ok: false, status: 400, error: NATIVE_TIME_CORRECTION_INVALID };
  }
  const started = parseBusinessDateTimeInput(
    input.proposedStartDate ?? "",
    input.proposedStartTime ?? "",
    timeZone,
  );
  const ended = parseBusinessDateTimeInput(
    input.proposedEndDate ?? "",
    input.proposedEndTime ?? "",
    timeZone,
  );
  if (!started.ok) {
    return { ok: false, status: 400, error: started.error };
  }
  if (!ended.ok) {
    return { ok: false, status: 400, error: ended.error };
  }
  return { ok: true, proposedStartedAt: started.value, proposedEndedAt: ended.value };
}

function mapTimeCorrectionWriteError(
  error: unknown,
): { ok: false; status: number; error: string } {
  const productMessage = productEntitlementErrorMessage(error);
  if (productMessage) {
    return { ok: false, status: 403, error: productMessage };
  }
  const saasMessage = saasOperatingErrorMessage(error);
  if (saasMessage) {
    return { ok: false, status: 403, error: saasMessage };
  }
  if (error instanceof ForbiddenError) {
    return { ok: false, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
  }
  if (isTimeCardError(error)) {
    const message = timeCardErrorMessage(error, NATIVE_TIME_CORRECTION_ENTRY_MISSING);
    if (message === NATIVE_TIME_CORRECTION_ENTRY_MISSING) {
      return { ok: false, status: 404, error: message };
    }
    if (
      message === "Describe the correction you need." ||
      message === "Proposed end time must be after the proposed start time."
    ) {
      return { ok: false, status: 400, error: message };
    }
    return { ok: false, status: 409, error: message };
  }
  throw error;
}

function uniqueWeekStarts(starts: Date[]) {
  const seen = new Set<number>();
  const values: Date[] = [];
  for (const start of starts) {
    const key = start.getTime();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(start);
  }
  return values;
}

function optionalTrimmedString(value: unknown) {
  return typeof value === "string" ? value.trim() : null;
}

function oversizedString(value: unknown, maxChars: number) {
  return typeof value === "string" && value.length > maxChars;
}

function parseIsoInstant(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
