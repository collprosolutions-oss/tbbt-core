/**
 * Project-conversation reads. Token lookup for the customer path.
 * OWNER review is scoped by BusinessAccess. Mutation-free. Opening a
 * page never sends.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { roleHasCapability, CAPABILITIES } from "@/lib/authorization";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import {
  MAX_PROJECT_CONVERSATION_MESSAGES,
  PROJECT_CONVERSATION_CUSTOMER_CHANNEL,
  PROJECT_CONVERSATION_JOB_TRADE_SELECT,
  PROJECT_CONVERSATION_OWNER_WORKFLOW_MESSAGE,
  PROJECT_CONVERSATION_PORTAL_WORKFLOW_MESSAGE,
  PROJECT_CONVERSATION_PURPOSE,
  PROJECT_CONVERSATION_RELATED_TYPE,
  compareProjectConversationMessages,
  parseProjectConversationToken,
  projectConversationHandymanEligible,
} from "@/lib/project-conversation";
import { findLiveJobByProjectToken } from "@/lib/project-link-data";

type Db = PrismaClient | Prisma.TransactionClient;

const CONVERSATION_MESSAGE_SELECT = {
  id: true,
  direction: true,
  channel: true,
  purpose: true,
  subject: true,
  bodySnapshot: true,
  status: true,
  relatedType: true,
  relatedId: true,
  createdAt: true,
  attemptedAt: true,
} as const;

export type ProjectConversationMessage = {
  id: string;
  occurredAt: Date;
  direction: "INBOUND" | "OUTBOUND";
  channel: string;
  purpose: string;
  subject: string | null;
  body: string;
  status: string;
};

export type PortalProjectConversationView =
  | { status: "hidden" }
  | {
      status: "ready" | "full" | "closed";
      jobId: string;
      canWrite: boolean;
      workflowMessage: string;
      remaining: number;
      messages: ProjectConversationMessage[];
    };

export type OwnerProjectConversationReview = {
  jobId: string;
  customerId: string;
  eligible: boolean;
  canWrite: boolean;
  canReply: boolean;
  workflowMessage: string;
  remaining: number;
  timeZone: string;
  messages: ProjectConversationMessage[];
};

function conversationWhere(businessId: string, jobId: string) {
  return {
    businessId,
    relatedType: PROJECT_CONVERSATION_RELATED_TYPE,
    relatedId: jobId,
    OR: [
      {
        direction: "INBOUND",
        channel: PROJECT_CONVERSATION_CUSTOMER_CHANNEL,
        purpose: PROJECT_CONVERSATION_PURPOSE,
      },
      {
        direction: "OUTBOUND",
        purpose: PROJECT_CONVERSATION_PURPOSE,
      },
    ],
  } satisfies Prisma.CustomerCommunicationWhereInput;
}

function mapConversationMessage(row: {
  id: string;
  direction: string;
  channel: string;
  purpose: string;
  subject: string | null;
  bodySnapshot: string;
  status: string;
  createdAt: Date;
  attemptedAt: Date | null;
}): ProjectConversationMessage | null {
  if (row.direction !== "INBOUND" && row.direction !== "OUTBOUND") return null;
  return {
    id: row.id,
    occurredAt: row.attemptedAt ?? row.createdAt,
    direction: row.direction,
    channel: row.channel,
    purpose: row.purpose,
    subject: row.subject,
    body: row.bodySnapshot,
    status: row.status,
  };
}

function portalVisibleMessage(
  message: ProjectConversationMessage,
): boolean {
  if (message.direction === "INBOUND") return true;
  return message.status === "SENT" || message.status === "DELIVERED";
}

export async function countProjectConversationMessages(
  db: Db,
  businessId: string,
  jobId: string,
) {
  return db.customerCommunication.count({
    where: conversationWhere(businessId, jobId),
  });
}

export async function listProjectConversationMessages(
  db: Db,
  businessId: string,
  jobId: string,
): Promise<ProjectConversationMessage[]> {
  const rows = await db.customerCommunication.findMany({
    where: conversationWhere(businessId, jobId),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: MAX_PROJECT_CONVERSATION_MESSAGES,
    select: CONVERSATION_MESSAGE_SELECT,
  });
  return rows
    .flatMap((row) => {
      const mapped = mapConversationMessage(row);
      return mapped ? [mapped] : [];
    })
    .sort(compareProjectConversationMessages);
}

export async function loadPortalProjectConversationView(
  db: Db,
  token: string,
): Promise<PortalProjectConversationView> {
  const projectToken = parseProjectConversationToken(token);
  if (!projectToken) return { status: "hidden" };

  const job = await findLiveJobByProjectToken(db, projectToken, {
    id: true,
    businessId: true,
    status: true,
    ...PROJECT_CONVERSATION_JOB_TRADE_SELECT,
  });
  if (!job) return { status: "hidden" };

  const messages = (await listProjectConversationMessages(
    db,
    job.businessId,
    job.id,
  )).filter(portalVisibleMessage);
  const eligible = projectConversationHandymanEligible(job);
  if (!eligible && messages.length === 0) return { status: "hidden" };

  const remaining = Math.max(0, MAX_PROJECT_CONVERSATION_MESSAGES - messages.length);
  const canWrite = eligible && remaining > 0;
  return {
    status: eligible ? (canWrite ? "ready" : "full") : "closed",
    jobId: job.id,
    canWrite,
    workflowMessage: PROJECT_CONVERSATION_PORTAL_WORKFLOW_MESSAGE,
    remaining,
    messages,
  };
}

export async function loadOwnerProjectConversationReview(
  db: Db,
  access: BusinessAccess,
  jobId: string,
): Promise<OwnerProjectConversationReview | null> {
  const job = await db.job.findFirst({
    where: { id: jobId, ...access.scope },
    select: {
      id: true,
      businessId: true,
      customerId: true,
      status: true,
      ...PROJECT_CONVERSATION_JOB_TRADE_SELECT,
    },
  });
  if (!job) return null;
  access.assertOwned(job);
  if (!job.customerId) return null;

  const [messages, business] = await Promise.all([
    listProjectConversationMessages(db, job.businessId, job.id),
    db.business.findFirst({
      where: { id: access.businessId },
      select: { timezone: true },
    }),
  ]);
  const eligible = projectConversationHandymanEligible(job);
  if (!eligible && messages.length === 0) return null;

  const remaining = Math.max(0, MAX_PROJECT_CONVERSATION_MESSAGES - messages.length);
  const canReply =
    eligible &&
    remaining > 0 &&
    roleHasCapability(access.workspace.role, CAPABILITIES.MANAGE_COMMUNICATIONS);

  return {
    jobId: job.id,
    customerId: job.customerId,
    eligible,
    canWrite: canReply,
    canReply,
    workflowMessage: PROJECT_CONVERSATION_OWNER_WORKFLOW_MESSAGE,
    remaining,
    timeZone: resolveBusinessTimeZone(business),
    messages,
  };
}
