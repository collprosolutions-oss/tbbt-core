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

export function parseSaasBillingEvent(event: unknown): ParsedSaasBillingEvent | null {
  if (!event || typeof event !== "object") return null;
  const record = event as {
    id?: unknown;
    type?: string;
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
      cancelAtPeriodEnd: false,
    };
    if (!snapshot.stripeCustomerId && !snapshot.stripeSubscriptionId) return null;
    return {
      stripeEventId,
      eventType,
      businessId: metadata.businessId || null,
      snapshot,
    };
  }

  if (SAAS_SUBSCRIPTION_EVENTS.has(eventType)) {
    if (object.object !== "subscription") return null;
    const metadata = readMetadata(object.metadata);
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
    if (!isSaasPurpose(metadata) && !metadata.businessId) {
      // Lookups by stored customer/subscription id happen in apply.
      // Events without TBBT metadata still parse so existing rows can sync.
    }
    return {
      stripeEventId,
      eventType,
      businessId: metadata.businessId || null,
      snapshot,
    };
  }

  return null;
}
