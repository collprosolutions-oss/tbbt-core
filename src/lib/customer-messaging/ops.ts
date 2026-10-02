import { Prisma, type PrismaClient } from "@prisma/client";
import {
  DISCONNECTED_CUSTOMER_MESSAGING_PROVIDER,
  TWILIO_CUSTOMER_MESSAGING_PROVIDER,
} from "@/lib/customer-messaging/config";
import { isUsableNormalizedPhone, normalizePhone } from "@/lib/customer-identity";
import {
  evaluateSmsEligibility,
  smsBlockFailureReason,
} from "@/lib/customer-messaging/eligibility";
import {
  claimCustomerMessagingWebhookEvent,
  completeCustomerMessagingWebhookEvent,
} from "@/lib/customer-messaging/inbound";
import { getCustomerMessagingProvider } from "@/lib/customer-messaging/provider";
import { ensureCustomerMessagingSchema } from "@/lib/customer-messaging/schema";
import {
  isAcceptedCustomerMessageStatus,
  isCustomerMessagePurpose,
  type AttemptCustomerSmsInput,
  type CustomerCommunicationAttemptResult,
  type CustomerMessageDeliveryUpdate,
  type CustomerMessageRelatedType,
  type CustomerMessageStatus,
} from "@/lib/customer-messaging/types";
import { DEFAULT_SETTINGS_PREFERENCES } from "@/lib/settings";
import { getOrCreateCustomerThread } from "@/lib/communications/thread";
import { consentContextSnapshot } from "@/lib/communications/consent";
import { isUsableEmail } from "@/lib/mail";
import { recordOwnerStudioReminderDeliveryBlock } from "@/lib/marketing-studio-reminder";

type Db = PrismaClient | Prisma.TransactionClient;

const RELATED_CUSTOMER_SELECT = { id: true, businessId: true, customerId: true } as const;

async function loadRelatedRecord(
  db: Db,
  input: {
    businessId: string;
    relatedType: CustomerMessageRelatedType;
    relatedId: string;
  },
) {
  if (input.relatedType === "ESTIMATE") {
    return db.estimate.findFirst({
      where: { id: input.relatedId, businessId: input.businessId },
      select: RELATED_CUSTOMER_SELECT,
    });
  }
  if (input.relatedType === "JOB") {
    return db.job.findFirst({
      where: { id: input.relatedId, businessId: input.businessId },
      select: RELATED_CUSTOMER_SELECT,
    });
  }
  if (input.relatedType === "INVOICE") {
    return db.invoice.findFirst({
      where: { id: input.relatedId, businessId: input.businessId },
      select: RELATED_CUSTOMER_SELECT,
    });
  }
  if (input.relatedType === "REVIEW_REQUEST") {
    return db.reviewRequest.findFirst({
      where: { id: input.relatedId, businessId: input.businessId },
      select: RELATED_CUSTOMER_SELECT,
    });
  }
  if (input.relatedType === "CUSTOMER_FOLLOW_UP") {
    return db.customerFollowUp.findFirst({
      where: { id: input.relatedId, businessId: input.businessId },
      select: RELATED_CUSTOMER_SELECT,
    });
  }
  if (input.relatedType === "SERVICE_REQUEST") {
    return db.serviceRequest.findFirst({
      where: { id: input.relatedId, businessId: input.businessId },
      select: RELATED_CUSTOMER_SELECT,
    });
  }
  if (input.relatedType === "PHONE_INTERACTION") {
    return db.phoneInteraction.findFirst({
      where: { id: input.relatedId, businessId: input.businessId },
      select: RELATED_CUSTOMER_SELECT,
    });
  }
  if (input.relatedType === "PROPERTY") {
    return db.property.findFirst({
      where: { id: input.relatedId, businessId: input.businessId },
      select: RELATED_CUSTOMER_SELECT,
    });
  }
  return db.referralRequest.findFirst({
    where: { id: input.relatedId, businessId: input.businessId },
    select: RELATED_CUSTOMER_SELECT,
  });
}

function toAttemptResult(
  row: {
    id: string;
    status: string;
    provider: string;
    providerMessageId: string | null;
    failureReason: string | null;
  },
  reused: boolean,
): CustomerCommunicationAttemptResult {
  return {
    ok: isAcceptedCustomerMessageStatus(row.status),
    communicationId: row.id,
    status: row.status as CustomerMessageStatus,
    provider: row.provider,
    providerMessageId: row.providerMessageId,
    failureReason: row.failureReason,
    reused,
  };
}

function nextDeliveryStatus(
  current: string,
  incoming: CustomerMessageDeliveryUpdate["status"],
): string {
  if (current === "DELIVERED") return "DELIVERED";
  if (current === "FAILED") return "FAILED";
  if (current === "BLOCKED" || current === "NOT_SENT" || current === "DRAFT") {
    return current;
  }
  if (incoming === "FAILED") return "FAILED";
  const rank: Record<string, number> = {
    QUEUED: 1,
    ACCEPTED: 1,
    SENT: 2,
    DELIVERED: 3,
  };
  const currentRank = rank[current] ?? 0;
  const incomingRank = rank[incoming] ?? 0;
  if (incomingRank < currentRank) return current;
  return incoming;
}

export const SMS_DISPATCH_CLAIM_LEASE_MS = 2 * 60 * 1000;
export const SMS_DISPATCH_CLAIM_STATUS = "READY";
export const STALE_RECIPIENT_FAILURE =
  "The customer destination changed after this send was claimed.";

/**
 * Test-only pause/fault points. Production never assigns these.
 * Used to prove claim-before-send and send-time consent/recipient checks.
 */
export const customerSmsDispatchTestHooks: {
  afterClaim?: () => Promise<void> | void;
  beforeProviderSend?: (ctx?: { db: Db }) => Promise<void> | void;
} = {};

/**
 * Test-only pause/fault points. Production never assigns these.
 * Used to prove leftover delivery webhook claims stay retryable.
 */
export const customerMessageDeliveryTestHooks: {
  afterClaim?: () => Promise<void> | void;
  beforeStatusWrite?: () => Promise<void> | void;
} = {};

function smsDispatchLockKey(businessId: string, idempotencyKey: string) {
  return `tbbt-sms:${businessId}:${idempotencyKey}`;
}

function smsDispatchClaimInProgress(
  row: { status: string; attemptedAt: Date | null } | null | undefined,
  now = new Date(),
) {
  if (!row || row.status !== SMS_DISPATCH_CLAIM_STATUS || !row.attemptedAt) return false;
  return now.getTime() - row.attemptedAt.getTime() < SMS_DISPATCH_CLAIM_LEASE_MS;
}

async function withSmsDispatchLock<T>(
  db: Db,
  businessId: string,
  idempotencyKey: string,
  work: (tx: Db) => Promise<T>,
): Promise<T> {
  const lockKey = smsDispatchLockKey(businessId, idempotencyKey);
  const run = async (tx: Db) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
    return work(tx);
  };
  const client = db as PrismaClient;
  if (typeof client.$transaction === "function") {
    return client.$transaction((tx) => run(tx), {
      timeout: 20_000,
      maxWait: 20_000,
    });
  }
  return run(db);
}

export async function getCustomerCommunication(
  db: Db,
  input: { businessId: string; communicationId: string },
) {
  await ensureCustomerMessagingSchema(db);
  return db.customerCommunication.findFirst({
    where: { id: input.communicationId, businessId: input.businessId },
  });
}

export async function listCustomerCommunications(
  db: Db,
  input: { businessId: string; customerId?: string },
) {
  await ensureCustomerMessagingSchema(db);
  return db.customerCommunication.findMany({
    where: {
      businessId: input.businessId,
      ...(input.customerId ? { customerId: input.customerId } : {}),
    },
    orderBy: { createdAt: "asc" },
  });
}

export async function attemptCustomerSms(
  db: Db,
  input: AttemptCustomerSmsInput,
): Promise<CustomerCommunicationAttemptResult> {
  await ensureCustomerMessagingSchema(db);

  if (!input.businessId || !input.customerId || !input.idempotencyKey.trim()) {
    return {
      ok: false,
      communicationId: null,
      status: "BLOCKED",
      provider: DISCONNECTED_CUSTOMER_MESSAGING_PROVIDER,
      providerMessageId: null,
      failureReason: "Customer message is missing required tenant scope.",
      reused: false,
    };
  }
  if (!isCustomerMessagePurpose(input.purpose)) {
    return {
      ok: false,
      communicationId: null,
      status: "BLOCKED",
      provider: DISCONNECTED_CUSTOMER_MESSAGING_PROVIDER,
      providerMessageId: null,
      failureReason: "Unsupported customer message purpose.",
      reused: false,
    };
  }

  const customer = await db.customer.findFirst({
    where: { id: input.customerId, businessId: input.businessId },
    select: {
      id: true,
      businessId: true,
      name: true,
      email: true,
      phone: true,
      smsConsentStatus: true,
    },
  });
  if (!customer) {
    return {
      ok: false,
      communicationId: null,
      status: "BLOCKED",
      provider: DISCONNECTED_CUSTOMER_MESSAGING_PROVIDER,
      providerMessageId: null,
      failureReason: "Customer is not in the authorized business.",
      reused: false,
    };
  }

  if (input.relatedType && input.relatedId) {
    const related = await loadRelatedRecord(db, {
      businessId: input.businessId,
      relatedType: input.relatedType,
      relatedId: input.relatedId,
    });
    if (!related) {
      return {
        ok: false,
        communicationId: null,
        status: "BLOCKED",
        provider: DISCONNECTED_CUSTOMER_MESSAGING_PROVIDER,
        providerMessageId: null,
        failureReason: "Related record is not in the authorized business.",
        reused: false,
      };
    }
    if (related.customerId && related.customerId !== customer.id) {
      return {
        ok: false,
        communicationId: null,
        status: "BLOCKED",
        provider: DISCONNECTED_CUSTOMER_MESSAGING_PROVIDER,
        providerMessageId: null,
        failureReason: "Related record does not belong to this customer.",
        reused: false,
      };
    }
  }

  const thread = await getOrCreateCustomerThread(db, {
    businessId: input.businessId,
    customerId: customer.id,
    title: customer.name,
  });

  const decision = await withSmsDispatchLock(
    db,
    input.businessId,
    input.idempotencyKey,
    async (tx) => decideSmsDispatch(tx, input, { threadId: thread?.id ?? null }),
  );
  if (decision.kind !== "send") {
    return decision.result;
  }

  if (customerSmsDispatchTestHooks.afterClaim) {
    await customerSmsDispatchTestHooks.afterClaim();
  }
  if (customerSmsDispatchTestHooks.beforeProviderSend) {
    await customerSmsDispatchTestHooks.beforeProviderSend({ db });
  }

  const liveCustomer = await db.customer.findFirst({
    where: { id: input.customerId, businessId: input.businessId },
    select: {
      id: true,
      email: true,
      phone: true,
      smsConsentStatus: true,
    },
  });
  const liveSettings = await db.businessSettings.findFirst({
    where: { businessId: input.businessId },
    select: {
      estimateCommunicationEnabled: true,
      scheduleNotificationEnabled: true,
      invoiceCommunicationEnabled: true,
      reviewRequestPreferenceEnabled: true,
      marketingCommunicationEnabled: true,
    },
  });
  const liveEligibility = evaluateSmsEligibility({
    businessId: input.businessId,
    phone: liveCustomer?.phone,
    smsConsentStatus: liveCustomer?.smsConsentStatus,
    purpose: input.purpose,
    preferences: liveSettings ?? DEFAULT_SETTINGS_PREFERENCES,
  });

  let status: CustomerMessageStatus = "READY";
  let failureReason: string | null = null;
  let providerMessageId: string | null = null;
  let providerMetadata: Prisma.InputJsonValue | typeof Prisma.JsonNull = Prisma.JsonNull;
  const provider = decision.provider;

  if (!liveCustomer) {
    status = "BLOCKED";
    failureReason = "Customer is not in the authorized business.";
  } else if (!liveEligibility.ok) {
    status = "BLOCKED";
    failureReason = smsBlockFailureReason(liveEligibility.reason);
  } else if (
    decision.claimedFingerprint &&
    liveEligibility.fingerprint !== decision.claimedFingerprint
  ) {
    status = "BLOCKED";
    failureReason = STALE_RECIPIENT_FAILURE;
  } else {
    try {
      const sent = await provider.send({
        businessId: input.businessId,
        communicationId: decision.communicationId,
        channel: "SMS",
        to: liveEligibility.normalizedPhone,
        from: decision.fromDigits || null,
        body: input.body,
        purpose: input.purpose,
      });
      if (sent.ok) {
        status = sent.status;
        providerMessageId = sent.providerMessageId;
        if (sent.providerMetadata) {
          providerMetadata = sent.providerMetadata as Prisma.InputJsonValue;
        }
      } else {
        status = sent.status;
        failureReason = sent.error;
      }
    } catch {
      status = "FAILED";
      failureReason = "The messaging provider failed.";
    }
  }

  const sendConsent = liveCustomer?.smsConsentStatus ?? decision.consentStatus;
  const sendLast4 = liveEligibility.last4 ?? decision.last4;
  const sendFingerprint = liveEligibility.fingerprint ?? decision.claimedFingerprint;
  const updated = await db.customerCommunication.update({
    where: { id: decision.communicationId },
    data: {
      status,
      failureReason,
      providerMessageId,
      providerMetadata,
      destinationLast4: sendLast4,
      destinationFingerprint: sendFingerprint,
      consentContext: consentContextSnapshot({
        smsConsentStatus: sendConsent,
        emailAvailable: isUsableEmail(liveCustomer?.email ?? decision.email),
        channel: "SMS",
        extra: liveEligibility.ok ? null : liveEligibility.reason,
      }),
      attemptedAt: new Date(),
    },
  });
  return toAttemptResult(updated, decision.reused);
}

type SmsDispatchDecision =
  | { kind: "done"; result: CustomerCommunicationAttemptResult }
  | {
      kind: "send";
      communicationId: string;
      reused: boolean;
      provider: ReturnType<typeof getCustomerMessagingProvider>;
      fromDigits: string;
      claimedFingerprint: string | null;
      last4: string | null;
      consentStatus: string | null;
      email: string | null;
    };

async function decideSmsDispatch(
  tx: Db,
  input: AttemptCustomerSmsInput,
  extras: { threadId: string | null },
): Promise<SmsDispatchDecision> {
  const existing = await tx.customerCommunication.findFirst({
    where: {
      businessId: input.businessId,
      idempotencyKey: input.idempotencyKey,
    },
  });
  if (existing && isAcceptedCustomerMessageStatus(existing.status)) {
    return { kind: "done", result: toAttemptResult(existing, true) };
  }

  const resume =
    Boolean(input.resumeCommunicationId) &&
    Boolean(existing) &&
    existing!.id === input.resumeCommunicationId;
  if (existing && !resume && smsDispatchClaimInProgress(existing)) {
    return { kind: "done", result: toAttemptResult(existing, true) };
  }

  const customer = await tx.customer.findFirst({
    where: { id: input.customerId, businessId: input.businessId },
    select: {
      id: true,
      email: true,
      phone: true,
      smsConsentStatus: true,
    },
  });
  if (!customer) {
    return {
      kind: "done",
      result: {
        ok: false,
        communicationId: existing?.id ?? null,
        status: "BLOCKED",
        provider: DISCONNECTED_CUSTOMER_MESSAGING_PROVIDER,
        providerMessageId: null,
        failureReason: "Customer is not in the authorized business.",
        reused: Boolean(existing),
      },
    };
  }

  const settings = await tx.businessSettings.findFirst({
    where: { businessId: input.businessId },
    select: {
      estimateCommunicationEnabled: true,
      scheduleNotificationEnabled: true,
      invoiceCommunicationEnabled: true,
      reviewRequestPreferenceEnabled: true,
      marketingCommunicationEnabled: true,
    },
  });
  const eligibility = evaluateSmsEligibility({
    businessId: input.businessId,
    phone: customer.phone,
    smsConsentStatus: customer.smsConsentStatus,
    purpose: input.purpose,
    preferences: settings ?? DEFAULT_SETTINGS_PREFERENCES,
  });

  if (
    resume &&
    existing?.destinationFingerprint &&
    eligibility.fingerprint &&
    existing.destinationFingerprint !== eligibility.fingerprint
  ) {
    const blocked = await upsertCustomerCommunication(tx, existing, {
      businessId: input.businessId,
      customerId: customer.id,
      threadId: extras.threadId,
      purpose: input.purpose,
      relatedType: input.relatedType ?? null,
      relatedId: input.relatedId ?? null,
      idempotencyKey: input.idempotencyKey,
      destinationLast4: existing.destinationLast4,
      destinationFingerprint: existing.destinationFingerprint,
      consentContext: consentContextSnapshot({
        smsConsentStatus: customer.smsConsentStatus,
        emailAvailable: isUsableEmail(customer.email),
        channel: "SMS",
        extra: "stale_recipient",
      }),
      bodySnapshot: input.body,
      provider: getCustomerMessagingProvider().id,
      initiatedByMembershipId: input.initiatedByMembershipId ?? null,
      status: "BLOCKED",
      failureReason: STALE_RECIPIENT_FAILURE,
    });
    return { kind: "done", result: toAttemptResult(blocked, true) };
  }

  const sendingIdentity = await tx.business.findFirst({
    where: { id: input.businessId },
    select: { operationalSmsNumber: true },
  });
  const fromDigits = normalizePhone(sendingIdentity?.operationalSmsNumber);
  const provider = getCustomerMessagingProvider();

  const baseData = {
    businessId: input.businessId,
    customerId: customer.id,
    threadId: extras.threadId,
    purpose: input.purpose,
    relatedType: input.relatedType ?? null,
    relatedId: input.relatedId ?? null,
    idempotencyKey: input.idempotencyKey,
    destinationLast4: eligibility.last4,
    destinationFingerprint: eligibility.fingerprint,
    consentContext: consentContextSnapshot({
      smsConsentStatus: customer.smsConsentStatus,
      emailAvailable: isUsableEmail(customer.email),
      channel: "SMS",
      extra: eligibility.ok ? null : eligibility.reason,
    }),
    bodySnapshot: input.body,
    provider: provider.id,
    initiatedByMembershipId: input.initiatedByMembershipId ?? null,
  };

  if (!eligibility.ok) {
    const row = await upsertCustomerCommunication(tx, existing, {
      ...baseData,
      status: "BLOCKED",
      failureReason: smsBlockFailureReason(eligibility.reason),
    });
    return { kind: "done", result: toAttemptResult(row, Boolean(existing)) };
  }
  if (!provider.connected) {
    const row = await upsertCustomerCommunication(tx, existing, {
      ...baseData,
      status: "NOT_SENT",
      failureReason: "SMS delivery is not connected.",
    });
    return { kind: "done", result: toAttemptResult(row, Boolean(existing)) };
  }
  if (provider.id === TWILIO_CUSTOMER_MESSAGING_PROVIDER && !isUsableNormalizedPhone(fromDigits)) {
    const row = await upsertCustomerCommunication(tx, existing, {
      ...baseData,
      status: "NOT_SENT",
      failureReason: "This business has no assigned SMS number.",
    });
    return { kind: "done", result: toAttemptResult(row, Boolean(existing)) };
  }

  const claimed = await upsertCustomerCommunication(tx, existing, {
    ...baseData,
    status: SMS_DISPATCH_CLAIM_STATUS,
    failureReason: null,
  });
  return {
    kind: "send",
    communicationId: claimed.id,
    reused: Boolean(existing),
    provider,
    fromDigits,
    claimedFingerprint: eligibility.fingerprint,
    last4: eligibility.last4,
    consentStatus: customer.smsConsentStatus,
    email: customer.email,
  };
}

async function upsertCustomerCommunication(
  db: Db,
  existing: { id: string } | null,
  data: {
    businessId: string;
    customerId: string;
    threadId: string | null;
    purpose: string;
    relatedType: string | null;
    relatedId: string | null;
    idempotencyKey: string;
    destinationLast4: string | null;
    destinationFingerprint: string | null;
    consentContext: string;
    bodySnapshot: string;
    provider: string;
    initiatedByMembershipId: string | null;
    status: CustomerMessageStatus;
    failureReason: string | null;
  },
) {
  const now = new Date();
  const rowData = {
    businessId: data.businessId,
    customerId: data.customerId,
    threadId: data.threadId,
    direction: "OUTBOUND",
    channel: "SMS",
    purpose: data.purpose,
    relatedType: data.relatedType,
    relatedId: data.relatedId,
    idempotencyKey: data.idempotencyKey,
    destinationLast4: data.destinationLast4,
    destinationFingerprint: data.destinationFingerprint,
    consentContext: data.consentContext,
    bodySnapshot: data.bodySnapshot,
    provider: data.provider,
    initiatedByMembershipId: data.initiatedByMembershipId,
    attemptedAt: now,
    status: data.status,
    failureReason: data.failureReason,
  };
  if (existing) {
    return db.customerCommunication.update({
      where: { id: existing.id },
      data: rowData,
    });
  }
  try {
    return await db.customerCommunication.create({ data: rowData });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await db.customerCommunication.findFirst({
        where: {
          businessId: data.businessId,
          idempotencyKey: data.idempotencyKey,
        },
      });
      if (raced) return raced;
    }
    throw error;
  }
}

export async function safeAttemptCustomerSms(
  db: Db,
  input: AttemptCustomerSmsInput,
): Promise<CustomerCommunicationAttemptResult | null> {
  try {
    return await attemptCustomerSms(db, input);
  } catch {
    return null;
  }
}

export async function applyCustomerMessageDeliveryUpdate(
  db: Db,
  update: CustomerMessageDeliveryUpdate,
): Promise<{ applied: boolean; reason: string; communicationId?: string; businessId?: string }> {
  await ensureCustomerMessagingSchema(db);
  if (!update.providerMessageId || !update.provider) {
    return { applied: false, reason: "missing_provider_message" };
  }

  let claimedBusinessId = update.claimedBusinessId ?? null;
  if (!claimedBusinessId && update.routingNumber) {
    const digits = normalizePhone(update.routingNumber);
    if (digits) {
      const routed = await db.business.findFirst({
        where: { operationalSmsNumber: digits },
        select: { id: true },
      });
      if (routed) claimedBusinessId = routed.id;
    }
  }

  const row = await db.customerCommunication.findFirst({
    where: {
      provider: update.provider,
      providerMessageId: update.providerMessageId,
    },
  });
  if (!row) {
    const ownerBlock = await recordOwnerStudioReminderDeliveryBlock(db, update);
    return ownerBlock ?? { applied: false, reason: "not_found" };
  }
  if (claimedBusinessId && claimedBusinessId !== row.businessId) {
    return { applied: false, reason: "tenant_mismatch" };
  }

  const eventId = update.providerEventId ?? `${update.providerMessageId}:${update.status}`;
  const claim = await claimCustomerMessagingWebhookEvent(db, {
    provider: update.provider,
    providerEventId: eventId,
    eventKind: "delivery",
    businessId: row.businessId,
  });
  if (claim === "completed") {
    return {
      applied: true,
      reason: "idempotent",
      communicationId: row.id,
      businessId: row.businessId,
    };
  }

  if (customerMessageDeliveryTestHooks.afterClaim) {
    await customerMessageDeliveryTestHooks.afterClaim();
  }

  const nextStatus = nextDeliveryStatus(row.status, update.status);
  const nextFailure =
    nextStatus === "FAILED" ? update.failureReason ?? row.failureReason : row.failureReason;

  if (nextStatus === row.status && nextFailure === row.failureReason) {
    await completeCustomerMessagingWebhookEvent(db, {
      provider: update.provider,
      providerEventId: eventId,
      eventKind: "delivery",
    });
    return {
      applied: true,
      reason: "idempotent",
      communicationId: row.id,
      businessId: row.businessId,
    };
  }

  if (customerMessageDeliveryTestHooks.beforeStatusWrite) {
    await customerMessageDeliveryTestHooks.beforeStatusWrite();
  }

  const updated = await db.customerCommunication.updateMany({
    where: {
      id: row.id,
      businessId: row.businessId,
      provider: row.provider,
      providerMessageId: row.providerMessageId,
    },
    data: {
      status: nextStatus,
      failureReason: nextFailure,
    },
  });
  if (updated.count !== 1) {
    return { applied: false, reason: "not_updated" };
  }
  await completeCustomerMessagingWebhookEvent(db, {
    provider: update.provider,
    providerEventId: eventId,
    eventKind: "delivery",
  });
  return {
    applied: true,
    reason: "updated",
    communicationId: row.id,
    businessId: row.businessId,
  };
}
