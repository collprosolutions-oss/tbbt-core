import type { Prisma, PrismaClient } from "@prisma/client";
import {
  requireCommunicationsCapability,
  type CommunicationAccess,
  type CommunicationSendResult,
} from "@/lib/communications/engine";
import { DEFAULT_SETTINGS_PREFERENCES } from "@/lib/settings";
import { STALE_RECIPIENT_FAILURE, attemptCustomerSms } from "@/lib/customer-messaging/ops";
import { evaluateSmsEligibility } from "@/lib/customer-messaging/eligibility";
import {
  CUSTOMER_MESSAGE_RELATED_TYPES,
  isAcceptedCustomerMessageStatus,
  isCustomerMessagePurpose,
  type CustomerMessageRelatedType,
} from "@/lib/customer-messaging/types";

type Db = PrismaClient | Prisma.TransactionClient;

export const FAILED_SMS_RETRY_KEY_PREFIX = "sms:failed-retry:";
export const FAILED_SMS_DELIVERY_LIMIT = 40;

export const FAILED_SMS_NOT_IN_BUSINESS_REASON = "That failed SMS is not in this business.";
export const FAILED_SMS_ONLY_FAILED_REASON = "Only a failed SMS can be retried.";
export const FAILED_SMS_SUCCESS_NOT_RETRIED_REASON = "A successful message is not retried.";
export const FAILED_SMS_EMPTY_BODY_REASON = "The failed SMS has no message body to retry.";
export const FAILED_SMS_UNSUPPORTED_PURPOSE_REASON = "That failed SMS purpose cannot be retried.";

export function failedSmsRetryIdempotencyKey(communicationId: string) {
  return `${FAILED_SMS_RETRY_KEY_PREFIX}${communicationId}`;
}

export function isFailedSmsRetryKey(value: string | null | undefined) {
  return Boolean(value?.startsWith(FAILED_SMS_RETRY_KEY_PREFIX));
}

function relatedTypeOf(value: string | null | undefined): CustomerMessageRelatedType | null {
  if (!value) return null;
  return (CUSTOMER_MESSAGE_RELATED_TYPES as readonly string[]).includes(value)
    ? (value as CustomerMessageRelatedType)
    : null;
}

function membershipIdOf(access: CommunicationAccess) {
  return access.workspace.membership?.id ?? null;
}

function blockedResult(
  channel: CommunicationSendResult["channel"],
  failureReason: string,
): CommunicationSendResult {
  return {
    ok: false,
    communicationId: null,
    threadId: null,
    status: "BLOCKED",
    channel,
    provider: "none",
    reused: false,
    failureReason,
  };
}

export type FailedSmsDeliveryRow = {
  id: string;
  customerId: string;
  customerName: string;
  purpose: string;
  bodySnapshot: string;
  status: string;
  failureReason: string | null;
  destinationLast4: string | null;
  relatedType: string | null;
  relatedId: string | null;
  createdAt: Date;
  attemptedAt: Date | null;
  canRetry: boolean;
  retryCommunicationId: string | null;
  retryStatus: string | null;
};

export async function listFailedSmsDeliveries(
  db: Db,
  access: CommunicationAccess,
): Promise<FailedSmsDeliveryRow[]> {
  requireCommunicationsCapability(access);

  const rows = await db.customerCommunication.findMany({
    where: {
      businessId: access.businessId,
      channel: "SMS",
      status: "FAILED",
      NOT: { idempotencyKey: { startsWith: FAILED_SMS_RETRY_KEY_PREFIX } },
    },
    orderBy: { createdAt: "desc" },
    take: FAILED_SMS_DELIVERY_LIMIT,
    select: {
      id: true,
      customerId: true,
      purpose: true,
      bodySnapshot: true,
      status: true,
      failureReason: true,
      destinationLast4: true,
      relatedType: true,
      relatedId: true,
      createdAt: true,
      attemptedAt: true,
      customer: { select: { name: true } },
    },
  });

  const retryKeys = rows.map((row) => failedSmsRetryIdempotencyKey(row.id));
  const retries = retryKeys.length
    ? await db.customerCommunication.findMany({
        where: {
          businessId: access.businessId,
          idempotencyKey: { in: retryKeys },
        },
        select: { id: true, idempotencyKey: true, status: true },
      })
    : [];
  const retryByKey = new Map(retries.map((row) => [row.idempotencyKey, row]));

  return rows.map((row) => {
    const retry = retryByKey.get(failedSmsRetryIdempotencyKey(row.id));
    const retryAccepted = Boolean(retry && isAcceptedCustomerMessageStatus(retry.status));
    return {
      id: row.id,
      customerId: row.customerId,
      customerName: row.customer.name,
      purpose: row.purpose,
      bodySnapshot: row.bodySnapshot,
      status: row.status,
      failureReason: row.failureReason,
      destinationLast4: row.destinationLast4,
      relatedType: row.relatedType,
      relatedId: row.relatedId,
      createdAt: row.createdAt,
      attemptedAt: row.attemptedAt,
      canRetry: !retryAccepted,
      retryCommunicationId: retry?.id ?? null,
      retryStatus: retry?.status ?? null,
    };
  });
}

/**
 * Explicit OWNER/ADMIN retry of one tenant FAILED SMS.
 * Reuses attemptCustomerSms so consent and destination are rechecked at
 * send time. Does not rebuild dispatch-claim logic and never auto-retries.
 */
export async function retryFailedSmsDelivery(
  db: Db,
  access: CommunicationAccess,
  input: {
    communicationId: string;
    browserBusinessId?: string | null;
  },
): Promise<CommunicationSendResult> {
  requireCommunicationsCapability(access);

  if (input.browserBusinessId && input.browserBusinessId !== access.businessId) {
    return blockedResult("SMS", "Browser businessId never authorizes a send.");
  }

  const communicationId = input.communicationId.trim();
  if (!communicationId) {
    return blockedResult("SMS", FAILED_SMS_NOT_IN_BUSINESS_REASON);
  }

  const row = await db.customerCommunication.findFirst({
    where: { id: communicationId, businessId: access.businessId },
    select: {
      id: true,
      customerId: true,
      channel: true,
      purpose: true,
      bodySnapshot: true,
      status: true,
      relatedType: true,
      relatedId: true,
      destinationFingerprint: true,
    },
  });
  if (!row) {
    return blockedResult("SMS", FAILED_SMS_NOT_IN_BUSINESS_REASON);
  }
  if (isAcceptedCustomerMessageStatus(row.status)) {
    return blockedResult("SMS", FAILED_SMS_SUCCESS_NOT_RETRIED_REASON);
  }
  if (row.channel !== "SMS" || row.status !== "FAILED") {
    return blockedResult("SMS", FAILED_SMS_ONLY_FAILED_REASON);
  }
  if (!isCustomerMessagePurpose(row.purpose)) {
    return blockedResult("SMS", FAILED_SMS_UNSUPPORTED_PURPOSE_REASON);
  }
  if (!row.bodySnapshot.trim()) {
    return blockedResult("SMS", FAILED_SMS_EMPTY_BODY_REASON);
  }

  const customer = await db.customer.findFirst({
    where: { id: row.customerId, businessId: access.businessId },
    select: {
      id: true,
      phone: true,
      smsConsentStatus: true,
    },
  });
  if (!customer) {
    return blockedResult("SMS", FAILED_SMS_NOT_IN_BUSINESS_REASON);
  }

  const settings = await db.businessSettings.findFirst({
    where: { businessId: access.businessId },
    select: {
      estimateCommunicationEnabled: true,
      scheduleNotificationEnabled: true,
      invoiceCommunicationEnabled: true,
      reviewRequestPreferenceEnabled: true,
      marketingCommunicationEnabled: true,
    },
  });
  const liveEligibility = evaluateSmsEligibility({
    businessId: access.businessId,
    phone: customer.phone,
    smsConsentStatus: customer.smsConsentStatus,
    purpose: row.purpose,
    preferences: settings ?? DEFAULT_SETTINGS_PREFERENCES,
  });
  if (
    row.destinationFingerprint &&
    liveEligibility.fingerprint &&
    row.destinationFingerprint !== liveEligibility.fingerprint
  ) {
    return blockedResult("SMS", STALE_RECIPIENT_FAILURE);
  }

  const result = await attemptCustomerSms(db, {
    businessId: access.businessId,
    customerId: customer.id,
    purpose: row.purpose,
    relatedType: relatedTypeOf(row.relatedType),
    relatedId: row.relatedId,
    idempotencyKey: failedSmsRetryIdempotencyKey(row.id),
    body: row.bodySnapshot,
    initiatedByMembershipId: membershipIdOf(access),
  });

  return {
    ok: result.ok,
    communicationId: result.communicationId,
    threadId: null,
    status: result.status,
    channel: "SMS",
    provider: result.provider,
    reused: result.reused,
    failureReason: result.failureReason,
  };
}
