import { createHash } from "node:crypto";
import { isUsableNormalizedPhone, normalizePhone } from "@/lib/customer-identity";
import {
  isSmsConsentGranted,
  isSmsConsentRevoked,
  resolveStoredSmsConsent,
} from "@/lib/customer-messaging/consent";
import type { CustomerMessagePurpose } from "@/lib/customer-messaging/types";
import {
  DEFAULT_SETTINGS_PREFERENCES,
  type SettingsPreferenceFlags,
} from "@/lib/settings";

export type SmsEligibilityBlockReason =
  | "missing_phone"
  | "unknown_consent"
  | "revoked_consent"
  | "preference_disabled";

export type SmsEligibility =
  | {
      ok: true;
      normalizedPhone: string;
      last4: string;
      fingerprint: string;
    }
  | {
      ok: false;
      reason: SmsEligibilityBlockReason;
      normalizedPhone: string | null;
      last4: string | null;
      fingerprint: string | null;
    };

const PURPOSE_PREFERENCE: Record<
  CustomerMessagePurpose,
  keyof Pick<
    SettingsPreferenceFlags,
    | "estimateCommunicationEnabled"
    | "scheduleNotificationEnabled"
    | "invoiceCommunicationEnabled"
    | "reviewRequestPreferenceEnabled"
    | "marketingCommunicationEnabled"
  >
> = {
  ESTIMATE_READY: "estimateCommunicationEnabled",
  ESTIMATE_FOLLOW_UP: "estimateCommunicationEnabled",
  APPOINTMENT_CONFIRMATION: "scheduleNotificationEnabled",
  APPOINTMENT_REMINDER: "scheduleNotificationEnabled",
  SCHEDULE_CHANGE: "scheduleNotificationEnabled",
  JOB_UPDATE: "scheduleNotificationEnabled",
  INVOICE_READY: "invoiceCommunicationEnabled",
  PAYMENT_REMINDER: "invoiceCommunicationEnabled",
  REVIEW_REQUEST: "reviewRequestPreferenceEnabled",
  REVIEW_REMINDER: "reviewRequestPreferenceEnabled",
  REFERRAL_REQUEST: "marketingCommunicationEnabled",
  JOB_FOLLOW_UP: "marketingCommunicationEnabled",
  REPEAT_FOLLOW_UP: "marketingCommunicationEnabled",
  GENERAL: "estimateCommunicationEnabled",
  OWNER_FOLLOW_UP: "estimateCommunicationEnabled",
  MISSED_CALL: "estimateCommunicationEnabled",
  MANUAL_PHONE: "estimateCommunicationEnabled",
  INBOUND_CALL: "estimateCommunicationEnabled",
};

export function destinationFingerprint(businessId: string, normalizedPhone: string) {
  return createHash("sha256").update(`sms:${businessId}:${normalizedPhone}`).digest("hex");
}

export function destinationLast4(normalizedPhone: string) {
  return normalizedPhone.slice(-4);
}

export function communicationPreferenceEnabled(
  purpose: CustomerMessagePurpose,
  flags: Partial<SettingsPreferenceFlags> | null | undefined,
) {
  const key = PURPOSE_PREFERENCE[purpose];
  const value = flags?.[key];
  if (typeof value === "boolean") return value;
  return DEFAULT_SETTINGS_PREFERENCES[key];
}

export function evaluateSmsEligibility(input: {
  businessId: string;
  phone: string | null | undefined;
  smsConsentStatus: string | null | undefined;
  purpose: CustomerMessagePurpose;
  preferences: Partial<SettingsPreferenceFlags> | null | undefined;
}): SmsEligibility {
  const normalizedPhone = normalizePhone(input.phone);
  const usablePhone = isUsableNormalizedPhone(normalizedPhone);
  const last4 = usablePhone ? destinationLast4(normalizedPhone) : null;
  const fingerprint = usablePhone
    ? destinationFingerprint(input.businessId, normalizedPhone)
    : null;

  if (!usablePhone || !last4 || !fingerprint) {
    return { ok: false, reason: "missing_phone", normalizedPhone: null, last4: null, fingerprint: null };
  }

  const consent = resolveStoredSmsConsent(input.smsConsentStatus);
  if (isSmsConsentRevoked(consent)) {
    return {
      ok: false,
      reason: "revoked_consent",
      normalizedPhone,
      last4,
      fingerprint,
    };
  }
  if (!isSmsConsentGranted(consent)) {
    return {
      ok: false,
      reason: "unknown_consent",
      normalizedPhone,
      last4,
      fingerprint,
    };
  }

  if (!communicationPreferenceEnabled(input.purpose, input.preferences)) {
    return {
      ok: false,
      reason: "preference_disabled",
      normalizedPhone,
      last4,
      fingerprint,
    };
  }

  return { ok: true, normalizedPhone, last4, fingerprint };
}

export function smsBlockFailureReason(reason: SmsEligibilityBlockReason) {
  if (reason === "missing_phone") return "Customer has no usable phone number.";
  if (reason === "revoked_consent") return "Customer SMS consent is revoked.";
  if (reason === "unknown_consent") return "Customer SMS consent is not granted.";
  return "Customer communication preference is off for this message type.";
}
