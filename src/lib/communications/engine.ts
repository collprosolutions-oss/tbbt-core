import { Prisma, type PrismaClient } from "@prisma/client";
import { CAPABILITIES, ForbiddenError, roleHasCapability } from "@/lib/authorization";
import {
  evaluateComposeChannelEligibility,
  consentContextSnapshot,
} from "@/lib/communications/consent";
import { productCapabilityForPurpose } from "@/lib/communications/entitlements";
import { assertRelatedRecordForCustomer } from "@/lib/communications/related";
import { departmentSmsComposeRequiresAddon } from "@/lib/communications/sms-policy";
import { getOrCreateCustomerThread, touchCommunicationThread } from "@/lib/communications/thread";
import {
  isCommunicationChannel,
  type CommunicationChannel,
  type CommunicationRelatedType,
} from "@/lib/communications/types";
import { attemptCustomerSms } from "@/lib/customer-messaging/ops";
import {
  isAcceptedCustomerMessageStatus,
  isCustomerMessagePurpose,
  type CustomerMessagePurpose,
  type CustomerMessageRelatedType,
  type CustomerMessageStatus,
} from "@/lib/customer-messaging/types";
import {
  getMailConfig,
  isUsableEmail,
  sendTransactionalEmail,
  senderFrom,
  type TransactionalEmailKind,
} from "@/lib/mail";
import { hasProductCapability } from "@/lib/product-entitlements/enforce";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog/codes";
import { DEFAULT_SETTINGS_PREFERENCES } from "@/lib/settings";

type Db = PrismaClient | Prisma.TransactionClient;

export type CommunicationAccess = {
  businessId: string;
  workspace: {
    role: "OWNER" | "ADMIN" | "MEMBER";
    membership?: { id?: string | null } | null;
  };
};

export type CommunicationSendResult = {
  ok: boolean;
  communicationId: string | null;
  threadId: string | null;
  status: CustomerMessageStatus | "BLOCKED";
  channel: CommunicationChannel;
  provider: string;
  reused: boolean;
  failureReason: string | null;
};

type EmailSender = (input: {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
  kind: TransactionalEmailKind;
}) => Promise<{ id?: string; error?: string }>;

let emailSender: EmailSender = sendTransactionalEmail;

export function setCommunicationEmailSender(sender: EmailSender | null) {
  emailSender = sender ?? sendTransactionalEmail;
}

export function resetCommunicationEmailSender() {
  emailSender = sendTransactionalEmail;
}

export function requireCommunicationsCapability(access: CommunicationAccess) {
  if (!roleHasCapability(access.workspace.role, CAPABILITIES.MANAGE_COMMUNICATIONS)) {
    throw new ForbiddenError();
  }
}

export function requireCommunicationsAiCapability(access: CommunicationAccess) {
  requireCommunicationsCapability(access);
  if (!roleHasCapability(access.workspace.role, CAPABILITIES.USE_AI_ASSIST)) {
    throw new ForbiddenError();
  }
}

function membershipIdOf(access: CommunicationAccess) {
  return access.workspace.membership?.id ?? null;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function composeCustomerCommunication(
  db: Db,
  access: CommunicationAccess,
  input: {
    customerId: string;
    channel: string;
    purpose: string;
    subject?: string | null;
    body: string;
    idempotencyKey: string;
    relatedType?: CommunicationRelatedType | null;
    relatedId?: string | null;
    browserBusinessId?: string | null;
  },
): Promise<CommunicationSendResult> {
  requireCommunicationsCapability(access);

  if (input.browserBusinessId && input.browserBusinessId !== access.businessId) {
    return {
      ok: false,
      communicationId: null,
      threadId: null,
      status: "BLOCKED",
      channel: isCommunicationChannel(input.channel) ? input.channel : "EMAIL",
      provider: "none",
      reused: false,
      failureReason: "Browser businessId never authorizes a send.",
    };
  }

  if (!isCommunicationChannel(input.channel)) {
    return blocked("Unsupported communication channel.");
  }
  if (!isCustomerMessagePurpose(input.purpose) && input.channel !== "MANUAL" && input.channel !== "PHONE") {
    return blocked("Unsupported communication purpose.", input.channel);
  }
  if (!input.idempotencyKey.trim() || !input.body.trim()) {
    return blocked("Message and idempotency key are required.", input.channel);
  }

  const purpose = (
    isCustomerMessagePurpose(input.purpose) ? input.purpose : "GENERAL"
  ) as CustomerMessagePurpose;

  const requiredProduct = productCapabilityForPurpose(purpose);
  const entitled = await hasProductCapability(db, access.businessId, requiredProduct);
  if (!entitled) {
    return blocked(
      `This plan does not include the ${requiredProduct.replaceAll("_", " ").toLowerCase()} capability for that message.`,
      input.channel,
    );
  }

  const smsEntitled = departmentSmsComposeRequiresAddon()
    ? await hasProductCapability(db, access.businessId, PRODUCT_CAPABILITIES.SMS_MESSAGING)
    : true;

  const customer = await db.customer.findFirst({
    where: { id: input.customerId, businessId: access.businessId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      smsConsentStatus: true,
    },
  });
  if (!customer) {
    throw new ForbiddenError();
  }

  const related = await assertRelatedRecordForCustomer(db, {
    businessId: access.businessId,
    customerId: customer.id,
    relatedType: input.relatedType,
    relatedId: input.relatedId,
  });
  if (!related.ok) {
    return blocked(related.reason, input.channel as CommunicationChannel);
  }
  const relatedType = related.record?.relatedType ?? null;
  const relatedId = related.record?.relatedId ?? null;

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

  const eligibility = evaluateComposeChannelEligibility({
    businessId: access.businessId,
    channel: input.channel,
    email: customer.email,
    phone: customer.phone,
    smsConsentStatus: customer.smsConsentStatus,
    purpose,
    preferences: settings ?? DEFAULT_SETTINGS_PREFERENCES,
    smsEntitled,
  });

  const thread = await getOrCreateCustomerThread(db, {
    businessId: access.businessId,
    customerId: customer.id,
    title: customer.name,
  });

  if (input.channel === "SMS") {
    if (!eligibility.permitted) {
      return recordNonProviderAttempt(db, {
        access,
        customerId: customer.id,
        threadId: thread?.id ?? null,
        channel: "SMS",
        purpose,
        subject: input.subject ?? null,
        body: input.body,
        idempotencyKey: input.idempotencyKey,
        relatedType,
        relatedId,
        status: "BLOCKED",
        provider: "none",
        failureReason: eligibility.ownerReason,
        last4: eligibility.last4,
        fingerprint: eligibility.fingerprint,
        consentContext: consentContextSnapshot({
          smsConsentStatus: customer.smsConsentStatus,
          emailAvailable: isUsableEmail(customer.email),
          channel: "SMS",
          extra: eligibility.reason,
        }),
      });
    }
    const result = await attemptCustomerSms(db, {
      businessId: access.businessId,
      customerId: customer.id,
      purpose,
      relatedType: relatedType as CustomerMessageRelatedType | null,
      relatedId,
      idempotencyKey: input.idempotencyKey,
      body: input.body,
      initiatedByMembershipId: membershipIdOf(access),
    });
    if (result.communicationId && thread) {
      await db.customerCommunication.updateMany({
        where: { id: result.communicationId, businessId: access.businessId },
        data: {
          threadId: thread.id,
          direction: "OUTBOUND",
          subject: input.subject ?? null,
          consentContext: consentContextSnapshot({
            smsConsentStatus: customer.smsConsentStatus,
            emailAvailable: isUsableEmail(customer.email),
            channel: "SMS",
          }),
        },
      });
      await touchCommunicationThread(db, {
        businessId: access.businessId,
        threadId: thread.id,
      });
    }
    return {
      ok: result.ok,
      communicationId: result.communicationId,
      threadId: thread?.id ?? null,
      status: result.status,
      channel: "SMS",
      provider: result.provider,
      reused: result.reused,
      failureReason: result.failureReason,
    };
  }

  if (input.channel === "EMAIL") {
    return sendRecordedEmail(db, {
      access,
      customer,
      threadId: thread?.id ?? null,
      purpose,
      subject: input.subject?.trim() || "Message from your contractor",
      body: input.body,
      idempotencyKey: input.idempotencyKey,
      relatedType,
      relatedId,
      eligibility,
    });
  }

  return recordNonProviderAttempt(db, {
    access,
    customerId: customer.id,
    threadId: thread?.id ?? null,
    channel: input.channel,
    purpose,
    subject: input.subject ?? null,
    body: input.body,
    idempotencyKey: input.idempotencyKey,
    relatedType,
    relatedId,
    status: input.channel === "PHONE" ? "NOT_SENT" : "SENT",
    provider: "manual",
    failureReason:
      input.channel === "PHONE"
        ? eligibility.ownerReason
        : null,
    last4: eligibility.last4,
    fingerprint: eligibility.fingerprint,
    consentContext: consentContextSnapshot({
      smsConsentStatus: customer.smsConsentStatus,
      emailAvailable: isUsableEmail(customer.email),
      channel: input.channel,
    }),
  });
}

function blocked(failureReason: string, channel: CommunicationChannel = "EMAIL"): CommunicationSendResult {
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

async function recordNonProviderAttempt(
  db: Db,
  input: {
    access: CommunicationAccess;
    customerId: string;
    threadId: string | null;
    channel: CommunicationChannel;
    purpose: string;
    subject: string | null;
    body: string;
    idempotencyKey: string;
    relatedType?: CommunicationRelatedType | null;
    relatedId?: string | null;
    status: CustomerMessageStatus;
    provider: string;
    failureReason: string | null;
    last4: string | null;
    fingerprint: string | null;
    consentContext: string;
  },
): Promise<CommunicationSendResult> {
  const existing = await db.customerCommunication.findFirst({
    where: {
      businessId: input.access.businessId,
      idempotencyKey: input.idempotencyKey,
    },
  });
  if (existing) {
    return {
      ok: isAcceptedCustomerMessageStatus(existing.status) || existing.status === "SENT",
      communicationId: existing.id,
      threadId: existing.threadId,
      status: existing.status as CustomerMessageStatus,
      channel: input.channel,
      provider: existing.provider,
      reused: true,
      failureReason: existing.failureReason,
    };
  }

  const created = await db.customerCommunication.create({
    data: {
      businessId: input.access.businessId,
      customerId: input.customerId,
      threadId: input.threadId,
      direction: "OUTBOUND",
      channel: input.channel,
      purpose: input.purpose,
      subject: input.subject,
      relatedType: input.relatedType ?? null,
      relatedId: input.relatedId ?? null,
      idempotencyKey: input.idempotencyKey,
      destinationLast4: input.last4,
      destinationFingerprint: input.fingerprint,
      consentContext: input.consentContext,
      bodySnapshot: input.body,
      status: input.status,
      provider: input.provider,
      failureReason: input.failureReason,
      initiatedByMembershipId: membershipIdOf(input.access),
      attemptedAt: new Date(),
    },
  });
  if (input.threadId) {
    await touchCommunicationThread(db, {
      businessId: input.access.businessId,
      threadId: input.threadId,
    });
  }
  return {
    ok: isAcceptedCustomerMessageStatus(created.status) || created.status === "SENT",
    communicationId: created.id,
    threadId: input.threadId,
    status: created.status as CustomerMessageStatus,
    channel: input.channel,
    provider: created.provider,
    reused: false,
    failureReason: created.failureReason,
  };
}

async function sendRecordedEmail(
  db: Db,
  input: {
    access: CommunicationAccess;
    customer: { id: string; name: string; email: string | null; smsConsentStatus: string | null };
    threadId: string | null;
    purpose: CustomerMessagePurpose;
    subject: string;
    body: string;
    idempotencyKey: string;
    relatedType?: CommunicationRelatedType | null;
    relatedId?: string | null;
    eligibility: ReturnType<typeof evaluateComposeChannelEligibility>;
  },
): Promise<CommunicationSendResult> {
  const existing = await db.customerCommunication.findFirst({
    where: {
      businessId: input.access.businessId,
      idempotencyKey: input.idempotencyKey,
    },
  });
  if (existing && isAcceptedCustomerMessageStatus(existing.status)) {
    return {
      ok: true,
      communicationId: existing.id,
      threadId: existing.threadId,
      status: existing.status as CustomerMessageStatus,
      channel: "EMAIL",
      provider: existing.provider,
      reused: true,
      failureReason: existing.failureReason,
    };
  }

  const consentContext = consentContextSnapshot({
    smsConsentStatus: input.customer.smsConsentStatus,
    emailAvailable: isUsableEmail(input.customer.email),
    channel: "EMAIL",
    extra: input.eligibility.reason,
  });
  const baseData = {
    businessId: input.access.businessId,
    customerId: input.customer.id,
    threadId: input.threadId,
    direction: "OUTBOUND",
    channel: "EMAIL",
    purpose: input.purpose,
    subject: input.subject,
    relatedType: input.relatedType ?? null,
    relatedId: input.relatedId ?? null,
    idempotencyKey: input.idempotencyKey,
    destinationLast4: input.eligibility.last4,
    destinationFingerprint: input.eligibility.fingerprint,
    consentContext,
    bodySnapshot: input.body,
    initiatedByMembershipId: membershipIdOf(input.access),
    attemptedAt: new Date(),
  };

  let status: CustomerMessageStatus = "READY";
  let failureReason: string | null = null;
  let provider = "resend";
  let providerMessageId: string | null = null;

  if (!input.eligibility.permitted || !input.eligibility.available) {
    status = input.eligibility.reason === "email_not_configured" ? "NOT_SENT" : "BLOCKED";
    failureReason = input.eligibility.ownerReason;
    provider = "disconnected";
  } else {
    const config = getMailConfig();
    if ("error" in config) {
      status = "NOT_SENT";
      failureReason = config.error;
      provider = "disconnected";
    } else {
      try {
        const sent = await emailSender({
          apiKey: config.apiKey,
          from: senderFrom("TBBT", config.fromAddress),
          to: input.customer.email!.trim(),
          subject: input.subject,
          text: input.body,
          html: `<p>${escapeHtml(input.body).replaceAll("\n", "<br />")}</p>`,
          idempotencyKey: input.idempotencyKey,
          kind: "customer",
        });
        if (sent.error) {
          status = "FAILED";
          failureReason = sent.error;
        } else {
          status = "SENT";
          providerMessageId = sent.id ?? input.idempotencyKey;
        }
      } catch {
        status = "FAILED";
        failureReason = "The email provider failed.";
      }
    }
  }

  if (existing) {
    const updated = await db.customerCommunication.update({
      where: { id: existing.id },
      data: {
        ...baseData,
        status,
        failureReason,
        provider,
        providerMessageId,
      },
    });
    if (input.threadId) {
      await touchCommunicationThread(db, {
        businessId: input.access.businessId,
        threadId: input.threadId,
      });
    }
    return {
      ok: isAcceptedCustomerMessageStatus(updated.status),
      communicationId: updated.id,
      threadId: input.threadId,
      status: updated.status as CustomerMessageStatus,
      channel: "EMAIL",
      provider: updated.provider,
      reused: true,
      failureReason: updated.failureReason,
    };
  }

  try {
    const created = await db.customerCommunication.create({
      data: {
        ...baseData,
        status,
        failureReason,
        provider,
        providerMessageId,
      },
    });
    if (input.threadId) {
      await touchCommunicationThread(db, {
        businessId: input.access.businessId,
        threadId: input.threadId,
      });
    }
    return {
      ok: isAcceptedCustomerMessageStatus(created.status),
      communicationId: created.id,
      threadId: input.threadId,
      status: created.status as CustomerMessageStatus,
      channel: "EMAIL",
      provider: created.provider,
      reused: false,
      failureReason: created.failureReason,
    };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await db.customerCommunication.findFirst({
        where: {
          businessId: input.access.businessId,
          idempotencyKey: input.idempotencyKey,
        },
      });
      if (raced) {
        return {
          ok: isAcceptedCustomerMessageStatus(raced.status),
          communicationId: raced.id,
          threadId: raced.threadId,
          status: raced.status as CustomerMessageStatus,
          channel: "EMAIL",
          provider: raced.provider,
          reused: true,
          failureReason: raced.failureReason,
        };
      }
    }
    return blocked("The communication record could not be saved.", "EMAIL");
  }
}
