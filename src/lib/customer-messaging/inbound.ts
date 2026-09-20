import { Prisma, type PrismaClient } from "@prisma/client";
import { isUsableNormalizedPhone, normalizePhone } from "@/lib/customer-identity";
import { ensureCustomerMessagingSchema } from "@/lib/customer-messaging/schema";
import type { InboundSmsEvent } from "@/lib/customer-messaging/types";

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
    await db.customer.update({
      where: { id: customer.id },
      data: {
        smsConsentStatus: "REVOKED",
        smsConsentUpdatedAt: new Date(),
      },
    });
    return {
      applied: true,
      reason: "revoked",
      businessId: business.id,
      customerId: customer.id,
      consentStatus: "REVOKED",
    };
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
  await db.customer.update({
    where: { id: customer.id },
    data: {
      smsConsentStatus: "GRANTED",
      smsConsentUpdatedAt: new Date(),
    },
  });
  return {
    applied: true,
    reason: "granted",
    businessId: business.id,
    customerId: customer.id,
    consentStatus: "GRANTED",
  };
}
