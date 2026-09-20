import { isUsableNormalizedPhone, normalizePhone } from "@/lib/customer-identity";

export const SMS_OPT_IN_FIELD = "smsOptIn";

export function isAffirmativeSmsOptIn(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  const trimmed = value.trim().toLowerCase();
  return trimmed === "true" || trimmed === "on" || trimmed === "1" || trimmed === "yes";
}

export function smsConsentFromPublicOptIn(input: {
  smsOptIn: unknown;
  phone: string | null | undefined;
}): { smsConsentStatus: "GRANTED"; smsConsentUpdatedAt: Date } | null {
  if (!isAffirmativeSmsOptIn(input.smsOptIn)) return null;
  if (!isUsableNormalizedPhone(normalizePhone(input.phone))) return null;
  return { smsConsentStatus: "GRANTED", smsConsentUpdatedAt: new Date() };
}

/**
 * Changing a customer's phone is not consent. The new number stays
 * UNKNOWN even if the previous number was GRANTED.
 */
export function smsConsentAfterOwnerPhoneEdit(
  previousPhone: string | null | undefined,
  nextPhone: string | null | undefined,
): { smsConsentStatus: "UNKNOWN"; smsConsentUpdatedAt: Date } | null {
  if (normalizePhone(previousPhone) === normalizePhone(nextPhone)) return null;
  return { smsConsentStatus: "UNKNOWN", smsConsentUpdatedAt: new Date() };
}
