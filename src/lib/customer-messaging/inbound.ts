import { Prisma, type PrismaClient } from "@prisma/client";
import { isUsableNormalizedPhone, normalizePhone } from "@/lib/customer-identity";
import { ensureCustomerMessagingSchema } from "@/lib/customer-messaging/schema";
import type { InboundSmsEvent } from "@/lib/customer-messaging/types";
import {
  recordOwnerStudioReminderStart,
  recordOwnerStudioReminderStop,
} from "@/lib/marketing-studio-reminder";

type Db = PrismaClient | Prisma.TransactionClient;

export type InboundConsentResult = {
  applied: boolean;
  reason: string;
  businessId?: string;
  customerId?: string;
  consentStatus?: string;
};

async function rememberWebhookEvent(
  db: Db,
  input: {
    provider: string;
    providerEventId: string;
    eventKind: "delivery" | "inbound";
    businessId?: string | null;
  },
): Promise<"recorded" | "duplicate"> {
  try {
    await db.customerMessagingWebhookEvent.create({
      data: {
        provider: input.provider,
        providerEventId: input.providerEventId,
        eventKind: input.eventKind,
        businessId: input.businessId ?? null,
      },
    });
    return "recorded";
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return "duplicate";
    }
    throw error;
  }
}

export async function rememberCustomerMessagingWebhookEvent(
  db: Db,
  input: {
    provider: string;
    providerEventId: string;
    eventKind: "delivery" | "inbound";
    businessId?: string | null;
  },
) {
  await ensureCustomerMessagingSchema(db);
  return rememberWebhookEvent(db, input);
}

function receivingNumberDigits(value: string) {
  return normalizePhone(value);
}

async function applyOwnerStudioReminderInbound(
  db: Db,
  input: { businessId: string; fromDigits: string; optOutType: InboundSmsEvent["optOutType"] },
): Promise<{ matched: boolean; applied: boolean; reason: string }> {
  const settings = await db.businessSettings.findUnique({
    where: { businessId: input.businessId },
    select: {
      studioWeeklyReminderOwnerSmsTo: true,
    },
  });
  const ownerDigits = normalizePhone(settings?.studioWeeklyReminderOwnerSmsTo);
  if (!settings || !ownerDigits || ownerDigits !== input.fromDigits) {
    return { matched: false, applied: false, reason: "not_owner_destination" };
  }
  if (input.optOutType === "HELP") {
    return { matched: true, applied: false, reason: "owner_help_no_change" };
  }
  if (input.optOutType === "START") {
    return recordOwnerStudioReminderStart(db, input.businessId, input.fromDigits);
  }
  return recordOwnerStudioReminderStop(db, input.businessId, input.fromDigits);
}

export async function applyInboundConsentEvent(
  db: Db,
  inbound: InboundSmsEvent,
): Promise<InboundConsentResult> {
  await ensureCustomerMessagingSchema(db);

  const toDigits = receivingNumberDigits(inbound.to);
  if (!toDigits) {
    await rememberWebhookEvent(db, {
      provider: inbound.provider,
      providerEventId: inbound.providerEventId,
      eventKind: "inbound",
    });
    return { applied: false, reason: "unknown_tenant" };
  }

  const business = await db.business.findFirst({
    where: { operationalSmsNumber: toDigits },
    select: { id: true },
  });
  if (!business) {
    await rememberWebhookEvent(db, {
      provider: inbound.provider,
      providerEventId: inbound.providerEventId,
      eventKind: "inbound",
    });
    return { applied: false, reason: "unknown_tenant" };
  }

  const duplicate = await rememberWebhookEvent(db, {
    provider: inbound.provider,
    providerEventId: inbound.providerEventId,
    eventKind: "inbound",
    businessId: business.id,
  });
  if (duplicate === "duplicate") {
    return { applied: true, reason: "idempotent", businessId: business.id };
  }

  if (!inbound.optOutType) {
    return { applied: false, reason: "ignored_inbound", businessId: business.id };
  }

  const fromDigits = normalizePhone(inbound.from);
  if (!isUsableNormalizedPhone(fromDigits)) {
    return { applied: false, reason: "unusable_from", businessId: business.id };
  }

  const ownerHandled = await applyOwnerStudioReminderInbound(db, {
    businessId: business.id,
    fromDigits,
    optOutType: inbound.optOutType,
  });
  if (ownerHandled.matched) {
    return {
      applied: ownerHandled.applied,
      reason: ownerHandled.reason,
      businessId: business.id,
    };
  }

  const candidates = await db.customer.findMany({
    where: { businessId: business.id, phone: { not: null } },
    select: { id: true, phone: true, smsConsentStatus: true },
  });
  const matches = candidates.filter(
    (row) => normalizePhone(row.phone) === fromDigits,
  );
  if (matches.length !== 1) {
    return {
      applied: false,
      reason: matches.length === 0 ? "unknown_customer" : "ambiguous_customer",
      businessId: business.id,
    };
  }

  const customer = matches[0];
  if (inbound.optOutType === "HELP") {
    return {
      applied: false,
      reason: "help_no_consent_change",
      businessId: business.id,
      customerId: customer.id,
      consentStatus: customer.smsConsentStatus,
    };
  }

  if (inbound.optOutType === "STOP") {
    if (customer.smsConsentStatus === "REVOKED") {
      return {
        applied: true,
        reason: "idempotent",
        businessId: business.id,
        customerId: customer.id,
        consentStatus: "REVOKED",
      };
    }
    return applyConsentStatus(db, {
      businessId: business.id,
      customerId: customer.id,
      fromDigits,
      provider: inbound.provider,
      providerEventId: inbound.providerEventId,
      status: "REVOKED",
      reason: "revoked",
    });
  }

  // START is recognized Twilio Advanced Opt-Out re-opt-in only from REVOKED.
  if (customer.smsConsentStatus !== "REVOKED") {
    return {
      applied: false,
      reason: "start_not_applicable",
      businessId: business.id,
      customerId: customer.id,
      consentStatus: customer.smsConsentStatus,
    };
  }
  return applyConsentStatus(db, {
    businessId: business.id,
    customerId: customer.id,
    fromDigits,
    provider: inbound.provider,
    providerEventId: inbound.providerEventId,
    status: "GRANTED",
    reason: "granted",
  });
}

const CONSENT_MERGE_HOPS = 4;

async function applyConsentStatus(
  db: Db,
  input: {
    businessId: string;
    customerId: string;
    fromDigits: string;
    provider: string;
    providerEventId: string;
    status: "REVOKED" | "GRANTED";
    reason: "revoked" | "granted";
  },
): Promise<InboundConsentResult> {
  try {
    const firstWhere =
      input.status === "GRANTED"
        ? { id: input.customerId, businessId: input.businessId, smsConsentStatus: "REVOKED" }
        : { id: input.customerId, businessId: input.businessId };
    const first = await db.customer.updateMany({
      where: firstWhere,
      data: {
        smsConsentStatus: input.status,
        smsConsentUpdatedAt: new Date(),
      },
    });
    if (first.count > 0) {
      return {
        applied: true,
        reason: input.reason,
        businessId: input.businessId,
        customerId: input.customerId,
        consentStatus: input.status,
      };
    }

    let currentId = input.customerId;
    for (let hop = 0; hop < CONSENT_MERGE_HOPS; hop += 1) {
      const merge = await db.customerMerge.findFirst({
        where: { businessId: input.businessId, absorbedCustomerId: currentId },
        select: { survivorCustomerId: true },
      });
      if (!merge) {
        return {
          applied: false,
          reason: "unknown_customer",
          businessId: input.businessId,
        };
      }
      currentId = merge.survivorCustomerId;

      if (input.status === "GRANTED") {
        const survivor = await db.customer.findFirst({
          where: { id: currentId, businessId: input.businessId },
          select: { id: true, phone: true, smsConsentStatus: true },
        });
        if (
          !survivor ||
          survivor.smsConsentStatus !== "REVOKED" ||
          normalizePhone(survivor.phone) !== input.fromDigits
        ) {
          return {
            applied: false,
            reason: "start_not_applicable",
            businessId: input.businessId,
            customerId: survivor?.id,
            consentStatus: survivor?.smsConsentStatus,
          };
        }
        const startHop = await db.customer.updateMany({
          where: { id: currentId, businessId: input.businessId, smsConsentStatus: "REVOKED" },
          data: {
            smsConsentStatus: "GRANTED",
            smsConsentUpdatedAt: new Date(),
          },
        });
        if (startHop.count > 0) {
          return {
            applied: true,
            reason: "granted",
            businessId: input.businessId,
            customerId: currentId,
            consentStatus: "GRANTED",
          };
        }
        continue;
      }

      const hopUpdated = await db.customer.updateMany({
        where: { id: currentId, businessId: input.businessId },
        data: {
          smsConsentStatus: "REVOKED",
          smsConsentUpdatedAt: new Date(),
        },
      });
      if (hopUpdated.count > 0) {
        return {
          applied: true,
          reason: "revoked",
          businessId: input.businessId,
          customerId: currentId,
          consentStatus: "REVOKED",
        };
      }
    }

    return {
      applied: false,
      reason: "unknown_customer",
      businessId: input.businessId,
    };
  } catch (error) {
    console.error("Inbound consent write failed", {
      businessId: input.businessId,
      providerEventId: input.providerEventId,
      customerId: input.customerId,
      status: input.status,
    });
    try {
      await db.customerMessagingWebhookEvent.deleteMany({
        where: { provider: input.provider, providerEventId: input.providerEventId },
      });
    } catch (cleanupError) {
      console.error("Failed to delete inbound webhook after consent write error", cleanupError);
    }
    throw error;
  }
}
