import { createHash } from "node:crypto";
import { isUsableEmail } from "@/lib/mail";
import {
  evaluateSmsEligibility,
  smsBlockFailureReason,
  type SmsEligibility,
} from "@/lib/customer-messaging/eligibility";
import { resolveStoredSmsConsent } from "@/lib/customer-messaging/consent";
import type { CustomerMessagePurpose } from "@/lib/customer-messaging/types";
import type { SettingsPreferenceFlags } from "@/lib/settings";
import {
  EMAIL_NOT_CONFIGURED_REASON,
  SMS_ADDON_NOT_ENTITLED_REASON,
  SMS_NOT_CONFIGURED_REASON,
  type CommunicationChannel,
} from "@/lib/communications/types";
import { isEmailDeliveryConfigured } from "@/lib/settings";
import { isCustomerMessagingConfigured } from "@/lib/customer-messaging/config";

export type ChannelUnavailableReason =
  | "missing_email"
  | "missing_phone"
  | "unknown_consent"
  | "revoked_consent"
  | "preference_disabled"
  | "email_not_configured"
  | "sms_not_configured"
  | "sms_entitlement_missing"
  | "channel_not_sendable"
  | "voice_not_connected";

export type ChannelEligibility = {
  channel: CommunicationChannel;
  permitted: boolean;
  available: boolean;
  reason: ChannelUnavailableReason | null;
  ownerReason: string | null;
  last4: string | null;
  fingerprint: string | null;
};

export function emailDestinationFingerprint(businessId: string, email: string) {
  return createHash("sha256")
    .update(`email:${businessId}:${email.trim().toLowerCase()}`)
    .digest("hex");
}

export function emailDestinationLast4(email: string) {
  const local = email.trim().split("@")[0] ?? "";
  return local.slice(-4) || email.trim().slice(-4);
}

export function evaluateEmailEligibility(input: {
  businessId: string;
  email: string | null | undefined;
  deliveryConfigured?: boolean;
}): ChannelEligibility {
  const configured = input.deliveryConfigured ?? isEmailDeliveryConfigured();
  if (!isUsableEmail(input.email)) {
    return {
      channel: "EMAIL",
      permitted: false,
      available: false,
      reason: "missing_email",
      ownerReason: "Customer has no usable email address.",
      last4: null,
      fingerprint: null,
    };
  }
  const email = input.email!.trim();
  if (!configured) {
    return {
      channel: "EMAIL",
      permitted: true,
      available: false,
      reason: "email_not_configured",
      ownerReason: EMAIL_NOT_CONFIGURED_REASON,
      last4: emailDestinationLast4(email),
      fingerprint: emailDestinationFingerprint(input.businessId, email),
    };
  }
  return {
    channel: "EMAIL",
    permitted: true,
    available: true,
    reason: null,
    ownerReason: null,
    last4: emailDestinationLast4(email),
    fingerprint: emailDestinationFingerprint(input.businessId, email),
  };
}

function smsEligibilityToChannel(eligibility: SmsEligibility): Omit<
  ChannelEligibility,
  "channel"
> {
  if (eligibility.ok) {
    return {
      permitted: true,
      available: true,
      reason: null,
      ownerReason: null,
      last4: eligibility.last4,
      fingerprint: eligibility.fingerprint,
    };
  }
  return {
    permitted: false,
    available: false,
    reason: eligibility.reason,
    ownerReason: smsBlockFailureReason(eligibility.reason),
    last4: eligibility.last4,
    fingerprint: eligibility.fingerprint,
  };
}

export function evaluateComposeChannelEligibility(input: {
  businessId: string;
  channel: CommunicationChannel;
  email: string | null | undefined;
  phone: string | null | undefined;
  smsConsentStatus: string | null | undefined;
  purpose: CustomerMessagePurpose;
  preferences: Partial<SettingsPreferenceFlags> | null | undefined;
  smsEntitled: boolean;
  smsConfigured?: boolean;
  emailConfigured?: boolean;
}): ChannelEligibility {
  if (input.channel === "EMAIL") {
    return evaluateEmailEligibility({
      businessId: input.businessId,
      email: input.email,
      deliveryConfigured: input.emailConfigured,
    });
  }

  if (input.channel === "SMS") {
    const sms = smsEligibilityToChannel(
      evaluateSmsEligibility({
        businessId: input.businessId,
        phone: input.phone,
        smsConsentStatus: input.smsConsentStatus,
        purpose: input.purpose,
        preferences: input.preferences,
      }),
    );
    if (!sms.permitted) {
      return { channel: "SMS", ...sms };
    }
    if (!input.smsEntitled) {
      return {
        channel: "SMS",
        permitted: false,
        available: false,
        reason: "sms_entitlement_missing",
        ownerReason: SMS_ADDON_NOT_ENTITLED_REASON,
        last4: sms.last4,
        fingerprint: sms.fingerprint,
      };
    }
    const configured = input.smsConfigured ?? isCustomerMessagingConfigured();
    if (!configured) {
      return {
        channel: "SMS",
        permitted: true,
        available: false,
        reason: "sms_not_configured",
        ownerReason: SMS_NOT_CONFIGURED_REASON,
        last4: sms.last4,
        fingerprint: sms.fingerprint,
      };
    }
    return { channel: "SMS", ...sms };
  }

  if (input.channel === "PHONE") {
    return {
      channel: "PHONE",
      permitted: true,
      available: false,
      reason: "voice_not_connected",
      ownerReason:
        "Voice is not connected. Log a missed or manual call instead of sending.",
      last4: null,
      fingerprint: null,
    };
  }

  if (input.channel === "MANUAL" || input.channel === "PORTAL" || input.channel === "SYSTEM") {
    return {
      channel: input.channel,
      permitted: true,
      available: true,
      reason: null,
      ownerReason: null,
      last4: null,
      fingerprint: null,
    };
  }

  return {
    channel: input.channel,
    permitted: false,
    available: false,
    reason: "channel_not_sendable",
    ownerReason: "This channel cannot be sent from Communications.",
    last4: null,
    fingerprint: null,
  };
}

export function consentContextSnapshot(input: {
  smsConsentStatus: string | null | undefined;
  emailAvailable: boolean;
  channel: CommunicationChannel;
  extra?: string | null;
}) {
  const sms = resolveStoredSmsConsent(input.smsConsentStatus);
  const parts = [
    `sms:${sms}`,
    `email:${input.emailAvailable ? "AVAILABLE" : "UNAVAILABLE"}`,
    `channel:${input.channel}`,
  ];
  if (input.extra) parts.push(input.extra);
  return parts.join(";");
}
