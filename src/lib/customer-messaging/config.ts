/**
 * Customer messaging is provider-neutral. No SMS vendor is configured
 * in production yet. The fake adapter is for local/script tests only
 * and is never treated as live delivery in Vercel production.
 */
export const CUSTOMER_MESSAGING_WEBHOOK_PATH = "/api/customer-messaging/webhook";
export const DISCONNECTED_CUSTOMER_MESSAGING_PROVIDER = "disconnected";
export const FAKE_CUSTOMER_MESSAGING_PROVIDER = "fake";

export function isFakeCustomerMessagingAdapterEnabled() {
  if (process.env.VERCEL_ENV === "production") {
    return false;
  }
  return process.env.TBBT_CUSTOMER_MESSAGING_ADAPTER === "fake";
}

export function getCustomerMessagingWebhookSecret(): string | null {
  const value = process.env.TBBT_CUSTOMER_MESSAGING_WEBHOOK_SECRET?.trim();
  return value || null;
}

export function isCustomerMessagingConfigured() {
  return isFakeCustomerMessagingAdapterEnabled();
}

export function isCustomerMessagingWebhookPath(pathname: string) {
  return pathname === CUSTOMER_MESSAGING_WEBHOOK_PATH;
}
