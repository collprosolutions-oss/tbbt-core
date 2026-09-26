/**
 * Owner/office recovery workspace over recorded phone and receptionist
 * facts. Read-only. Does not provision numbers, place calls, send SMS or
 * email, create leads, or invent resolved state.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import {
  requireCommunicationsCapability,
  type CommunicationAccess,
} from "@/lib/communications/engine";
import { getReceptionistReadiness } from "@/lib/communications/receptionist";

type Db = PrismaClient | Prisma.TransactionClient;

export const RECEPTIONIST_RECOVERY_QUEUE_LIMIT = 40;
export const RECEPTIONIST_RECOVERY_SCAN_LIMIT = 80;
export const OWNER_LOG_LEAD_HREF = "/requests/log-lead";

export const RECEPTIONIST_RECOVERY_FACT_KEYS = {
  missedCallCount: "communications-missed-call-count",
  callerWithoutLaterCommunicationCount:
    "communications-recorded-caller-without-later-communication-count",
} as const;

const PHONE_ATTENTION_KINDS = new Set(["MISSED_CALL"]);
const PHONE_ATTENTION_STATUSES = new Set(["CALLBACK_NEEDED", "ESCALATED"]);
const RECEPTIONIST_ATTENTION_KINDS = new Set(["INBOUND_CALL", "ESCALATION"]);
const RECEPTIONIST_ATTENTION_STATUSES = new Set(["ESCALATED"]);

export type ReceptionistRecoveryCustomer = {
  id: string;
  name: string;
  href: string;
};

export type ReceptionistRecoveryRelated = {
  id: string;
  label: string;
  href: string;
};

export type ReceptionistRecoveryLastCommunication = {
  occurredAt: string;
  channel: string;
  direction: string;
  status: string;
  purpose: string;
  isThisCallRecord: boolean;
};

export type ReceptionistRecoveryQueueItem = {
  id: string;
  source: "PHONE_INTERACTION" | "RECEPTIONIST_EVENT";
  occurredAt: string;
  direction: string;
  kind: string;
  status: string;
  callbackNeeded: boolean;
  callerLast4: string | null;
  summary: string | null;
  attentionReasons: string[];
  customer: ReceptionistRecoveryCustomer | null;
  customerKnown: boolean;
  request: ReceptionistRecoveryRelated | null;
  job: ReceptionistRecoveryRelated | null;
  receptionistKind: string | null;
  receptionistStatus: string | null;
  lastCustomerCommunication: ReceptionistRecoveryLastCommunication | null;
  laterCommunicationRecorded: boolean | null;
  logLeadHref: string | null;
};

export type ReceptionistRecoveryCenter = {
  queue: ReceptionistRecoveryQueueItem[];
  queueLimit: number;
  recordedMissedCallCount: number;
  recordedCallbackNeededCount: number;
  recordedInboundEventCount: number;
  unknownCallerCount: number;
  knownCustomerCount: number;
  timeZone: string;
  voiceConnected: false;
  voiceReason: string;
  logLeadHref: string;
  logLeadPrefillSupported: false;
};

type PhoneRow = {
  id: string;
  kind: string;
  status: string;
  direction: string;
  callerLast4: string | null;
  callbackNeeded: boolean;
  summary: string;
  occurredAt: Date;
  customerId: string | null;
  requestId: string | null;
  jobId: string | null;
  communicationId: string | null;
};

type EventRow = {
  id: string;
  kind: string;
  status: string;
  customerId: string | null;
  phoneInteractionId: string | null;
  payload: Prisma.JsonValue | null;
  createdAt: Date;
};

function phoneNeedsAttention(row: Pick<PhoneRow, "kind" | "status" | "callbackNeeded">) {
  return (
    PHONE_ATTENTION_KINDS.has(row.kind) ||
    PHONE_ATTENTION_STATUSES.has(row.status) ||
    row.callbackNeeded
  );
}

function receptionistNeedsAttention(row: Pick<EventRow, "kind" | "status">) {
  return RECEPTIONIST_ATTENTION_KINDS.has(row.kind) || RECEPTIONIST_ATTENTION_STATUSES.has(row.status);
}

function phoneAttentionReasons(row: Pick<PhoneRow, "kind" | "status" | "callbackNeeded">) {
  const reasons: string[] = [];
  if (row.kind === "MISSED_CALL") reasons.push("Recorded as a missed call.");
  if (row.status === "CALLBACK_NEEDED" || row.callbackNeeded) {
    reasons.push("Callback needed is recorded.");
  }
  if (row.status === "ESCALATED") reasons.push("Phone interaction is recorded as escalated.");
  return reasons;
}

function receptionistAttentionReasons(row: Pick<EventRow, "kind" | "status">) {
  const reasons: string[] = [];
  if (row.kind === "INBOUND_CALL") {
    reasons.push("Inbound call was recorded while voice was not connected.");
  }
  if (row.kind === "ESCALATION" || row.status === "ESCALATED") {
    reasons.push("Receptionist event is recorded as escalated.");
  }
  return reasons;
}

function receptionistSummary(payload: Prisma.JsonValue | null) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const summary = "summary" in payload ? payload.summary : null;
  return typeof summary === "string" && summary.trim() ? summary.trim() : null;
}

function communicationOccurredAt(row: { attemptedAt: Date | null; createdAt: Date }) {
  return row.attemptedAt ?? row.createdAt;
}

export function appendReceptionistRecoveryFacts(
  facts: Record<string, string>,
  factKeys: string[],
  input: {
    phoneInteractions: Array<{
      kind: string;
      customerId: string | null;
      occurredAt: string;
    }>;
    messages: Array<{
      customerId: string;
      occurredAt: string;
    }>;
    factsCap: number;
  },
) {
  const add = (key: string, value: string) => {
    if (factKeys.includes(key) || factKeys.length >= input.factsCap) return;
    facts[key] = value;
    factKeys.push(key);
  };

  const missedCallCount = input.phoneInteractions.filter((row) => row.kind === "MISSED_CALL").length;
  add(RECEPTIONIST_RECOVERY_FACT_KEYS.missedCallCount, String(missedCallCount));

  const withoutLater = input.phoneInteractions.filter((row) => {
    if (!row.customerId) return false;
    return !input.messages.some(
      (message) => message.customerId === row.customerId && message.occurredAt > row.occurredAt,
    );
  }).length;
  add(
    RECEPTIONIST_RECOVERY_FACT_KEYS.callerWithoutLaterCommunicationCount,
    String(withoutLater),
  );
}

export async function loadReceptionistRecoveryCenter(
  db: Db,
  access: CommunicationAccess,
): Promise<ReceptionistRecoveryCenter> {
  requireCommunicationsCapability(access);
  const businessId = access.businessId;
  const readiness = getReceptionistReadiness();

  const [phoneRows, eventRows, recordedMissedCallCount, recordedCallbackNeededCount, business] =
    await Promise.all([
      db.phoneInteraction.findMany({
        where: { businessId },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: RECEPTIONIST_RECOVERY_SCAN_LIMIT,
        select: {
          id: true,
          kind: true,
          status: true,
          direction: true,
          callerLast4: true,
          callbackNeeded: true,
          summary: true,
          occurredAt: true,
          customerId: true,
          requestId: true,
          jobId: true,
          communicationId: true,
        },
      }),
      db.receptionistEvent.findMany({
        where: { businessId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: RECEPTIONIST_RECOVERY_SCAN_LIMIT,
        select: {
          id: true,
          kind: true,
          status: true,
          customerId: true,
          phoneInteractionId: true,
          payload: true,
          createdAt: true,
        },
      }),
      db.phoneInteraction.count({
        where: { businessId, kind: "MISSED_CALL" },
      }),
      db.phoneInteraction.count({
        where: {
          businessId,
          OR: [{ callbackNeeded: true }, { status: "CALLBACK_NEEDED" }],
        },
      }),
      db.business.findFirst({
        where: { id: businessId },
        select: { timezone: true },
      }),
    ]);

  const attentionPhones = phoneRows.filter(phoneNeedsAttention);
  const eventsByPhoneId = new Map<string, EventRow[]>();
  const standaloneEvents: EventRow[] = [];
  for (const event of eventRows) {
    if (!receptionistNeedsAttention(event)) continue;
    if (event.phoneInteractionId) {
      const list = eventsByPhoneId.get(event.phoneInteractionId) ?? [];
      list.push(event);
      eventsByPhoneId.set(event.phoneInteractionId, list);
      continue;
    }
    standaloneEvents.push(event);
  }

  const customerIds = new Set<string>();
  const requestIds = new Set<string>();
  const jobIds = new Set<string>();
  for (const row of attentionPhones) {
    if (row.customerId) customerIds.add(row.customerId);
    if (row.requestId) requestIds.add(row.requestId);
    if (row.jobId) jobIds.add(row.jobId);
  }
  for (const event of standaloneEvents) {
    if (event.customerId) customerIds.add(event.customerId);
  }

  const [customers, requests, jobs, communications] = await Promise.all([
    customerIds.size
      ? db.customer.findMany({
          where: { businessId, id: { in: [...customerIds] } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
    requestIds.size
      ? db.serviceRequest.findMany({
          where: { businessId, id: { in: [...requestIds] } },
          select: { id: true, summary: true, customerId: true },
        })
      : Promise.resolve([]),
    jobIds.size
      ? db.job.findMany({
          where: { businessId, id: { in: [...jobIds] } },
          select: { id: true, status: true, customerId: true },
        })
      : Promise.resolve([]),
    customerIds.size
      ? db.customerCommunication.findMany({
          where: { businessId, customerId: { in: [...customerIds] } },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: {
            id: true,
            customerId: true,
            createdAt: true,
            attemptedAt: true,
            channel: true,
            direction: true,
            status: true,
            purpose: true,
            relatedType: true,
            relatedId: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const customerById = new Map(customers.map((row) => [row.id, row]));
  const requestById = new Map(requests.map((row) => [row.id, row]));
  const jobById = new Map(jobs.map((row) => [row.id, row]));
  const lastCommunicationByCustomer = new Map<string, (typeof communications)[number]>();
  for (const row of communications) {
    if (!lastCommunicationByCustomer.has(row.customerId)) {
      lastCommunicationByCustomer.set(row.customerId, row);
    }
  }

  function resolveCustomer(customerId: string | null): ReceptionistRecoveryCustomer | null {
    if (!customerId) return null;
    const owned = customerById.get(customerId);
    if (!owned) return null;
    return { id: owned.id, name: owned.name, href: `/customers/${owned.id}` };
  }

  function resolveRequest(
    requestId: string | null,
    customerId: string | null,
  ): ReceptionistRecoveryRelated | null {
    if (!requestId) return null;
    const owned = requestById.get(requestId);
    if (!owned) return null;
    if (customerId && owned.customerId !== customerId) return null;
    return {
      id: owned.id,
      label: owned.summary ?? "Recorded request",
      href: `/requests/${owned.id}`,
    };
  }

  function resolveJob(
    jobId: string | null,
    customerId: string | null,
  ): ReceptionistRecoveryRelated | null {
    if (!jobId) return null;
    const owned = jobById.get(jobId);
    if (!owned) return null;
    if (customerId && owned.customerId !== customerId) return null;
    return {
      id: owned.id,
      label: owned.status,
      href: `/jobs/${owned.id}`,
    };
  }

  function lastCommunicationFor(
    customerId: string | null,
    phoneId: string | null,
    occurredAt: Date,
  ): {
    lastCustomerCommunication: ReceptionistRecoveryLastCommunication | null;
    laterCommunicationRecorded: boolean | null;
  } {
    if (!customerId || !customerById.has(customerId)) {
      return { lastCustomerCommunication: null, laterCommunicationRecorded: null };
    }
    const last = lastCommunicationByCustomer.get(customerId);
    if (!last) {
      return { lastCustomerCommunication: null, laterCommunicationRecorded: false };
    }
    const lastAt = communicationOccurredAt(last);
    const isThisCallRecord =
      last.relatedType === "PHONE_INTERACTION" && Boolean(phoneId) && last.relatedId === phoneId;
    return {
      lastCustomerCommunication: {
        occurredAt: lastAt.toISOString(),
        channel: last.channel,
        direction: last.direction,
        status: last.status,
        purpose: last.purpose,
        isThisCallRecord,
      },
      laterCommunicationRecorded: !isThisCallRecord && lastAt > occurredAt,
    };
  }

  const merged: Array<{
    occurredAt: Date;
    id: string;
    item: ReceptionistRecoveryQueueItem;
  }> = [];

  for (const row of attentionPhones) {
    const customer = resolveCustomer(row.customerId);
    const linkedEvents = eventsByPhoneId.get(row.id) ?? [];
    const receptionist = linkedEvents[0] ?? null;
    const { lastCustomerCommunication, laterCommunicationRecorded } = lastCommunicationFor(
      customer?.id ?? null,
      row.id,
      row.occurredAt,
    );
    const attentionReasons = [
      ...phoneAttentionReasons(row),
      ...linkedEvents.flatMap(receptionistAttentionReasons),
    ];
    merged.push({
      occurredAt: row.occurredAt,
      id: `phone:${row.id}`,
      item: {
        id: row.id,
        source: "PHONE_INTERACTION",
        occurredAt: row.occurredAt.toISOString(),
        direction: row.direction,
        kind: row.kind,
        status: row.status,
        callbackNeeded: row.callbackNeeded,
        callerLast4: row.callerLast4,
        summary: row.summary.trim() || null,
        attentionReasons,
        customer,
        customerKnown: Boolean(customer),
        request: resolveRequest(row.requestId, customer?.id ?? null),
        job: resolveJob(row.jobId, customer?.id ?? null),
        receptionistKind: receptionist?.kind ?? null,
        receptionistStatus: receptionist?.status ?? null,
        lastCustomerCommunication,
        laterCommunicationRecorded,
        logLeadHref: customer ? null : OWNER_LOG_LEAD_HREF,
      },
    });
  }

  for (const event of standaloneEvents) {
    const customer = resolveCustomer(event.customerId);
    const { lastCustomerCommunication, laterCommunicationRecorded } = lastCommunicationFor(
      customer?.id ?? null,
      null,
      event.createdAt,
    );
    merged.push({
      occurredAt: event.createdAt,
      id: `event:${event.id}`,
      item: {
        id: event.id,
        source: "RECEPTIONIST_EVENT",
        occurredAt: event.createdAt.toISOString(),
        direction: "INBOUND",
        kind: event.kind,
        status: event.status,
        callbackNeeded: false,
        callerLast4: null,
        summary: receptionistSummary(event.payload),
        attentionReasons: receptionistAttentionReasons(event),
        customer,
        customerKnown: Boolean(customer),
        request: null,
        job: null,
        receptionistKind: event.kind,
        receptionistStatus: event.status,
        lastCustomerCommunication,
        laterCommunicationRecorded,
        logLeadHref: customer ? null : OWNER_LOG_LEAD_HREF,
      },
    });
  }

  merged.sort((left, right) => {
    const delta = right.occurredAt.getTime() - left.occurredAt.getTime();
    if (delta !== 0) return delta;
    return right.id.localeCompare(left.id);
  });

  const queue = merged.slice(0, RECEPTIONIST_RECOVERY_QUEUE_LIMIT).map((row) => row.item);
  const inboundEventCount = eventRows.filter((row) => row.kind === "INBOUND_CALL").length;

  return {
    queue,
    queueLimit: RECEPTIONIST_RECOVERY_QUEUE_LIMIT,
    recordedMissedCallCount,
    recordedCallbackNeededCount,
    recordedInboundEventCount: inboundEventCount,
    unknownCallerCount: queue.filter((row) => !row.customerKnown).length,
    knownCustomerCount: queue.filter((row) => row.customerKnown).length,
    timeZone: resolveBusinessTimeZone(business),
    voiceConnected: false,
    voiceReason: readiness.voice.reason,
    logLeadHref: OWNER_LOG_LEAD_HREF,
    logLeadPrefillSupported: false,
  };
}
