/**
 * Native assigned-job problem-report reads and writes.
 *
 * After the assigned-job authorize read (`businessId` +
 * `assignedMembershipId`), writes reuse `reportAssignedJobProblem` — the
 * same Job lock, business / assignment / active-membership / job-state
 * recheck, and JobProblemReport create as Field Home. A report never
 * completes, cancels, or reschedules the Job and never sends a customer
 * message.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { formatDateTime } from "@/lib/format";
import {
  FIELD_JOB_NOT_ASSIGNED,
  FIELD_JOB_PROBLEM_CLOSED,
  FIELD_JOB_PROBLEM_DESCRIBE,
  FIELD_JOB_PROBLEM_DESCRIPTION_MAX,
  assignedJobCanReceiveProblemReport,
  normalizeAssignedJobProblemDescription,
  reportAssignedJobProblem,
} from "@/lib/field-job-ops";
import type { NativeJobDetail } from "@/lib/native-field";
import { NATIVE_JOB_NOT_AVAILABLE } from "@/lib/native-field-ops";
import type { NativeFieldAccess } from "@/lib/native-session";
import { NATIVE_SESSION_TOO_LARGE } from "@/lib/native-session-limits";
import {
  requireSaasOperatingEntitlement,
  saasOperatingErrorMessage,
  SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE,
} from "@/lib/saas-billing/entitlement";

type Db = PrismaClient | Prisma.TransactionClient;

export const NATIVE_JOB_PROBLEM_REPORT_LIMIT = 20;
export const NATIVE_PROBLEM_JSON_MAX_BYTES = 4096;
export const NATIVE_PROBLEM_CHOOSE_RECORD =
  "Choose a problem type and describe what happened.";
export const NATIVE_PROBLEM_KIND_MAX_CHARS = 32;
export const NATIVE_PROBLEM_DESCRIPTION_MAX_CHARS = FIELD_JOB_PROBLEM_DESCRIPTION_MAX;

export const NATIVE_JOB_PROBLEM_KINDS = [
  { value: "ACCESS", label: "Access issue (can't get in / no one home)" },
  { value: "UNEXPECTED_CONDITION", label: "Unexpected condition found" },
  { value: "MATERIAL", label: "Damaged or missing material" },
  { value: "CANNOT_PROCEED", label: "Work cannot proceed" },
  { value: "SAFETY", label: "Safety concern" },
  { value: "CUSTOMER_UNAVAILABLE", label: "Customer unavailable" },
] as const;

export type NativeJobProblemKind = (typeof NATIVE_JOB_PROBLEM_KINDS)[number]["value"];

export const NATIVE_JOB_PROBLEM_STATUS_LABELS = {
  OPEN: "Open",
  RESOLVED: "Resolved",
} as const;

export type NativeJobProblemReport = {
  id: string;
  kind: NativeJobProblemKind | null;
  kindLabel: string | null;
  description: string;
  status: string;
  statusLabel: string;
  reportedAt: string;
  reportedAtLabel: string;
};

export type NativeJobProblemReports = {
  items: NativeJobProblemReport[];
  count: number;
  limit: number;
  truncated: boolean;
  truncatedNotice: string | null;
  recordAction: {
    available: boolean;
    reason: string | null;
  };
};

export type NativeProblemReportInput = {
  kind: NativeJobProblemKind;
  description: string;
};

export type NativeRecordAssignedProblemResult =
  | {
      ok: true;
      alreadyRecorded: boolean;
      job: NativeJobDetail;
    }
  | { ok: false; status: number; error: string };

export function nativeJobProblemTruncatedNotice(
  limit = NATIVE_JOB_PROBLEM_REPORT_LIMIT,
) {
  return `Showing the first ${limit} reports. More are on this job; this list is capped.`;
}

export function emptyNativeJobProblemReports(
  status = "SCHEDULED",
): NativeJobProblemReports {
  const available = assignedJobCanReceiveProblemReport(status);
  return {
    items: [],
    count: 0,
    limit: NATIVE_JOB_PROBLEM_REPORT_LIMIT,
    truncated: false,
    truncatedNotice: null,
    recordAction: {
      available,
      reason: available ? null : FIELD_JOB_PROBLEM_CLOSED,
    },
  };
}

/** Same assignment clause as `nativeAssignedJobWhere()`. */
export function nativeAssignedJobProblemAuthorizeWhere(
  jobId: string,
  field: Pick<NativeFieldAccess, "businessId" | "membershipId">,
) {
  return {
    id: jobId,
    businessId: field.businessId,
    assignedMembershipId: field.membershipId,
  } as const;
}

/** Problem-report rows are caller-scoped on the already-authorized job. */
export function nativeAssignedJobProblemWhere(
  jobId: string,
  businessId: string,
  membershipId: string,
) {
  return { jobId, businessId, membershipId } as const;
}

export function isNativeJobProblemKind(value: unknown): value is NativeJobProblemKind {
  return NATIVE_JOB_PROBLEM_KINDS.some((kind) => kind.value === value);
}

export function nativeJobProblemKindLabel(kind: NativeJobProblemKind) {
  return NATIVE_JOB_PROBLEM_KINDS.find((item) => item.value === kind)?.label ?? kind;
}

export function composeNativeProblemDescription(
  kind: NativeJobProblemKind,
  description: string,
) {
  const label = nativeJobProblemKindLabel(kind);
  const text = normalizeAssignedJobProblemDescription(description);
  if (!text) return "";
  if (text === label || text.startsWith(`${label}:`)) {
    return normalizeAssignedJobProblemDescription(text);
  }
  return normalizeAssignedJobProblemDescription(`${label}: ${text}`);
}

export function resolveNativeJobProblemKind(description: string): {
  kind: NativeJobProblemKind | null;
  kindLabel: string | null;
} {
  for (const item of NATIVE_JOB_PROBLEM_KINDS) {
    if (description === item.label || description.startsWith(`${item.label}:`)) {
      return { kind: item.value, kindLabel: item.label };
    }
  }
  return { kind: null, kindLabel: null };
}

export function nativeJobProblemStatusLabel(status: string) {
  if (status === "RESOLVED") return NATIVE_JOB_PROBLEM_STATUS_LABELS.RESOLVED;
  return NATIVE_JOB_PROBLEM_STATUS_LABELS.OPEN;
}

export function toNativeJobProblemReport(
  row: {
    id: string;
    description: string;
    status: string;
    createdAt: Date;
  },
  timeZone: string,
): NativeJobProblemReport {
  const kind = resolveNativeJobProblemKind(row.description);
  return {
    id: row.id,
    kind: kind.kind,
    kindLabel: kind.kindLabel,
    description: row.description,
    status: row.status === "RESOLVED" ? "RESOLVED" : "OPEN",
    statusLabel: nativeJobProblemStatusLabel(row.status),
    reportedAt: row.createdAt.toISOString(),
    reportedAtLabel: formatDateTime(row.createdAt, timeZone),
  };
}

export function boundNativeJobProblemReports<T>(
  rows: readonly T[],
  limit = NATIVE_JOB_PROBLEM_REPORT_LIMIT,
): { items: T[]; truncated: boolean } {
  const truncated = rows.length > limit;
  return {
    items: truncated ? rows.slice(0, limit) : [...rows],
    truncated,
  };
}

export function parseNativeProblemReportJson(text: string):
  | { ok: true; input: NativeProblemReportInput }
  | { ok: false; status: 400 | 413; error: string } {
  if (!text.trim()) {
    return { ok: false, status: 400, error: NATIVE_PROBLEM_CHOOSE_RECORD };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, error: NATIVE_PROBLEM_CHOOSE_RECORD };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, status: 400, error: NATIVE_PROBLEM_CHOOSE_RECORD };
  }
  const payload = parsed as Record<string, unknown>;
  const rawKind = payload.kind;
  if (typeof rawKind === "string" && rawKind.length > NATIVE_PROBLEM_KIND_MAX_CHARS) {
    return { ok: false, status: 413, error: NATIVE_SESSION_TOO_LARGE };
  }
  if (!isNativeJobProblemKind(rawKind)) {
    return { ok: false, status: 400, error: NATIVE_PROBLEM_CHOOSE_RECORD };
  }

  const rawDescription = payload.description;
  if (
    typeof rawDescription === "string" &&
    rawDescription.length > NATIVE_PROBLEM_DESCRIPTION_MAX_CHARS
  ) {
    return { ok: false, status: 413, error: NATIVE_SESSION_TOO_LARGE };
  }
  if (typeof rawDescription !== "string") {
    return { ok: false, status: 400, error: NATIVE_PROBLEM_CHOOSE_RECORD };
  }
  const description = normalizeAssignedJobProblemDescription(rawDescription);
  if (!description) {
    return { ok: false, status: 400, error: FIELD_JOB_PROBLEM_DESCRIBE };
  }

  return { ok: true, input: { kind: rawKind, description } };
}

function problemWriteFailure(error: string): Extract<
  NativeRecordAssignedProblemResult,
  { ok: false }
> {
  if (error === FIELD_JOB_NOT_ASSIGNED) {
    return { ok: false, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
  }
  if (error === FIELD_JOB_PROBLEM_DESCRIBE) {
    return { ok: false, status: 400, error };
  }
  return { ok: false, status: 409, error };
}

export async function loadNativeAssignedJobProblemReports(
  db: Db,
  access: Pick<NativeFieldAccess, "businessId" | "membershipId">,
  jobId: string,
  timeZone: string,
  status = "SCHEDULED",
): Promise<NativeJobProblemReports> {
  const assigned = await db.job.findFirst({
    where: nativeAssignedJobProblemAuthorizeWhere(jobId, access),
    select: { id: true, status: true },
  });
  if (!assigned) {
    return emptyNativeJobProblemReports(status);
  }

  const where = nativeAssignedJobProblemWhere(
    assigned.id,
    access.businessId,
    access.membershipId,
  );
  const [count, rows] = await Promise.all([
    db.jobProblemReport.count({ where }),
    db.jobProblemReport.findMany({
      where,
      select: {
        id: true,
        description: true,
        status: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: NATIVE_JOB_PROBLEM_REPORT_LIMIT + 1,
    }),
  ]);
  const bound = boundNativeJobProblemReports(rows);
  const available = assignedJobCanReceiveProblemReport(assigned.status);
  return {
    items: bound.items.map((row) => toNativeJobProblemReport(row, timeZone)),
    count,
    limit: NATIVE_JOB_PROBLEM_REPORT_LIMIT,
    truncated: bound.truncated,
    truncatedNotice: bound.truncated ? nativeJobProblemTruncatedNotice() : null,
    recordAction: {
      available,
      reason: available ? null : FIELD_JOB_PROBLEM_CLOSED,
    },
  };
}

export async function recordNativeAssignedJobProblem(
  db: PrismaClient,
  access: NativeFieldAccess,
  jobId: string,
  input: NativeProblemReportInput,
  options?: {
    /** Proof hook: runs after the authorize read and before the Job lock. */
    afterInitialRead?: () => Promise<void>;
  },
): Promise<NativeRecordAssignedProblemResult> {
  const assigned = await db.job.findFirst({
    where: nativeAssignedJobProblemAuthorizeWhere(jobId, access),
    select: { id: true, status: true },
  });
  if (!assigned) {
    return { ok: false, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
  }
  if (!assignedJobCanReceiveProblemReport(assigned.status)) {
    return { ok: false, status: 409, error: FIELD_JOB_PROBLEM_CLOSED };
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

  const description = composeNativeProblemDescription(input.kind, input.description);
  const reported = await reportAssignedJobProblem(
    db,
    { businessId: access.businessId, membershipId: access.membershipId },
    {
      jobId: assigned.id,
      description,
      afterInitialRead: options?.afterInitialRead,
    },
  );
  if (!reported.ok) {
    return problemWriteFailure(reported.error);
  }

  const { loadNativeAssignedJob } = await import("@/lib/native-field");
  const job = await loadNativeAssignedJob(db, access, assigned.id);
  if (!job) {
    return { ok: false, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
  }
  return { ok: true, alreadyRecorded: reported.alreadyRecorded, job };
}
