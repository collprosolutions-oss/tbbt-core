import { Prisma, type PrismaClient } from "@prisma/client";
import { CAPABILITIES, ForbiddenError, roleHasCapability } from "@/lib/authorization";
import {
  evaluateComposeChannelEligibility,
  consentContextSnapshot,
  emailDestinationFingerprint,
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
import { isMaintenanceFollowUp } from "@/lib/customer-follow-up-origin";
import {
  assertMaintenanceFollowUpComposeAllowed,
  claimMaintenanceFollowUpCompose,
  markMaintenanceFollowUpSentAfterCompose,
} from "@/lib/handyman-maintenance-follow-up-ops";
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

export const EMAIL_DISPATCH_CLAIM_LEASE_MS = 2 * 60 * 1000;

/**
 * Test-only pause/fault points. Production never assigns these.
 * Used to prove email claim-before-send and send-time recipient binding.
 */
export const communicationEmailDispatchTestHooks: {
  afterClaim?: () => Promise<void> | void;
  beforeProviderSend?: (ctx?: { db: Db }) => Promise<void> | void;
} = {};

/**
 * Test-only pause/fault points for MAINTENANCE compose. Production never
 * assigns these. afterClaim runs after the short claim transaction commits
 * and before the provider call. beforeMarkSent can force a mark-SENT failure.
 */
export const maintenanceComposeTestHooks: {
  afterClaim?: () => Promise<void> | void;
  beforeMarkSent?: () => Promise<void> | void;
} = {};

async function finishMaintenanceMarkSent(
  db: Db,
  access: { businessId: string },
  followUpId: string,
) {
  try {
    await maintenanceComposeTestHooks.beforeMarkSent?.();
    await markMaintenanceFollowUpSentAfterCompose(db, access, { followUpId });
  } catch (error) {
    console.error(
      "Failed to mark MAINTENANCE follow-up SENT after an accepted compose",
      error,
    );
  }
}

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
    resumeCommunicationId?: string | null;
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
  let resumeCommunicationId = input.resumeCommunicationId ?? null;
  if (relatedType === "CUSTOMER_FOLLOW_UP" && relatedId) {
    const followUp = await db.customerFollowUp.findFirst({
      where: { id: relatedId, businessId: access.businessId },
      select: { origin: true },
    });
    if (followUp && isMaintenanceFollowUp(followUp.origin)) {
      if ((input.channel === "SMS" || input.channel === "EMAIL") && "$transaction" in db) {
        const claimed = await claimMaintenanceFollowUpCompose(db as PrismaClient, access, {
          followUpId: relatedId,
          customerId: customer.id,
          idempotencyKey: input.idempotencyKey,
          channel: input.channel,
          purpose,
          subject: input.subject,
          body: input.body,
        });
        if (!claimed.ok) {
          return blocked(claimed.reason, input.channel);
        }
        if (claimed.outcome === "accepted") {
          await finishMaintenanceMarkSent(db, access, relatedId);
          return {
            ok: true,
            communicationId: claimed.communicationId,
            threadId: null,
            status: claimed.status as CommunicationSendResult["status"],
            channel: input.channel,
            provider: claimed.provider,
            reused: true,
            failureReason: claimed.failureReason,
          };
        }
        if (claimed.outcome === "in_progress") {
          return {
            ok: false,
            communicationId: claimed.communicationId,
            threadId: null,
            status: claimed.status as CommunicationSendResult["status"],
            channel: input.channel,
            provider: claimed.provider,
            reused: true,
            failureReason: claimed.failureReason,
          };
        }
        resumeCommunicationId = claimed.communicationId;
        await maintenanceComposeTestHooks.afterClaim?.();
      } else {
        const gate = await assertMaintenanceFollowUpComposeAllowed(db, access, {
          followUpId: relatedId,
          customerId: customer.id,
          idempotencyKey: input.idempotencyKey,
        });
        if (!gate.ok) {
          return blocked(gate.reason, input.channel);
        }
      }
    }
  }

  const finishCompose = async (result: CommunicationSendResult) => {
    if (
      result.ok &&
      (result.channel === "SMS" || result.channel === "EMAIL") &&
      isAcceptedCustomerMessageStatus(result.status) &&
      relatedType === "CUSTOMER_FOLLOW_UP" &&
      relatedId
    ) {
      await finishMaintenanceMarkSent(db, access, relatedId);
    }
    return result;
  };

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
        resumeCommunicationId: input.resumeCommunicationId,
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
      resumeCommunicationId,
    });
    if (result.communicationId && thread) {
      await db.customerCommunication.updateMany({
        where: { id: result.communicationId, businessId: access.businessId },
        data: {
          threadId: thread.id,
          direction: "OUTBOUND",
          subject: input.subject ?? null,
        },
      });
      await touchCommunicationThread(db, {
        businessId: access.businessId,
        threadId: thread.id,
      });
    }
    return finishCompose({
      ok: result.ok,
      communicationId: result.communicationId,
      threadId: thread?.id ?? null,
      status: result.status,
      channel: "SMS",
      provider: result.provider,
      reused: result.reused,
      failureReason: result.failureReason,
    });
  }

  if (input.channel === "EMAIL") {
    return finishCompose(await sendRecordedEmail(db, {
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
      resumeCommunicationId,
    }));
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
    resumeCommunicationId?: string | null;
    consentContext: string;
  },
): Promise<CommunicationSendResult> {
  const existing =
    (input.resumeCommunicationId
      ? await db.customerCommunication.findFirst({
          where: {
            id: input.resumeCommunicationId,
            businessId: input.access.businessId,
            idempotencyKey: input.idempotencyKey,
          },
        })
      : null) ??
    (await db.customerCommunication.findFirst({
      where: {
        businessId: input.access.businessId,
        idempotencyKey: input.idempotencyKey,
      },
    }));
  if (
    existing &&
    (isAcceptedCustomerMessageStatus(existing.status) || existing.status === "SENT")
  ) {
    return {
      ok: true,
      communicationId: existing.id,
      threadId: existing.threadId,
      status: existing.status as CustomerMessageStatus,
      channel: input.channel,
      provider: existing.provider,
      reused: true,
      failureReason: existing.failureReason,
    };
  }

  const rowData = {
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
  };

  let row;
  try {
    if (existing) {
      row = await db.customerCommunication.update({
        where: { id: existing.id },
        data: rowData,
      });
    } else {
      row = await db.customerCommunication.create({ data: rowData });
    }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await db.customerCommunication.findFirst({
        where: {
          businessId: input.access.businessId,
          idempotencyKey: input.idempotencyKey,
        },
      });
      if (raced && (isAcceptedCustomerMessageStatus(raced.status) || raced.status === "SENT")) {
        return {
          ok: true,
          communicationId: raced.id,
          threadId: raced.threadId,
          status: raced.status as CustomerMessageStatus,
          channel: input.channel,
          provider: raced.provider,
          reused: true,
          failureReason: raced.failureReason,
        };
      }
      if (raced) {
        row = await db.customerCommunication.update({
          where: { id: raced.id },
          data: rowData,
        });
      }
    }
    if (!row) {
      return blocked("The communication record could not be saved.", input.channel);
    }
  }
  if (input.threadId) {
    await touchCommunicationThread(db, {
      businessId: input.access.businessId,
      threadId: input.threadId,
    });
  }
  return {
    ok: isAcceptedCustomerMessageStatus(row.status) || row.status === "SENT",
    communicationId: row.id,
    threadId: input.threadId,
    status: row.status as CustomerMessageStatus,
    channel: input.channel,
    provider: row.provider,
    reused: Boolean(existing),
    failureReason: row.failureReason,
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
    resumeCommunicationId?: string | null;
  },
): Promise<CommunicationSendResult> {
  const decision = await withEmailDispatchLock(
    db,
    input.access.businessId,
    input.idempotencyKey,
    async (tx) => decideEmailDispatch(tx, input),
  );
  if (decision.kind !== "send") {
    return decision.result;
  }

  if (communicationEmailDispatchTestHooks.afterClaim) {
    await communicationEmailDispatchTestHooks.afterClaim();
  }
  if (communicationEmailDispatchTestHooks.beforeProviderSend) {
    await communicationEmailDispatchTestHooks.beforeProviderSend({ db });
  }

  const liveCustomer = await db.customer.findFirst({
    where: { id: input.customer.id, businessId: input.access.businessId },
    select: { id: true, email: true, smsConsentStatus: true },
  });
  const liveEmail = liveCustomer?.email?.trim() ?? "";
  const liveFingerprint = isUsableEmail(liveEmail)
    ? emailDestinationFingerprint(input.access.businessId, liveEmail)
    : null;

  let status: CustomerMessageStatus = "READY";
  let failureReason: string | null = null;
  let provider = "resend";
  let providerMessageId: string | null = null;

  if (!liveCustomer || !isUsableEmail(liveEmail)) {
    status = "BLOCKED";
    failureReason = "Customer has no usable email address.";
    provider = "disconnected";
  } else if (
    decision.claimedFingerprint &&
    liveFingerprint &&
    liveFingerprint !== decision.claimedFingerprint
  ) {
    status = "BLOCKED";
    failureReason = "The customer destination changed after this send was claimed.";
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
          to: liveEmail,
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

  const updated = await db.customerCommunication.update({
    where: { id: decision.communicationId },
    data: {
      status,
      failureReason,
      provider,
      providerMessageId,
      destinationLast4: decision.last4,
      destinationFingerprint: liveFingerprint ?? decision.claimedFingerprint,
      consentContext: consentContextSnapshot({
        smsConsentStatus: liveCustomer?.smsConsentStatus ?? input.customer.smsConsentStatus,
        emailAvailable: isUsableEmail(liveEmail),
        channel: "EMAIL",
        extra: status === "BLOCKED" || status === "NOT_SENT" ? failureReason : null,
      }),
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
    ok: isAcceptedCustomerMessageStatus(updated.status),
    communicationId: updated.id,
    threadId: input.threadId,
    status: updated.status as CustomerMessageStatus,
    channel: "EMAIL",
    provider: updated.provider,
    reused: decision.reused,
    failureReason: updated.failureReason,
  };
}

function emailDispatchLockKey(businessId: string, idempotencyKey: string) {
  return `tbbt-email:${businessId}:${idempotencyKey}`;
}

function emailDispatchClaimInProgress(
  row: { status: string; attemptedAt: Date | null } | null | undefined,
  now = new Date(),
) {
  if (!row || row.status !== "READY" || !row.attemptedAt) return false;
  return now.getTime() - row.attemptedAt.getTime() < EMAIL_DISPATCH_CLAIM_LEASE_MS;
}

async function withEmailDispatchLock<T>(
  db: Db,
  businessId: string,
  idempotencyKey: string,
  work: (tx: Db) => Promise<T>,
): Promise<T> {
  const lockKey = emailDispatchLockKey(businessId, idempotencyKey);
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

type EmailDispatchDecision =
  | { kind: "done"; result: CommunicationSendResult }
  | {
      kind: "send";
      communicationId: string;
      reused: boolean;
      claimedFingerprint: string | null;
      last4: string | null;
    };

async function decideEmailDispatch(
  tx: Db,
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
    resumeCommunicationId?: string | null;
  },
): Promise<EmailDispatchDecision> {
  const existing = await tx.customerCommunication.findFirst({
    where: {
      businessId: input.access.businessId,
      idempotencyKey: input.idempotencyKey,
    },
  });
  if (existing && isAcceptedCustomerMessageStatus(existing.status)) {
    return {
      kind: "done",
      result: {
        ok: true,
        communicationId: existing.id,
        threadId: existing.threadId,
        status: existing.status as CustomerMessageStatus,
        channel: "EMAIL",
        provider: existing.provider,
        reused: true,
        failureReason: existing.failureReason,
      },
    };
  }

  const resume =
    Boolean(input.resumeCommunicationId) &&
    Boolean(existing) &&
    existing!.id === input.resumeCommunicationId;
  if (existing && !resume && emailDispatchClaimInProgress(existing)) {
    return {
      kind: "done",
      result: {
        ok: isAcceptedCustomerMessageStatus(existing.status),
        communicationId: existing.id,
        threadId: existing.threadId,
        status: existing.status as CustomerMessageStatus,
        channel: "EMAIL",
        provider: existing.provider,
        reused: true,
        failureReason: existing.failureReason,
      },
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

  if (!input.eligibility.permitted || !input.eligibility.available) {
    const status = input.eligibility.reason === "email_not_configured" ? "NOT_SENT" : "BLOCKED";
    const row = existing
      ? await tx.customerCommunication.update({
          where: { id: existing.id },
          data: {
            ...baseData,
            status,
            failureReason: input.eligibility.ownerReason,
            provider: "disconnected",
          },
        })
      : await tx.customerCommunication.create({
          data: {
            ...baseData,
            status,
            failureReason: input.eligibility.ownerReason,
            provider: "disconnected",
          },
        });
    return {
      kind: "done",
      result: {
        ok: false,
        communicationId: row.id,
        threadId: input.threadId,
        status: row.status as CustomerMessageStatus,
        channel: "EMAIL",
        provider: row.provider,
        reused: Boolean(existing),
        failureReason: row.failureReason,
      },
    };
  }

  const config = getMailConfig();
  if ("error" in config) {
    const row = existing
      ? await tx.customerCommunication.update({
          where: { id: existing.id },
          data: {
            ...baseData,
            status: "NOT_SENT",
            failureReason: config.error,
            provider: "disconnected",
          },
        })
      : await tx.customerCommunication.create({
          data: {
            ...baseData,
            status: "NOT_SENT",
            failureReason: config.error,
            provider: "disconnected",
          },
        });
    return {
      kind: "done",
      result: {
        ok: false,
        communicationId: row.id,
        threadId: input.threadId,
        status: row.status as CustomerMessageStatus,
        channel: "EMAIL",
        provider: row.provider,
        reused: Boolean(existing),
        failureReason: row.failureReason,
      },
    };
  }

  const claimed = existing
    ? await tx.customerCommunication.update({
        where: { id: existing.id },
        data: {
          ...baseData,
          status: "READY",
          failureReason: null,
          provider: "resend",
        },
      })
    : await tx.customerCommunication.create({
        data: {
          ...baseData,
          status: "READY",
          failureReason: null,
          provider: "resend",
        },
      });
  return {
    kind: "send",
    communicationId: claimed.id,
    reused: Boolean(existing),
    claimedFingerprint: input.eligibility.fingerprint,
    last4: input.eligibility.last4,
  };
}
