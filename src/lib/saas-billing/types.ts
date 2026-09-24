export const SAAS_SUBSCRIPTION_STATUS_NONE = "none";

export const SAAS_SUBSCRIBED_STATUSES = ["active", "trialing"] as const;
export const SAAS_PAYMENT_PROBLEM_STATUSES = ["past_due", "unpaid", "paused"] as const;
export const SAAS_TERMINATED_STATUSES = ["canceled", "incomplete_expired"] as const;

export const BLOCKING_SAAS_SUBSCRIPTION_STATUSES = [
  ...SAAS_SUBSCRIBED_STATUSES,
  ...SAAS_PAYMENT_PROBLEM_STATUSES,
] as const;

export type BlockingSaasSubscriptionStatus =
  (typeof BLOCKING_SAAS_SUBSCRIPTION_STATUSES)[number];

export type SaasSubscriptionSnapshot = {
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  status: string;
  currentPeriodEnd: Date | null;
  /**
   * null means the event does not speak to cancellation scheduling
   * (Checkout / invoice recovery without an expanded subscription).
   */
  cancelAtPeriodEnd: boolean | null;
};

export type CreateSaasCustomerInput = {
  businessId: string;
  email: string | null;
  name: string;
};

export type CreateSaasCheckoutInput = {
  businessId: string;
  customerId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
};

export type SaasCheckoutSessionResult = {
  id: string;
  url: string;
};

export type CreateSaasPortalInput = {
  customerId: string;
  returnUrl: string;
};

export type ScheduleSaasCancelInput = {
  subscriptionId: string;
};

export type ScheduleSaasCancelResult = {
  subscriptionId: string;
  cancelAtPeriodEnd: boolean;
};

export type ParsedSaasBillingEvent = {
  stripeEventId: string;
  eventType: string;
  businessId: string | null;
  stripeEventCreatedAt: Date | null;
  snapshot: SaasSubscriptionSnapshot;
};

/**
 * Stripe Billing operations for TBBT SaaS subscriptions.
 * Never creates a Connect account or an invoice/deposit Checkout.
 */
export type SaasBillingProvider = {
  createCustomer(input: CreateSaasCustomerInput): Promise<{ id: string }>;
  createSubscriptionCheckout(
    input: CreateSaasCheckoutInput,
  ): Promise<SaasCheckoutSessionResult>;
  listBlockingSubscriptions(customerId: string): Promise<Array<{ id: string; status: string }>>;
  createBillingPortalSession(
    input: CreateSaasPortalInput,
  ): Promise<{ url: string }>;
  /**
   * Ask Stripe (or the fake adapter) to schedule cancel-at-period-end.
   * Local TBBT rows stay unchanged until a webhook snapshot arrives.
   */
  scheduleCancelAtPeriodEnd(
    input: ScheduleSaasCancelInput,
  ): Promise<ScheduleSaasCancelResult>;
};

export class SaasBillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaasBillingError";
  }
}

export function saasBillingErrorMessage(error: unknown, fallback: string) {
  if (error instanceof SaasBillingError) {
    return error.message;
  }
  return fallback;
}

export function isBlockingSaasStatus(status: string | null | undefined) {
  return BLOCKING_SAAS_SUBSCRIPTION_STATUSES.includes(
    (status ?? "") as BlockingSaasSubscriptionStatus,
  );
}

export function isSaasPaymentProblemStatus(status: string | null | undefined) {
  return (SAAS_PAYMENT_PROBLEM_STATUSES as readonly string[]).includes(status ?? "");
}

export function isSaasSubscribedStatus(status: string | null | undefined) {
  return (SAAS_SUBSCRIBED_STATUSES as readonly string[]).includes(status ?? "");
}

export function isSaasTerminatedStatus(status: string | null | undefined) {
  return (SAAS_TERMINATED_STATUSES as readonly string[]).includes(status ?? "");
}

export function saasStatusLabel(status: string | null | undefined) {
  switch (status) {
    case "active":
      return "Active";
    case "trialing":
      return "Trialing";
    case "past_due":
      return "Past due";
    case "unpaid":
      return "Unpaid";
    case "paused":
      return "Paused";
    case "canceled":
      return "Canceled";
    case "incomplete":
      return "Incomplete";
    case "incomplete_expired":
      return "Expired";
    case SAAS_SUBSCRIPTION_STATUS_NONE:
    case null:
    case undefined:
    case "":
      return "Not subscribed";
    default:
      return status;
  }
}
