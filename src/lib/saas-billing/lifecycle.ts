/**
 * SaaS subscription webhook lifecycle helpers. These refine how Stripe
 * events map onto the existing BusinessSaasSubscription row. They are
 * not a second entitlement or billing system.
 */
import {
  SAAS_PAYMENT_PROBLEM_STATUSES,
  SAAS_SUBSCRIPTION_STATUS_NONE,
} from "@/lib/saas-billing/types";

const PAYMENT_PROBLEM = new Set<string>(SAAS_PAYMENT_PROBLEM_STATUSES);

export const SAAS_INVOICE_RECOVERY_EVENTS = new Set([
  "invoice.paid",
  "invoice.payment_succeeded",
]);

export function isSaasInvoiceRecoveryEvent(eventType: string) {
  return SAAS_INVOICE_RECOVERY_EVENTS.has(eventType);
}

export function isSaasSubscriptionObjectEvent(eventType: string) {
  return eventType.startsWith("customer.subscription");
}

/**
 * Stripe event.created is authoritative for ordering. A replayed older
 * event must not overwrite a newer known subscription snapshot.
 * Missing timestamps are treated as unknown, not stale.
 */
export function isStaleSaasStripeEvent(
  currentEventCreatedAt: Date | null | undefined,
  incomingEventCreatedAt: Date | null | undefined,
) {
  if (!currentEventCreatedAt || !incomingEventCreatedAt) return false;
  return incomingEventCreatedAt.getTime() < currentEventCreatedAt.getTime();
}

export function resolveNextSaasStatus(input: {
  eventType: string;
  incomingStatus: string;
  currentStatus: string | null | undefined;
}) {
  const current = input.currentStatus || SAAS_SUBSCRIPTION_STATUS_NONE;
  const incoming = input.incomingStatus || current;

  if (isSaasInvoiceRecoveryEvent(input.eventType)) {
    if (PAYMENT_PROBLEM.has(current) || current === "incomplete") {
      return incoming;
    }
    if (current === SAAS_SUBSCRIPTION_STATUS_NONE) {
      return incoming;
    }
    return current;
  }

  if (
    !isSaasSubscriptionObjectEvent(input.eventType) &&
    current !== SAAS_SUBSCRIPTION_STATUS_NONE &&
    current !== "incomplete"
  ) {
    return current;
  }

  return incoming;
}
