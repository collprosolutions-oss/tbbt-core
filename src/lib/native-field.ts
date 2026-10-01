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
 * live in `src/lib/native-field-ops.ts`, `src/lib/native-field-activity.ts`,
 * `src/lib/native-field-photos.ts`, `src/lib/native-field-visits.ts`,
 * `src/lib/native-field-checklist.ts`, `src/lib/native-field-pickup.ts`,
 * and `src/lib/native-field-time-correction.ts`.
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
import { loadAssignedCleaningVisitView } from "@/lib/cleaning-visit-data";
import { parseChecklistJson, START_BEFORE_COMPLETE_MESSAGE } from "@/lib/cleaning-visit-workflow";
import { evaluateCompleteJob, evaluateStartJob } from "@/lib/job-lifecycle";
import { ownerAccessSummaryLines } from "@/lib/property-access";
import { startOfDay } from "@/lib/schedule";
import {
  TIME_ACTIVITY_LABELS,
  formatDurationClock,
  isAssignedFieldActivityType,
  isTimeActivityType,
  sumHours,
  type AssignedFieldActivityType,
  type TimeActivityType,
} from "@/lib/time-cards";
import { authorizePrivateStoredAssetDownload } from "@/lib/business-storage/private-serve";
import type { StorageProvider } from "@/lib/business-storage/types";
import { listAssignedJobPickupView } from "@/lib/materials/pickup";
import type { FieldJobPickupView } from "@/lib/materials/types";
import type { NativeJobTimeCorrections } from "@/lib/native-field-time-correction";
import type { NativeFieldAccess, NativeViewer, NativeWorkspace } from "@/lib/native-session";

type Db = PrismaClient | Prisma.TransactionClient;

export const NATIVE_ASSIGNED_JOB_WHERE = {
  businessId: true,
  assignedMembershipId: true,
} as const;

export const NATIVE_FIELD_JOB_LIST_SELECT = FIELD_JOB_SELECT;

/** Hard cap on the native Today list. Detail stays one assigned job by id. */
export const NATIVE_TODAY_JOB_LIMIT = 20;

/** Hard cap on assigned-job photos shown and uploaded from native. */
export const NATIVE_JOB_PHOTO_LIMIT = 12;

export function nativeTodayTruncatedNotice(limit = NATIVE_TODAY_JOB_LIMIT) {
  return `Showing the first ${limit} assigned jobs. More are assigned; this list is capped.`;
}

export function nativeJobPhotoTruncatedNotice(limit = NATIVE_JOB_PHOTO_LIMIT) {
  return `Showing the first ${limit} photos. More are on this job; this list is capped.`;
}

export function nativeJobPhotoTooManyMessage(limit = NATIVE_JOB_PHOTO_LIMIT) {
  return `This job already has ${limit} photos, the field capture limit.`;
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
        select: { description: true, quantity: true, type: true, optionId: true },
      },
    },
  },
  approvedEstimateOptionId: true,
  approvedEstimateVersion: {
    select: {
      versionNumber: true,
      approvedAt: true,
      lineItems: {
        orderBy: { createdAt: "asc" as const },
        select: { description: true, quantity: true, type: true, optionId: true },
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

export type NativeJobStopTimeAction = {
  available: boolean;
  reason: string | null;
};

export type NativeJobActivityAction = {
  available: boolean;
  reason: string | null;
};

export type NativeJobRunningTime = {
  running: boolean;
  recorded: boolean;
  activityType: string | null;
  activityLabel: string | null;
  startedAt: string | null;
  startedAtLabel: string | null;
  endedAt: string | null;
  endedAtLabel: string | null;
  hours: number | null;
  hoursLabel: string | null;
};

export type NativeJobPhotoStage = "BEFORE" | "DURING" | "AFTER";

export type NativeJobPhoto = {
  id: string;
  stage: NativeJobPhotoStage;
  caption: string | null;
  createdAt: string;
  previewUrl: string | null;
  previewExpiresInSeconds: number | null;
};

export type NativeJobPhotoUploadAction = {
  available: boolean;
  reason: string | null;
  remaining: number;
  limit: number;
  count: number;
};

export type NativeJobVisitAction = {
  available: boolean;
  reason: string | null;
};

export type NativeJobChecklistItem = {
  key: string;
  title: string;
  required: boolean;
  checked: boolean;
};

export type NativeJobVisit = {
  eligible: true;
  outcomeStatus: string;
  outcomeLabel: string;
  cadenceLabel: string;
  procedureTitle: string | null;
  checklist: NativeJobChecklistItem[];
  recordCompleted: NativeJobVisitAction;
  recordReclean: NativeJobVisitAction;
};

export type NativeJobChecklist = {
  procedureTitle: string | null;
  items: NativeJobChecklistItem[];
};

export type NativeJobPhotos = {
  items: NativeJobPhoto[];
  count: number;
  limit: number;
  remaining: number;
  truncated: boolean;
  truncatedNotice: string | null;
  upload: NativeJobPhotoUploadAction;
};

export type NativeJobPickupItem = {
  id: string;
  name: string;
  quantityNeeded: string;
  unit: string;
  supplierName: string | null;
  pickupLocationDescription: string | null;
  pickupDurationMinutes: number | null;
  pickupReady: boolean;
  status: string;
  quantityPickedUp: string | null;
  pickupException: string | null;
  pickupExceptionLabel: string | null;
  pickupExceptionNote: string | null;
  pickupRecorded: boolean;
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
  stopTimeAction: NativeJobStopTimeAction;
  runningTime: NativeJobRunningTime;
  travelTime: NativeJobRunningTime;
  pickupTime: NativeJobRunningTime;
  startTravelAction: NativeJobActivityAction;
  stopTravelAction: NativeJobActivityAction;
  startPickupAction: NativeJobActivityAction;
  stopPickupAction: NativeJobActivityAction;
  pickupItems: NativeJobPickupItem[];
  photos: NativeJobPhotos;
  visit: NativeJobVisit | null;
  checklist: NativeJobChecklist | null;
  timeCorrections: NativeJobTimeCorrections;
};

export type NativeJobLoadOptions = {
  storage?: { provider?: StorageProvider };
};

export function emptyNativeJobPhotos(): NativeJobPhotos {
  return {
    items: [],
    count: 0,
    limit: NATIVE_JOB_PHOTO_LIMIT,
    remaining: NATIVE_JOB_PHOTO_LIMIT,
    truncated: false,
    truncatedNotice: null,
    upload: nativeJobPhotoUploadAction(0),
  };
}

export function nativeJobPhotoUploadAction(count: number): NativeJobPhotoUploadAction {
  const remaining = Math.max(0, NATIVE_JOB_PHOTO_LIMIT - count);
  if (remaining === 0) {
    return {
      available: false,
      reason: nativeJobPhotoTooManyMessage(),
      remaining,
      limit: NATIVE_JOB_PHOTO_LIMIT,
      count,
    };
  }
  return {
    available: true,
    reason: null,
    remaining,
    limit: NATIVE_JOB_PHOTO_LIMIT,
    count,
  };
}

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

export function nativeVisitCompletedAction(status: string): NativeJobVisitAction {
  if (status === "IN_PROGRESS" || status === "COMPLETED") {
    return { available: true, reason: null };
  }
  return { available: false, reason: START_BEFORE_COMPLETE_MESSAGE };
}

export function nativeVisitRecleanAction(): NativeJobVisitAction {
  return { available: true, reason: null };
}

export async function loadNativeAssignedJobVisit(
  db: Db,
  access: NativeFieldAccess,
  job: { id: string; status: string },
): Promise<NativeJobVisit | null> {
  const view = await loadAssignedCleaningVisitView(db, access, job.id);
  if (!view) return null;
  return {
    eligible: true,
    outcomeStatus: view.outcomeStatus,
    outcomeLabel: view.outcomeLabel,
    cadenceLabel: view.cadenceLabel,
    procedureTitle: view.procedureTitle,
    checklist: view.checklist,
    recordCompleted: nativeVisitCompletedAction(job.status),
    recordReclean: nativeVisitRecleanAction(),
  };
}

export async function loadNativeAssignedJobChecklist(
  db: Db,
  access: NativeFieldAccess,
  job: { id: string },
): Promise<NativeJobChecklist | null> {
  const visit = await db.jobCrewVisit.findFirst({
    where: { jobId: job.id, businessId: access.businessId },
    include: { procedure: { select: { title: true } } },
  });
  if (!visit) return null;
  const items = parseChecklistJson(visit.checklistJson);
  if (items.length === 0) return null;
  return {
    procedureTitle: visit.procedure?.title ?? null,
    items,
  };
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
    recorded: false,
    activityType: null,
    activityLabel: null,
    startedAt: null,
    startedAtLabel: null,
    endedAt: null,
    endedAtLabel: null,
    hours: null,
    hoursLabel: null,
  };
}

export function nativeStopTimeAction(running: boolean): NativeJobStopTimeAction {
  if (running) {
    return { available: true, reason: null };
  }
  return { available: false, reason: null };
}

export function nativeActivityStartAction(running: boolean): NativeJobActivityAction {
  if (running) {
    return { available: false, reason: null };
  }
  return { available: true, reason: null };
}

export function nativeActivityStopAction(running: boolean): NativeJobActivityAction {
  if (running) {
    return { available: true, reason: null };
  }
  return { available: false, reason: null };
}

export async function loadNativeJobActivityTime(
  db: Db,
  field: Pick<NativeFieldAccess, "businessId" | "membershipId">,
  jobId: string,
  timeZone: string,
  activityType: TimeActivityType,
): Promise<NativeJobRunningTime> {
  const [running, recordedRows] = await Promise.all([
    db.timeEntry.findFirst({
      where: {
        businessId: field.businessId,
        membershipId: field.membershipId,
        jobId,
        activityType,
        status: "RUNNING",
        endedAt: null,
      },
      select: { startedAt: true, activityType: true },
      orderBy: { startedAt: "desc" },
    }),
    db.timeEntry.findMany({
      where: {
        businessId: field.businessId,
        membershipId: field.membershipId,
        jobId,
        activityType,
        endedAt: { not: null },
      },
      select: { startedAt: true, endedAt: true, activityType: true },
      orderBy: [{ endedAt: "desc" }, { startedAt: "desc" }],
    }),
  ]);
  if (running) {
    const resolvedType = isTimeActivityType(running.activityType) ? running.activityType : activityType;
    return {
      running: true,
      recorded: false,
      activityType: resolvedType,
      activityLabel: TIME_ACTIVITY_LABELS[resolvedType],
      startedAt: running.startedAt.toISOString(),
      startedAtLabel: formatDateTime(running.startedAt, timeZone),
      endedAt: null,
      endedAtLabel: null,
      hours: null,
      hoursLabel: null,
    };
  }
  const latest = recordedRows[0];
  if (latest?.endedAt) {
    const hours = sumHours(recordedRows);
    const resolvedType = isTimeActivityType(latest.activityType) ? latest.activityType : activityType;
    return {
      running: false,
      recorded: true,
      activityType: resolvedType,
      activityLabel: TIME_ACTIVITY_LABELS[resolvedType],
      startedAt: latest.startedAt.toISOString(),
      startedAtLabel: formatDateTime(latest.startedAt, timeZone),
      endedAt: latest.endedAt.toISOString(),
      endedAtLabel: formatDateTime(latest.endedAt, timeZone),
      hours,
      hoursLabel: formatDurationClock(hours),
    };
  }
  return idleNativeJobRunningTime();
}

export async function loadNativeJobRunningTime(
  db: Db,
  field: Pick<NativeFieldAccess, "businessId" | "membershipId">,
  jobId: string,
  timeZone: string,
): Promise<NativeJobRunningTime> {
  return loadNativeJobActivityTime(db, field, jobId, timeZone, "JOB");
}

export async function loadNativeAssignedFieldActivityTimes(
  db: Db,
  field: Pick<NativeFieldAccess, "businessId" | "membershipId">,
  jobId: string,
  timeZone: string,
): Promise<{
  runningTime: NativeJobRunningTime;
  travelTime: NativeJobRunningTime;
  pickupTime: NativeJobRunningTime;
}> {
  const [runningTime, travelTime, pickupTime] = await Promise.all([
    loadNativeJobActivityTime(db, field, jobId, timeZone, "JOB"),
    loadNativeJobActivityTime(db, field, jobId, timeZone, "TRAVEL"),
    loadNativeJobActivityTime(db, field, jobId, timeZone, "MATERIAL_PICKUP"),
  ]);
  return { runningTime, travelTime, pickupTime };
}

export function isNativeFieldActivityType(value: string): value is AssignedFieldActivityType {
  return isAssignedFieldActivityType(value);
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
  options?: NativeJobLoadOptions,
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
  const { runningTime, travelTime, pickupTime } = await loadNativeAssignedFieldActivityTimes(
    db,
    access,
    job.id,
    timeZone,
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
    stopTimeAction: nativeStopTimeAction(runningTime.running),
    runningTime,
    travelTime,
    pickupTime,
    startTravelAction: nativeActivityStartAction(travelTime.running),
    stopTravelAction: nativeActivityStopAction(travelTime.running),
    startPickupAction: nativeActivityStartAction(pickupTime.running),
    stopPickupAction: nativeActivityStopAction(pickupTime.running),
    pickupItems: await loadNativeAssignedJobPickupItems(db, access, job.id),
    photos: await loadNativeAssignedJobPhotos(db, access, job.id, options),
    visit: await loadNativeAssignedJobVisit(db, access, job),
    checklist: await loadNativeAssignedJobChecklist(db, access, job),
    timeCorrections: await (
      await import("@/lib/native-field-time-correction")
    ).loadNativeAssignedJobTimeCorrections(db, access, job.id, timeZone),
  };
}

export async function loadNativeAssignedJobPickupItems(
  db: Db,
  access: Pick<NativeFieldAccess, "businessId" | "membershipId">,
  jobId: string,
): Promise<NativeJobPickupItem[]> {
  const items = await listAssignedJobPickupView(db, access, jobId);
  return items.map(toNativeJobPickupItem);
}

function toNativeJobPickupItem(item: FieldJobPickupView): NativeJobPickupItem {
  return {
    id: item.id,
    name: item.name,
    quantityNeeded: item.quantityNeeded,
    unit: item.unit,
    supplierName: item.supplierName,
    pickupLocationDescription: item.pickupLocationDescription,
    pickupDurationMinutes: item.pickupDurationMinutes,
    pickupReady: item.pickupReady,
    status: item.status,
    quantityPickedUp: item.quantityPickedUp,
    pickupException: item.pickupException,
    pickupExceptionLabel: item.pickupExceptionLabel,
    pickupExceptionNote: item.pickupExceptionNote,
    pickupRecorded: item.pickupRecorded,
  };
}

export async function loadNativeAssignedJobPhotos(
  db: Db,
  access: NativeFieldAccess,
  jobId: string,
  options?: NativeJobLoadOptions,
): Promise<NativeJobPhotos> {
  const assigned = await db.job.findFirst({
    where: nativeAssignedJobWhere(jobId, access),
    select: { id: true },
  });
  if (!assigned) {
    return emptyNativeJobPhotos();
  }

  const where = { businessId: access.businessId, jobId: assigned.id };
  const [count, rows] = await Promise.all([
    db.jobPhoto.count({ where }),
    db.jobPhoto.findMany({
      where,
      select: {
        id: true,
        stage: true,
        caption: true,
        createdAt: true,
        url: true,
        storedAssetId: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: NATIVE_JOB_PHOTO_LIMIT + 1,
    }),
  ]);
  const truncated = rows.length > NATIVE_JOB_PHOTO_LIMIT;
  const listed = truncated ? rows.slice(0, NATIVE_JOB_PHOTO_LIMIT) : rows;
  const items: NativeJobPhoto[] = [];
  for (const row of listed) {
    items.push(await toNativeJobPhoto(db, access, row, options));
  }
  return {
    items,
    count,
    limit: NATIVE_JOB_PHOTO_LIMIT,
    remaining: Math.max(0, NATIVE_JOB_PHOTO_LIMIT - count),
    truncated,
    truncatedNotice: truncated ? nativeJobPhotoTruncatedNotice() : null,
    upload: nativeJobPhotoUploadAction(count),
  };
}

async function toNativeJobPhoto(
  db: Db,
  access: NativeFieldAccess,
  row: {
    id: string;
    stage: NativeJobPhotoStage;
    caption: string | null;
    createdAt: Date;
    url: string;
    storedAssetId: string | null;
  },
  options?: NativeJobLoadOptions,
): Promise<NativeJobPhoto> {
  if (row.storedAssetId) {
    const download = await authorizePrivateStoredAssetDownload(
      db,
      row.storedAssetId,
      access.businessId,
      {
        provider: options?.storage?.provider,
        viewer: {
          role: access.workspace.role,
          membershipId: access.membershipId,
        },
      },
    );
    if (download.ok) {
      return {
        id: row.id,
        stage: row.stage,
        caption: row.caption,
        createdAt: row.createdAt.toISOString(),
        previewUrl: download.url,
        previewExpiresInSeconds: download.expiresInSeconds,
      };
    }
    return {
      id: row.id,
      stage: row.stage,
      caption: row.caption,
      createdAt: row.createdAt.toISOString(),
      previewUrl: null,
      previewExpiresInSeconds: null,
    };
  }

  return {
    id: row.id,
    stage: row.stage,
    caption: row.caption,
    createdAt: row.createdAt.toISOString(),
    previewUrl: row.url.startsWith("https://") || row.url.startsWith("http://") ? row.url : null,
    previewExpiresInSeconds: null,
  };
}

function fieldSafeScope(job: {
  approvedEstimateOptionId?: string | null;
  approvedEstimateVersion: {
    versionNumber: number;
    lineItems: Array<{
      description: string;
      quantity: { toString(): string };
      type: string;
      optionId?: string | null;
    }>;
  } | null;
  estimate: {
    lineItems: Array<{
      description: string;
      quantity: { toString(): string };
      type: string;
      optionId?: string | null;
    }>;
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
    const optionId = job.approvedEstimateOptionId ?? null;
    const lines = optionId
      ? job.approvedEstimateVersion.lineItems.filter((line) => line.optionId === optionId)
      : job.approvedEstimateVersion.lineItems;
    return {
      source: "version",
      versionNumber: job.approvedEstimateVersion.versionNumber,
      items: toItems(lines),
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
