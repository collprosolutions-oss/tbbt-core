/**
 * Tenant-scoped inbox for authenticated Connect invoice Checkout events
 * that return HTTP 200 while remaining unapplied.
 *
 * Invoice apply, Invoice FOR UPDATE, and Payment unique indexes stay in
 * `applyVerifiedCheckoutPayment` (`src/lib/payments/service.ts`). This
 * module does not reimplement those writes. #332 (merged) locks Estimate
 * FOR NO KEY UPDATE on the material-deposit path in that file.
 *
 * OWNER retry uses the frozen verified payment JSON. It never calls
 * Stripe and never applies another business's event.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { applyVerifiedCheckoutPayment } from "@/lib/payments";
import type { VerifiedCheckoutPayment } from "@/lib/payments/types";
import { assertRequiredTablesExist } from "@/lib/request-path-schema";
import { writeSettingsAuditLog } from "@/lib/settings-ops";

type InboxDb = PrismaClient | Prisma.TransactionClient;

export const CONNECT_INVOICE_WEBHOOK_OWNER_TITLE = "Card payment received but not applied";
export const CONNECT_INVOICE_WEBHOOK_OWNER_DETAIL =
  "Stripe already accepted this card payment. Retry applies the stored verified event only. It does not charge the customer again.";
export const CONNECT_INVOICE_WEBHOOK_NOT_IN_WORKSPACE =
  "That payment event is not in this workspace.";
export const CONNECT_INVOICE_WEBHOOK_RETRY_LABEL = "Retry stored card event";

export const CONNECT_INVOICE_WEBHOOK_INBOX_HIDDEN_REASONS = [
  "already_paid",
  "already_applied",
] as const;

const EVENT_SELECT = {
  id: true,
  stripeEventId: true,
  businessId: true,
  invoiceId: true,
  checkoutSessionId: true,
  amountCents: true,
  currency: true,
  purpose: true,
  paymentStatus: true,
  eventType: true,
  verifiedPaymentJson: true,
  applied: true,
  reason: true,
  lastAttemptedAt: true,
  appliedAt: true,
  createdAt: true,
} as const;

export type ConnectInvoiceWebhookEventRow = {
  id: string;
  stripeEventId: string;
  businessId: string;
  invoiceId: string | null;
  checkoutSessionId: string;
  amountCents: number;
  currency: string;
  purpose: string;
  paymentStatus: string;
  eventType: string;
  verifiedPaymentJson: Prisma.JsonValue;
  applied: boolean;
  reason: string;
  lastAttemptedAt: Date;
  appliedAt: Date | null;
  createdAt: Date;
};

export type ConnectInvoiceWebhookOwnerItem = {
  id: string;
  businessId: string;
  invoiceId: string | null;
  amountCents: number;
  reason: string;
  reasonLabel: string;
  lastAttemptedAt: Date;
};

export class ConnectInvoiceWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectInvoiceWebhookError";
  }
}

export function connectInvoiceWebhookErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ConnectInvoiceWebhookError) {
    return error.message;
  }
  return fallback;
}

const REASON_LABELS: Record<string, string> = {
  amount_mismatch: "Amount no longer matches remaining due",
  account_mismatch: "Connected account does not match this business",
  not_sent: "Invoice was not sent yet",
  invoice_not_found: "Invoice was not found",
  business_mismatch: "Business did not match",
  currency_mismatch: "Currency is not USD",
  already_paid: "Payment already recorded",
  already_applied: "Event already applied",
  received: "Received and not yet applied",
};

export function connectInvoiceWebhookReasonLabel(reason: string) {
  return REASON_LABELS[reason] ?? "Verified card event was not applied";
}

export function connectInvoiceWebhookInboxWhere(
  businessId: string,
  invoiceId?: string | null,
) {
  return {
    businessId,
    applied: false,
    purpose: "invoice_balance",
    reason: { notIn: [...CONNECT_INVOICE_WEBHOOK_INBOX_HIDDEN_REASONS] },
    ...(invoiceId ? { invoiceId } : {}),
  };
}

let ensureTablePromise: Promise<void> | null = null;

export function resetConnectInvoiceWebhookEventTableEnsure() {
  ensureTablePromise = null;
}

export async function ensureConnectInvoiceWebhookEventTable(db: InboxDb) {
  if (!ensureTablePromise) {
    ensureTablePromise = assertRequiredTablesExist(db, ["ConnectInvoiceWebhookEvent"]).catch(
      (error) => {
        ensureTablePromise = null;
        throw error;
      },
    );
  }
  await ensureTablePromise;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readIntegerCents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return null;
  }
  return value;
}

export function readStripeEventId(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  return readNonEmptyString((event as { id?: unknown }).id);
}

function readEventType(event: unknown): string {
  if (!event || typeof event !== "object") return "checkout.session.completed";
  return readNonEmptyString((event as { type?: unknown }).type) ?? "checkout.session.completed";
}

export function parseStoredVerifiedCheckoutPayment(
  value: unknown,
): VerifiedCheckoutPayment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.purpose !== "invoice_balance") {
    return null;
  }
  const invoiceId = readNonEmptyString(record.invoiceId);
  const checkoutSessionId = readNonEmptyString(record.checkoutSessionId);
  const businessId = readNonEmptyString(record.businessId);
  const connectedAccountId = readNonEmptyString(record.connectedAccountId);
  const currency = readNonEmptyString(record.currency);
  const paymentReference = readNonEmptyString(record.paymentReference);
  const paymentStatus = readNonEmptyString(record.paymentStatus);
  const amountCents = readIntegerCents(record.amountCents);
  if (
    !invoiceId ||
    !checkoutSessionId ||
    !businessId ||
    !connectedAccountId ||
    !currency ||
    !paymentReference ||
    !paymentStatus ||
    amountCents === null
  ) {
    return null;
  }
  return {
    purpose: "invoice_balance",
    invoiceId,
    estimateId: null,
    checkoutSessionId,
    businessId,
    connectedAccountId,
    amountCents,
    currency,
    paymentReference,
    paymentStatus,
  };
}

function frozenVerifiedPaymentJson(payment: VerifiedCheckoutPayment): Prisma.InputJsonValue {
  return {
    purpose: "invoice_balance",
    invoiceId: payment.invoiceId,
    estimateId: null,
    checkoutSessionId: payment.checkoutSessionId,
    businessId: payment.businessId,
    connectedAccountId: payment.connectedAccountId,
    amountCents: payment.amountCents,
    currency: payment.currency,
    paymentReference: payment.paymentReference,
    paymentStatus: payment.paymentStatus,
  };
}

function isUniqueConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function recordConnectInvoiceWebhookEvent(
  db: InboxDb,
  input: {
    stripeEventId: string;
    eventType: string;
    payment: VerifiedCheckoutPayment;
  },
): Promise<ConnectInvoiceWebhookEventRow> {
  await ensureConnectInvoiceWebhookEventTable(db);
  try {
    return await db.connectInvoiceWebhookEvent.create({
      data: {
        stripeEventId: input.stripeEventId,
        businessId: input.payment.businessId,
        invoiceId: input.payment.invoiceId,
        checkoutSessionId: input.payment.checkoutSessionId,
        amountCents: input.payment.amountCents,
        currency: input.payment.currency,
        purpose: input.payment.purpose,
        paymentStatus: input.payment.paymentStatus,
        eventType: input.eventType,
        verifiedPaymentJson: frozenVerifiedPaymentJson(input.payment),
        applied: false,
        reason: "received",
      },
      select: EVENT_SELECT,
    });
  } catch (error) {
    if (!isUniqueConflict(error)) {
      throw error;
    }
    const existing = await db.connectInvoiceWebhookEvent.findUnique({
      where: { stripeEventId: input.stripeEventId },
      select: EVENT_SELECT,
    });
    if (!existing || existing.businessId !== input.payment.businessId) {
      throw new ConnectInvoiceWebhookError(CONNECT_INVOICE_WEBHOOK_NOT_IN_WORKSPACE);
    }
    return existing;
  }
}

function resultMarksApplied(result: { applied: boolean; reason: string }) {
  return result.applied || result.reason === "already_paid" || result.reason === "already_applied";
}

export async function markConnectInvoiceWebhookEventResult(
  db: InboxDb,
  eventId: string,
  businessId: string,
  result: { applied: boolean; reason: string },
) {
  const applied = resultMarksApplied(result);
  await db.connectInvoiceWebhookEvent.updateMany({
    where: { id: eventId, businessId },
    data: {
      applied,
      reason: result.reason,
      lastAttemptedAt: new Date(),
      appliedAt: applied ? new Date() : null,
    },
  });
}

export async function applyRecordedConnectInvoicePayment(
  db: PrismaClient,
  event: unknown,
  payment: VerifiedCheckoutPayment,
): Promise<{ applied: boolean; reason: string }> {
  if (payment.purpose !== "invoice_balance") {
    return applyVerifiedCheckoutPayment(db, payment);
  }

  const stripeEventId = readStripeEventId(event);
  if (!stripeEventId) {
    return applyVerifiedCheckoutPayment(db, payment);
  }

  const row = await recordConnectInvoiceWebhookEvent(db, {
    stripeEventId,
    eventType: readEventType(event),
    payment,
  });
  const stored = parseStoredVerifiedCheckoutPayment(row.verifiedPaymentJson);
  if (!stored || stored.businessId !== row.businessId) {
    await markConnectInvoiceWebhookEventResult(db, row.id, row.businessId, {
      applied: false,
      reason: "business_mismatch",
    });
    return { applied: false, reason: "business_mismatch" };
  }

  const result = await applyVerifiedCheckoutPayment(db, stored);
  await markConnectInvoiceWebhookEventResult(db, row.id, row.businessId, result);
  return result;
}

function toOwnerItem(row: {
  id: string;
  businessId: string;
  invoiceId: string | null;
  amountCents: number;
  reason: string;
  lastAttemptedAt: Date;
}): ConnectInvoiceWebhookOwnerItem {
  return {
    id: row.id,
    businessId: row.businessId,
    invoiceId: row.invoiceId,
    amountCents: row.amountCents,
    reason: row.reason,
    reasonLabel: connectInvoiceWebhookReasonLabel(row.reason),
    lastAttemptedAt: row.lastAttemptedAt,
  };
}

export async function listUnappliedConnectInvoiceWebhookEvents(
  db: InboxDb,
  businessId: string,
  options: { invoiceId?: string | null; take?: number } = {},
): Promise<ConnectInvoiceWebhookOwnerItem[]> {
  await ensureConnectInvoiceWebhookEventTable(db);
  const rows = await db.connectInvoiceWebhookEvent.findMany({
    where: connectInvoiceWebhookInboxWhere(businessId, options.invoiceId),
    select: {
      id: true,
      businessId: true,
      invoiceId: true,
      amountCents: true,
      reason: true,
      lastAttemptedAt: true,
    },
    orderBy: [{ lastAttemptedAt: "desc" }, { id: "desc" }],
    take: options.take,
  });
  return rows.filter((row) => row.businessId === businessId).map(toOwnerItem);
}

export async function retryConnectInvoiceWebhookEvent(
  db: PrismaClient,
  access: BusinessAccess,
  eventId: string,
): Promise<{ applied: boolean; reason: string; eventId: string }> {
  // RETRY_CONNECT_INVOICE_WEBHOOK_GUARD
  requireBusinessCapability(access, CAPABILITIES.RETRY_CONNECT_INVOICE_WEBHOOK);
  await ensureConnectInvoiceWebhookEventTable(db);

  const found = await db.connectInvoiceWebhookEvent.findFirst({
    where: { id: eventId, businessId: access.businessId },
    select: EVENT_SELECT,
  });
  if (!found) {
    throw new ConnectInvoiceWebhookError(CONNECT_INVOICE_WEBHOOK_NOT_IN_WORKSPACE);
  }
  const row = access.assertOwned(found);

  const stored = parseStoredVerifiedCheckoutPayment(row.verifiedPaymentJson);
  if (
    !stored ||
    stored.businessId !== access.businessId ||
    stored.businessId !== row.businessId
  ) {
    return { applied: false, reason: "business_mismatch", eventId: row.id };
  }

  const result = await applyVerifiedCheckoutPayment(db, stored);
  const reason =
    row.applied && (result.reason === "already_paid" || !result.applied)
      ? "already_applied"
      : result.reason;
  await markConnectInvoiceWebhookEventResult(db, row.id, access.businessId, {
    applied: result.applied,
    reason,
  });

  try {
    await writeSettingsAuditLog(db, {
      businessId: access.businessId,
      changedByMembershipId: access.workspace.membership.id,
      settingArea: "payments",
      settingKey: "connectInvoiceWebhookRetry",
      previousValue: {
        eventId: row.id,
        invoiceId: row.invoiceId,
        applied: row.applied,
        reason: row.reason,
      },
      newValue: {
        eventId: row.id,
        invoiceId: row.invoiceId,
        applied: result.applied,
        reason,
        stripeRefund: false,
        customerCharge: false,
      },
    });
  } catch {
    // Retry outcome is already durable on the event row.
  }

  return { applied: result.applied, reason, eventId: row.id };
}
