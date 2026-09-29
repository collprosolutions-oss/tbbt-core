/**
 * Trade-neutral OWNER warranty statements and customer-reported callbacks.
 *
 * A callback attaches only to a completed job in the caller's business.
 * Warranty text is whatever the owner already recorded. Nothing here
 * invents coverage, a duration, a job, an invoice, or a customer message.
 */
import type { MembershipRole } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  ForbiddenError,
  canAccessManagementConsole,
  requireBusinessRole,
} from "@/lib/authorization";

export const WARRANTY_CALLBACK_STATUSES = [
  "REPORTED",
  "REVIEWED",
  "OUTCOME_RECORDED",
] as const;

export type WarrantyCallbackStatus = (typeof WARRANTY_CALLBACK_STATUSES)[number];

export const MAX_WARRANTY_TEXT_LENGTH = 2000;

export const NO_WARRANTY_TERMS_RECORDED_MESSAGE =
  "No warranty terms are recorded for this job.";

export const WARRANTY_TERMS_ONLY_RECORDED_MESSAGE =
  "Only warranty terms already recorded for this job are shown. This screen does not add coverage or a duration.";

export const WARRANTY_CALLBACK_OWNER_ONLY_MESSAGE =
  "Only the business owner can record or resolve a warranty callback.";

export const WARRANTY_CALLBACK_UNAUTHENTICATED_MESSAGE =
  "Sign in as the business owner to record a warranty callback.";

export const WARRANTY_CALLBACK_JOB_NOT_FOUND_MESSAGE =
  "That job is not in this business.";

export const WARRANTY_CALLBACK_NOT_COMPLETED_MESSAGE =
  "Warranty terms and callbacks can be recorded only for a completed job.";

export const WARRANTY_CALLBACK_NOT_FOUND_MESSAGE =
  "That callback is not in this business.";

export const WARRANTY_CALLBACK_REPORT_REQUIRED_MESSAGE =
  "Record what the customer reported before saving the callback.";

export const WARRANTY_STATEMENT_REQUIRED_MESSAGE =
  "Type the warranty terms that were actually agreed. This screen does not fill in coverage or a duration.";

export const WARRANTY_TEXT_TOO_LONG_MESSAGE = `Keep this to ${MAX_WARRANTY_TEXT_LENGTH} characters.`;

export const WARRANTY_CALLBACK_REVIEW_FIRST_MESSAGE =
  "Review the callback before recording an outcome.";

export const WARRANTY_CALLBACK_ALREADY_REVIEWED_MESSAGE =
  "This callback has already been reviewed.";

export const WARRANTY_CALLBACK_ALREADY_RESOLVED_MESSAGE =
  "This callback already has a recorded outcome.";

export const WARRANTY_CALLBACK_OUTCOME_REQUIRED_MESSAGE =
  "Type the outcome in your own words. Recording an outcome does not create a job, an invoice, or a message.";

export const WARRANTY_CALLBACK_NO_SIDE_EFFECTS_MESSAGE =
  "Recording or resolving a callback does not create a job, an invoice, or a message.";

export const WARRANTY_CALLBACK_UNAVAILABLE_MESSAGE =
  "Warranty and callback records are unavailable until the warranty migration is applied.";

export type RecordedWarrantyStatement = {
  id: string;
  statement: string;
  recordedAt: Date;
};

export type WarrantyTermsDisplay = {
  recorded: boolean;
  statements: RecordedWarrantyStatement[];
  emptyMessage: string | null;
};

const INVENTED_TERM_KEYS = [
  "coverageDays",
  "durationDays",
  "expiresOn",
  "warrantyDays",
  "warrantyMonths",
  "warrantyYears",
] as const;

export function canAccessWarrantyCallbacks(
  role: MembershipRole | null | undefined,
): boolean {
  return role === "OWNER" && canAccessManagementConsole("OWNER");
}

export function assertWarrantyCallbackActor(
  access: BusinessAccess | null | undefined,
): asserts access is BusinessAccess {
  if (!access?.businessId || !access.workspace?.role || !access.workspace.membership?.id) {
    throw new ForbiddenError(WARRANTY_CALLBACK_UNAUTHENTICATED_MESSAGE);
  }
  if (!canAccessWarrantyCallbacks(access.workspace.role)) {
    throw new ForbiddenError(WARRANTY_CALLBACK_OWNER_ONLY_MESSAGE);
  }
  requireBusinessRole(access, "OWNER");
}

export function normalizeWarrantyText(raw: string | null | undefined): string {
  return (raw ?? "").trim();
}

export function assertWarrantyTextLength(text: string): void {
  if (text.length > MAX_WARRANTY_TEXT_LENGTH) {
    throw new Error(WARRANTY_TEXT_TOO_LONG_MESSAGE);
  }
}

/**
 * Show only statements the owner already saved. An empty list stays empty.
 * The result has no coverage or duration fields to fill in.
 */
export function displayRecordedWarrantyTerms(
  terms: Array<{ id: string; statement: string; createdAt: Date }>,
): WarrantyTermsDisplay {
  const statements: RecordedWarrantyStatement[] = [];
  for (const term of terms) {
    const statement = normalizeWarrantyText(term.statement);
    if (!statement) continue;
    statements.push({
      id: term.id,
      statement,
      recordedAt: term.createdAt,
    });
  }
  if (statements.length === 0) {
    return {
      recorded: false,
      statements: [],
      emptyMessage: NO_WARRANTY_TERMS_RECORDED_MESSAGE,
    };
  }
  return {
    recorded: true,
    statements,
    emptyMessage: null,
  };
}

export function warrantyDisplayHasInventedDuration(display: WarrantyTermsDisplay): boolean {
  const record = display as WarrantyTermsDisplay & Record<string, unknown>;
  return INVENTED_TERM_KEYS.some((key) => key in record || record[key] != null);
}

export function isWarrantyCallbackStatus(value: string): value is WarrantyCallbackStatus {
  return (WARRANTY_CALLBACK_STATUSES as readonly string[]).includes(value);
}
