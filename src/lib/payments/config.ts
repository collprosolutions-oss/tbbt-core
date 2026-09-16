/**
 * Platform Stripe configuration. The secret key is environment-only —
 * never stored per business and never sent to the browser.
 */
export function getStripeSecretKey(): string | null {
  const value = process.env.STRIPE_SECRET_KEY?.trim();
  return value || null;
}

export function getStripeWebhookSecret(): string | null {
  const value = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  return value || null;
}

/**
 * The fake adapter is for local/script tests only. Production must talk
 * to Stripe with STRIPE_SECRET_KEY. Never treat a fake adapter as a
 * live payment platform.
 */
export function isFakePaymentsAdapterEnabled(): boolean {
  if (process.env.VERCEL_ENV === "production") {
    return false;
  }
  return process.env.TBBT_PAYMENTS_ADAPTER === "fake";
}

export function isStripePlatformConfigured(): boolean {
  if (isFakePaymentsAdapterEnabled()) {
    return true;
  }
  return Boolean(getStripeSecretKey());
}

export const STRIPE_CURRENCY = "usd" as const;
