import type { SmsConsentStatus } from "@/lib/customer-messaging/types";
import { SMS_CONSENT_STATUSES } from "@/lib/customer-messaging/types";

export function isSmsConsentStatus(value: string): value is SmsConsentStatus {
  return (SMS_CONSENT_STATUSES as readonly string[]).includes(value);
}

export function isSmsConsentGranted(status: string | null | undefined) {
  return status === "GRANTED";
}

export function isSmsConsentRevoked(status: string | null | undefined) {
  return status === "REVOKED";
}

/**
 * A stored phone number is not consent. UNKNOWN stays UNKNOWN.
 */
export function resolveStoredSmsConsent(status: string | null | undefined): SmsConsentStatus {
  if (status === "GRANTED" || status === "REVOKED") return status;
  return "UNKNOWN";
}
