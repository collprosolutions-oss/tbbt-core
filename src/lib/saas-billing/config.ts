/**
 * TBBT SaaS subscription billing configuration.
 *
 * The trade business pays TBBT for software access. This is not Stripe
 * Connect (customers paying the trade business). Platform Stripe keys
 * may be shared; Connect account records must never represent a TBBT
 * subscription.
 */
import { getStripeSecretKey, getStripeWebhookSecret } from "@/lib/payments/config";

export const TBBT_SAAS_PLAN_CODE = "tbbt_founder";
export const TBBT_SAAS_PLAN_NAME = "Founder Plan";
export const SAAS_CHECKOUT_PURPOSE = "tbbt_saas_subscription";
export const SAAS_BILLING_SETTINGS_HREF = "/settings?section=tbbt-billing";

/**
 * Founder Checkout is card-only. Delayed methods (ACH, bank debit, wallets
 * that settle later) can finish Checkout unpaid and only later fire
 * checkout.session.async_payment_succeeded. Card keeps payment synchronous;
 * unpaid complete events are still refused by the SaaS parser.
 */
export const SAAS_CHECKOUT_PAYMENT_METHOD_TYPES = ["card"] as const;

export function getSaasPriceId(): string | null {
  const value = process.env.STRIPE_SAAS_PRICE_ID?.trim();
  return value || null;
}

export function getSaasBillingWebhookSecret(): string | null {
  const dedicated = process.env.STRIPE_SAAS_WEBHOOK_SECRET?.trim();
  if (dedicated) return dedicated;
  return getStripeWebhookSecret();
}

export function saasBillingWebhookSecrets(): string[] {
  const secrets = [
    getStripeWebhookSecret(),
    process.env.STRIPE_SAAS_WEBHOOK_SECRET?.trim() || null,
  ].filter((value): value is string => Boolean(value));
  return [...new Set(secrets)];
}

/**
 * The fake adapter is for local/script tests only. Production must talk
 * to Stripe with STRIPE_SAAS_PRICE_ID. Never treat a fake adapter as a
 * live TBBT subscription platform. Same production-safety pattern as
 * Connect payments (`isFakePaymentsAdapterEnabled`) and customer SMS.
 */
export function isFakeSaasBillingAdapterEnabled(): boolean {
  if (process.env.VERCEL_ENV === "production") {
    return false;
  }
  return process.env.TBBT_SAAS_BILLING_ADAPTER === "fake";
}

export function isSaasBillingConfigured(): boolean {
  if (isFakeSaasBillingAdapterEnabled()) {
    return true;
  }
  return Boolean(getSaasPriceId() && getStripeSecretKey());
}
