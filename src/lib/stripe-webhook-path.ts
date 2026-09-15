/**
 * Platform Stripe webhook. SaaS subscription events and Connect
 * invoice/deposit events share this path, then split in dispatch.
 * Stripe POSTs have no TBBT session cookie; the auth proxy must not
 * redirect them to sign-in. The route itself verifies Stripe signatures.
 */
export const STRIPE_WEBHOOK_PATH = "/api/stripe/webhook";

export function isStripeWebhookPath(pathname: string) {
  return pathname === STRIPE_WEBHOOK_PATH;
}
