/**
 * Same-business possible-duplicate review and explicit customer merge.
 *
 * Possible duplicates are listed only when a usable normalized email or
 * phone matches inside one business. Matching names never establish
 * identity and never appear as a match reason. Merge is OWNER-confirmed
 * and never crosses businesses.
 */
import {
  isUsableNormalizedEmail,
  isUsableNormalizedPhone,
  normalizeEmail,
  normalizePhone,
} from "@/lib/customer-identity";
import { resolveStoredSmsConsent } from "@/lib/customer-messaging/consent";
import type { SmsConsentStatus } from "@/lib/customer-messaging/types";

export const CUSTOMER_MERGE_ROUTE = "/customers/duplicates";

export const OWNER_ONLY_MERGE_MESSAGE =
  "Only the business owner can review possible duplicate customers and merge two confirmed records.";

export const NAME_IS_NOT_IDENTITY_MESSAGE =
  "Matching names do not prove these records are the same customer. Possible duplicates are listed only when the same-business email or phone matches.";

export const NO_SHARED_IDENTIFIER_MESSAGE =
  "These records do not share a recorded email or phone, so they cannot be merged. Matching names are not identity.";

export const CONFIRM_REQUIRED_MESSAGE =
  "Confirm that these two records are the same customer before merging.";

export const SAME_RECORD_MESSAGE = "Choose two different customer records to merge.";

export const CUSTOMERS_NOT_AVAILABLE_MESSAGE =
  "Those customer records are not available in this business.";

export const CROSS_BUSINESS_MERGE_MESSAGE =
  "Customers from different businesses cannot be merged.";

export const MERGE_ALREADY_ABSORBED_MESSAGE =
  "One of those customer records was already merged.";

export const MERGE_TRY_AGAIN_MESSAGE =
  "That merge could not finish because another change happened at the same time. Try again.";

export const MERGE_LEFTOVER_REFERENCES_MESSAGE =
  "Merge stopped because another record still pointed at the absorbed customer. Try again.";

export const ABSORBED_CONTACT_AUDIT_MESSAGE =
  "The absorbed record's name, email, and phone are kept only in the merge audit snapshot. They are not copied onto the record you keep unless that record is missing an email or phone.";

export const MERGE_CONFIRM_LABEL =
  "I confirm these two records are the same customer. Matching names alone are not enough.";

export const DUPLICATE_REVIEW_GROUP_TAKE = 25;
export const DUPLICATE_REVIEW_MAX_CUSTOMERS_PER_GROUP = 8;
export const CUSTOMER_DETAIL_DUPLICATE_TAKE = 12;

export const MERGE_MATCH_REASONS = ["email", "phone"] as const;
export type MergeMatchReason = (typeof MERGE_MATCH_REASONS)[number];

export class CustomerMergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomerMergeError";
  }
}

export type CustomerMergeIdentity = {
  id: string;
  businessId: string;
  name: string;
  email: string | null;
  phone: string | null;
  smsConsentStatus: string;
  smsConsentUpdatedAt: Date | null;
  firstLeadSource: string | null;
  firstCampaignId: string | null;
  createdAt: Date;
};

export type CustomerMergeCounts = {
  jobs: number;
  estimates: number;
  invoices: number;
  properties: number;
  communications: number;
};

export type PossibleDuplicatePair = {
  left: CustomerMergeIdentity;
  right: CustomerMergeIdentity;
  reasons: MergeMatchReason[];
  sharedEmail: string | null;
  sharedPhone: string | null;
};

export function pairHref(leftId: string, rightId: string) {
  const [first, second] = [leftId, rightId].sort();
  return `${CUSTOMER_MERGE_ROUTE}/${first}/${second}`;
}

export function sharedNormalizedEmail(
  left: Pick<CustomerMergeIdentity, "email">,
  right: Pick<CustomerMergeIdentity, "email">,
): string | null {
  const a = normalizeEmail(left.email);
  const b = normalizeEmail(right.email);
  if (!isUsableNormalizedEmail(a) || a !== b) return null;
  return a;
}

export function sharedNormalizedPhone(
  left: Pick<CustomerMergeIdentity, "phone">,
  right: Pick<CustomerMergeIdentity, "phone">,
): string | null {
  const a = normalizePhone(left.phone);
  const b = normalizePhone(right.phone);
  if (!isUsableNormalizedPhone(a) || a !== b) return null;
  return a;
}

export function pairMatchReasons(
  left: Pick<CustomerMergeIdentity, "email" | "phone">,
  right: Pick<CustomerMergeIdentity, "email" | "phone">,
): MergeMatchReason[] {
  const reasons: MergeMatchReason[] = [];
  if (sharedNormalizedEmail(left, right)) reasons.push("email");
  if (sharedNormalizedPhone(left, right)) reasons.push("phone");
  return reasons;
}

/**
 * REVOKED is strictest (never text). UNKNOWN is stricter than GRANTED.
 * A stored phone number is not consent.
 */
export function mergeSmsConsentStates(
  left: string | null | undefined,
  right: string | null | undefined,
): SmsConsentStatus {
  const a = resolveStoredSmsConsent(left);
  const b = resolveStoredSmsConsent(right);
  if (a === "REVOKED" || b === "REVOKED") return "REVOKED";
  if (a === "UNKNOWN" || b === "UNKNOWN") return "UNKNOWN";
  return "GRANTED";
}

export function encodeMatchReasons(reasons: MergeMatchReason[]) {
  return reasons.join(",");
}

export function findPossibleDuplicatePairs(
  customers: CustomerMergeIdentity[],
  options: { maxCustomersPerGroup?: number } = {},
): PossibleDuplicatePair[] {
  const maxPerGroup = options.maxCustomersPerGroup ?? DUPLICATE_REVIEW_MAX_CUSTOMERS_PER_GROUP;
  const byId = new Map(customers.map((row) => [row.id, row]));
  const emailGroups = new Map<string, string[]>();
  const phoneGroups = new Map<string, string[]>();

  for (const row of customers) {
    const email = normalizeEmail(row.email);
    if (isUsableNormalizedEmail(email)) {
      const group = emailGroups.get(email) ?? [];
      group.push(row.id);
      emailGroups.set(email, group);
    }
    const phone = normalizePhone(row.phone);
    if (isUsableNormalizedPhone(phone)) {
      const group = phoneGroups.get(phone) ?? [];
      group.push(row.id);
      phoneGroups.set(phone, group);
    }
  }

  const pairs = new Map<string, PossibleDuplicatePair>();

  function addGroup(group: string[], reason: MergeMatchReason, shared: string) {
    const unique = [...new Set(group)];
    if (unique.length < 2) return;
    unique.sort();
    const capped = unique.slice(0, Math.max(2, maxPerGroup));
    for (let i = 0; i < capped.length; i += 1) {
      for (let j = i + 1; j < capped.length; j += 1) {
        const left = byId.get(capped[i]);
        const right = byId.get(capped[j]);
        if (!left || !right || left.businessId !== right.businessId) continue;
        const key = `${left.id}:${right.id}`;
        const existing = pairs.get(key);
        if (existing) {
          if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
          if (reason === "email") existing.sharedEmail = shared;
          if (reason === "phone") existing.sharedPhone = shared;
          continue;
        }
        pairs.set(key, {
          left,
          right,
          reasons: [reason],
          sharedEmail: reason === "email" ? shared : sharedNormalizedEmail(left, right),
          sharedPhone: reason === "phone" ? shared : sharedNormalizedPhone(left, right),
        });
      }
    }
  }

  for (const [email, group] of emailGroups) addGroup(group, "email", email);
  for (const [phone, group] of phoneGroups) addGroup(group, "phone", phone);

  return [...pairs.values()].sort((a, b) => {
    const name = a.left.name.localeCompare(b.left.name) || a.right.name.localeCompare(b.right.name);
    if (name !== 0) return name;
    return a.left.id.localeCompare(b.left.id);
  });
}

export function survivorContactFields(
  survivor: CustomerMergeIdentity,
  absorbed: CustomerMergeIdentity,
) {
  return {
    email: survivor.email?.trim() || absorbed.email,
    phone: survivor.phone?.trim() || absorbed.phone,
    firstLeadSource: survivor.firstLeadSource || absorbed.firstLeadSource,
    firstCampaignId: survivor.firstCampaignId || absorbed.firstCampaignId,
  };
}

export function absorbedCustomerSnapshot(customer: CustomerMergeIdentity) {
  return {
    id: customer.id,
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
    smsConsentStatus: resolveStoredSmsConsent(customer.smsConsentStatus),
    smsConsentUpdatedAt: customer.smsConsentUpdatedAt?.toISOString() ?? null,
    firstLeadSource: customer.firstLeadSource,
    firstCampaignId: customer.firstCampaignId,
    createdAt: customer.createdAt.toISOString(),
  };
}
