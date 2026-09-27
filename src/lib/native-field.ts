/**
 * Native assigned-job / Today reads.
 *
 * This is the field contract for the isolated native app. It is NOT the
 * owner/admin Today page (`src/lib/owner-today.ts`). MEMBER (and anyone
 * calling this API) only receives Jobs assigned to their own Membership
 * in their own workspace. Owner records — invoices, estimates totals,
 * wages, other employees' jobs, business-wide dashboards — are never
 * selected or returned.
 *
 * Lookup uses the same compound scope as `assignedJobWhere()` in
 * src/lib/field-access.ts: businessId + assignedMembershipId in one
 * query. There is no fetch-then-compare step. Assigned-worker writes
 * live in `src/lib/native-field-ops.ts`.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  appointmentConfirmationLabel,
  CUSTOMER_HAS_NOT_CONFIRMED_APPOINTMENT,
  effectiveAppointmentConfirmationStatus,
  startJobRequiresCustomerConfirmation,
  type AppointmentJobFields,
} from "@/lib/appointment-confirmation";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import { directionsUrl, telHref } from "@/lib/directions";
import { FIELD_JOB_SELECT, groupFieldJobs, type FieldJob } from "@/lib/field-jobs";
import { formatAddress, formatDateTime } from "@/lib/format";
import { evaluateCompleteJob, evaluateStartJob } from "@/lib/job-lifecycle";
import { ownerAccessSummaryLines } from "@/lib/property-access";
import { startOfDay } from "@/lib/schedule";
import { TIME_ACTIVITY_LABELS, isTimeActivityType } from "@/lib/time-cards";
import type { NativeFieldAccess, NativeViewer, NativeWorkspace } from "@/lib/native-session";

type Db = PrismaClient | Prisma.TransactionClient;

export const NATIVE_ASSIGNED_JOB_WHERE = {
  businessId: true,
  assignedMembershipId: true,
} as const;

export const NATIVE_FIELD_JOB_LIST_SELECT = FIELD_JOB_SELECT;

/** Hard cap on the native Today list. Detail stays one assigned job by id. */
export const NATIVE_TODAY_JOB_LIMIT = 20;

export function nativeTodayTruncatedNotice(limit = NATIVE_TODAY_JOB_LIMIT) {
  return `Showing the first ${limit} assigned jobs. More are assigned; this list is capped.`;
}

const NATIVE_FIELD_JOB_DETAIL_SELECT = {
  id: true,
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
  customer: { select: { name: true, phone: true } },
  property: {
    select: {
      addressLine1: true,
      addressLine2: true,
      city: true,
      region: true,
      postalCode: true,
    },
  },
  estimate: {
    select: {
      lineItems: {
        orderBy: { createdAt: "asc" as const },
        select: { description: true, quantity: true, type: true },
      },
    },
  },
  approvedEstimateVersion: {
    select: {
      versionNumber: true,
      approvedAt: true,
      lineItems: {
        orderBy: { createdAt: "asc" as const },
        select: { description: true, quantity: true, type: true },
      },
    },
  },
} as const;

export type NativeJobSummary = {
  id: string;
  status: string;
  scheduledAt: string | null;
  scheduledDurationMinutes: number | null;
  whenLabel: string | null;
  customerName: string | null;
  address: string | null;
};

export type NativeJobCompleteAction = {
  available: boolean;
  reason: string | null;
};

export type NativeJobStartAction = {
  available: boolean;
  reason: string | null;
};

export type NativeJobRunningTime = {
  running: boolean;
  activityType: string | null;
  activityLabel: string | null;
  startedAt: string | null;
  startedAtLabel: string | null;
};

export type NativeJobDetail = NativeJobSummary & {
  customerPhone: string | null;
  callHref: string | null;
  directionsHref: string | null;
  confirmationLabel: string;
  accessLines: string[];
  scope: {
    source: "version" | "legacy-estimate" | "none";
    versionNumber: number | null;
    items: Array<{ description: string; quantity: string; type: string }>;
  };
  startAction: NativeJobStartAction;
  completeAction: NativeJobCompleteAction;
  runningTime: NativeJobRunningTime;
};

export function nativeCompleteAction(status: string): NativeJobCompleteAction {
  const lifecycle = evaluateCompleteJob(status);
  if (!lifecycle.ok) {
    return { available: false, reason: lifecycle.error };
  }
  if (lifecycle.nextStatus === null) {
    return { available: false, reason: null };
  }
  return { available: true, reason: null };
}

export function nativeStartAction(
  status: string,
  job: AppointmentJobFields,
): NativeJobStartAction {
  const lifecycle = evaluateStartJob(status);
  if (!lifecycle.ok) {
    return { available: false, reason: lifecycle.error };
  }
  if (lifecycle.nextStatus === null) {
    return { available: false, reason: null };
  }
  if (startJobRequiresCustomerConfirmation(job)) {
    return { available: false, reason: CUSTOMER_HAS_NOT_CONFIRMED_APPOINTMENT };
  }
  return { available: true, reason: null };
}

export function idleNativeJobRunningTime(): NativeJobRunningTime {
  return {
    running: false,
    activityType: null,
    activityLabel: null,
    startedAt: null,
    startedAtLabel: null,
  };
}

export async function loadNativeJobRunningTime(
  db: Db,
  field: Pick<NativeFieldAccess, "businessId" | "membershipId">,
  jobId: string,
  timeZone: string,
): Promise<NativeJobRunningTime> {
  const running = await db.timeEntry.findFirst({
    where: {
      businessId: field.businessId,
      membershipId: field.membershipId,
      jobId,
      activityType: "JOB",
      status: "RUNNING",
      endedAt: null,
    },
    select: { startedAt: true, activityType: true },
    orderBy: { startedAt: "desc" },
  });
  if (!running) {
    return idleNativeJobRunningTime();
  }
  const activityType = isTimeActivityType(running.activityType) ? running.activityType : "JOB";
  return {
    running: true,
    activityType,
    activityLabel: TIME_ACTIVITY_LABELS[activityType],
    startedAt: running.startedAt.toISOString(),
    startedAtLabel: formatDateTime(running.startedAt, timeZone),
  };
}

export type NativeAssignedJobPage = {
  jobs: FieldJob[];
  truncated: boolean;
  limit: number;
};

export type NativeTodayPayload = {
  viewer: NativeViewer;
  workspace: NativeWorkspace;
  timeZone: string;
  today: NativeJobSummary[];
  upcoming: NativeJobSummary[];
  completed: NativeJobSummary[];
  truncated: boolean;
  limit: number;
  truncatedNotice: string | null;
};

export function nativeAssignedJobWhere(
  jobId: string,
  field: Pick<NativeFieldAccess, "businessId" | "membershipId">,
) {
  return {
    id: jobId,
    businessId: field.businessId,
    assignedMembershipId: field.membershipId,
  } as const;
}

export function toNativeJobSummary(job: FieldJob, timeZone: string): NativeJobSummary {
  return {
    id: job.id,
    status: job.status,
    scheduledAt: job.scheduledAt?.toISOString() ?? null,
    scheduledDurationMinutes: job.scheduledDurationMinutes,
    whenLabel: job.scheduledAt ? formatDateTime(job.scheduledAt, timeZone) : null,
    customerName: job.customer?.name ?? null,
    address: job.property ? formatAddress(job.property) : null,
  };
}

export async function listNativeAssignedJobs(
  db: Db,
  field: Pick<NativeFieldAccess, "businessId" | "membershipId">,
): Promise<NativeAssignedJobPage> {
  const rows = await db.job.findMany({
    where: {
      businessId: field.businessId,
      assignedMembershipId: field.membershipId,
    },
    select: NATIVE_FIELD_JOB_LIST_SELECT,
    orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
    take: NATIVE_TODAY_JOB_LIMIT + 1,
  });
  const truncated = rows.length > NATIVE_TODAY_JOB_LIMIT;
  const jobs = truncated ? rows.slice(0, NATIVE_TODAY_JOB_LIMIT) : rows;
  return {
    jobs,
    truncated,
    limit: NATIVE_TODAY_JOB_LIMIT,
  };
}

export function buildNativeTodayPayload(
  jobs: FieldJob[],
  input: {
    access: NativeFieldAccess;
    now?: Date;
    timeZone?: string;
    truncated?: boolean;
    limit?: number;
  },
): NativeTodayPayload {
  const timeZone = input.timeZone ?? resolveBusinessTimeZone(null);
  const groups = groupFieldJobs(jobs, startOfDay(input.now ?? new Date(), timeZone), timeZone);
  const truncated = Boolean(input.truncated);
  const limit = input.limit ?? NATIVE_TODAY_JOB_LIMIT;
  return {
    viewer: input.access.viewer,
    workspace: input.access.workspace,
    timeZone,
    today: groups.today.map((job) => toNativeJobSummary(job, timeZone)),
    upcoming: groups.upcoming.map((job) => toNativeJobSummary(job, timeZone)),
    completed: groups.completed.map((job) => toNativeJobSummary(job, timeZone)),
    truncated,
    limit,
    truncatedNotice: truncated ? nativeTodayTruncatedNotice(limit) : null,
  };
}

export async function loadNativeToday(
  db: Db,
  access: NativeFieldAccess,
  options?: { now?: Date },
): Promise<NativeTodayPayload> {
  const timeZone = resolveBusinessTimeZone(
    await db.business.findFirst({
      where: { id: access.businessId },
      select: { timezone: true },
    }),
  );
  const page = await listNativeAssignedJobs(db, access);
  return buildNativeTodayPayload(page.jobs, {
    access,
    now: options?.now,
    timeZone,
    truncated: page.truncated,
    limit: page.limit,
  });
}

export async function loadNativeAssignedJob(
  db: Db,
  access: NativeFieldAccess,
  jobId: string,
): Promise<NativeJobDetail | null> {
  const job = await db.job.findFirst({
    where: nativeAssignedJobWhere(jobId, access),
    select: NATIVE_FIELD_JOB_DETAIL_SELECT,
  });
  if (!job) return null;

  const timeZone = resolveBusinessTimeZone(
    await db.business.findFirst({
      where: { id: access.businessId },
      select: { timezone: true },
    }),
  );

  const confirmationLabel = appointmentConfirmationLabel(
    effectiveAppointmentConfirmationStatus(job),
  );

  return {
    ...toNativeJobSummary(job, timeZone),
    customerPhone: job.customer?.phone ?? null,
    callHref: telHref(job.customer?.phone),
    directionsHref: directionsUrl(job.property),
    confirmationLabel,
    accessLines: ownerAccessSummaryLines(job),
    scope: fieldSafeScope(job),
    startAction: nativeStartAction(job.status, job),
    completeAction: nativeCompleteAction(job.status),
    runningTime: await loadNativeJobRunningTime(db, access, job.id, timeZone),
  };
}

function fieldSafeScope(job: {
  approvedEstimateVersion: {
    versionNumber: number;
    lineItems: Array<{ description: string; quantity: { toString(): string }; type: string }>;
  } | null;
  estimate: {
    lineItems: Array<{ description: string; quantity: { toString(): string }; type: string }>;
  } | null;
}): NativeJobDetail["scope"] {
  const toItems = (
    items: Array<{ description: string; quantity: { toString(): string }; type: string }>,
  ) =>
    items.map((item) => ({
      description: item.description,
      quantity: item.quantity.toString(),
      type: item.type,
    }));

  if (job.approvedEstimateVersion) {
    return {
      source: "version",
      versionNumber: job.approvedEstimateVersion.versionNumber,
      items: toItems(job.approvedEstimateVersion.lineItems),
    };
  }
  if (job.estimate) {
    return {
      source: "legacy-estimate",
      versionNumber: null,
      items: toItems(job.estimate.lineItems),
    };
  }
  return { source: "none", versionNumber: null, items: [] };
}
