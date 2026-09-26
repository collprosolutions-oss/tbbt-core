/**
 * Business Protection domain helpers.
 *
 * TBBT stores owner-supplied licenses, insurance, and agreements, and
 * warns about recorded expiration dates. It is not a licensing authority
 * and does not guarantee legal compliance or enforceability.
 */
import { formatISODateInTimeZone } from "@/lib/business-timezone";

export const VAULT_CATEGORIES = [
  "COMPANY_LEGAL",
  "EIN_TAX",
  "INSURANCE",
  "LICENSE",
  "CERTIFICATION",
  "WARRANTY",
  "CONTRACT",
  "SUBCONTRACTOR_AGREEMENT",
  "CUSTOMER_AGREEMENT",
  "NDA",
  "REFERRAL_AGREEMENT",
  "PARTNERSHIP_AGREEMENT",
  "VENDOR_AGREEMENT",
  "OTHER",
] as const;
export type VaultCategory = (typeof VAULT_CATEGORIES)[number];

export const VAULT_CATEGORY_LABELS: Record<VaultCategory, string> = {
  COMPANY_LEGAL: "Company / legal",
  EIN_TAX: "EIN / tax",
  INSURANCE: "Insurance",
  LICENSE: "License",
  CERTIFICATION: "Certification",
  WARRANTY: "Warranty",
  CONTRACT: "Contract",
  SUBCONTRACTOR_AGREEMENT: "Subcontractor agreement",
  CUSTOMER_AGREEMENT: "Customer agreement",
  NDA: "NDA",
  REFERRAL_AGREEMENT: "Referral agreement",
  PARTNERSHIP_AGREEMENT: "Partnership agreement",
  VENDOR_AGREEMENT: "Vendor agreement",
  OTHER: "Other",
};

export const VAULT_RECORD_STATUSES = ["ACTIVE", "ARCHIVED"] as const;
export type VaultRecordStatus = (typeof VAULT_RECORD_STATUSES)[number];

export const EXPIRY_STATES = [
  "CURRENT",
  "EXPIRING_SOON",
  "EXPIRED",
  "MISSING_DATE",
  "NO_DATE_OPTIONAL",
] as const;
export type ExpiryState = (typeof EXPIRY_STATES)[number];

export const EXPIRY_STATE_LABELS: Record<ExpiryState, string> = {
  CURRENT: "Current",
  EXPIRING_SOON: "Renewal approaching",
  EXPIRED: "Expired",
  MISSING_DATE: "No expiration recorded",
  NO_DATE_OPTIONAL: "No expiration recorded",
};

/**
 * Operational renewal states derived from recorded Vault dates.
 * These are not persisted. Category never invents a date.
 */
export const VAULT_RENEWAL_STATES = [
  "NO_EXPIRATION_RECORDED",
  "CURRENT",
  "RENEWAL_APPROACHING",
  "EXPIRED",
] as const;
export type VaultRenewalState = (typeof VAULT_RENEWAL_STATES)[number];

export const VAULT_RENEWAL_STATE_LABELS: Record<VaultRenewalState, string> = {
  NO_EXPIRATION_RECORDED: "No expiration recorded",
  CURRENT: "Current",
  RENEWAL_APPROACHING: "Renewal approaching",
  EXPIRED: "Expired",
};

export const VAULT_RENEWAL_GROUP_ORDER = [
  "EXPIRED",
  "RENEWAL_APPROACHING",
  "CURRENT",
  "NO_EXPIRATION_RECORDED",
] as const;

/** Categories where an expiration/renewal date is expected. */
export const DATED_VAULT_CATEGORIES = new Set<VaultCategory>([
  "INSURANCE",
  "LICENSE",
  "CERTIFICATION",
  "WARRANTY",
  "CONTRACT",
  "SUBCONTRACTOR_AGREEMENT",
  "CUSTOMER_AGREEMENT",
  "NDA",
  "REFERRAL_AGREEMENT",
  "PARTNERSHIP_AGREEMENT",
  "VENDOR_AGREEMENT",
]);

export const EXPIRING_SOON_DAYS = 30;

export const VAULT_DOCUMENT_PURPOSE = "BUSINESS_VAULT";
export const VAULT_DOCUMENT_MAX_BYTES = 15 * 1024 * 1024;
export const VAULT_ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
] as const;

export const PROTECTION_AREAS = ["dashboard", "vault", "agreements"] as const;
export type ProtectionArea = (typeof PROTECTION_AREAS)[number];

export const PROTECTION_AREA_LABELS: Record<ProtectionArea, string> = {
  dashboard: "Protection",
  vault: "Business Vault",
  agreements: "Agreement Coach",
};

export const LEGAL_NOT_AUTHORITY_MESSAGE =
  "TBBT stores the records you add and can warn about dates you record. It is not a nationwide licensing or regulatory authority and does not verify government filings.";

export const LEGAL_NO_COMPLIANCE_GUARANTEE_MESSAGE =
  "This view is an organization checklist. TBBT does not guarantee legal, licensing, or insurance compliance.";

export const AGREEMENT_NOT_LEGAL_ADVICE_MESSAGE =
  "Agreement Coach is drafting and organization assistance. It is not a lawyer and does not replace attorney review.";

export const AGREEMENT_NOT_ENFORCEABLE_MESSAGE =
  "A generated or stored draft is not a representation that the agreement is legally sufficient, valid, or enforceable.";

export const AGREEMENT_ATTORNEY_RECOMMENDATION_MESSAGE =
  "Have an attorney licensed in the relevant jurisdiction review this agreement before you rely on it. TBBT does not provide legal advice.";

export const NO_STATE_CLAUSE_MESSAGE =
  "TBBT will not invent state-specific legal clauses. Add governing-law or local requirements only when you supply them.";

export const NO_FAKE_ESIGN_MESSAGE =
  "No e-sign provider is connected. TBBT will not invent a digital signature.";

export const OWNER_REVIEW_REQUIRES_OWNER_MESSAGE =
  "Only the business owner can record owner review. Admins can prepare and edit drafts, but cannot set owner review.";

export const AGREEMENT_NOT_READY_MESSAGE =
  "This agreement is not ready. Complete guided answers, a current draft, a matching risk review, and owner review first.";

export const AGREEMENT_NOT_READY_FOR_COMPLETION_MESSAGE =
  "Complete an agreement only from READY or SENT after readiness checks pass. An empty or early-state draft cannot be signed.";

export const EXTERNAL_SIGNATURE_NO_FILE_NOTE =
  "No signed document file was uploaded. The owner attested that this agreement was signed externally. No digital signature was invented.";

export const UPLOADED_SIGNED_DOCUMENT_NOTE =
  "This vault record holds the uploaded signed document file. No digital signature was invented.";

export const READY_WITHOUT_SENT_COMPLETION_NOTE =
  "READY-but-not-SENT completion is allowed for an externally signed or uploaded signed document. The owner may finalize a ready draft that was signed outside TBBT without first recording SENT.";

export const VAULT_PRIVATE_MESSAGE =
  "Vault files stay private. Adding a document here does not publish it to your website or any public page.";

export const PROTECTION_CHECKLIST = [
  {
    id: "insurance",
    label: "Insurance record on file",
    categories: ["INSURANCE"] as const,
  },
  {
    id: "license_cert",
    label: "License or certification on file",
    categories: ["LICENSE", "CERTIFICATION"] as const,
  },
  {
    id: "company_identity",
    label: "Company / legal or EIN / tax record",
    categories: ["COMPANY_LEGAL", "EIN_TAX"] as const,
  },
  {
    id: "agreements",
    label: "At least one contract or agreement record",
    categories: [
      "CONTRACT",
      "CUSTOMER_AGREEMENT",
      "SUBCONTRACTOR_AGREEMENT",
      "NDA",
      "REFERRAL_AGREEMENT",
      "PARTNERSHIP_AGREEMENT",
      "VENDOR_AGREEMENT",
    ] as const,
  },
] as const;

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isVaultCategory(value: string): value is VaultCategory {
  return (VAULT_CATEGORIES as readonly string[]).includes(value);
}

export function isVaultRecordStatus(value: string): value is VaultRecordStatus {
  return (VAULT_RECORD_STATUSES as readonly string[]).includes(value);
}

export function isExpiryState(value: string): value is ExpiryState {
  return (EXPIRY_STATES as readonly string[]).includes(value);
}

export function isProtectionArea(value: string): value is ProtectionArea {
  return (PROTECTION_AREAS as readonly string[]).includes(value);
}

export function parseProtectionArea(value?: string | null): ProtectionArea {
  return value && isProtectionArea(value) ? value : "dashboard";
}

export function isCalendarDate(value: string): boolean {
  const match = CALENDAR_DATE.exec(value.trim());
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function parseOptionalCalendarDate(value?: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  if (!isCalendarDate(trimmed)) {
    throw new Error("Use a valid YYYY-MM-DD date.");
  }
  return trimmed;
}

export function utcCalendarDate(now: Date): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function businessCalendarDate(now: Date, timeZone: string): string {
  return formatISODateInTimeZone(now, timeZone);
}

export function utcMidnightFromCalendarDate(value: string): Date {
  const match = CALENDAR_DATE.exec(value.trim());
  if (!match) {
    throw new Error("Use a valid YYYY-MM-DD date.");
  }
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

export function daysUntilCalendarDate(expiresOn: string, now: Date, timeZone?: string): number {
  const exp = utcMidnightFromCalendarDate(expiresOn);
  const today = utcMidnightFromCalendarDate(
    timeZone ? businessCalendarDate(now, timeZone) : utcCalendarDate(now),
  );
  return Math.round((exp.getTime() - today.getTime()) / 86_400_000);
}

export function parseOptionalRenewalLeadDays(value?: string | number | null): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 365) {
    throw new Error("Enter a renewal lead time of 0 to 365 days.");
  }
  return parsed;
}

export function resolveRenewalLeadDays(value?: number | null): number {
  return value == null ? EXPIRING_SOON_DAYS : value;
}

export function isVaultRenewalState(value: string): value is VaultRenewalState {
  return (VAULT_RENEWAL_STATES as readonly string[]).includes(value);
}

/**
 * Pure operational renewal state. Uses recorded expiration + lead time
 * and the business timezone calendar day. Never infers a date from
 * category or AI. `now` is an instant; "today" is that instant in
 * `timeZone`.
 */
export function deriveVaultRenewalState(input: {
  expiresOn?: string | null;
  renewalLeadDays?: number | null;
  now: Date;
  timeZone: string;
}): VaultRenewalState {
  const expiresOn = input.expiresOn?.trim() || "";
  if (!expiresOn) return "NO_EXPIRATION_RECORDED";
  const days = daysUntilCalendarDate(expiresOn, input.now, input.timeZone);
  if (days < 0) return "EXPIRED";
  if (days <= resolveRenewalLeadDays(input.renewalLeadDays)) return "RENEWAL_APPROACHING";
  return "CURRENT";
}

export function vaultRenewalStateFromExpiry(state: ExpiryState): VaultRenewalState {
  if (state === "EXPIRED") return "EXPIRED";
  if (state === "EXPIRING_SOON") return "RENEWAL_APPROACHING";
  if (state === "CURRENT") return "CURRENT";
  return "NO_EXPIRATION_RECORDED";
}

export function expiryStateFromVaultRenewal(
  renewal: VaultRenewalState,
  category: VaultCategory,
): ExpiryState {
  if (renewal === "EXPIRED") return "EXPIRED";
  if (renewal === "RENEWAL_APPROACHING") return "EXPIRING_SOON";
  if (renewal === "CURRENT") return "CURRENT";
  return categoryNeedsExpiration(category) ? "MISSING_DATE" : "NO_DATE_OPTIONAL";
}

export function categoryNeedsExpiration(category: VaultCategory): boolean {
  return DATED_VAULT_CATEGORIES.has(category);
}

export function classifyExpiry(input: {
  category: VaultCategory;
  expiresOn?: string | null;
  now: Date;
  timeZone?: string;
  renewalLeadDays?: number | null;
}): ExpiryState {
  if (input.timeZone) {
    return expiryStateFromVaultRenewal(
      deriveVaultRenewalState({
        expiresOn: input.expiresOn,
        renewalLeadDays: input.renewalLeadDays,
        now: input.now,
        timeZone: input.timeZone,
      }),
      input.category,
    );
  }
  const expiresOn = input.expiresOn?.trim() || "";
  if (!expiresOn) {
    return categoryNeedsExpiration(input.category) ? "MISSING_DATE" : "NO_DATE_OPTIONAL";
  }
  const days = daysUntilCalendarDate(expiresOn, input.now);
  if (days < 0) return "EXPIRED";
  if (days <= resolveRenewalLeadDays(input.renewalLeadDays)) return "EXPIRING_SOON";
  return "CURRENT";
}

export function needsRenewalAttention(state: ExpiryState): boolean {
  return state === "EXPIRED" || state === "EXPIRING_SOON" || state === "MISSING_DATE";
}

export function isVaultMimeAllowed(mimeType: string): boolean {
  return (VAULT_ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType);
}
