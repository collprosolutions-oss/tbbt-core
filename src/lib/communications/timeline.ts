import type { Prisma, PrismaClient } from "@prisma/client";
import { ForbiddenError } from "@/lib/authorization";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import {
  requireCommunicationsCapability,
  type CommunicationAccess,
} from "@/lib/communications/engine";
import type { CommunicationChannel } from "@/lib/communications/types";

type Db = PrismaClient | Prisma.TransactionClient;

export const CUSTOMER_COMMUNICATION_TIMELINE_LIMIT = 80;

export type CommunicationTimelineSource = "record" | "phone";
export type CommunicationTimelineDirection = "INBOUND" | "OUTBOUND";

export type CommunicationTimelineItem = {
  id: string;
  source: CommunicationTimelineSource;
  occurredAt: string;
  direction: CommunicationTimelineDirection | null;
  channel: CommunicationChannel;
  purpose: string;
  subject: string | null;
  body: string;
  status: string;
  relatedType: string | null;
  relatedId: string | null;
  contextLabel: string;
  relatedHref: string | null;
  failureReason: string | null;
  consentContext: string | null;
  provider: string | null;
  reusedSafe: boolean;
};

export type CommunicationTimelineSummary = {
  lastOccurredAt: string | null;
  lastChannel: string | null;
  lastDirection: CommunicationTimelineDirection | null;
  lastStatus: string | null;
  lastPurpose: string | null;
  itemCount: number;
  truncated: boolean;
};

export type CustomerCommunicationHistory = {
  customerId: string;
  businessId: string;
  timeZone: string;
  items: CommunicationTimelineItem[];
  summary: CommunicationTimelineSummary;
};

const CONTEXT_RECORD_HREFS: Record<string, (id: string) => string> = {
  ESTIMATE: (id) => `/estimates/${id}`,
  JOB: (id) => `/jobs/${id}`,
  INVOICE: (id) => `/invoices/${id}`,
  SERVICE_REQUEST: (id) => `/requests/${id}`,
};

export function recordedCommunicationDirection(
  value: string | null | undefined,
): CommunicationTimelineDirection | null {
  if (value === "INBOUND" || value === "OUTBOUND") return value;
  return null;
}

export function communicationContextLabel(
  relatedType: string | null | undefined,
  purpose: string,
): string {
  const related = relatedType?.trim() ?? "";
  if (related === "ESTIMATE" || purpose.startsWith("ESTIMATE")) return "Estimate";
  if (related === "INVOICE" || purpose.startsWith("INVOICE") || purpose.startsWith("PAYMENT")) {
    return "Invoice";
  }
  if (
    purpose.startsWith("APPOINTMENT") ||
    purpose === "SCHEDULE_CHANGE"
  ) {
    return "Appointment";
  }
  if (related === "SERVICE_REQUEST") return "Request";
  if (related === "JOB" || purpose.startsWith("JOB")) return "Job";
  if (related === "REVIEW_REQUEST" || purpose.startsWith("REVIEW")) return "Review request";
  if (related === "REFERRAL_REQUEST" || purpose.startsWith("REFERRAL")) return "Referral";
  if (related === "PHONE_INTERACTION" || purpose.includes("CALL") || purpose.includes("PHONE")) {
    return "Phone";
  }
  return "Customer";
}

export function summarizeCustomerCommunicationTimeline(
  items: CommunicationTimelineItem[],
  truncated = false,
): CommunicationTimelineSummary {
  const newest = items[0] ?? null;
  return {
    lastOccurredAt: newest?.occurredAt ?? null,
    lastChannel: newest?.channel ?? null,
    lastDirection: newest?.direction ?? null,
    lastStatus: newest?.status ?? null,
    lastPurpose: newest?.purpose ?? null,
    itemCount: items.length,
    truncated,
  };
}

export function filterCommunicationTimelineItems(
  items: CommunicationTimelineItem[],
  filter: { channel?: string | null; direction?: string | null },
): CommunicationTimelineItem[] {
  const channel = filter.channel?.trim() || null;
  const direction = filter.direction?.trim() || null;
  return items.filter((item) => {
    if (channel && channel !== "all" && item.channel !== channel) return false;
    if (direction && direction !== "all") {
      if (direction === "UNRECORDED") return item.direction == null;
      if (item.direction !== direction) return false;
    }
    return true;
  });
}

export function compareCommunicationTimelineItems(
  left: CommunicationTimelineItem,
  right: CommunicationTimelineItem,
) {
  if (left.occurredAt !== right.occurredAt) {
    return right.occurredAt.localeCompare(left.occurredAt);
  }
  return right.id.localeCompare(left.id);
}

function emptyHistory(
  businessId: string,
  customerId: string,
  timeZone: string,
): CustomerCommunicationHistory {
  return {
    customerId,
    businessId,
    timeZone,
    items: [],
    summary: summarizeCustomerCommunicationTimeline([], false),
  };
}

function mapCommunicationRecord(row: {
  id: string;
  direction: string;
  channel: string;
  purpose: string;
  subject: string | null;
  bodySnapshot: string;
  status: string;
  relatedType: string | null;
  relatedId: string | null;
  failureReason: string | null;
  consentContext: string | null;
  provider: string;
  createdAt: Date;
  attemptedAt: Date | null;
}): CommunicationTimelineItem {
  return {
    id: row.id,
    source: "record",
    occurredAt: (row.attemptedAt ?? row.createdAt).toISOString(),
    direction: recordedCommunicationDirection(row.direction),
    channel: row.channel as CommunicationChannel,
    purpose: row.purpose,
    subject: row.subject,
    body: row.bodySnapshot,
    status: row.status,
    relatedType: row.relatedType,
    relatedId: row.relatedId,
    contextLabel: communicationContextLabel(row.relatedType, row.purpose),
    relatedHref: null,
    failureReason: row.failureReason,
    consentContext: row.consentContext,
    provider: row.provider,
    reusedSafe: true,
  };
}

function mapPhoneInteraction(row: {
  id: string;
  kind: string;
  status: string;
  direction: string;
  summary: string;
  callbackNeeded: boolean;
  occurredAt: Date;
  requestId: string | null;
  jobId: string | null;
}): CommunicationTimelineItem {
  const relatedType = row.jobId ? "JOB" : row.requestId ? "SERVICE_REQUEST" : "PHONE_INTERACTION";
  const relatedId = row.jobId ?? row.requestId ?? row.id;
  return {
    id: `phone:${row.id}`,
    source: "phone",
    occurredAt: row.occurredAt.toISOString(),
    direction: recordedCommunicationDirection(row.direction),
    channel: "PHONE",
    purpose: row.kind,
    subject: row.callbackNeeded ? "Callback needed" : "Phone log",
    body: row.summary,
    status: row.status,
    relatedType,
    relatedId,
    contextLabel: communicationContextLabel(relatedType, row.kind),
    relatedHref: null,
    failureReason: null,
    consentContext: null,
    provider: "manual",
    reusedSafe: true,
  };
}

async function attachVerifiedContextLinks(
  db: Db,
  input: { businessId: string; customerId: string; items: CommunicationTimelineItem[] },
): Promise<CommunicationTimelineItem[]> {
  const idsByType = new Map<string, string[]>();
  for (const item of input.items) {
    if (!item.relatedType || !item.relatedId) continue;
    if (!CONTEXT_RECORD_HREFS[item.relatedType]) continue;
    const list = idsByType.get(item.relatedType) ?? [];
    list.push(item.relatedId);
    idsByType.set(item.relatedType, list);
  }

  const verified = new Set<string>();
  const lookups: Array<Promise<void>> = [];
  const selectOwned = async (
    relatedType: string,
    rows: Promise<Array<{ id: string }>>,
  ) => {
    for (const row of await rows) {
      verified.add(`${relatedType}:${row.id}`);
    }
  };

  const estimateIds = [...new Set(idsByType.get("ESTIMATE") ?? [])];
  if (estimateIds.length) {
    lookups.push(
      selectOwned(
        "ESTIMATE",
        db.estimate.findMany({
          where: {
            businessId: input.businessId,
            customerId: input.customerId,
            id: { in: estimateIds },
          },
          select: { id: true },
        }),
      ),
    );
  }
  const jobIds = [...new Set(idsByType.get("JOB") ?? [])];
  if (jobIds.length) {
    lookups.push(
      selectOwned(
        "JOB",
        db.job.findMany({
          where: {
            businessId: input.businessId,
            customerId: input.customerId,
            id: { in: jobIds },
          },
          select: { id: true },
        }),
      ),
    );
  }
  const invoiceIds = [...new Set(idsByType.get("INVOICE") ?? [])];
  if (invoiceIds.length) {
    lookups.push(
      selectOwned(
        "INVOICE",
        db.invoice.findMany({
          where: {
            businessId: input.businessId,
            customerId: input.customerId,
            id: { in: invoiceIds },
          },
          select: { id: true },
        }),
      ),
    );
  }
  const requestIds = [...new Set(idsByType.get("SERVICE_REQUEST") ?? [])];
  if (requestIds.length) {
    lookups.push(
      selectOwned(
        "SERVICE_REQUEST",
        db.serviceRequest.findMany({
          where: {
            businessId: input.businessId,
            customerId: input.customerId,
            id: { in: requestIds },
          },
          select: { id: true },
        }),
      ),
    );
  }
  if (lookups.length) await Promise.all(lookups);

  return input.items.map((item) => {
    const hrefBuilder = item.relatedType ? CONTEXT_RECORD_HREFS[item.relatedType] : null;
    const key = item.relatedType && item.relatedId ? `${item.relatedType}:${item.relatedId}` : null;
    return {
      ...item,
      relatedHref: hrefBuilder && key && verified.has(key) ? hrefBuilder(item.relatedId!) : null,
    };
  });
}

/**
 * Recorded customer communication history only.
 * Lifecycle status on estimates, invoices, jobs, or review requests is never
 * treated as proof that a message was sent or delivered.
 */
export async function loadCustomerCommunicationHistory(
  db: Db,
  access: CommunicationAccess,
  input: { customerId: string },
): Promise<CustomerCommunicationHistory> {
  requireCommunicationsCapability(access);

  const [customer, business] = await Promise.all([
    db.customer.findFirst({
      where: { id: input.customerId, businessId: access.businessId },
      select: { id: true, businessId: true },
    }),
    db.business.findFirst({
      where: { id: access.businessId },
      select: { timezone: true },
    }),
  ]);
  if (!customer) throw new ForbiddenError();

  const timeZone = resolveBusinessTimeZone(business);
  const [records, phoneLogs] = await Promise.all([
    db.customerCommunication.findMany({
      where: { businessId: access.businessId, customerId: customer.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: CUSTOMER_COMMUNICATION_TIMELINE_LIMIT,
      select: {
        id: true,
        direction: true,
        channel: true,
        purpose: true,
        subject: true,
        bodySnapshot: true,
        status: true,
        relatedType: true,
        relatedId: true,
        failureReason: true,
        consentContext: true,
        provider: true,
        createdAt: true,
        attemptedAt: true,
      },
    }),
    db.phoneInteraction.findMany({
      where: { businessId: access.businessId, customerId: customer.id },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: CUSTOMER_COMMUNICATION_TIMELINE_LIMIT,
      select: {
        id: true,
        communicationId: true,
        kind: true,
        status: true,
        direction: true,
        summary: true,
        callbackNeeded: true,
        occurredAt: true,
        requestId: true,
        jobId: true,
      },
    }),
  ]);

  const items: CommunicationTimelineItem[] = records.map(mapCommunicationRecord);
  const recordedIds = new Set(records.map((row) => row.id));
  for (const log of phoneLogs) {
    if (log.communicationId && recordedIds.has(log.communicationId)) continue;
    items.push(mapPhoneInteraction(log));
  }

  items.sort(compareCommunicationTimelineItems);
  const truncated =
    records.length === CUSTOMER_COMMUNICATION_TIMELINE_LIMIT ||
    phoneLogs.length === CUSTOMER_COMMUNICATION_TIMELINE_LIMIT ||
    items.length > CUSTOMER_COMMUNICATION_TIMELINE_LIMIT;
  const bounded = items.slice(0, CUSTOMER_COMMUNICATION_TIMELINE_LIMIT);
  const withLinks = await attachVerifiedContextLinks(db, {
    businessId: access.businessId,
    customerId: customer.id,
    items: bounded,
  });

  return {
    customerId: customer.id,
    businessId: access.businessId,
    timeZone,
    items: withLinks,
    summary: summarizeCustomerCommunicationTimeline(withLinks, truncated),
  };
}

export async function loadCustomerCommunicationTimeline(
  db: Db,
  access: CommunicationAccess,
  input: { customerId: string },
): Promise<CommunicationTimelineItem[]> {
  return (await loadCustomerCommunicationHistory(db, access, input)).items;
}

export async function listAssignedJobCommunications(
  db: Db,
  input: { businessId: string; membershipId: string; jobId: string },
) {
  const job = await db.job.findFirst({
    where: {
      id: input.jobId,
      businessId: input.businessId,
      assignedMembershipId: input.membershipId,
    },
    select: { id: true },
  });
  if (!job) return [];
  return db.customerCommunication.findMany({
    where: {
      businessId: input.businessId,
      relatedType: "JOB",
      relatedId: job.id,
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      purpose: true,
      channel: true,
      status: true,
      bodySnapshot: true,
      createdAt: true,
      failureReason: true,
    },
  });
}

export async function listBusinessCommunicationInbox(
  db: Db,
  access: CommunicationAccess,
  take = 40,
) {
  requireCommunicationsCapability(access);
  return db.customerCommunication.findMany({
    where: { businessId: access.businessId },
    orderBy: { createdAt: "desc" },
    take,
    include: {
      customer: { select: { id: true, name: true } },
    },
  });
}

export function emptyCustomerCommunicationHistory(
  businessId: string,
  customerId: string,
  timeZone: string,
): CustomerCommunicationHistory {
  return emptyHistory(businessId, customerId, timeZone);
}
