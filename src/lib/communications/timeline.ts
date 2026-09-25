import type { PrismaClient } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { ForbiddenError } from "@/lib/authorization";
import { ensureCommunicationsSchema } from "@/lib/communications/schema";
import {
  requireCommunicationsCapability,
  type CommunicationAccess,
} from "@/lib/communications/engine";
import type { CommunicationChannel } from "@/lib/communications/types";

type Db = PrismaClient | Prisma.TransactionClient;

export type CommunicationTimelineItem = {
  id: string;
  source: "record" | "projected";
  occurredAt: string;
  direction: "INBOUND" | "OUTBOUND";
  channel: CommunicationChannel | "PROJECTED";
  purpose: string;
  subject: string | null;
  body: string;
  status: string;
  relatedType: string | null;
  relatedId: string | null;
  failureReason: string | null;
  consentContext: string | null;
  provider: string | null;
  reusedSafe: boolean;
};

function dedupeKey(item: {
  purpose: string;
  relatedType: string | null;
  relatedId: string | null;
}) {
  if (item.relatedType && item.relatedId) {
    return `${item.purpose}:${item.relatedType}:${item.relatedId}`;
  }
  return null;
}

export async function loadCustomerCommunicationTimeline(
  db: Db,
  access: CommunicationAccess,
  input: { customerId: string },
): Promise<CommunicationTimelineItem[]> {
  await ensureCommunicationsSchema(db);
  requireCommunicationsCapability(access);

  const customer = await db.customer.findFirst({
    where: { id: input.customerId, businessId: access.businessId },
    select: { id: true },
  });
  if (!customer) throw new ForbiddenError();

  const [records, estimates, invoices, jobs, reviewRequests, phoneLogs] = await Promise.all([
    db.customerCommunication.findMany({
      where: { businessId: access.businessId, customerId: customer.id },
      orderBy: { createdAt: "asc" },
    }),
    db.estimate.findMany({
      where: { businessId: access.businessId, customerId: customer.id, status: "SENT" },
      select: { id: true, updatedAt: true, createdAt: true },
    }),
    db.invoice.findMany({
      where: { businessId: access.businessId, customerId: customer.id, status: "SENT" },
      select: { id: true, updatedAt: true, createdAt: true },
    }),
    db.job.findMany({
      where: {
        businessId: access.businessId,
        customerId: customer.id,
        scheduledAt: { not: null },
      },
      select: {
        id: true,
        scheduledAt: true,
        appointmentNotificationStatus: true,
      },
    }),
    db.reviewRequest.findMany({
      where: {
        businessId: access.businessId,
        customerId: customer.id,
        status: { in: ["SENT", "COMPLETED"] },
      },
      select: { id: true, updatedAt: true, requestText: true },
    }),
    db.phoneInteraction.findMany({
      where: { businessId: access.businessId, customerId: customer.id },
      orderBy: { occurredAt: "asc" },
    }),
  ]);

  const items: CommunicationTimelineItem[] = records.map((row) => ({
    id: row.id,
    source: "record",
    occurredAt: (row.attemptedAt ?? row.createdAt).toISOString(),
    direction: row.direction === "INBOUND" ? "INBOUND" : "OUTBOUND",
    channel: row.channel as CommunicationChannel,
    purpose: row.purpose,
    subject: row.subject,
    body: row.bodySnapshot,
    status: row.status,
    relatedType: row.relatedType,
    relatedId: row.relatedId,
    failureReason: row.failureReason,
    consentContext: row.consentContext,
    provider: row.provider,
    reusedSafe: true,
  }));

  const seen = new Set(
    items
      .map((item) => dedupeKey(item))
      .filter((key): key is string => Boolean(key)),
  );

  function addProjected(item: CommunicationTimelineItem) {
    const key = dedupeKey(item);
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    items.push(item);
  }

  for (const estimate of estimates) {
    addProjected({
      id: `projected:estimate:${estimate.id}`,
      source: "projected",
      occurredAt: estimate.updatedAt.toISOString(),
      direction: "OUTBOUND",
      channel: "PROJECTED",
      purpose: "ESTIMATE_READY",
      subject: "Estimate sent",
      body: "Estimate was marked sent. No duplicate send was created for the timeline.",
      status: "PROJECTED",
      relatedType: "ESTIMATE",
      relatedId: estimate.id,
      failureReason: null,
      consentContext: null,
      provider: null,
      reusedSafe: true,
    });
  }
  for (const invoice of invoices) {
    addProjected({
      id: `projected:invoice:${invoice.id}`,
      source: "projected",
      occurredAt: invoice.updatedAt.toISOString(),
      direction: "OUTBOUND",
      channel: "PROJECTED",
      purpose: "INVOICE_READY",
      subject: "Invoice sent",
      body: "Invoice was marked sent. No duplicate send was created for the timeline.",
      status: "PROJECTED",
      relatedType: "INVOICE",
      relatedId: invoice.id,
      failureReason: null,
      consentContext: null,
      provider: null,
      reusedSafe: true,
    });
  }
  for (const job of jobs) {
    if (!job.scheduledAt) continue;
    addProjected({
      id: `projected:job:${job.id}`,
      source: "projected",
      occurredAt: job.scheduledAt.toISOString(),
      direction: "OUTBOUND",
      channel: "PROJECTED",
      purpose: "APPOINTMENT_CONFIRMATION",
      subject: "Appointment scheduled",
      body:
        job.appointmentNotificationStatus === "SENT"
          ? "Appointment was scheduled and a notification was recorded."
          : "Appointment was scheduled. Timeline projection does not send another message.",
      status: job.appointmentNotificationStatus ?? "PROJECTED",
      relatedType: "JOB",
      relatedId: job.id,
      failureReason: null,
      consentContext: null,
      provider: null,
      reusedSafe: true,
    });
  }
  for (const request of reviewRequests) {
    addProjected({
      id: `projected:review:${request.id}`,
      source: "projected",
      occurredAt: request.updatedAt.toISOString(),
      direction: "OUTBOUND",
      channel: "PROJECTED",
      purpose: "REVIEW_REQUEST",
      subject: "Review request",
      body: request.requestText || "Review request recorded.",
      status: "PROJECTED",
      relatedType: "REVIEW_REQUEST",
      relatedId: request.id,
      failureReason: null,
      consentContext: null,
      provider: null,
      reusedSafe: true,
    });
  }
  for (const log of phoneLogs) {
    addProjected({
      id: log.communicationId ?? `phone:${log.id}`,
      source: log.communicationId ? "record" : "projected",
      occurredAt: log.occurredAt.toISOString(),
      direction: log.direction === "OUTBOUND" ? "OUTBOUND" : "INBOUND",
      channel: "PHONE",
      purpose: log.kind,
      subject: log.callbackNeeded ? "Callback needed" : "Phone log",
      body: log.summary,
      status: log.status,
      relatedType: "PHONE_INTERACTION",
      relatedId: log.id,
      failureReason: null,
      consentContext: null,
      provider: "manual",
      reusedSafe: true,
    });
  }

  items.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  return items;
}

export async function listAssignedJobCommunications(
  db: Db,
  input: { businessId: string; membershipId: string; jobId: string },
) {
  await ensureCommunicationsSchema(db);
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
  await ensureCommunicationsSchema(db);
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
