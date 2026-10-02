/**
 * Customer Project Portal conversation write + OWNER reply.
 *
 * Customer posts are authorized by the live project token only. They
 * record an inbound PORTAL CustomerCommunication on that one job.
 * OWNER replies call composeCustomerCommunication. Opening a page
 * never sends.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { isAiAttemptId } from "@/lib/ai/types";
import {
  composeCustomerCommunication,
  requireCommunicationsCapability,
  type CommunicationSendResult,
} from "@/lib/communications/engine";
import { getOrCreateCustomerThread, touchCommunicationThread } from "@/lib/communications/thread";
import { consentContextSnapshot } from "@/lib/communications/consent";
import { isAcceptedCustomerMessageStatus } from "@/lib/customer-messaging";
import { isUsableEmail } from "@/lib/mail";
import {
  MAX_PROJECT_CONVERSATION_MESSAGES,
  PROJECT_CONVERSATION_ACTIVE_JOB_MESSAGE,
  PROJECT_CONVERSATION_ATTEMPT_REQUIRED_MESSAGE,
  PROJECT_CONVERSATION_BODY_REQUIRED_MESSAGE,
  PROJECT_CONVERSATION_BOUND_MESSAGE,
  PROJECT_CONVERSATION_CHANNEL_REQUIRED_MESSAGE,
  PROJECT_CONVERSATION_CUSTOMER_CHANNEL,
  PROJECT_CONVERSATION_CUSTOMER_PROVIDER,
  PROJECT_CONVERSATION_CUSTOMER_REQUIRED_MESSAGE,
  PROJECT_CONVERSATION_JOB_REQUIRED_MESSAGE,
  PROJECT_CONVERSATION_JOB_TRADE_SELECT,
  PROJECT_CONVERSATION_PORTAL_UNAVAILABLE_MESSAGE,
  PROJECT_CONVERSATION_PURPOSE,
  PROJECT_CONVERSATION_RELATED_TYPE,
  PROJECT_CONVERSATION_SUBJECT,
  isProjectConversationOwnerChannel,
  parseProjectConversationBody,
  parseProjectConversationToken,
  portalProjectConversationIdempotencyKey,
  projectConversationHandymanEligible,
} from "@/lib/project-conversation";
import { countProjectConversationMessages } from "@/lib/project-conversation-data";
import {
  assertLiveLockedProjectToken,
  findLiveJobByProjectToken,
} from "@/lib/project-link-data";
import { lockTenantOwnedJob } from "@/lib/time-card-ops";

type Db = PrismaClient | Prisma.TransactionClient;

export type PortalProjectConversationSubmitInput = {
  token: string;
  body?: string | null;
  attemptId?: string | null;
};

export type PortalProjectConversationSubmitResult =
  | { ok: true; communicationId: string; jobId: string; reused: boolean }
  | { ok: false; error: string };

export type OwnerProjectConversationReplyInput = {
  jobId: string;
  channel: string;
  body?: string | null;
  subject?: string | null;
  idempotencyKey: string;
  browserBusinessId?: string | null;
};

/**
 * Test-only barrier. Production never sets this.
 * afterJobLock runs inside the write transaction after lockTenantOwnedJob
 * and before the post-lock live-token re-check.
 */
export const portalProjectConversationTestHooks: {
  afterJobLock?: (input: { jobId: string; token: string }) => Promise<void> | void;
} = {};

const PORTAL_JOB_SELECT = {
  id: true,
  businessId: true,
  customerId: true,
  status: true,
  ...PROJECT_CONVERSATION_JOB_TRADE_SELECT,
} as const;

async function findExistingConversationRow(
  db: Db,
  businessId: string,
  idempotencyKey: string,
) {
  return db.customerCommunication.findFirst({
    where: { businessId, idempotencyKey },
    select: { id: true, relatedId: true },
  });
}

export async function submitPortalProjectConversation(
  db: PrismaClient,
  input: PortalProjectConversationSubmitInput,
): Promise<PortalProjectConversationSubmitResult> {
  const token = parseProjectConversationToken(input.token);
  if (!token) {
    return { ok: false, error: PROJECT_CONVERSATION_PORTAL_UNAVAILABLE_MESSAGE };
  }
  const body = parseProjectConversationBody(input.body);
  if (!body) {
    return { ok: false, error: PROJECT_CONVERSATION_BODY_REQUIRED_MESSAGE };
  }
  const attemptId = (input.attemptId ?? "").trim();
  if (!isAiAttemptId(attemptId)) {
    return { ok: false, error: PROJECT_CONVERSATION_ATTEMPT_REQUIRED_MESSAGE };
  }

  try {
    return await db.$transaction(async (tx) => {
      const job = await findLiveJobByProjectToken(tx, token, PORTAL_JOB_SELECT);
      if (!job?.customerId) {
        return { ok: false, error: PROJECT_CONVERSATION_PORTAL_UNAVAILABLE_MESSAGE };
      }

      const locked = await lockTenantOwnedJob(tx, job.businessId, job.id);
      if (!locked || locked.businessId !== job.businessId) {
        return { ok: false, error: PROJECT_CONVERSATION_PORTAL_UNAVAILABLE_MESSAGE };
      }
      await portalProjectConversationTestHooks.afterJobLock?.({
        jobId: locked.id,
        token,
      });
      if (
        !(await assertLiveLockedProjectToken(tx, {
          jobId: locked.id,
          businessId: locked.businessId,
          token,
        }))
      ) {
        return { ok: false, error: PROJECT_CONVERSATION_PORTAL_UNAVAILABLE_MESSAGE };
      }

      const live = await tx.job.findFirst({
        where: { id: locked.id, businessId: locked.businessId },
        select: PORTAL_JOB_SELECT,
      });
      if (!live?.customerId || !projectConversationHandymanEligible(live)) {
        return { ok: false, error: PROJECT_CONVERSATION_ACTIVE_JOB_MESSAGE };
      }

      const idempotencyKey = portalProjectConversationIdempotencyKey(
        live.id,
        attemptId,
      );
      const existing = await findExistingConversationRow(
        tx,
        live.businessId,
        idempotencyKey,
      );
      if (existing) {
        return {
          ok: true,
          communicationId: existing.id,
          jobId: live.id,
          reused: true,
        };
      }

      const used = await countProjectConversationMessages(
        tx,
        live.businessId,
        live.id,
      );
      if (used >= MAX_PROJECT_CONVERSATION_MESSAGES) {
        return { ok: false, error: PROJECT_CONVERSATION_BOUND_MESSAGE };
      }

      const customer = await tx.customer.findFirst({
        where: { id: live.customerId, businessId: live.businessId },
        select: { id: true, name: true, email: true, smsConsentStatus: true },
      });
      if (!customer) {
        return { ok: false, error: PROJECT_CONVERSATION_PORTAL_UNAVAILABLE_MESSAGE };
      }

      const thread = await getOrCreateCustomerThread(tx, {
        businessId: live.businessId,
        customerId: customer.id,
        title: customer.name,
      });

      const created = await tx.customerCommunication.create({
        data: {
          businessId: live.businessId,
          customerId: customer.id,
          threadId: thread?.id ?? null,
          direction: "INBOUND",
          channel: PROJECT_CONVERSATION_CUSTOMER_CHANNEL,
          purpose: PROJECT_CONVERSATION_PURPOSE,
          subject: PROJECT_CONVERSATION_SUBJECT,
          relatedType: PROJECT_CONVERSATION_RELATED_TYPE,
          relatedId: live.id,
          idempotencyKey,
          bodySnapshot: body,
          status: "SENT",
          provider: PROJECT_CONVERSATION_CUSTOMER_PROVIDER,
          initiatedByMembershipId: null,
          attemptedAt: new Date(),
          consentContext: consentContextSnapshot({
            smsConsentStatus: customer.smsConsentStatus,
            emailAvailable: isUsableEmail(customer.email),
            channel: PROJECT_CONVERSATION_CUSTOMER_CHANNEL,
            extra: "portal_inbound",
          }),
        },
      });
      if (thread) {
        await touchCommunicationThread(tx, {
          businessId: live.businessId,
          threadId: thread.id,
        });
      }
      return {
        ok: true,
        communicationId: created.id,
        jobId: live.id,
        reused: false,
      };
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const job = await findLiveJobByProjectToken(db, token, {
        id: true,
        businessId: true,
      });
      if (!job) {
        return { ok: false, error: PROJECT_CONVERSATION_PORTAL_UNAVAILABLE_MESSAGE };
      }
      const raced = await findExistingConversationRow(
        db,
        job.businessId,
        portalProjectConversationIdempotencyKey(job.id, attemptId),
      );
      if (raced) {
        return {
          ok: true,
          communicationId: raced.id,
          jobId: job.id,
          reused: true,
        };
      }
    }
    throw error;
  }
}

export async function sendProjectConversationOwnerReply(
  db: PrismaClient,
  access: BusinessAccess,
  input: OwnerProjectConversationReplyInput,
): Promise<CommunicationSendResult | { ok: false; failureReason: string }> {
  requireCommunicationsCapability(access);

  const jobId = input.jobId.trim();
  if (!jobId) {
    return { ok: false, failureReason: PROJECT_CONVERSATION_JOB_REQUIRED_MESSAGE };
  }
  if (!isProjectConversationOwnerChannel(input.channel)) {
    return { ok: false, failureReason: PROJECT_CONVERSATION_CHANNEL_REQUIRED_MESSAGE };
  }
  const body = parseProjectConversationBody(input.body);
  if (!body) {
    return { ok: false, failureReason: PROJECT_CONVERSATION_BODY_REQUIRED_MESSAGE };
  }
  if (!input.idempotencyKey.trim()) {
    return { ok: false, failureReason: PROJECT_CONVERSATION_ATTEMPT_REQUIRED_MESSAGE };
  }

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
  if (!job) {
    return { ok: false, failureReason: PROJECT_CONVERSATION_JOB_REQUIRED_MESSAGE };
  }
  access.assertOwned(job);
  const customerId = job.customerId;
  if (!customerId) {
    return { ok: false, failureReason: PROJECT_CONVERSATION_CUSTOMER_REQUIRED_MESSAGE };
  }
  if (!projectConversationHandymanEligible(job)) {
    return { ok: false, failureReason: PROJECT_CONVERSATION_ACTIVE_JOB_MESSAGE };
  }
  if (input.browserBusinessId && input.browserBusinessId !== access.businessId) {
    return {
      ok: false,
      communicationId: null,
      threadId: null,
      status: "BLOCKED",
      channel: input.channel,
      provider: "none",
      reused: false,
      failureReason: "Browser businessId never authorizes a send.",
    };
  }

  const reserved = await reserveProjectConversationOwnerReply(db, {
    access,
    jobId: job.id,
    businessId: job.businessId,
    customerId,
    channel: input.channel,
    body,
    subject: input.subject?.trim() || PROJECT_CONVERSATION_SUBJECT,
    idempotencyKey: input.idempotencyKey,
  });
  if (!reserved.ok) {
    return { ok: false, failureReason: reserved.failureReason };
  }
  if (reserved.alreadySent) {
    return {
      ok: true,
      communicationId: reserved.communicationId,
      threadId: reserved.threadId,
      status: reserved.status,
      channel: input.channel,
      provider: reserved.provider,
      reused: true,
      failureReason: reserved.failureReason,
    };
  }

  const sent = await composeCustomerCommunication(db, access, {
    customerId,
    channel: input.channel,
    purpose: PROJECT_CONVERSATION_PURPOSE,
    subject: input.subject?.trim() || PROJECT_CONVERSATION_SUBJECT,
    body,
    relatedType: PROJECT_CONVERSATION_RELATED_TYPE,
    relatedId: job.id,
    idempotencyKey: input.idempotencyKey,
    browserBusinessId: input.browserBusinessId,
    resumeCommunicationId: reserved.resume ? reserved.communicationId : null,
  });
  if (reserved.resume && sent.communicationId === reserved.communicationId) {
    return { ...sent, reused: false };
  }
  return sent;
}

const OWNER_REPLY_CLAIM_STATUS = "READY" as const;

async function reserveProjectConversationOwnerReply(
  db: PrismaClient,
  input: {
    access: BusinessAccess;
    jobId: string;
    businessId: string;
    customerId: string;
    channel: string;
    body: string;
    subject: string;
    idempotencyKey: string;
  },
): Promise<
  | { ok: false; failureReason: string }
  | {
      ok: true;
      alreadySent: true;
      communicationId: string;
      threadId: string | null;
      status: CommunicationSendResult["status"];
      provider: string;
      failureReason: string | null;
    }
  | { ok: true; alreadySent: false; communicationId: string; resume: boolean }
> {
  return db.$transaction(async (tx) => {
    const locked = await lockTenantOwnedJob(tx, input.businessId, input.jobId);
    if (!locked || locked.businessId !== input.businessId) {
      return { ok: false, failureReason: PROJECT_CONVERSATION_JOB_REQUIRED_MESSAGE };
    }

    const existing = await tx.customerCommunication.findFirst({
      where: { businessId: input.businessId, idempotencyKey: input.idempotencyKey },
      select: {
        id: true,
        status: true,
        threadId: true,
        provider: true,
        failureReason: true,
      },
    });
    if (existing && isAcceptedCustomerMessageStatus(existing.status)) {
      return {
        ok: true,
        alreadySent: true,
        communicationId: existing.id,
        threadId: existing.threadId,
        status: existing.status as CommunicationSendResult["status"],
        provider: existing.provider,
        failureReason: existing.failureReason,
      };
    }

    const used = await countProjectConversationMessages(
      tx,
      locked.businessId,
      locked.id,
    );
    const existingOccupiesSlot = Boolean(
      existing &&
        existing.status !== "BLOCKED" &&
        existing.status !== "FAILED",
    );
    if (used >= MAX_PROJECT_CONVERSATION_MESSAGES && !existingOccupiesSlot) {
      return { ok: false, failureReason: PROJECT_CONVERSATION_BOUND_MESSAGE };
    }
    if (existing) {
      return {
        ok: true,
        alreadySent: false,
        communicationId: existing.id,
        resume: false,
      };
    }

    const customer = await tx.customer.findFirst({
      where: { id: input.customerId, businessId: input.businessId },
      select: { id: true, name: true },
    });
    if (!customer) {
      return { ok: false, failureReason: PROJECT_CONVERSATION_CUSTOMER_REQUIRED_MESSAGE };
    }
    const thread = await getOrCreateCustomerThread(tx, {
      businessId: input.businessId,
      customerId: customer.id,
      title: customer.name,
    });

    try {
      const created = await tx.customerCommunication.create({
        data: {
          businessId: input.businessId,
          customerId: customer.id,
          threadId: thread?.id ?? null,
          direction: "OUTBOUND",
          channel: input.channel,
          purpose: PROJECT_CONVERSATION_PURPOSE,
          subject: input.subject,
          relatedType: PROJECT_CONVERSATION_RELATED_TYPE,
          relatedId: input.jobId,
          idempotencyKey: input.idempotencyKey,
          bodySnapshot: input.body,
          status: OWNER_REPLY_CLAIM_STATUS,
          provider: "none",
          initiatedByMembershipId: input.access.workspace.membership?.id ?? null,
          attemptedAt: new Date(),
        },
        select: { id: true },
      });
      return {
        ok: true,
        alreadySent: false,
        communicationId: created.id,
        resume: true,
      };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const raced = await tx.customerCommunication.findFirst({
          where: {
            businessId: input.businessId,
            idempotencyKey: input.idempotencyKey,
          },
          select: {
            id: true,
            status: true,
            threadId: true,
            provider: true,
            failureReason: true,
          },
        });
        if (raced && isAcceptedCustomerMessageStatus(raced.status)) {
          return {
            ok: true,
            alreadySent: true,
            communicationId: raced.id,
            threadId: raced.threadId,
            status: raced.status as CommunicationSendResult["status"],
            provider: raced.provider,
            failureReason: raced.failureReason,
          };
        }
        if (raced) {
          return {
            ok: true,
            alreadySent: false,
            communicationId: raced.id,
            resume: false,
          };
        }
      }
      throw error;
    }
  });
}

export {
  countBusinessCommunications,
  countBusinessInvoices,
  countBusinessJobs,
  countBusinessPayments,
} from "@/lib/job-callback-ops";
