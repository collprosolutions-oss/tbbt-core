export const SAAS_SUBSCRIPTION_STATUS_NONE = "none";

export const BLOCKING_SAAS_SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "paused",
] as const;

export type BlockingSaasSubscriptionStatus =
  (typeof BLOCKING_SAAS_SUBSCRIPTION_STATUSES)[number];

export type SaasSubscriptionSnapshot = {
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  status: string;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
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

export type ParsedSaasBillingEvent = {
  stripeEventId: string;
  eventType: string;
  businessId: string | null;
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
