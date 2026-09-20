/**
 * Customer messaging is provider-neutral. Twilio is the production SMS
 * adapter when its env vars are set. Otherwise the app stays disconnected
 * and never fabricates delivery. The fake adapter is local/script tests
 * only and cannot enable in Vercel production.
 */
export const CUSTOMER_MESSAGING_WEBHOOK_PATH = "/api/customer-messaging/webhook";
export const DISCONNECTED_CUSTOMER_MESSAGING_PROVIDER = "disconnected";
export const FAKE_CUSTOMER_MESSAGING_PROVIDER = "fake";
export const TWILIO_CUSTOMER_MESSAGING_PROVIDER = "twilio";

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

export function getTwilioAccountSid(): string | null {
  return process.env.TWILIO_ACCOUNT_SID?.trim() || null;
}

export function getTwilioAuthToken(): string | null {
  return process.env.TWILIO_AUTH_TOKEN?.trim() || null;
}

export function getTwilioMessagingServiceSid(): string | null {
  return process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() || null;
}

export function getTwilioFromNumber(): string | null {
  return process.env.TWILIO_FROM_NUMBER?.trim() || null;
}

export type TwilioMessagingConfig = {
  accountSid: string;
  authToken: string;
  messagingServiceSid: string | null;
  fromNumber: string | null;
};

export function getTwilioMessagingConfig(): TwilioMessagingConfig | null {
  const accountSid = getTwilioAccountSid();
  const authToken = getTwilioAuthToken();
  if (!accountSid || !authToken) return null;
  const messagingServiceSid = getTwilioMessagingServiceSid();
  const fromNumber = getTwilioFromNumber();
  if (!messagingServiceSid && !fromNumber) return null;
  return { accountSid, authToken, messagingServiceSid, fromNumber };
}

export function isTwilioCustomerMessagingConfigured() {
  return getTwilioMessagingConfig() !== null;
}

export function isCustomerMessagingConfigured() {
  return isFakeCustomerMessagingAdapterEnabled() || isTwilioCustomerMessagingConfigured();
}

export function isCustomerMessagingWebhookPath(pathname: string) {
  return pathname === CUSTOMER_MESSAGING_WEBHOOK_PATH;
}
