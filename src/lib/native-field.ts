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
 * query. There is no fetch-then-compare step.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  appointmentConfirmationLabel,
  effectiveAppointmentConfirmationStatus,
} from "@/lib/appointment-confirmation";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import { directionsUrl, telHref } from "@/lib/directions";
import { FIELD_JOB_SELECT, groupFieldJobs, type FieldJob } from "@/lib/field-jobs";
import { formatAddress, formatDateTime } from "@/lib/format";
import { ownerAccessSummaryLines } from "@/lib/property-access";
import { startOfDay } from "@/lib/schedule";
import type { NativeFieldAccess, NativeViewer, NativeWorkspace } from "@/lib/native-session";

type Db = PrismaClient | Prisma.TransactionClient;

export const NATIVE_ASSIGNED_JOB_WHERE = {
  businessId: true,
  assignedMembershipId: true,
} as const;

export const NATIVE_FIELD_JOB_LIST_SELECT = FIELD_JOB_SELECT;

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
};

export type NativeTodayPayload = {
  viewer: NativeViewer;
  workspace: NativeWorkspace;
  timeZone: string;
  today: NativeJobSummary[];
  upcoming: NativeJobSummary[];
  completed: NativeJobSummary[];
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
) {
  return db.job.findMany({
    where: {
      businessId: field.businessId,
      assignedMembershipId: field.membershipId,
    },
    select: NATIVE_FIELD_JOB_LIST_SELECT,
    orderBy: { scheduledAt: "asc" },
  });
}

export function buildNativeTodayPayload(
  jobs: FieldJob[],
  input: {
    access: NativeFieldAccess;
    now?: Date;
    timeZone?: string;
  },
): NativeTodayPayload {
  const timeZone = input.timeZone ?? resolveBusinessTimeZone(null);
  const groups = groupFieldJobs(jobs, startOfDay(input.now ?? new Date(), timeZone), timeZone);
  return {
    viewer: input.access.viewer,
    workspace: input.access.workspace,
    timeZone,
    today: groups.today.map((job) => toNativeJobSummary(job, timeZone)),
    upcoming: groups.upcoming.map((job) => toNativeJobSummary(job, timeZone)),
    completed: groups.completed.map((job) => toNativeJobSummary(job, timeZone)),
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
  const jobs = await listNativeAssignedJobs(db, access);
  return buildNativeTodayPayload(jobs, { access, now: options?.now, timeZone });
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
