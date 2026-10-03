/**
 * Verified Resend bounce/complaint ingest. Signature is checked before
 * any payload is trusted. Tenant is taken from existing Resend send
 * history. Forged, unknown, and cross-tenant events write nothing.
 * Replays and concurrent deliveries reuse one destination row. A bounce
 * racing a complaint for the same address ends as COMPLAINT.
 */
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  claimCustomerMessagingWebhookEvent,
  completeCustomerMessagingWebhookEvent,
} from "@/lib/customer-messaging/inbound";
import {
  emailDestinationFingerprintOrNull,
  emailDestinationLast4,
} from "@/lib/communications/consent";
import { isUsableEmail } from "@/lib/mail";
import {
  EMAIL_BOUNCE_BLOCK_REASON,
  EMAIL_COMPLAINT_BLOCK_REASON,
  ensureEmailFailedDestinationSchema,
  type EmailFailedDestinationReason,
} from "@/lib/mail-failed-destination";
import { getResendWebhookSecret, RESEND_MAIL_PROVIDER } from "@/lib/mail-webhook-path";
import {
  resendWebhookHeadersFromRequest,
  verifyResendWebhookSignature,
  type ResendWebhookHeaders,
} from "@/lib/mail-webhook-signature";

type Db = PrismaClient | Prisma.TransactionClient;

const GENERIC_NOT_FOUND = { error: "Not found." };
const GENERIC_INVALID = { error: "Invalid signature." };
const GENERIC_UNAVAILABLE = { error: "Unable to process." };
const GENERIC_OK = { ok: true as const };

export const MAIL_WEBHOOK_EVENT_BOUNCE = "email.bounced";
export const MAIL_WEBHOOK_EVENT_COMPLAINT = "email.complained";

export type MailWebhookRequest = {
  rawBody: string;
  headers: ResendWebhookHeaders;
};

export type MailWebhookHttpResult = {
  status: number;
  body: { ok?: true; error?: string };
};

export type ParsedMailDeliveryEvent = {
  type: typeof MAIL_WEBHOOK_EVENT_BOUNCE | typeof MAIL_WEBHOOK_EVENT_COMPLAINT;
  provider: typeof RESEND_MAIL_PROVIDER;
  providerEventId: string;
  providerMessageId: string;
  claimedBusinessId: string | null;
};

export type ApplyMailDeliveryEventResult = {
  applied: boolean;
  reason: string;
  businessId?: string;
  communicationId?: string;
  destinationId?: string;
};

function webhookEventKind(type: ParsedMailDeliveryEvent["type"]): "delivery" {
  void type;
  return "delivery";
}

function webhookEventId(event: Pick<ParsedMailDeliveryEvent, "providerMessageId" | "type">) {
  return `${event.providerMessageId}:${event.type}`;
}

function reasonForEvent(type: ParsedMailDeliveryEvent["type"]): EmailFailedDestinationReason {
  return type === MAIL_WEBHOOK_EVENT_COMPLAINT ? "COMPLAINT" : "BOUNCE";
}

function failureReasonFor(reason: EmailFailedDestinationReason) {
  return reason === "COMPLAINT" ? EMAIL_COMPLAINT_BLOCK_REASON : EMAIL_BOUNCE_BLOCK_REASON;
}

function asNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseResendDeliveryEvent(payload: string): ParsedMailDeliveryEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (record.type !== MAIL_WEBHOOK_EVENT_BOUNCE && record.type !== MAIL_WEBHOOK_EVENT_COMPLAINT) {
    return null;
  }
  const data =
    record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : null;
  const providerMessageId = asNonEmptyString(data?.email_id);
  if (!providerMessageId) return null;
  const claimedBusinessId =
    asNonEmptyString(data?.claimed_business_id) ?? asNonEmptyString(record.claimed_business_id);
  return {
    type: record.type,
    provider: RESEND_MAIL_PROVIDER,
    providerEventId: webhookEventId({ providerMessageId, type: record.type }),
    providerMessageId,
    claimedBusinessId,
  };
}

export function verifyAndParseMailWebhook(input: MailWebhookRequest): ParsedMailDeliveryEvent | null {
  const secret = getResendWebhookSecret();
  if (!secret) return null;
  if (
    !verifyResendWebhookSignature({
      secret,
      payload: input.rawBody,
      headers: input.headers,
    })
  ) {
    return null;
  }
  return parseResendDeliveryEvent(input.rawBody);
}

async function loadSendHistory(db: Db, providerMessageId: string) {
  return db.customerCommunication.findMany({
    where: {
      provider: RESEND_MAIL_PROVIDER,
      providerMessageId,
      channel: "EMAIL",
    },
    select: {
      id: true,
      businessId: true,
      customerId: true,
      status: true,
      failureReason: true,
      destinationFingerprint: true,
      destinationLast4: true,
    },
  });
}

function destinationLockKey(businessId: string, fingerprint: string) {
  return `tbbt-email-fail:${businessId}:${fingerprint}`;
}

function eventLockKey(provider: string, providerEventId: string) {
  return `tbbt-email-event:${provider}:${providerEventId}`;
}

function strongerFailedReason(
  current: string,
  incoming: EmailFailedDestinationReason,
): EmailFailedDestinationReason {
  return current === "COMPLAINT" || incoming === "COMPLAINT" ? "COMPLAINT" : incoming;
}

async function upsertFailedDestination(
  tx: Db,
  input: {
    businessId: string;
    destinationFingerprint: string;
    destinationLast4: string | null;
    reason: EmailFailedDestinationReason;
    provider: string;
    providerEventId: string;
    providerMessageId: string;
    communicationId: string;
  },
) {
  const destLock = destinationLockKey(input.businessId, input.destinationFingerprint);
  const eventLock = eventLockKey(input.provider, input.providerEventId);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${destLock}))`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${eventLock}))`;

  const existing = await tx.emailFailedDestination.findFirst({
    where: {
      OR: [
        {
          provider: input.provider,
          providerEventId: input.providerEventId,
        },
        {
          businessId: input.businessId,
          destinationFingerprint: input.destinationFingerprint,
        },
      ],
    },
    select: { id: true, reason: true, communicationId: true },
  });
  if (existing) {
    return updateExistingFailedDestination(tx, existing, input);
  }

  // ON CONFLICT DO NOTHING (no target) absorbs either unique index so
  // Postgres never aborts the transaction with 25P02. Recovery then
  // reads the winner and applies the stronger reason.
  const inserted = await tx.$queryRaw<Array<{ id: string; reason: string }>>`
    INSERT INTO "EmailFailedDestination" (
      id,
      "businessId",
      "destinationFingerprint",
      "destinationLast4",
      reason,
      provider,
      "providerEventId",
      "providerMessageId",
      "communicationId",
      "createdAt",
      "updatedAt"
    ) VALUES (
      ${randomUUID()},
      ${input.businessId},
      ${input.destinationFingerprint},
      ${input.destinationLast4},
      ${input.reason},
      ${input.provider},
      ${input.providerEventId},
      ${input.providerMessageId},
      ${input.communicationId},
      NOW(),
      NOW()
    )
    ON CONFLICT DO NOTHING
    RETURNING id, reason
  `;
  if (inserted[0]) {
    return {
      id: inserted[0].id,
      reason: inserted[0].reason as EmailFailedDestinationReason,
      created: true,
    };
  }

  const recovered = await tx.emailFailedDestination.findFirst({
    where: {
      OR: [
        {
          provider: input.provider,
          providerEventId: input.providerEventId,
        },
        {
          businessId: input.businessId,
          destinationFingerprint: input.destinationFingerprint,
        },
      ],
    },
    select: { id: true, reason: true, communicationId: true },
  });
  if (!recovered) {
    throw new Error("Failed destination upsert recovered no row.");
  }
  return updateExistingFailedDestination(tx, recovered, input);
}

async function updateExistingFailedDestination(
  tx: Db,
  existing: { id: string; reason: string; communicationId: string | null },
  input: {
    reason: EmailFailedDestinationReason;
    communicationId: string;
  },
) {
  const nextReason = strongerFailedReason(existing.reason, input.reason);
  if (nextReason !== existing.reason || !existing.communicationId) {
    await tx.emailFailedDestination.update({
      where: { id: existing.id },
      data: {
        reason: nextReason,
        communicationId: existing.communicationId ?? input.communicationId,
      },
    });
  }
  return { id: existing.id, reason: nextReason, created: false };
}

export async function applyVerifiedMailDeliveryEvent(
  db: PrismaClient,
  event: ParsedMailDeliveryEvent,
): Promise<ApplyMailDeliveryEventResult> {
  const rows = await loadSendHistory(db, event.providerMessageId);
  if (rows.length !== 1) {
    return { applied: false, reason: rows.length === 0 ? "not_found" : "ambiguous_send" };
  }
  const row = rows[0];
  if (event.claimedBusinessId && event.claimedBusinessId !== row.businessId) {
    return { applied: false, reason: "tenant_mismatch" };
  }

  await ensureEmailFailedDestinationSchema(db);
  const claim = await claimCustomerMessagingWebhookEvent(db, {
    provider: event.provider,
    providerEventId: event.providerEventId,
    eventKind: webhookEventKind(event.type),
    businessId: row.businessId,
  });
  if (claim === "completed") {
    return {
      applied: true,
      reason: "idempotent",
      businessId: row.businessId,
      communicationId: row.id,
    };
  }

  const client = db as PrismaClient;
  const run = async (tx: Db): Promise<ApplyMailDeliveryEventResult> => {
    const customer = await tx.customer.findFirst({
      where: { id: row.customerId, businessId: row.businessId },
      select: { email: true },
    });
    const fingerprint =
      row.destinationFingerprint ||
      emailDestinationFingerprintOrNull(row.businessId, customer?.email);
    if (!fingerprint) {
      await completeCustomerMessagingWebhookEvent(tx, {
        provider: event.provider,
        providerEventId: event.providerEventId,
        eventKind: webhookEventKind(event.type),
      });
      return { applied: false, reason: "missing_destination", businessId: row.businessId };
    }
    const last4 =
      row.destinationLast4 ||
      (isUsableEmail(customer?.email) ? emailDestinationLast4(customer.email) : null);
    const reason = reasonForEvent(event.type);
    const upserted = await upsertFailedDestination(tx, {
      businessId: row.businessId,
      destinationFingerprint: fingerprint,
      destinationLast4: last4,
      reason,
      provider: event.provider,
      providerEventId: event.providerEventId,
      providerMessageId: event.providerMessageId,
      communicationId: row.id,
    });

    if (row.status !== "BLOCKED" && row.status !== "NOT_SENT" && row.status !== "DRAFT") {
      await tx.customerCommunication.updateMany({
        where: {
          id: row.id,
          businessId: row.businessId,
          provider: RESEND_MAIL_PROVIDER,
          providerMessageId: event.providerMessageId,
        },
        data: {
          status: "FAILED",
          failureReason: failureReasonFor(upserted.reason),
        },
      });
    }

    await completeCustomerMessagingWebhookEvent(tx, {
      provider: event.provider,
      providerEventId: event.providerEventId,
      eventKind: webhookEventKind(event.type),
    });
    return {
      applied: true,
      reason: upserted.created ? "updated" : "idempotent",
      businessId: row.businessId,
      communicationId: row.id,
      destinationId: upserted.id,
    };
  };

  if (typeof client.$transaction === "function") {
    return client.$transaction((tx) => run(tx), {
      timeout: 20_000,
      maxWait: 20_000,
    });
  }
  return run(db);
}

export async function handleMailWebhookRequest(
  db: PrismaClient,
  request: MailWebhookRequest,
): Promise<MailWebhookHttpResult> {
  if (!getResendWebhookSecret()) {
    return { status: 404, body: GENERIC_NOT_FOUND };
  }
  const event = verifyAndParseMailWebhook(request);
  if (!event) {
    if (
      !verifyResendWebhookSignature({
        secret: getResendWebhookSecret() ?? "",
        payload: request.rawBody,
        headers: request.headers,
      })
    ) {
      return { status: 400, body: GENERIC_INVALID };
    }
    return { status: 200, body: GENERIC_OK };
  }
  try {
    await applyVerifiedMailDeliveryEvent(db, event);
    return { status: 200, body: GENERIC_OK };
  } catch {
    return { status: 500, body: GENERIC_UNAVAILABLE };
  }
}

export function mailWebhookHeadersFromRequest(request: Request): ResendWebhookHeaders {
  return resendWebhookHeadersFromRequest(request.headers);
}
