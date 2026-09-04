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

export function isStripePlatformConfigured(): boolean {
  if (process.env.TBBT_PAYMENTS_ADAPTER === "fake") {
    return true;
  }
  return Boolean(getStripeSecretKey());
}

export const STRIPE_CURRENCY = "usd" as const;
