import { Prisma, type PrismaClient } from "@prisma/client";
import { ForbiddenError } from "@/lib/authorization";
import { destinationFingerprint, destinationLast4 } from "@/lib/customer-messaging/eligibility";
import { isUsableNormalizedPhone, normalizePhone } from "@/lib/customer-identity";
import { getOrCreateCustomerThread, touchCommunicationThread } from "@/lib/communications/thread";
import {
  requireCommunicationsCapability,
  type CommunicationAccess,
} from "@/lib/communications/engine";
import { consentContextSnapshot } from "@/lib/communications/consent";
import {
  PHONE_LOG_CUSTOMER_CONFLICT_REASON,
  RELATED_RECORD_NOT_OWNED_REASON,
  conflictingCustomerIds,
} from "@/lib/communications/related";

type Db = PrismaClient | Prisma.TransactionClient;

export type PhoneLogResult = {
  ok: boolean;
  phoneInteractionId: string | null;
  communicationId: string | null;
  actionItemId: string | null;
  reused: boolean;
  failureReason: string | null;
};

export type PhoneLogFailureStage = "claimed" | "action" | "communication";

export const PHONE_LOG_INJECTED_FAILURE_PREFIX = "Injected phone-log failure after ";

let failAfter: PhoneLogFailureStage | null = null;

export function setPhoneLogFailureAfter(stage: PhoneLogFailureStage | null) {
  failAfter = stage;
}

function maybeFail(stage: PhoneLogFailureStage) {
  if (failAfter === stage) {
    failAfter = null;
    throw new Error(`${PHONE_LOG_INJECTED_FAILURE_PREFIX}${stage}`);
  }
}

function failed(failureReason: string): PhoneLogResult {
  return {
    ok: false,
    phoneInteractionId: null,
    communicationId: null,
    actionItemId: null,
    reused: false,
    failureReason,
  };
}

function callbackRecommendationKey(idempotencyKey: string) {
  return `phone-callback:${idempotencyKey}`;
}

function communicationIdempotencyKey(kind: string, idempotencyKey: string) {
  return `phone:${kind}:${idempotencyKey}`;
}

async function resolvePhoneLogCustomer(
  db: Db,
  access: CommunicationAccess,
  input: {
    customerId?: string | null;
    callerPhone?: string | null;
    requestId?: string | null;
    jobId?: string | null;
  },
): Promise<{ ok: true; customerId: string | null } | { ok: false; reason: string }> {
  let explicitId: string | null = null;
  if (input.customerId) {
    const customer = await db.customer.findFirst({
      where: { id: input.customerId, businessId: access.businessId },
      select: { id: true },
    });
    if (!customer) throw new ForbiddenError();
    explicitId = customer.id;
  }

  let requestCustomerId: string | null = null;
  if (input.requestId) {
    const request = await db.serviceRequest.findFirst({
      where: { id: input.requestId, businessId: access.businessId },
      select: { id: true, customerId: true },
    });
    if (!request) return { ok: false, reason: RELATED_RECORD_NOT_OWNED_REASON };
    requestCustomerId = request.customerId;
  }

  let jobCustomerId: string | null = null;
  if (input.jobId) {
    const job = await db.job.findFirst({
      where: { id: input.jobId, businessId: access.businessId },
      select: { id: true, customerId: true },
    });
    if (!job) return { ok: false, reason: RELATED_RECORD_NOT_OWNED_REASON };
    jobCustomerId = job.customerId;
  }

  if (conflictingCustomerIds([explicitId, requestCustomerId, jobCustomerId])) {
    return { ok: false, reason: PHONE_LOG_CUSTOMER_CONFLICT_REASON };
  }

  const linked = explicitId ?? requestCustomerId ?? jobCustomerId;
  if (linked) return { ok: true, customerId: linked };

  if (input.callerPhone) {
    const digits = normalizePhone(input.callerPhone);
    if (isUsableNormalizedPhone(digits)) {
      const matched = await db.customer.findFirst({
        where: { businessId: access.businessId, phone: digits },
        select: { id: true },
      });
      return { ok: true, customerId: matched?.id ?? null };
    }
  }

  return { ok: true, customerId: null };
}

async function ensureCallbackAction(
  db: Db,
  access: CommunicationAccess,
  input: {
    idempotencyKey: string;
    summary: string;
    customerName: string | null;
  },
) {
  const recommendationKey = callbackRecommendationKey(input.idempotencyKey);
  const existingAction = await db.businessActionItem.findFirst({
    where: { businessId: access.businessId, recommendationKey },
  });
  if (existingAction) return existingAction.id;
  try {
    const action = await db.businessActionItem.create({
      data: {
        businessId: access.businessId,
        recommendationKey,
        title: input.customerName ? `Call back ${input.customerName}` : "Call back a missed caller",
        notes: input.summary,
        createdByMembershipId: access.workspace.membership?.id ?? null,
      },
    });
    return action.id;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const racedAction = await db.businessActionItem.findFirst({
        where: { businessId: access.businessId, recommendationKey },
      });
      return racedAction?.id ?? null;
    }
    throw error;
  }
}

async function ensurePhoneCommunication(
  db: Db,
  access: CommunicationAccess,
  input: {
    claimedId: string;
    kind: string;
    idempotencyKey: string;
    summary: string;
    callbackNeeded: boolean;
    customer: { id: string; smsConsentStatus: string | null; email: string | null };
    threadId: string | null;
    last4: string | null;
    fingerprint: string | null;
  },
) {
  const communicationKey = communicationIdempotencyKey(input.kind, input.idempotencyKey);
  const existingCommunication = await db.customerCommunication.findFirst({
    where: { businessId: access.businessId, idempotencyKey: communicationKey },
  });
  if (existingCommunication) return existingCommunication.id;
  try {
    const communication = await db.customerCommunication.create({
      data: {
        businessId: access.businessId,
        customerId: input.customer.id,
        threadId: input.threadId,
        direction: "INBOUND",
        channel: "PHONE",
        purpose: input.kind,
        subject: input.callbackNeeded ? "Callback needed" : "Phone log",
        relatedType: "PHONE_INTERACTION",
        relatedId: input.claimedId,
        idempotencyKey: communicationKey,
        destinationLast4: input.last4,
        destinationFingerprint: input.fingerprint,
        consentContext: consentContextSnapshot({
          smsConsentStatus: input.customer.smsConsentStatus,
          emailAvailable: Boolean(input.customer.email),
          channel: "PHONE",
        }),
        bodySnapshot: input.summary,
        status: "SENT",
        provider: "manual",
        initiatedByMembershipId: access.workspace.membership?.id ?? null,
        attemptedAt: new Date(),
      },
    });
    return communication.id;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const racedCommunication = await db.customerCommunication.findFirst({
        where: { businessId: access.businessId, idempotencyKey: communicationKey },
      });
      return racedCommunication?.id ?? null;
    }
    throw error;
  }
}

async function completePhoneLog(
  db: Db,
  access: CommunicationAccess,
  input: {
    kind: "MISSED_CALL" | "MANUAL_PHONE";
    callerPhone?: string | null;
    summary: string;
    callbackNeeded?: boolean;
    requestId?: string | null;
    jobId?: string | null;
    idempotencyKey: string;
  },
  claimed: {
    id: string;
    customerId: string | null;
    threadId: string | null;
    communicationId: string | null;
    followUpActionItemId: string | null;
    kind: string;
    callbackNeeded: boolean;
    summary: string;
  },
  customer: { id: string; name: string; smsConsentStatus: string | null; email: string | null } | null,
  reused: boolean,
): Promise<PhoneLogResult> {
  maybeFail("claimed");

  const digits = normalizePhone(input.callerPhone);
  const usable = isUsableNormalizedPhone(digits);
  const summary = claimed.summary || input.summary.trim();
  const callbackNeeded = claimed.callbackNeeded || Boolean(input.callbackNeeded);
  const kind = (claimed.kind as "MISSED_CALL" | "MANUAL_PHONE") || input.kind;

  const thread = customer
    ? await getOrCreateCustomerThread(db, {
        businessId: access.businessId,
        customerId: customer.id,
        title: customer.name,
      })
    : null;

  let actionItemId = claimed.followUpActionItemId;
  if (callbackNeeded) {
    actionItemId = await ensureCallbackAction(db, access, {
      idempotencyKey: input.idempotencyKey,
      summary,
      customerName: customer?.name ?? null,
    });
    maybeFail("action");
  }

  let communicationId = claimed.communicationId;
  if (customer) {
    communicationId = await ensurePhoneCommunication(db, access, {
      claimedId: claimed.id,
      kind,
      idempotencyKey: input.idempotencyKey,
      summary,
      callbackNeeded,
      customer,
      threadId: thread?.id ?? claimed.threadId,
      last4: usable ? destinationLast4(digits) : null,
      fingerprint: usable ? destinationFingerprint(access.businessId, digits) : null,
    });
    maybeFail("communication");
  }

  await db.phoneInteraction.updateMany({
    where: { id: claimed.id, businessId: access.businessId },
    data: {
      customerId: customer?.id ?? claimed.customerId,
      threadId: thread?.id ?? claimed.threadId,
      communicationId,
      followUpActionItemId: actionItemId,
      requestId: input.requestId || null,
      jobId: input.jobId || null,
      callbackNeeded,
      status: callbackNeeded ? "CALLBACK_NEEDED" : "LOGGED",
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
    phoneInteractionId: claimed.id,
    communicationId,
    actionItemId,
    reused,
    failureReason: null,
  };
}

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
  requireCommunicationsCapability(access);
  if (input.browserBusinessId && input.browserBusinessId !== access.businessId) {
    return failed("Browser businessId never authorizes a phone log.");
  }
  if (!input.idempotencyKey.trim() || !input.summary.trim()) {
    return failed("Summary and idempotency key are required.");
  }

  const resolved = await resolvePhoneLogCustomer(db, access, input);
  if (!resolved.ok) return failed(resolved.reason);

  const customer = resolved.customerId
    ? await db.customer.findFirst({
        where: { id: resolved.customerId, businessId: access.businessId },
        select: { id: true, name: true, smsConsentStatus: true, email: true },
      })
    : null;
  if (resolved.customerId && !customer) throw new ForbiddenError();

  const digits = normalizePhone(input.callerPhone);
  const usable = isUsableNormalizedPhone(digits);
  const thread = customer
    ? await getOrCreateCustomerThread(db, {
        businessId: access.businessId,
        customerId: customer.id,
        title: customer.name,
      })
    : null;

  const existing = await db.phoneInteraction.findFirst({
    where: {
      businessId: access.businessId,
      idempotencyKey: input.idempotencyKey,
    },
  });
  if (existing) {
    return completePhoneLog(db, access, input, existing, customer, true);
  }

  let claimed;
  try {
    claimed = await db.phoneInteraction.create({
      data: {
        businessId: access.businessId,
        customerId: customer?.id ?? null,
        threadId: thread?.id ?? null,
        kind: input.kind,
        status: input.callbackNeeded ? "CALLBACK_NEEDED" : "LOGGED",
        direction: "INBOUND",
        callerLast4: usable ? destinationLast4(digits) : null,
        callerFingerprint: usable ? destinationFingerprint(access.businessId, digits) : null,
        summary: input.summary.trim(),
        callbackNeeded: Boolean(input.callbackNeeded),
        idempotencyKey: input.idempotencyKey,
        initiatedByMembershipId: access.workspace.membership?.id ?? null,
        requestId: input.requestId || null,
        jobId: input.jobId || null,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await db.phoneInteraction.findFirst({
        where: {
          businessId: access.businessId,
          idempotencyKey: input.idempotencyKey,
        },
      });
      if (raced) return completePhoneLog(db, access, input, raced, customer, true);
    }
    return failed("The phone log could not be saved.");
  }

  return completePhoneLog(db, access, input, claimed, customer, false);
}
