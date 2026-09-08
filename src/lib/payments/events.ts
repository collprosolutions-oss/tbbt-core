import type { VerifiedCheckoutPayment } from "@/lib/payments/types";

const SUCCESSFUL_CHECKOUT_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);

function normalizeCheckoutEventType(type: string | undefined) {
  if (!type) {
    return "";
  }
  return type.startsWith("v1.") ? type.slice(3) : type;
}

function readMetadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return Object.fromEntries(entries);
}

export function parseCheckoutPaymentEvent(
  event: unknown,
): VerifiedCheckoutPayment | null {
  if (!event || typeof event !== "object") {
    return null;
  }
  const record = event as {
    type?: string;
    account?: string;
    data?: { object?: Record<string, unknown> };
  };
  const eventType = normalizeCheckoutEventType(record.type);
  if (!eventType || !SUCCESSFUL_CHECKOUT_EVENTS.has(eventType)) {
    return null;
  }
  const session = record.data?.object;
  if (!session || session.object !== "checkout.session") {
    return null;
  }
  const metadata = readMetadata(session.metadata);
  const paymentStatus =
    typeof session.payment_status === "string" ? session.payment_status : "";
  if (eventType === "checkout.session.completed" && paymentStatus !== "paid") {
    return null;
  }
  const amountCents =
    typeof session.amount_total === "number" ? session.amount_total : NaN;
  const currency = typeof session.currency === "string" ? session.currency : "";
  const checkoutSessionId = typeof session.id === "string" ? session.id : "";
  const paymentIntent =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : checkoutSessionId;
  const connectedAccountId = record.account || metadata.connectedAccountId;
  const purpose =
    metadata.purpose === "material_deposit" ? "material_deposit" : "invoice_balance";
  const invoiceId = metadata.invoiceId || null;
  const estimateId = metadata.estimateId || null;
  if (
    !metadata.businessId ||
    !connectedAccountId ||
    !checkoutSessionId ||
    !Number.isInteger(amountCents) ||
    !currency ||
    !paymentIntent
  ) {
    return null;
  }
  if (purpose === "material_deposit" && !estimateId) {
    return null;
  }
  if (purpose === "invoice_balance" && !invoiceId) {
    return null;
  }
  return {
    purpose,
    invoiceId,
    estimateId,
    checkoutSessionId,
    businessId: metadata.businessId,
    connectedAccountId,
    amountCents,
    currency,
    paymentReference: paymentIntent,
    paymentStatus: paymentStatus || "paid",
  };
}
