import type { Prisma, PrismaClient } from "@prisma/client";
import { ForbiddenError } from "@/lib/authorization";
import { destinationFingerprint, destinationLast4 } from "@/lib/customer-messaging/eligibility";
import { isUsableNormalizedPhone, normalizePhone } from "@/lib/customer-identity";
import { isCustomerMessagingConfigured } from "@/lib/customer-messaging/config";
import { isEmailDeliveryConfigured } from "@/lib/settings";
import { ensureCommunicationsSchema } from "@/lib/communications/schema";
import {
  requireCommunicationsCapability,
  type CommunicationAccess,
} from "@/lib/communications/engine";
import {
  RECEPTIONIST_CAPABILITIES,
  VOICE_NOT_CONNECTED_REASON,
} from "@/lib/communications/types";

type Db = PrismaClient | Prisma.TransactionClient;

export function getReceptionistReadiness(input?: {
  emailConfigured?: boolean;
  smsConfigured?: boolean;
}) {
  const emailConfigured = input?.emailConfigured ?? isEmailDeliveryConfigured();
  const smsConfigured = input?.smsConfigured ?? isCustomerMessagingConfigured();
  return {
    voice: {
      connected: false,
      provider: null,
      provisionedNumber: false,
      canCompleteCalls: false,
      reason: VOICE_NOT_CONNECTED_REASON,
    },
    email: {
      connected: emailConfigured,
      provider: emailConfigured ? "resend" : null,
      reason: emailConfigured ? null : "Email delivery is not configured.",
    },
    sms: {
      connected: smsConfigured,
      provider: smsConfigured ? "twilio-or-adapter" : null,
      reason: smsConfigured ? null : "SMS delivery is not connected.",
    },
    capabilities: RECEPTIONIST_CAPABILITIES.map((capability) => ({
      capability,
      available: capability !== "INBOUND_CALL_EVENT",
      liveVoiceRequired: capability === "INBOUND_CALL_EVENT",
      canAuthorizeBusinessChange: false,
    })),
  };
}

export async function lookupCaller(
  db: Db,
  access: CommunicationAccess,
  input: { phone?: string | null; browserBusinessId?: string | null },
) {
  await ensureCommunicationsSchema(db);
  requireCommunicationsCapability(access);
  if (input.browserBusinessId && input.browserBusinessId !== access.businessId) {
    throw new ForbiddenError();
  }
  const digits = normalizePhone(input.phone);
  if (!isUsableNormalizedPhone(digits)) {
    return { matched: false as const, customer: null, reason: "No usable caller phone." };
  }
  const customer = await db.customer.findFirst({
    where: { businessId: access.businessId, phone: digits },
    select: { id: true, name: true, email: true, smsConsentStatus: true },
  });
  return {
    matched: Boolean(customer),
    customer,
    callerLast4: destinationLast4(digits),
    callerFingerprint: destinationFingerprint(access.businessId, digits),
  };
}

export async function recordInboundCallEvent(
  db: Db,
  access: CommunicationAccess,
  input: {
    phone?: string | null;
    customerId?: string | null;
    summary?: string | null;
    idempotencyKey: string;
    browserBusinessId?: string | null;
  },
) {
  await ensureCommunicationsSchema(db);
  requireCommunicationsCapability(access);
  if (input.browserBusinessId && input.browserBusinessId !== access.businessId) {
    throw new ForbiddenError();
  }
  const readiness = getReceptionistReadiness();
  const existing = await db.receptionistEvent.findFirst({
    where: {
      businessId: access.businessId,
      idempotencyKey: input.idempotencyKey,
    },
  });
  if (existing) {
    return { ok: true, reused: true, event: existing, readiness };
  }

  let customerId = input.customerId ?? null;
  if (customerId) {
    const owned = await db.customer.findFirst({
      where: { id: customerId, businessId: access.businessId },
      select: { id: true },
    });
    if (!owned) throw new ForbiddenError();
  } else if (input.phone) {
    const lookup = await lookupCaller(db, access, { phone: input.phone });
    customerId = lookup.customer?.id ?? null;
  }

  const event = await db.receptionistEvent.create({
    data: {
      businessId: access.businessId,
      customerId,
      kind: "INBOUND_CALL",
      status: "SKIPPED_NOT_CONNECTED",
      provider: "none",
      providerConnected: false,
      payload: {
        summary: input.summary ?? null,
        voiceReady: false,
        reason: VOICE_NOT_CONNECTED_REASON,
      },
      idempotencyKey: input.idempotencyKey,
      initiatedByMembershipId: access.workspace.membership?.id ?? null,
    },
  });
  return { ok: true, reused: false, event, readiness };
}

export async function proposeReceptionistAction(
  db: Db,
  access: CommunicationAccess,
  input: {
    kind: "QUALIFICATION" | "CREATE_REQUEST_PROPOSAL" | "SCHEDULING_PROPOSAL" | "MESSAGE_SUMMARY" | "ESCALATION";
    customerId?: string | null;
    phoneInteractionId?: string | null;
    proposal: Record<string, unknown>;
    idempotencyKey: string;
  },
) {
  await ensureCommunicationsSchema(db);
  requireCommunicationsCapability(access);
  if (input.customerId) {
    const owned = await db.customer.findFirst({
      where: { id: input.customerId, businessId: access.businessId },
      select: { id: true },
    });
    if (!owned) throw new ForbiddenError();
  }
  if (input.phoneInteractionId) {
    const owned = await db.phoneInteraction.findFirst({
      where: { id: input.phoneInteractionId, businessId: access.businessId },
      select: { id: true },
    });
    if (!owned) throw new ForbiddenError();
  }

  const existing = await db.receptionistEvent.findFirst({
    where: {
      businessId: access.businessId,
      idempotencyKey: input.idempotencyKey,
    },
  });
  if (existing) return { ok: true, reused: true, event: existing, authorizedChange: false };

  const event = await db.receptionistEvent.create({
    data: {
      businessId: access.businessId,
      customerId: input.customerId ?? null,
      phoneInteractionId: input.phoneInteractionId ?? null,
      kind: input.kind,
      status: input.kind === "ESCALATION" ? "ESCALATED" : "PROPOSED",
      provider: "none",
      providerConnected: false,
      payload: {
        ...input.proposal,
        authorizedChange: false,
        suggestionOnly: true,
      },
      idempotencyKey: input.idempotencyKey,
      initiatedByMembershipId: access.workspace.membership?.id ?? null,
    },
  });
  return { ok: true, reused: false, event, authorizedChange: false };
}
