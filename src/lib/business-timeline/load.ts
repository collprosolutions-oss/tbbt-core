import type { Prisma, PrismaClient } from "@prisma/client";
import { canAccessManagementConsole, ForbiddenError } from "@/lib/authorization";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import {
  describeActionItemRecorded,
  describeAdditionalWorkRecorded,
  describeAdditionalWorkReviewed,
  describeAgreementCompleted,
  describeAgreementLegalAcknowledged,
  describeAgreementOwnerReviewed,
  describeAgreementRecorded,
  describeAppointmentEvent,
  describeChangeOrderEvent,
  describeCustomerFollowUpSent,
  describeCustomerRecorded,
  describeEstimateApproved,
  describeEstimateRecorded,
  describeEstimateSent,
  describeInvoiceLifecycleEvent,
  describeInvoicePaid,
  describeInvoiceRecorded,
  describeJobCompleted,
  describeJobRecorded,
  describeJobStarted,
  describeJobStartWithoutConfirmation,
  describePaymentRecorded,
  describePhoneInteraction,
  describeProblemReportRecorded,
  describeProblemReportResolved,
  describeProtectionAcknowledged,
  describeRecommendationHistoryStatus,
  describeRecommendationRecorded,
  describeRecordedCommunication,
  describeRequestRecorded,
  describeReviewRequestRecorded,
  describeTimeEntryEnded,
  describeTimeEntryStarted,
  describeVaultRecorded,
  estimateTimelineNumber,
  invoiceTimelineNumber,
  jobTimelineReference,
} from "@/lib/business-timeline/describe";
import { attachVerifiedTimelineLinks } from "@/lib/business-timeline/links";
import { sortBusinessTimelineItems } from "@/lib/business-timeline/order";
import {
  BUSINESS_EVENT_TIMELINE_TYPES,
  BUSINESS_TIMELINE_CATEGORIES,
  BUSINESS_TIMELINE_CUSTOMER_FILTER_LIMIT,
  BUSINESS_TIMELINE_LIMIT,
  BUSINESS_TIMELINE_LOOKBACK_DAYS,
  BUSINESS_TIMELINE_SOURCE_LIMIT,
  type BusinessTimeline,
  type BusinessTimelineAccess,
  type BusinessTimelineCategory,
  type BusinessTimelineCustomerOption,
  type BusinessTimelineDraft,
  type BusinessTimelineQuery,
} from "@/lib/business-timeline/types";

type Db = PrismaClient | Prisma.TransactionClient;

const CUSTOMER_BOUND_CATEGORIES = new Set([
  "sales",
  "work",
  "money",
  "communications",
  "all",
]);

export function requireBusinessTimelineAccess(access: BusinessTimelineAccess) {
  if (!canAccessManagementConsole(access.workspace.role)) {
    throw new ForbiddenError();
  }
}

export function parseBusinessTimelineCategory(
  value?: string | null,
): BusinessTimelineCategory {
  const normalized = value?.trim().toLowerCase() ?? "";
  return BUSINESS_TIMELINE_CATEGORIES.includes(normalized as BusinessTimelineCategory)
    ? (normalized as BusinessTimelineCategory)
    : "all";
}

export function parseBusinessTimelineCustomerId(value?: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveBusinessTimelineWindow(input: {
  now?: Date;
  since?: Date;
  lookbackDays?: number;
}): { now: Date; since: Date; lookbackDays: number } {
  const now = input.now ?? new Date();
  const lookbackDays = input.lookbackDays ?? BUSINESS_TIMELINE_LOOKBACK_DAYS;
  const since =
    input.since ??
    new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  return { now, since, lookbackDays };
}

function includesCategory(
  category: BusinessTimelineCategory,
  wanted: Exclude<BusinessTimelineCategory, "all">,
) {
  return category === "all" || category === wanted;
}

function draft(input: BusinessTimelineDraft): BusinessTimelineDraft {
  return input;
}

function recommendationHistoryEntries(value: unknown): Array<{ at: Date; status: string }> {
  if (!Array.isArray(value)) return [];
  const entries: Array<{ at: Date; status: string }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as { at?: unknown; status?: unknown };
    const atValue = typeof record.at === "string" ? record.at : null;
    const status = typeof record.status === "string" ? record.status : null;
    if (!atValue || !status) continue;
    const at = new Date(atValue);
    if (Number.isNaN(at.getTime())) continue;
    entries.push({ at, status });
  }
  return entries;
}

async function loadOwnedCustomers(
  db: Db,
  businessId: string,
  ids: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await db.customer.findMany({
    where: { businessId, id: { in: unique } },
    select: { id: true, name: true },
  });
  return new Map(rows.map((row) => [row.id, row.name]));
}

export async function listBusinessTimelineCustomers(
  db: Db,
  access: BusinessTimelineAccess,
): Promise<BusinessTimelineCustomerOption[]> {
  requireBusinessTimelineAccess(access);
  return db.customer.findMany({
    where: { businessId: access.businessId },
    select: { id: true, name: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: BUSINESS_TIMELINE_CUSTOMER_FILTER_LIMIT,
  });
}

const CHANGE_ORDER_SELECT = {
  id: true,
  jobId: true,
  title: true,
  createdAt: true,
  sentAt: true,
  approvedAt: true,
  declinedAt: true,
  cancelledAt: true,
  job: { select: { customerId: true } },
} as const;

function changeOrderDraft(
  row: {
    id: string;
    jobId: string;
    title: string;
    job: { customerId: string | null };
  },
  moment: {
    kind: "created" | "sent" | "approved" | "declined" | "cancelled";
    at: Date;
    eventType: string;
    status: string;
  },
): BusinessTimelineDraft {
  return draft({
    id: `change-order:${row.id}:${moment.kind}`,
    occurredAt: moment.at,
    eventType: moment.eventType,
    category: "sales",
    description: describeChangeOrderEvent(moment.kind, row.title),
    customerId: row.job.customerId,
    relatedType: "CHANGE_ORDER",
    relatedId: row.id,
    relatedJobId: row.jobId,
    relatedLabel: row.title,
    sourceStatus: moment.status,
  });
}

async function collectSalesDrafts(
  db: Db,
  input: {
    businessId: string;
    since: Date;
    take: number;
    customerId: string | null;
  },
): Promise<BusinessTimelineDraft[]> {
  const customerWhere = input.customerId ? { customerId: input.customerId } : {};
  const estimateScope = { businessId: input.businessId, ...customerWhere };
  const jobScope = { businessId: input.businessId, ...customerWhere };
  const [
    customers,
    requests,
    estimates,
    sentVersions,
    approvedVersions,
    changeOrdersCreated,
    changeOrdersSent,
    changeOrdersApproved,
    changeOrdersDeclined,
    changeOrdersCancelled,
  ] = await Promise.all([
    input.customerId
      ? db.customer.findMany({
          where: {
            businessId: input.businessId,
            id: input.customerId,
            createdAt: { gte: input.since },
          },
          select: { id: true, createdAt: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: input.take,
        })
      : db.customer.findMany({
          where: { businessId: input.businessId, createdAt: { gte: input.since } },
          select: { id: true, createdAt: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: input.take,
        }),
    db.serviceRequest.findMany({
      where: { businessId: input.businessId, createdAt: { gte: input.since }, ...customerWhere },
      select: { id: true, customerId: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.take,
    }),
    db.estimate.findMany({
      where: { businessId: input.businessId, createdAt: { gte: input.since }, ...customerWhere },
      select: { id: true, customerId: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.take,
    }),
    db.estimateVersion.findMany({
      where: {
        businessId: input.businessId,
        sentAt: { gte: input.since },
        estimate: estimateScope,
      },
      select: {
        id: true,
        estimateId: true,
        sentAt: true,
        estimate: { select: { customerId: true } },
      },
      orderBy: [{ sentAt: "desc" }, { id: "desc" }],
      take: input.take,
    }),
    db.estimateVersion.findMany({
      where: {
        businessId: input.businessId,
        approvedAt: { gte: input.since },
        estimate: estimateScope,
      },
      select: {
        id: true,
        estimateId: true,
        approvedAt: true,
        estimate: { select: { customerId: true } },
      },
      orderBy: [{ approvedAt: "desc" }, { id: "desc" }],
      take: input.take,
    }),
    db.changeOrder.findMany({
      where: {
        businessId: input.businessId,
        createdAt: { gte: input.since },
        job: jobScope,
      },
      select: CHANGE_ORDER_SELECT,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.take,
    }),
    db.changeOrder.findMany({
      where: {
        businessId: input.businessId,
        sentAt: { gte: input.since },
        job: jobScope,
      },
      select: CHANGE_ORDER_SELECT,
      orderBy: [{ sentAt: "desc" }, { id: "desc" }],
      take: input.take,
    }),
    db.changeOrder.findMany({
      where: {
        businessId: input.businessId,
        approvedAt: { gte: input.since },
        job: jobScope,
      },
      select: CHANGE_ORDER_SELECT,
      orderBy: [{ approvedAt: "desc" }, { id: "desc" }],
      take: input.take,
    }),
    db.changeOrder.findMany({
      where: {
        businessId: input.businessId,
        declinedAt: { gte: input.since },
        job: jobScope,
      },
      select: CHANGE_ORDER_SELECT,
      orderBy: [{ declinedAt: "desc" }, { id: "desc" }],
      take: input.take,
    }),
    db.changeOrder.findMany({
      where: {
        businessId: input.businessId,
        cancelledAt: { gte: input.since },
        job: jobScope,
      },
      select: CHANGE_ORDER_SELECT,
      orderBy: [{ cancelledAt: "desc" }, { id: "desc" }],
      take: input.take,
    }),
  ]);

  const drafts: BusinessTimelineDraft[] = [];
  for (const row of customers) {
    drafts.push(
      draft({
        id: `customer:${row.id}:recorded`,
        occurredAt: row.createdAt,
        eventType: "CUSTOMER_RECORDED",
        category: "sales",
        description: describeCustomerRecorded(),
        customerId: row.id,
        relatedType: "CUSTOMER",
        relatedId: row.id,
        relatedJobId: null,
        relatedLabel: "Customer",
        sourceStatus: null,
      }),
    );
  }
  for (const row of requests) {
    drafts.push(
      draft({
        id: `request:${row.id}:recorded`,
        occurredAt: row.createdAt,
        eventType: "REQUEST_RECORDED",
        category: "sales",
        description: describeRequestRecorded(),
        customerId: row.customerId,
        relatedType: "SERVICE_REQUEST",
        relatedId: row.id,
        relatedJobId: null,
        relatedLabel: "Request",
        sourceStatus: null,
      }),
    );
  }
  for (const row of estimates) {
    drafts.push(
      draft({
        id: `estimate:${row.id}:recorded`,
        occurredAt: row.createdAt,
        eventType: "ESTIMATE_RECORDED",
        category: "sales",
        description: describeEstimateRecorded(row.id),
        customerId: row.customerId,
        relatedType: "ESTIMATE",
        relatedId: row.id,
        relatedJobId: null,
        relatedLabel: estimateTimelineNumber(row.id),
        sourceStatus: null,
      }),
    );
  }
  for (const row of sentVersions) {
    drafts.push(
      draft({
        id: `estimate-version:${row.id}:sent`,
        occurredAt: row.sentAt,
        eventType: "ESTIMATE_SENT",
        category: "sales",
        description: describeEstimateSent(row.estimateId),
        customerId: row.estimate.customerId,
        relatedType: "ESTIMATE",
        relatedId: row.estimateId,
        relatedJobId: null,
        relatedLabel: estimateTimelineNumber(row.estimateId),
        sourceStatus: "SENT",
      }),
    );
  }
  for (const row of approvedVersions) {
    if (!row.approvedAt) continue;
    drafts.push(
      draft({
        id: `estimate-version:${row.id}:approved`,
        occurredAt: row.approvedAt,
        eventType: "ESTIMATE_APPROVED",
        category: "sales",
        description: describeEstimateApproved(row.estimateId),
        customerId: row.estimate.customerId,
        relatedType: "ESTIMATE",
        relatedId: row.estimateId,
        relatedJobId: null,
        relatedLabel: estimateTimelineNumber(row.estimateId),
        sourceStatus: "APPROVED",
      }),
    );
  }
  for (const row of changeOrdersCreated) {
    drafts.push(
      changeOrderDraft(row, {
        kind: "created",
        at: row.createdAt,
        eventType: "CHANGE_ORDER_RECORDED",
        status: "DRAFT",
      }),
    );
  }
  for (const row of changeOrdersSent) {
    if (!row.sentAt) continue;
    drafts.push(
      changeOrderDraft(row, {
        kind: "sent",
        at: row.sentAt,
        eventType: "CHANGE_ORDER_SENT",
        status: "SENT",
      }),
    );
  }
  for (const row of changeOrdersApproved) {
    if (!row.approvedAt) continue;
    drafts.push(
      changeOrderDraft(row, {
        kind: "approved",
        at: row.approvedAt,
        eventType: "CHANGE_ORDER_APPROVED",
        status: "APPROVED",
      }),
    );
  }
  for (const row of changeOrdersDeclined) {
    if (!row.declinedAt) continue;
    drafts.push(
      changeOrderDraft(row, {
        kind: "declined",
        at: row.declinedAt,
        eventType: "CHANGE_ORDER_DECLINED",
        status: "DECLINED",
      }),
    );
  }
  for (const row of changeOrdersCancelled) {
    if (!row.cancelledAt) continue;
    drafts.push(
      changeOrderDraft(row, {
        kind: "cancelled",
        at: row.cancelledAt,
        eventType: "CHANGE_ORDER_CANCELLED",
        status: "CANCELLED",
      }),
    );
  }
  return drafts;
}

async function collectWorkDrafts(
  db: Db,
  input: {
    businessId: string;
    since: Date;
    take: number;
    customerId: string | null;
  },
): Promise<BusinessTimelineDraft[]> {
  const customerWhere = input.customerId ? { customerId: input.customerId } : {};
  const jobScope = { businessId: input.businessId, ...customerWhere };
  const timeJobScope = input.customerId
    ? { job: { businessId: input.businessId, customerId: input.customerId } }
    : {};
  const [
    jobsCreated,
    jobsStartedWithoutConfirmation,
    appointmentEvents,
    additionalWorkCreated,
    additionalWorkReviewed,
    problemsCreated,
    problemsResolved,
    timeEntriesStarted,
    timeEntriesEnded,
    jobEvents,
  ] = await Promise.all([
      db.job.findMany({
        where: {
          businessId: input.businessId,
          createdAt: { gte: input.since },
          ...customerWhere,
        },
        select: {
          id: true,
          customerId: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.take,
      }),
      db.job.findMany({
        where: {
          businessId: input.businessId,
          startWithoutConfirmationAt: { gte: input.since },
          ...customerWhere,
        },
        select: {
          id: true,
          customerId: true,
          startWithoutConfirmationAt: true,
        },
        orderBy: [{ startWithoutConfirmationAt: "desc" }, { id: "desc" }],
        take: input.take,
      }),
      db.jobAppointmentEvent.findMany({
        where: {
          businessId: input.businessId,
          createdAt: { gte: input.since },
          job: jobScope,
        },
        select: {
          id: true,
          jobId: true,
          eventType: true,
          createdAt: true,
          job: { select: { customerId: true } },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.take,
      }),
      db.additionalWorkRequest.findMany({
        where: {
          businessId: input.businessId,
          createdAt: { gte: input.since },
          job: jobScope,
        },
        select: {
          id: true,
          jobId: true,
          status: true,
          createdAt: true,
          job: { select: { customerId: true } },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.take,
      }),
      db.additionalWorkRequest.findMany({
        where: {
          businessId: input.businessId,
          reviewedAt: { gte: input.since },
          job: jobScope,
        },
        select: {
          id: true,
          jobId: true,
          status: true,
          reviewedAt: true,
          job: { select: { customerId: true } },
        },
        orderBy: [{ reviewedAt: "desc" }, { id: "desc" }],
        take: input.take,
      }),
      db.jobProblemReport.findMany({
        where: {
          businessId: input.businessId,
          createdAt: { gte: input.since },
          job: jobScope,
        },
        select: {
          id: true,
          jobId: true,
          createdAt: true,
          job: { select: { customerId: true } },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.take,
      }),
      db.jobProblemReport.findMany({
        where: {
          businessId: input.businessId,
          resolvedAt: { gte: input.since },
          job: jobScope,
        },
        select: {
          id: true,
          jobId: true,
          resolvedAt: true,
          job: { select: { customerId: true } },
        },
        orderBy: [{ resolvedAt: "desc" }, { id: "desc" }],
        take: input.take,
      }),
      db.timeEntry.findMany({
        where: {
          businessId: input.businessId,
          startedAt: { gte: input.since },
          ...timeJobScope,
        },
        select: {
          id: true,
          jobId: true,
          activityType: true,
          startedAt: true,
          job: { select: { customerId: true } },
        },
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
        take: input.take,
      }),
      db.timeEntry.findMany({
        where: {
          businessId: input.businessId,
          endedAt: { gte: input.since },
          ...timeJobScope,
        },
        select: {
          id: true,
          jobId: true,
          activityType: true,
          endedAt: true,
          job: { select: { customerId: true } },
        },
        orderBy: [{ endedAt: "desc" }, { id: "desc" }],
        take: input.take,
      }),
      db.businessEvent.findMany({
        where: {
          businessId: input.businessId,
          occurredAt: { gte: input.since },
          type: { in: [...BUSINESS_EVENT_TIMELINE_TYPES.filter((type) => type.startsWith("JOB_"))] },
        },
        select: {
          id: true,
          type: true,
          subjectType: true,
          subjectId: true,
          occurredAt: true,
        },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: input.take,
      }),
    ]);

  const drafts: BusinessTimelineDraft[] = [];
  for (const row of jobsCreated) {
    drafts.push(
      draft({
        id: `job:${row.id}:recorded`,
        occurredAt: row.createdAt,
        eventType: "JOB_RECORDED",
        category: "work",
        description: describeJobRecorded(row.id),
        customerId: row.customerId,
        relatedType: "JOB",
        relatedId: row.id,
        relatedJobId: row.id,
        relatedLabel: jobTimelineReference(row.id),
        sourceStatus: null,
      }),
    );
  }
  for (const row of jobsStartedWithoutConfirmation) {
    if (!row.startWithoutConfirmationAt) continue;
    drafts.push(
      draft({
        id: `job:${row.id}:start-without-confirmation`,
        occurredAt: row.startWithoutConfirmationAt,
        eventType: "JOB_START_WITHOUT_CONFIRMATION",
        category: "work",
        description: describeJobStartWithoutConfirmation(row.id),
        customerId: row.customerId,
        relatedType: "JOB",
        relatedId: row.id,
        relatedJobId: row.id,
        relatedLabel: jobTimelineReference(row.id),
        sourceStatus: null,
      }),
    );
  }
  for (const row of appointmentEvents) {
    const isNotification = row.eventType.startsWith("APPOINTMENT_NOTIFICATION");
    drafts.push(
      draft({
        id: `appointment-event:${row.id}`,
        occurredAt: row.createdAt,
        eventType: row.eventType,
        category: isNotification ? "communications" : "work",
        description: describeAppointmentEvent(row.eventType),
        customerId: row.job.customerId,
        relatedType: "JOB",
        relatedId: row.jobId,
        relatedJobId: row.jobId,
        relatedLabel: jobTimelineReference(row.jobId),
        sourceStatus: row.eventType,
      }),
    );
  }
  for (const row of additionalWorkCreated) {
    drafts.push(
      draft({
        id: `additional-work:${row.id}:recorded`,
        occurredAt: row.createdAt,
        eventType: "ADDITIONAL_WORK_RECORDED",
        category: "work",
        description: describeAdditionalWorkRecorded(),
        customerId: row.job.customerId,
        relatedType: "JOB",
        relatedId: row.jobId,
        relatedJobId: row.jobId,
        relatedLabel: jobTimelineReference(row.jobId),
        sourceStatus: row.status,
      }),
    );
  }
  for (const row of additionalWorkReviewed) {
    if (!row.reviewedAt) continue;
    drafts.push(
      draft({
        id: `additional-work:${row.id}:reviewed`,
        occurredAt: row.reviewedAt,
        eventType: "ADDITIONAL_WORK_REVIEWED",
        category: "work",
        description: describeAdditionalWorkReviewed(row.status),
        customerId: row.job.customerId,
        relatedType: "JOB",
        relatedId: row.jobId,
        relatedJobId: row.jobId,
        relatedLabel: jobTimelineReference(row.jobId),
        sourceStatus: row.status,
      }),
    );
  }
  for (const row of problemsCreated) {
    drafts.push(
      draft({
        id: `problem-report:${row.id}:recorded`,
        occurredAt: row.createdAt,
        eventType: "PROBLEM_REPORT_RECORDED",
        category: "work",
        description: describeProblemReportRecorded(),
        customerId: row.job.customerId,
        relatedType: "JOB",
        relatedId: row.jobId,
        relatedJobId: row.jobId,
        relatedLabel: jobTimelineReference(row.jobId),
        sourceStatus: null,
      }),
    );
  }
  for (const row of problemsResolved) {
    if (!row.resolvedAt) continue;
    drafts.push(
      draft({
        id: `problem-report:${row.id}:resolved`,
        occurredAt: row.resolvedAt,
        eventType: "PROBLEM_REPORT_RESOLVED",
        category: "work",
        description: describeProblemReportResolved(),
        customerId: row.job.customerId,
        relatedType: "JOB",
        relatedId: row.jobId,
        relatedJobId: row.jobId,
        relatedLabel: jobTimelineReference(row.jobId),
        sourceStatus: "RESOLVED",
      }),
    );
  }
  for (const row of timeEntriesStarted) {
    drafts.push(
      draft({
        id: `time-entry:${row.id}:started`,
        occurredAt: row.startedAt,
        eventType: "TIME_ENTRY_STARTED",
        category: "work",
        description: describeTimeEntryStarted(row.activityType),
        customerId: row.job?.customerId ?? null,
        relatedType: row.jobId ? "JOB" : "TIME_ENTRY",
        relatedId: row.jobId ?? row.id,
        relatedJobId: row.jobId,
        relatedLabel: row.jobId ? jobTimelineReference(row.jobId) : "Time entry",
        sourceStatus: null,
      }),
    );
  }
  for (const row of timeEntriesEnded) {
    if (!row.endedAt) continue;
    drafts.push(
      draft({
        id: `time-entry:${row.id}:ended`,
        occurredAt: row.endedAt,
        eventType: "TIME_ENTRY_ENDED",
        category: "work",
        description: describeTimeEntryEnded(row.activityType),
        customerId: row.job?.customerId ?? null,
        relatedType: row.jobId ? "JOB" : "TIME_ENTRY",
        relatedId: row.jobId ?? row.id,
        relatedJobId: row.jobId,
        relatedLabel: row.jobId ? jobTimelineReference(row.jobId) : "Time entry",
        sourceStatus: null,
      }),
    );
  }

  const jobEventIds = jobEvents
    .filter((row) => row.subjectType === "JOB")
    .map((row) => row.subjectId);
  const ownedJobs =
    jobEventIds.length === 0
      ? []
      : await db.job.findMany({
          where: { businessId: input.businessId, id: { in: jobEventIds }, ...customerWhere },
          select: { id: true, customerId: true },
        });
  const ownedJobMap = new Map(ownedJobs.map((row) => [row.id, row.customerId]));
  for (const row of jobEvents) {
    if (row.subjectType !== "JOB") continue;
    const customerId = ownedJobMap.get(row.subjectId);
    if (customerId === undefined) continue;
    drafts.push(
      draft({
        id: `business-event:${row.id}`,
        occurredAt: row.occurredAt,
        eventType: row.type,
        category: "work",
        description:
          row.type === "JOB_COMPLETED"
            ? describeJobCompleted(row.subjectId)
            : describeJobStarted(row.subjectId),
        customerId,
        relatedType: "JOB",
        relatedId: row.subjectId,
        relatedJobId: row.subjectId,
        relatedLabel: jobTimelineReference(row.subjectId),
        sourceStatus: row.type,
      }),
    );
  }
  return drafts;
}

async function collectMoneyDrafts(
  db: Db,
  input: {
    businessId: string;
    since: Date;
    take: number;
    customerId: string | null;
  },
): Promise<BusinessTimelineDraft[]> {
  const customerWhere = input.customerId ? { customerId: input.customerId } : {};
  const [invoicesCreated, invoicesPaid, payments, invoiceEvents] = await Promise.all([
    db.invoice.findMany({
      where: {
        businessId: input.businessId,
        createdAt: { gte: input.since },
        ...customerWhere,
      },
      select: { id: true, customerId: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.take,
    }),
    db.invoice.findMany({
      where: {
        businessId: input.businessId,
        paidAt: { gte: input.since },
        ...customerWhere,
      },
      select: { id: true, customerId: true, paidAt: true },
      orderBy: [{ paidAt: "desc" }, { id: "desc" }],
      take: input.take,
    }),
    db.payment.findMany({
      where: {
        businessId: input.businessId,
        receivedAt: { gte: input.since },
        ...customerWhere,
      },
      select: {
        id: true,
        customerId: true,
        invoiceId: true,
        amount: true,
        receivedAt: true,
      },
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
      take: input.take,
    }),
    db.businessEvent.findMany({
      where: {
        businessId: input.businessId,
        occurredAt: { gte: input.since },
        type: {
          in: [...BUSINESS_EVENT_TIMELINE_TYPES.filter((type) => type.startsWith("INVOICE_"))],
        },
      },
      select: {
        id: true,
        type: true,
        subjectType: true,
        subjectId: true,
        occurredAt: true,
      },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: input.take,
    }),
  ]);

  const drafts: BusinessTimelineDraft[] = [];
  for (const row of invoicesCreated) {
    drafts.push(
      draft({
        id: `invoice:${row.id}:recorded`,
        occurredAt: row.createdAt,
        eventType: "INVOICE_RECORDED",
        category: "money",
        description: describeInvoiceRecorded(row.id),
        customerId: row.customerId,
        relatedType: "INVOICE",
        relatedId: row.id,
        relatedJobId: null,
        relatedLabel: invoiceTimelineNumber(row.id),
        sourceStatus: null,
      }),
    );
  }
  for (const row of invoicesPaid) {
    if (!row.paidAt) continue;
    drafts.push(
      draft({
        id: `invoice:${row.id}:paid`,
        occurredAt: row.paidAt,
        eventType: "INVOICE_PAID",
        category: "money",
        description: describeInvoicePaid(row.id),
        customerId: row.customerId,
        relatedType: "INVOICE",
        relatedId: row.id,
        relatedJobId: null,
        relatedLabel: invoiceTimelineNumber(row.id),
        sourceStatus: "PAID",
      }),
    );
  }
  for (const row of payments) {
    drafts.push(
      draft({
        id: `payment:${row.id}:recorded`,
        occurredAt: row.receivedAt,
        eventType: "PAYMENT_RECORDED",
        category: "money",
        description: describePaymentRecorded(row.amount),
        customerId: row.customerId,
        relatedType: row.invoiceId ? "INVOICE" : "CUSTOMER",
        relatedId: row.invoiceId ?? row.customerId ?? row.id,
        relatedJobId: null,
        relatedLabel: row.invoiceId ? invoiceTimelineNumber(row.invoiceId) : "Payment",
        sourceStatus: null,
      }),
    );
  }

  const invoiceEventIds = invoiceEvents
    .filter((row) => row.subjectType === "INVOICE")
    .map((row) => row.subjectId);
  const ownedInvoices =
    invoiceEventIds.length === 0
      ? []
      : await db.invoice.findMany({
          where: {
            businessId: input.businessId,
            id: { in: invoiceEventIds },
            ...customerWhere,
          },
          select: { id: true, customerId: true },
        });
  const ownedInvoiceMap = new Map(ownedInvoices.map((row) => [row.id, row.customerId]));
  for (const row of invoiceEvents) {
    if (row.subjectType !== "INVOICE") continue;
    const customerId = ownedInvoiceMap.get(row.subjectId);
    if (customerId === undefined) continue;
    drafts.push(
      draft({
        id: `business-event:${row.id}`,
        occurredAt: row.occurredAt,
        eventType: row.type,
        category: "money",
        description: describeInvoiceLifecycleEvent(row.type, row.subjectId),
        customerId,
        relatedType: "INVOICE",
        relatedId: row.subjectId,
        relatedJobId: null,
        relatedLabel: invoiceTimelineNumber(row.subjectId),
        sourceStatus: row.type,
      }),
    );
  }
  return drafts;
}

async function collectCommunicationDrafts(
  db: Db,
  input: {
    businessId: string;
    since: Date;
    take: number;
    customerId: string | null;
  },
): Promise<BusinessTimelineDraft[]> {
  const customerWhere = input.customerId ? { customerId: input.customerId } : {};
  const [communicationsAttempted, communicationsCreated, phones, reviewRequests, followUps] =
    await Promise.all([
    db.customerCommunication.findMany({
      where: {
        businessId: input.businessId,
        attemptedAt: { gte: input.since },
        ...customerWhere,
      },
      select: {
        id: true,
        customerId: true,
        channel: true,
        status: true,
        relatedType: true,
        relatedId: true,
        createdAt: true,
        attemptedAt: true,
      },
      orderBy: [{ attemptedAt: "desc" }, { id: "desc" }],
      take: input.take,
    }),
    db.customerCommunication.findMany({
      where: {
        businessId: input.businessId,
        createdAt: { gte: input.since },
        ...customerWhere,
      },
      select: {
        id: true,
        customerId: true,
        channel: true,
        status: true,
        relatedType: true,
        relatedId: true,
        createdAt: true,
        attemptedAt: true,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.take,
    }),
    db.phoneInteraction.findMany({
      where: {
        businessId: input.businessId,
        occurredAt: { gte: input.since },
        ...customerWhere,
      },
      select: {
        id: true,
        customerId: true,
        kind: true,
        status: true,
        occurredAt: true,
        requestId: true,
        jobId: true,
        communicationId: true,
      },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: input.take,
    }),
    db.reviewRequest.findMany({
      where: {
        businessId: input.businessId,
        requestedAt: { gte: input.since },
        ...customerWhere,
      },
      select: { id: true, customerId: true, jobId: true, requestedAt: true },
      orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
      take: input.take,
    }),
    db.customerFollowUp.findMany({
      where: {
        businessId: input.businessId,
        sentAt: { gte: input.since },
        ...customerWhere,
      },
      select: { id: true, customerId: true, jobId: true, sentAt: true },
      orderBy: [{ sentAt: "desc" }, { id: "desc" }],
      take: input.take,
    }),
  ]);

  const drafts: BusinessTimelineDraft[] = [];
  const representedCommunicationIds = new Set<string>();
  const pushCommunication = (row: {
    id: string;
    customerId: string;
    channel: string;
    status: string;
    relatedType: string | null;
    relatedId: string | null;
    createdAt: Date;
    attemptedAt: Date | null;
  }) => {
    const occurredAt = row.attemptedAt ?? row.createdAt;
    if (occurredAt < input.since) return;
    if (representedCommunicationIds.has(row.id)) return;
    representedCommunicationIds.add(row.id);
    const relatedType = row.relatedType ?? "CUSTOMER";
    const relatedId = row.relatedId ?? row.customerId;
    drafts.push(
      draft({
        id: `communication:${row.id}`,
        occurredAt,
        eventType: "COMMUNICATION_RECORDED",
        category: "communications",
        description: describeRecordedCommunication(row.channel, row.status),
        customerId: row.customerId,
        relatedType,
        relatedId,
        relatedJobId: relatedType === "JOB" ? relatedId : null,
        relatedLabel: relatedType.replaceAll("_", " "),
        sourceStatus: row.status,
      }),
    );
  };
  for (const row of communicationsAttempted) pushCommunication(row);
  for (const row of communicationsCreated) pushCommunication(row);
  for (const row of phones) {
    if (row.communicationId && representedCommunicationIds.has(row.communicationId)) {
      continue;
    }
    drafts.push(
      draft({
        id: `phone:${row.id}`,
        occurredAt: row.occurredAt,
        eventType: "PHONE_INTERACTION_RECORDED",
        category: "communications",
        description: describePhoneInteraction(row.kind, row.status),
        customerId: row.customerId,
        relatedType: row.jobId ? "JOB" : row.requestId ? "SERVICE_REQUEST" : "CUSTOMER",
        relatedId: row.jobId ?? row.requestId ?? row.customerId ?? row.id,
        relatedJobId: row.jobId,
        relatedLabel: row.kind,
        sourceStatus: row.status,
      }),
    );
  }
  for (const row of reviewRequests) {
    if (!row.requestedAt) continue;
    drafts.push(
      draft({
        id: `review-request:${row.id}:requested`,
        occurredAt: row.requestedAt,
        eventType: "REVIEW_REQUEST_RECORDED",
        category: "communications",
        description: describeReviewRequestRecorded(),
        customerId: row.customerId,
        relatedType: row.jobId ? "JOB" : "CUSTOMER",
        relatedId: row.jobId ?? row.customerId,
        relatedJobId: row.jobId,
        relatedLabel: "Review request",
        sourceStatus: "SENT",
      }),
    );
  }
  for (const row of followUps) {
    if (!row.sentAt) continue;
    drafts.push(
      draft({
        id: `follow-up:${row.id}:sent`,
        occurredAt: row.sentAt,
        eventType: "CUSTOMER_FOLLOW_UP_SENT",
        category: "communications",
        description: describeCustomerFollowUpSent(),
        customerId: row.customerId,
        relatedType: row.jobId ? "JOB" : "CUSTOMER",
        relatedId: row.jobId ?? row.customerId,
        relatedJobId: row.jobId,
        relatedLabel: "Follow-up",
        sourceStatus: "SENT",
      }),
    );
  }
  return drafts;
}

async function collectOperationsDrafts(
  db: Db,
  input: {
    businessId: string;
    since: Date;
    take: number;
    customerId: string | null;
  },
): Promise<BusinessTimelineDraft[]> {
  if (input.customerId) return [];

  const AGREEMENT_SELECT = {
    id: true,
    title: true,
    createdAt: true,
    completedAt: true,
    ownerReviewedAt: true,
    legalReviewAcknowledgedAt: true,
  } as const;
  const [actionItems, recommendations, vaultRecords, agreementsCreated, agreementsCompleted, agreementsOwnerReviewed, agreementsLegalAcknowledged, acknowledgments] =
    await Promise.all([
      db.businessActionItem.findMany({
        where: { businessId: input.businessId, createdAt: { gte: input.since } },
        select: { id: true, title: true, createdAt: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.take,
      }),
      db.bsosRecommendationState.findMany({
        where: { businessId: input.businessId, createdAt: { gte: input.since } },
        select: {
          id: true,
          recommendationKey: true,
          history: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.take,
      }),
      db.businessVaultRecord.findMany({
        where: { businessId: input.businessId, createdAt: { gte: input.since } },
        select: { id: true, title: true, createdAt: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.take,
      }),
      db.businessAgreement.findMany({
        where: {
          businessId: input.businessId,
          createdAt: { gte: input.since },
        },
        select: AGREEMENT_SELECT,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.take,
      }),
      db.businessAgreement.findMany({
        where: {
          businessId: input.businessId,
          completedAt: { gte: input.since },
        },
        select: AGREEMENT_SELECT,
        orderBy: [{ completedAt: "desc" }, { id: "desc" }],
        take: input.take,
      }),
      db.businessAgreement.findMany({
        where: {
          businessId: input.businessId,
          ownerReviewedAt: { gte: input.since },
        },
        select: AGREEMENT_SELECT,
        orderBy: [{ ownerReviewedAt: "desc" }, { id: "desc" }],
        take: input.take,
      }),
      db.businessAgreement.findMany({
        where: {
          businessId: input.businessId,
          legalReviewAcknowledgedAt: { gte: input.since },
        },
        select: AGREEMENT_SELECT,
        orderBy: [{ legalReviewAcknowledgedAt: "desc" }, { id: "desc" }],
        take: input.take,
      }),
      db.businessProtectionAcknowledgment.findMany({
        where: { businessId: input.businessId, acknowledgedAt: { gte: input.since } },
        select: { id: true, kind: true, acknowledgedAt: true },
        orderBy: [{ acknowledgedAt: "desc" }, { id: "desc" }],
        take: input.take,
      }),
    ]);

  const drafts: BusinessTimelineDraft[] = [];
  for (const row of actionItems) {
    drafts.push(
      draft({
        id: `action-item:${row.id}:recorded`,
        occurredAt: row.createdAt,
        eventType: "ACTION_ITEM_RECORDED",
        category: "operations",
        description: describeActionItemRecorded(row.title),
        customerId: null,
        relatedType: "ACTION_ITEM",
        relatedId: row.id,
        relatedJobId: null,
        relatedLabel: row.title,
        sourceStatus: null,
      }),
    );
  }
  for (const row of recommendations) {
    drafts.push(
      draft({
        id: `recommendation:${row.id}:recorded`,
        occurredAt: row.createdAt,
        eventType: "RECOMMENDATION_RECORDED",
        category: "operations",
        description: describeRecommendationRecorded(row.recommendationKey),
        customerId: null,
        relatedType: "RECOMMENDATION",
        relatedId: row.id,
        relatedJobId: null,
        relatedLabel: row.recommendationKey,
        sourceStatus: null,
      }),
    );
    for (const entry of recommendationHistoryEntries(row.history)) {
      if (entry.at < input.since) continue;
      drafts.push(
        draft({
          id: `recommendation:${row.id}:history:${entry.at.toISOString()}:${entry.status}`,
          occurredAt: entry.at,
          eventType: "RECOMMENDATION_STATUS_RECORDED",
          category: "operations",
          description: describeRecommendationHistoryStatus(entry.status),
          customerId: null,
          relatedType: "RECOMMENDATION",
          relatedId: row.id,
          relatedJobId: null,
          relatedLabel: row.recommendationKey,
          sourceStatus: entry.status,
        }),
      );
    }
  }
  for (const row of vaultRecords) {
    drafts.push(
      draft({
        id: `vault:${row.id}:recorded`,
        occurredAt: row.createdAt,
        eventType: "VAULT_RECORD_RECORDED",
        category: "operations",
        description: describeVaultRecorded(row.title),
        customerId: null,
        relatedType: "VAULT_RECORD",
        relatedId: row.id,
        relatedJobId: null,
        relatedLabel: row.title,
        sourceStatus: null,
      }),
    );
  }
  for (const row of agreementsCreated) {
    drafts.push(
      draft({
        id: `agreement:${row.id}:recorded`,
        occurredAt: row.createdAt,
        eventType: "AGREEMENT_RECORDED",
        category: "operations",
        description: describeAgreementRecorded(row.title),
        customerId: null,
        relatedType: "AGREEMENT",
        relatedId: row.id,
        relatedJobId: null,
        relatedLabel: row.title,
        sourceStatus: null,
      }),
    );
  }
  for (const row of agreementsCompleted) {
    if (!row.completedAt) continue;
    drafts.push(
      draft({
        id: `agreement:${row.id}:completed`,
        occurredAt: row.completedAt,
        eventType: "AGREEMENT_COMPLETED",
        category: "operations",
        description: describeAgreementCompleted(row.title),
        customerId: null,
        relatedType: "AGREEMENT",
        relatedId: row.id,
        relatedJobId: null,
        relatedLabel: row.title,
        sourceStatus: "COMPLETE",
      }),
    );
  }
  for (const row of agreementsOwnerReviewed) {
    if (!row.ownerReviewedAt) continue;
    drafts.push(
      draft({
        id: `agreement:${row.id}:owner-reviewed`,
        occurredAt: row.ownerReviewedAt,
        eventType: "AGREEMENT_OWNER_REVIEWED",
        category: "operations",
        description: describeAgreementOwnerReviewed(row.title),
        customerId: null,
        relatedType: "AGREEMENT",
        relatedId: row.id,
        relatedJobId: null,
        relatedLabel: row.title,
        sourceStatus: null,
      }),
    );
  }
  for (const row of agreementsLegalAcknowledged) {
    if (!row.legalReviewAcknowledgedAt) continue;
    drafts.push(
      draft({
        id: `agreement:${row.id}:legal-acknowledged`,
        occurredAt: row.legalReviewAcknowledgedAt,
        eventType: "AGREEMENT_LEGAL_ACKNOWLEDGED",
        category: "operations",
        description: describeAgreementLegalAcknowledged(row.title),
        customerId: null,
        relatedType: "AGREEMENT",
        relatedId: row.id,
        relatedJobId: null,
        relatedLabel: row.title,
        sourceStatus: null,
      }),
    );
  }
  for (const row of acknowledgments) {
    drafts.push(
      draft({
        id: `protection-ack:${row.id}`,
        occurredAt: row.acknowledgedAt,
        eventType: "PROTECTION_ACKNOWLEDGED",
        category: "operations",
        description: describeProtectionAcknowledged(row.kind),
        customerId: null,
        relatedType: "VAULT_RECORD",
        relatedId: row.id,
        relatedJobId: null,
        relatedLabel: row.kind,
        sourceStatus: row.kind,
      }),
    );
  }
  return drafts;
}

export async function loadBusinessTimeline(
  db: Db,
  access: BusinessTimelineAccess,
  query: BusinessTimelineQuery = {},
): Promise<BusinessTimeline> {
  requireBusinessTimelineAccess(access);

  const category = parseBusinessTimelineCategory(query.category);
  const customerId = parseBusinessTimelineCustomerId(query.customerId);
  const limit = Math.min(
    Math.max(query.limit ?? BUSINESS_TIMELINE_LIMIT, 1),
    BUSINESS_TIMELINE_LIMIT,
  );
  const window = resolveBusinessTimelineWindow(query);

  const [business, filterCustomer, customers] = await Promise.all([
    db.business.findFirst({
      where: { id: access.businessId },
      select: { id: true, timezone: true },
    }),
    customerId
      ? db.customer.findFirst({
          where: { id: customerId, businessId: access.businessId },
          select: { id: true },
        })
      : Promise.resolve(null),
    listBusinessTimelineCustomers(db, access),
  ]);
  if (!business) throw new ForbiddenError();
  if (customerId && !filterCustomer) throw new ForbiddenError();

  const scopedCustomerId = filterCustomer?.id ?? null;
  const take = BUSINESS_TIMELINE_SOURCE_LIMIT;
  const sourceInput = {
    businessId: access.businessId,
    since: window.since,
    take,
    customerId: scopedCustomerId,
  };

  const groups = await Promise.all([
    includesCategory(category, "sales") ? collectSalesDrafts(db, sourceInput) : [],
    includesCategory(category, "work") || includesCategory(category, "communications")
      ? collectWorkDrafts(db, sourceInput)
      : [],
    includesCategory(category, "money") ? collectMoneyDrafts(db, sourceInput) : [],
    includesCategory(category, "communications")
      ? collectCommunicationDrafts(db, sourceInput)
      : [],
    includesCategory(category, "operations") && !scopedCustomerId
      ? collectOperationsDrafts(db, sourceInput)
      : [],
  ]);

  let drafts = groups.flat();
  if (category !== "all") {
    drafts = drafts.filter((item) => item.category === category);
  }
  if (scopedCustomerId) {
    drafts = drafts.filter(
      (item) =>
        item.customerId === scopedCustomerId && CUSTOMER_BOUND_CATEGORIES.has(item.category),
    );
  }

  const sorted = sortBusinessTimelineItems(drafts);
  const truncated =
    sorted.length > limit ||
    groups.some((group) => group.length >= take);
  const bounded = sorted.slice(0, limit);
  const ownedCustomers = await loadOwnedCustomers(
    db,
    access.businessId,
    bounded.map((item) => item.customerId).filter((id): id is string => Boolean(id)),
  );
  const items = await attachVerifiedTimelineLinks(db, {
    businessId: access.businessId,
    customerId: scopedCustomerId,
    drafts: bounded,
    customers: ownedCustomers,
  });

  return {
    businessId: access.businessId,
    timeZone: resolveBusinessTimeZone(business),
    category,
    customerId: scopedCustomerId,
    lookbackDays: window.lookbackDays,
    limit,
    since: window.since.toISOString(),
    truncated,
    items,
    customers,
  };
}
