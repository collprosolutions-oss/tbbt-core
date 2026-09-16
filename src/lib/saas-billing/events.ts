import { SAAS_CHECKOUT_PURPOSE } from "@/lib/saas-billing/config";
import type { ParsedSaasBillingEvent, SaasSubscriptionSnapshot } from "@/lib/saas-billing/types";

const SAAS_CHECKOUT_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);

const SAAS_SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
]);

const SAAS_INVOICE_EVENTS = new Set([
  "invoice.paid",
  "invoice.payment_succeeded",
]);

const CONNECT_OR_CUSTOMER_PAYMENT_PURPOSES = new Set([
  "invoice_balance",
  "material_deposit",
]);

function normalizeEventType(type: string | undefined) {
  if (!type) return "";
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

function idOf(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string" && id.trim()) return id;
  }
  return null;
}

function unixToDate(value: unknown): Date | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return new Date(value * 1000);
}

function eventCreatedAt(record: { created?: unknown }): Date | null {
  return unixToDate(record.created);
}

function periodEndFromSubscription(object: Record<string, unknown>): Date | null {
  const items = object.items as
    | { data?: Array<{ current_period_end?: unknown }> }
    | undefined;
  const itemEnd = items?.data?.[0]?.current_period_end;
  return unixToDate(itemEnd) ?? unixToDate(object.current_period_end);
}

function priceIdFromSubscription(object: Record<string, unknown>): string | null {
  const items = object.items as
    | { data?: Array<{ price?: unknown }> }
    | undefined;
  return idOf(items?.data?.[0]?.price);
}

function isSaasPurpose(metadata: Record<string, string>) {
  return metadata.purpose === SAAS_CHECKOUT_PURPOSE;
}

function isCustomerPaymentPurpose(metadata: Record<string, string>) {
  return CONNECT_OR_CUSTOMER_PAYMENT_PURPOSES.has(metadata.purpose);
}

function snapshotFromSubscription(
  object: Record<string, unknown>,
  eventType: string,
): SaasSubscriptionSnapshot | null {
  const snapshot: SaasSubscriptionSnapshot = {
    stripeCustomerId: idOf(object.customer),
    stripeSubscriptionId: idOf(object.id) ?? idOf(object),
    stripePriceId: priceIdFromSubscription(object),
    status:
      eventType === "customer.subscription.deleted"
        ? "canceled"
        : typeof object.status === "string"
          ? object.status
          : "none",
    currentPeriodEnd: periodEndFromSubscription(object),
    cancelAtPeriodEnd: object.cancel_at_period_end === true,
  };
  if (!snapshot.stripeSubscriptionId) return null;
  return snapshot;
}

function subscriptionFromInvoice(object: Record<string, unknown>): Record<string, unknown> | null {
  const direct = object.subscription;
  if (direct && typeof direct === "object") {
    return direct as Record<string, unknown>;
  }
  const parent = object.parent as
    | { subscription_details?: { subscription?: unknown } }
    | undefined;
  const nested = parent?.subscription_details?.subscription;
  if (nested && typeof nested === "object") {
    return nested as Record<string, unknown>;
  }
  return null;
}

function subscriptionIdFromInvoice(object: Record<string, unknown>): string | null {
  const expanded = subscriptionFromInvoice(object);
  if (expanded) return idOf(expanded.id) ?? idOf(expanded);
  const parent = object.parent as
    | { subscription_details?: { subscription?: unknown } }
    | undefined;
  const lines = object.lines as { data?: Array<{ subscription?: unknown }> } | undefined;
  return (
    idOf(object.subscription) ??
    idOf(parent?.subscription_details?.subscription) ??
    idOf(lines?.data?.[0]?.subscription)
  );
}

function periodEndFromInvoice(object: Record<string, unknown>): Date | null {
  const expanded = subscriptionFromInvoice(object);
  if (expanded) return periodEndFromSubscription(expanded);
  const lines = object.lines as
    | { data?: Array<{ period?: { end?: unknown } }> }
    | undefined;
  return unixToDate(lines?.data?.[0]?.period?.end);
}

function priceIdFromInvoice(object: Record<string, unknown>): string | null {
  const expanded = subscriptionFromInvoice(object);
  if (expanded) return priceIdFromSubscription(expanded);
  const lines = object.lines as
    | { data?: Array<{ price?: unknown; pricing?: { price_details?: { price?: unknown } } }> }
    | undefined;
  const first = lines?.data?.[0];
  return idOf(first?.price) ?? idOf(first?.pricing?.price_details?.price);
}

export function parseSaasBillingEvent(event: unknown): ParsedSaasBillingEvent | null {
  if (!event || typeof event !== "object") return null;
  const record = event as {
    id?: unknown;
    type?: string;
    created?: unknown;
    account?: unknown;
    data?: { object?: Record<string, unknown> };
  };
  // Connect-account events belong to customer invoice/deposit Checkout, not
  // TBBT SaaS billing (the trade business paying TBBT).
  if (typeof record.account === "string" && record.account.trim()) {
    return null;
  }
  const stripeEventId = typeof record.id === "string" ? record.id : "";
  const eventType = normalizeEventType(record.type);
  const object = record.data?.object;
  if (!stripeEventId || !eventType || !object) return null;
  const stripeEventCreatedAt = eventCreatedAt(record);

  if (SAAS_CHECKOUT_EVENTS.has(eventType)) {
    if (object.object !== "checkout.session") return null;
    if (object.mode !== "subscription") return null;
    const metadata = readMetadata(object.metadata);
    if (!isSaasPurpose(metadata)) return null;
    const snapshot: SaasSubscriptionSnapshot = {
      stripeCustomerId: idOf(object.customer),
      stripeSubscriptionId: idOf(object.subscription),
      stripePriceId: metadata.priceId || null,
      status:
        object.payment_status === "paid" || object.status === "complete"
          ? "active"
          : "incomplete",
      currentPeriodEnd: null,
      cancelAtPeriodEnd: null,
    };
    if (!snapshot.stripeCustomerId && !snapshot.stripeSubscriptionId) return null;
    return {
      stripeEventId,
      eventType,
      businessId: metadata.businessId || null,
      stripeEventCreatedAt,
      snapshot,
    };
  }

  if (SAAS_SUBSCRIPTION_EVENTS.has(eventType)) {
    if (object.object !== "subscription") return null;
    const metadata = readMetadata(object.metadata);
    const snapshot = snapshotFromSubscription(object, eventType);
    if (!snapshot) return null;
    if (!isSaasPurpose(metadata) && !metadata.businessId) {
      // Lookups by stored customer/subscription id happen in apply.
      // Events without TBBT metadata still parse so existing rows can sync.
    }
    return {
      stripeEventId,
      eventType,
      businessId: metadata.businessId || null,
      stripeEventCreatedAt,
      snapshot,
    };
  }

  if (SAAS_INVOICE_EVENTS.has(eventType)) {
    if (object.object !== "invoice") return null;
    const metadata = readMetadata(object.metadata);
    if (isCustomerPaymentPurpose(metadata)) return null;
    const expanded = subscriptionFromInvoice(object);
    const stripeSubscriptionId = subscriptionIdFromInvoice(object);
    const stripeCustomerId = idOf(object.customer);
    if (!stripeSubscriptionId && !stripeCustomerId) return null;
    const snapshot: SaasSubscriptionSnapshot = expanded
      ? {
          stripeCustomerId: idOf(expanded.customer) ?? stripeCustomerId,
          stripeSubscriptionId: idOf(expanded.id) ?? stripeSubscriptionId,
          stripePriceId: priceIdFromSubscription(expanded),
          status: typeof expanded.status === "string" ? expanded.status : "active",
          currentPeriodEnd: periodEndFromSubscription(expanded),
          cancelAtPeriodEnd: expanded.cancel_at_period_end === true,
        }
      : {
          stripeCustomerId,
          stripeSubscriptionId,
          stripePriceId: priceIdFromInvoice(object),
          status: "active",
          currentPeriodEnd: periodEndFromInvoice(object),
          cancelAtPeriodEnd: null,
        };
    return {
      stripeEventId,
      eventType,
      businessId: metadata.businessId || null,
      stripeEventCreatedAt,
      snapshot,
    };
  }

  return null;
}
