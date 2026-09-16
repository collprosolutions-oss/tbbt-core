/**
 * Deterministic public-intake customer matching.
 *
 * Repeat customers may be identified only by an exact normalized email
 * or an exact normalized phone. Name and address never establish identity.
 * Conflicting identifiers are never merged or guessed.
 */

export const IDENTITY_REVIEW_MARKER = "\n\nTBBT Identity Review:\n";

export const IDENTITY_REVIEW_REASONS = [
  "email_phone_conflict",
  "duplicate_email",
  "duplicate_phone",
] as const;

export type IdentityReviewReason = (typeof IDENTITY_REVIEW_REASONS)[number];

export type IntakeIdentityReview = {
  reason: IdentityReviewReason;
  emailCustomerIds: string[];
  phoneCustomerIds: string[];
};

export type CustomerIdentityRecord = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
};

export type CustomerMatchDecision =
  | { kind: "new" }
  | { kind: "reuse"; customer: CustomerIdentityRecord }
  | {
      kind: "ambiguous";
      review: IntakeIdentityReview;
    };

const IDENTITY_REVIEW_LABELS: Record<IdentityReviewReason, string> = {
  email_phone_conflict:
    "Submitted email and phone match different existing customers. This request was filed for owner review and was not merged.",
  duplicate_email:
    "More than one existing customer has this email. This request was filed for owner review and was not merged.",
  duplicate_phone:
    "More than one existing customer has this phone number. This request was filed for owner review and was not merged.",
};

export function normalizeEmail(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * Keep only digits. A leading US country code `1` on an 11-digit value is
 * dropped so `(239) 357-8199` and `+1 239-357-8199` compare equal.
 */
export function normalizePhone(value: string | null | undefined): string {
  const digits = (value ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return digits.slice(1);
  }
  return digits;
}

export function isUsableNormalizedEmail(value: string): boolean {
  return value.length > 0 && value.includes("@");
}

export function isUsableNormalizedPhone(value: string): boolean {
  return value.length >= 7;
}

function uniqueById(rows: CustomerIdentityRecord[]) {
  const seen = new Set<string>();
  const unique: CustomerIdentityRecord[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    unique.push(row);
  }
  return unique;
}

export function customersMatchingEmail(
  customers: CustomerIdentityRecord[],
  email: string,
): CustomerIdentityRecord[] {
  const normalized = normalizeEmail(email);
  if (!isUsableNormalizedEmail(normalized)) return [];
  return uniqueById(
    customers.filter((row) => normalizeEmail(row.email) === normalized),
  );
}

export function customersMatchingPhone(
  customers: CustomerIdentityRecord[],
  phone: string,
): CustomerIdentityRecord[] {
  const normalized = normalizePhone(phone);
  if (!isUsableNormalizedPhone(normalized)) return [];
  return uniqueById(
    customers.filter((row) => normalizePhone(row.phone) === normalized),
  );
}

export function decideCustomerMatch(
  customers: CustomerIdentityRecord[],
  submitted: { email: string; phone: string },
): CustomerMatchDecision {
  const emailMatches = customersMatchingEmail(customers, submitted.email);
  const phoneMatches = customersMatchingPhone(customers, submitted.phone);

  if (emailMatches.length > 1) {
    return {
      kind: "ambiguous",
      review: {
        reason: "duplicate_email",
        emailCustomerIds: emailMatches.map((row) => row.id),
        phoneCustomerIds: phoneMatches.map((row) => row.id),
      },
    };
  }

  if (phoneMatches.length > 1) {
    return {
      kind: "ambiguous",
      review: {
        reason: "duplicate_phone",
        emailCustomerIds: emailMatches.map((row) => row.id),
        phoneCustomerIds: phoneMatches.map((row) => row.id),
      },
    };
  }

  if (
    emailMatches.length === 1 &&
    phoneMatches.length === 1 &&
    emailMatches[0].id !== phoneMatches[0].id
  ) {
    return {
      kind: "ambiguous",
      review: {
        reason: "email_phone_conflict",
        emailCustomerIds: [emailMatches[0].id],
        phoneCustomerIds: [phoneMatches[0].id],
      },
    };
  }

  if (emailMatches.length === 1) {
    return { kind: "reuse", customer: emailMatches[0] };
  }

  if (phoneMatches.length === 1) {
    return { kind: "reuse", customer: phoneMatches[0] };
  }

  return { kind: "new" };
}

export function identityReviewOwnerMessage(reason: IdentityReviewReason): string {
  return IDENTITY_REVIEW_LABELS[reason];
}

export function appendIntakeIdentityReview(
  description: string | null,
  review: IntakeIdentityReview,
): string {
  const payload = JSON.stringify({
    reason: review.reason,
    emailCustomerIds: review.emailCustomerIds,
    phoneCustomerIds: review.phoneCustomerIds,
  });
  return `${description ?? ""}${IDENTITY_REVIEW_MARKER}${payload}`;
}

export function parseIntakeIdentityReview(
  description?: string | null,
): IntakeIdentityReview | null {
  const raw = description ?? "";
  const index = raw.indexOf(IDENTITY_REVIEW_MARKER);
  if (index === -1) return null;
  const encoded = raw.slice(index + IDENTITY_REVIEW_MARKER.length);
  const end = encoded.search(/\n\nTBBT /);
  const block = (end === -1 ? encoded : encoded.slice(0, end)).trim();
  try {
    const parsed = JSON.parse(block) as {
      reason?: unknown;
      emailCustomerIds?: unknown;
      phoneCustomerIds?: unknown;
    };
    if (
      !IDENTITY_REVIEW_REASONS.includes(parsed.reason as IdentityReviewReason)
    ) {
      return null;
    }
    return {
      reason: parsed.reason as IdentityReviewReason,
      emailCustomerIds: Array.isArray(parsed.emailCustomerIds)
        ? parsed.emailCustomerIds.filter((id): id is string => typeof id === "string")
        : [],
      phoneCustomerIds: Array.isArray(parsed.phoneCustomerIds)
        ? parsed.phoneCustomerIds.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {
    return null;
  }
}
