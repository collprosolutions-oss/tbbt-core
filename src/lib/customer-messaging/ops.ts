import { Prisma, type PrismaClient } from "@prisma/client";
import { DISCONNECTED_CUSTOMER_MESSAGING_PROVIDER } from "@/lib/customer-messaging/config";
import {
  evaluateSmsEligibility,
  smsBlockFailureReason,
} from "@/lib/customer-messaging/eligibility";
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
  return db.reviewRequest.findFirst({
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
  if (current === "FAILED" && incoming !== "FAILED") return current;
  if (current === "BLOCKED" || current === "NOT_SENT" || current === "DRAFT") {
    return current;
  }
  return incoming;
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

  const existing = await db.customerCommunication.findFirst({
    where: {
      businessId: input.businessId,
      idempotencyKey: input.idempotencyKey,
    },
  });
  if (existing && isAcceptedCustomerMessageStatus(existing.status)) {
    return toAttemptResult(existing, true);
  }

  const settings = await db.businessSettings.findFirst({
    where: { businessId: input.businessId },
    select: {
      estimateCommunicationEnabled: true,
      scheduleNotificationEnabled: true,
      invoiceCommunicationEnabled: true,
      reviewRequestPreferenceEnabled: true,
    },
  });
  const eligibility = evaluateSmsEligibility({
    businessId: input.businessId,
    phone: customer.phone,
    smsConsentStatus: customer.smsConsentStatus,
    purpose: input.purpose,
    preferences: settings ?? DEFAULT_SETTINGS_PREFERENCES,
  });

  const provider = getCustomerMessagingProvider();
  const now = new Date();
  const baseData = {
    businessId: input.businessId,
    customerId: customer.id,
    channel: "SMS",
    purpose: input.purpose,
    relatedType: input.relatedType ?? null,
    relatedId: input.relatedId ?? null,
    idempotencyKey: input.idempotencyKey,
    destinationLast4: eligibility.last4,
    destinationFingerprint: eligibility.fingerprint,
    bodySnapshot: input.body,
    provider: provider.id,
    initiatedByMembershipId: input.initiatedByMembershipId ?? null,
    attemptedAt: now,
  };

  let status: CustomerMessageStatus = "READY";
  let failureReason: string | null = null;
  let providerMessageId: string | null = null;
  let providerMetadata: Prisma.InputJsonValue | typeof Prisma.JsonNull = Prisma.JsonNull;

  if (!eligibility.ok) {
    status = "BLOCKED";
    failureReason = smsBlockFailureReason(eligibility.reason);
  } else if (!provider.connected) {
    status = "NOT_SENT";
    failureReason = "SMS delivery is not connected.";
  } else {
    try {
      const sent = await provider.send({
        businessId: input.businessId,
        communicationId: existing?.id ?? "pending",
        channel: "SMS",
        to: eligibility.normalizedPhone,
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

  if (existing) {
    const updated = await db.customerCommunication.update({
      where: { id: existing.id },
      data: {
        ...baseData,
        status,
        failureReason,
        providerMessageId,
        providerMetadata,
      },
    });
    return toAttemptResult(updated, true);
  }

  try {
    const created = await db.customerCommunication.create({
      data: {
        ...baseData,
        status,
        failureReason,
        providerMessageId,
        providerMetadata,
      },
    });
    return toAttemptResult(created, false);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const raced = await db.customerCommunication.findFirst({
        where: {
          businessId: input.businessId,
          idempotencyKey: input.idempotencyKey,
        },
      });
      if (raced) return toAttemptResult(raced, true);
    }
    return {
      ok: false,
      communicationId: null,
      status: "FAILED",
      provider: provider.id,
      providerMessageId: null,
      failureReason: "The communication record could not be saved.",
      reused: false,
    };
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

  const row = await db.customerCommunication.findFirst({
    where: {
      provider: update.provider,
      providerMessageId: update.providerMessageId,
    },
  });
  if (!row) {
    return { applied: false, reason: "not_found" };
  }
  if (update.claimedBusinessId && update.claimedBusinessId !== row.businessId) {
    return { applied: false, reason: "tenant_mismatch" };
  }

  const nextStatus = nextDeliveryStatus(row.status, update.status);
  const nextFailure =
    nextStatus === "FAILED" ? update.failureReason ?? row.failureReason : row.failureReason;

  if (nextStatus === row.status && nextFailure === row.failureReason) {
    return {
      applied: true,
      reason: "idempotent",
      communicationId: row.id,
      businessId: row.businessId,
    };
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
  return {
    applied: true,
    reason: "updated",
    communicationId: row.id,
    businessId: row.businessId,
  };
}
