/**
 * Receipt field extraction contract. Vendor, date, amount, and tax are
 * reviewable suggestions only. The canonical AI provider produces them;
 * they never become recorded expenses or report totals until OWNER
 * confirmation.
 */
import { Prisma } from "@prisma/client";
import { sanitizeAiText } from "@/lib/ai/sanitize";
import { parseExpenseDate, type ExpenseReviewStatus } from "@/lib/expenses";

export const EXPENSE_RECEIPT_EXTRACT_UNAVAILABLE_MESSAGE = "Unavailable";

export const EXPENSE_RECEIPT_EXTRACT_REVIEW_MESSAGE =
  "Receipt draft ready for owner review. It is not recorded and is not in reports.";

export const EXPENSE_RECEIPT_EXTRACT_OWNER_ONLY_MESSAGE =
  "Only the owner can extract a receipt into an expense draft.";

export const EXPENSE_RECEIPT_EXTRACT_EXISTING_MESSAGE =
  "That receipt is already on a recorded expense. TBBT did not overwrite it.";

export const EXPENSE_RECEIPT_EXTRACT_LOW_CONFIDENCE_MESSAGE =
  "The provider was not confident enough to create an expense draft. Recorded expenses were not changed.";

export const EXPENSE_RECEIPT_EXTRACT_CENTS_MESSAGE =
  "The provider amount or tax was not valid cents. Recorded expenses were not changed.";

export const EXPENSE_RECEIPT_EXTRACT_CONFIRM_MESSAGE =
  "Receipt draft confirmed. It is now a recorded expense and can appear in reports.";

export const EXPENSE_RECEIPT_EXTRACT_MIN_CONFIDENCE = 0.7;
export const EXPENSE_RECEIPT_EXTRACT_MAX_INPUT_CHARS = 4_000;
export const EXPENSE_RECEIPT_EXTRACT_MAX_OUTPUT_TOKENS = 400;
export const EXPENSE_RECEIPT_EXTRACT_MAX_VENDOR_CHARS = 80;

const HOSTILE_VENDOR_PATTERN =
  /ignore (all |previous |prior )?instructions|system prompt|you are now|api[_-]?key|overwrite (the )?(expense|report)/i;

export type ExpenseReceiptExtractStatus =
  | "UNAVAILABLE"
  | "PENDING"
  | "COMPLETED"
  | "FAILED"
  | "VALIDATION_FAILED"
  | "LOW_CONFIDENCE";

export type ExpenseReceiptExtractFields = {
  vendor: string | null;
  occurredOn: string | null;
  amountCents: number | null;
  taxCents: number | null;
  taxInvalid: boolean;
  confidence: number | null;
};

export type ExpenseReceiptExtractResult = {
  status: ExpenseReceiptExtractStatus;
  message: string;
  fields: ExpenseReceiptExtractFields;
  expenseId?: string;
  reviewStatus?: ExpenseReviewStatus | string;
  interactionId?: string;
  applied: false | true;
  confirmable: boolean;
  enteredReports: false;
  lowConfidence: boolean;
};

export function emptyReceiptExtractFields(): ExpenseReceiptExtractFields {
  return {
    vendor: null,
    occurredOn: null,
    amountCents: null,
    taxCents: null,
    taxInvalid: false,
    confidence: null,
  };
}

export function receiptExtractTaxNote(taxCents: number | null) {
  if (taxCents == null || taxCents < 0) return null;
  return `Receipt tax: $${centsToMoneyString(taxCents)}`;
}

export function centsToMoneyString(cents: number) {
  return (cents / 100).toFixed(2);
}

export function parseMoneyToCents(raw: unknown): number | null {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0) return null;
    const cents = Math.round(raw * 100);
    if (Math.abs(raw * 100 - cents) > 1e-6) return null;
    return cents;
  }
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[$,\s]/g, "").trim();
  if (!cleaned) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  try {
    const value = new Prisma.Decimal(cleaned);
    if (value.isNaN() || value.lt(0)) return null;
    return Number(value.toDecimalPlaces(2).mul(100).toFixed(0));
  } catch {
    return null;
  }
}

export function parseIntegerCents(raw: unknown): number | null {
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw < 0) return null;
    return raw;
  }
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function parseExtractConfidence(raw: unknown): number | null {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0 || raw > 1) return null;
    return raw;
  }
  if (typeof raw !== "string") return null;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

export function sanitizeReceiptExtractText(value: string) {
  return sanitizeAiText(value, EXPENSE_RECEIPT_EXTRACT_MAX_INPUT_CHARS);
}

export function sanitizeExtractedVendor(raw: unknown) {
  if (typeof raw !== "string") return null;
  const vendor = sanitizeAiText(raw, EXPENSE_RECEIPT_EXTRACT_MAX_VENDOR_CHARS).replace(/\s+/g, " ").trim();
  if (!vendor || HOSTILE_VENDOR_PATTERN.test(vendor)) return null;
  return vendor;
}

export function parseExtractedOccurredOn(raw: unknown, timeZone?: string) {
  if (typeof raw !== "string") return null;
  const date = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return parseExpenseDate(date, timeZone) ? date : null;
}

export function parseReceiptExtractFields(
  raw: unknown,
  timeZone?: string,
): ExpenseReceiptExtractFields {
  const source =
    typeof raw === "string"
      ? safeJsonObject(raw)
      : raw && typeof raw === "object"
        ? (raw as Record<string, unknown>)
        : null;
  if (!source) return emptyReceiptExtractFields();

  const amountCents =
    parseIntegerCents(source.amountCents) ?? parseMoneyToCents(source.amount);
  const taxPresent = Object.prototype.hasOwnProperty.call(source, "taxCents")
    || Object.prototype.hasOwnProperty.call(source, "tax");
  const taxCents = taxPresent
    ? (parseIntegerCents(source.taxCents) ?? parseMoneyToCents(source.tax))
    : null;

  return {
    vendor: sanitizeExtractedVendor(source.vendor),
    occurredOn: parseExtractedOccurredOn(source.date ?? source.occurredOn, timeZone),
    amountCents,
    taxCents,
    taxInvalid: taxPresent && taxCents == null,
    confidence: parseExtractedConfidence(source.confidence),
  };
}

function parseExtractedConfidence(raw: unknown) {
  return parseExtractConfidence(raw);
}

export function receiptExtractFieldsFromAiNotes(notes: string | undefined, timeZone?: string) {
  return parseReceiptExtractFields(notes, timeZone);
}

export function receiptExtractHasValidAmount(fields: ExpenseReceiptExtractFields) {
  return fields.amountCents != null && fields.amountCents > 0;
}

export function receiptExtractHasValidTax(fields: ExpenseReceiptExtractFields) {
  if (fields.taxInvalid) return false;
  if (fields.taxCents == null) return true;
  return Number.isInteger(fields.taxCents) && fields.taxCents >= 0;
}

export function receiptExtractIsLowConfidence(fields: ExpenseReceiptExtractFields) {
  return fields.confidence == null || fields.confidence < EXPENSE_RECEIPT_EXTRACT_MIN_CONFIDENCE;
}

export function receiptExtractCanPersistDraft(fields: ExpenseReceiptExtractFields) {
  return (
    receiptExtractHasValidAmount(fields) &&
    receiptExtractHasValidTax(fields) &&
    Boolean(fields.occurredOn) &&
    !receiptExtractIsLowConfidence(fields)
  );
}

export function amountDecimalFromCents(cents: number) {
  return new Prisma.Decimal(centsToMoneyString(cents));
}

function safeJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
