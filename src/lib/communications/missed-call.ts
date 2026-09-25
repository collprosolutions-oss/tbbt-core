import { Prisma, type PrismaClient } from "@prisma/client";
import { ForbiddenError } from "@/lib/authorization";
import { destinationFingerprint, destinationLast4 } from "@/lib/customer-messaging/eligibility";
import { isUsableNormalizedPhone, normalizePhone } from "@/lib/customer-identity";
import { ensureCommunicationsSchema } from "@/lib/communications/schema";
import { getOrCreateCustomerThread, touchCommunicationThread } from "@/lib/communications/thread";
import {
  requireCommunicationsCapability,
  type CommunicationAccess,
} from "@/lib/communications/engine";
import { consentContextSnapshot } from "@/lib/communications/consent";

type Db = PrismaClient | Prisma.TransactionClient;

export type PhoneLogResult = {
  ok: boolean;
  phoneInteractionId: string | null;
  communicationId: string | null;
  actionItemId: string | null;
  reused: boolean;
  failureReason: string | null;
};

export async function recordMissedOrManualCall(
  db: Db,
  access: CommunicationAccess,
  input: {
    kind: "MISSED_CALL" | "MANUAL_PHONE";
    customerId?: string | null;
    callerPhone?: string | null;
    summary: string;
    callbackNeeded?: boolean;
    requestId?: string | null;
    jobId?: string | null;
    idempotencyKey: string;
    browserBusinessId?: string | null;
  },
): Promise<PhoneLogResult> {
  await ensureCommunicationsSchema(db);
  requireCommunicationsCapability(access);
  if (input.browserBusinessId && input.browserBusinessId !== access.businessId) {
    return {
      ok: false,
      phoneInteractionId: null,
      communicationId: null,
      actionItemId: null,
      reused: false,
      failureReason: "Browser businessId never authorizes a phone log.",
    };
  }
  if (!input.idempotencyKey.trim() || !input.summary.trim()) {
    return {
      ok: false,
      phoneInteractionId: null,
      communicationId: null,
      actionItemId: null,
      reused: false,
      failureReason: "Summary and idempotency key are required.",
    };
  }

  const existing = await db.phoneInteraction.findFirst({
    where: {
      businessId: access.businessId,
      idempotencyKey: input.idempotencyKey,
    },
  });
  if (existing) {
    return {
      ok: true,
      phoneInteractionId: existing.id,
      communicationId: existing.communicationId,
      actionItemId: existing.followUpActionItemId,
      reused: true,
      failureReason: null,
    };
  }

  let customerId = input.customerId ?? null;
  if (customerId) {
    const customer = await db.customer.findFirst({
      where: { id: customerId, businessId: access.businessId },
      select: { id: true, name: true, smsConsentStatus: true, email: true },
    });
    if (!customer) throw new ForbiddenError();
    customerId = customer.id;
  } else if (input.callerPhone) {
    const digits = normalizePhone(input.callerPhone);
    if (isUsableNormalizedPhone(digits)) {
      const matched = await db.customer.findFirst({
        where: { businessId: access.businessId, phone: digits },
        select: { id: true },
      });
      customerId = matched?.id ?? null;
    }
  }

  if (input.requestId) {
    const request = await db.serviceRequest.findFirst({
      where: { id: input.requestId, businessId: access.businessId },
      select: { id: true, customerId: true },
    });
    if (!request) throw new ForbiddenError();
    customerId = customerId ?? request.customerId;
  }
  if (input.jobId) {
    const job = await db.job.findFirst({
      where: { id: input.jobId, businessId: access.businessId },
      select: { id: true, customerId: true },
    });
    if (!job) throw new ForbiddenError();
    customerId = customerId ?? job.customerId;
  }

  const customer = customerId
    ? await db.customer.findFirst({
        where: { id: customerId, businessId: access.businessId },
        select: { id: true, name: true, smsConsentStatus: true, email: true },
      })
    : null;

  const digits = normalizePhone(input.callerPhone);
  const usable = isUsableNormalizedPhone(digits);
  const thread = customer
    ? await getOrCreateCustomerThread(db, {
        businessId: access.businessId,
        customerId: customer.id,
        title: customer.name,
      })
    : null;

  let actionItemId: string | null = null;
  if (input.callbackNeeded) {
    const action = await db.businessActionItem.create({
      data: {
        businessId: access.businessId,
        recommendationKey: `phone-callback:${input.idempotencyKey}`,
        title: customer
          ? `Call back ${customer.name}`
          : "Call back a missed caller",
        notes: input.summary.trim(),
        createdByMembershipId: access.workspace.membership?.id ?? null,
      },
    });
    actionItemId = action.id;
  }

  const communication = customer
    ? await db.customerCommunication.create({
        data: {
          businessId: access.businessId,
          customerId: customer.id,
          threadId: thread?.id ?? null,
          direction: "INBOUND",
          channel: "PHONE",
          purpose: input.kind,
          subject: input.callbackNeeded ? "Callback needed" : "Phone log",
          relatedType: input.requestId ? "SERVICE_REQUEST" : input.jobId ? "JOB" : null,
          relatedId: input.requestId ?? input.jobId ?? null,
          idempotencyKey: `phone:${input.kind}:${input.idempotencyKey}`,
          destinationLast4: usable ? destinationLast4(digits) : null,
          destinationFingerprint: usable
            ? destinationFingerprint(access.businessId, digits)
            : null,
          consentContext: consentContextSnapshot({
            smsConsentStatus: customer.smsConsentStatus,
            emailAvailable: Boolean(customer.email),
            channel: "PHONE",
          }),
          bodySnapshot: input.summary.trim(),
          status: "SENT",
          provider: "manual",
          initiatedByMembershipId: access.workspace.membership?.id ?? null,
          attemptedAt: new Date(),
        },
      })
    : null;

  try {
    const created = await db.phoneInteraction.create({
      data: {
        businessId: access.businessId,
        customerId: customer?.id ?? null,
        threadId: thread?.id ?? null,
        communicationId: communication?.id ?? null,
        requestId: input.requestId ?? null,
        jobId: input.jobId ?? null,
        followUpActionItemId: actionItemId,
        kind: input.kind,
        status: input.callbackNeeded ? "CALLBACK_NEEDED" : "LOGGED",
        direction: "INBOUND",
        callerLast4: usable ? destinationLast4(digits) : null,
        callerFingerprint: usable ? destinationFingerprint(access.businessId, digits) : null,
        summary: input.summary.trim(),
        callbackNeeded: Boolean(input.callbackNeeded),
        idempotencyKey: input.idempotencyKey,
        initiatedByMembershipId: access.workspace.membership?.id ?? null,
      },
    });
    if (thread) {
      await touchCommunicationThread(db, {
        businessId: access.businessId,
        threadId: thread.id,
      });
    }
    return {
      ok: true,
      phoneInteractionId: created.id,
      communicationId: communication?.id ?? null,
      actionItemId,
      reused: false,
      failureReason: null,
    };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await db.phoneInteraction.findFirst({
        where: {
          businessId: access.businessId,
          idempotencyKey: input.idempotencyKey,
        },
      });
      if (raced) {
        return {
          ok: true,
          phoneInteractionId: raced.id,
          communicationId: raced.communicationId,
          actionItemId: raced.followUpActionItemId,
          reused: true,
          failureReason: null,
        };
      }
    }
    return {
      ok: false,
      phoneInteractionId: null,
      communicationId: communication?.id ?? null,
      actionItemId,
      reused: false,
      failureReason: "The phone log could not be saved.",
    };
  }
}
