/**
 * Client-safe copy and bounds for OWNER-reviewed bank CSV reconciliation.
 * Keep Node built-ins out of this file so upload forms can import it.
 */

export const BANK_RECONCILIATION_ROUTE = "/reconciliation";

export const MAX_BANK_CSV_BYTES = 256 * 1024;
export const MAX_BANK_CSV_ROWS = 500;
export const MAX_BANK_CSV_DESCRIPTION = 240;
export const BANK_MATCH_DATE_WINDOW_DAYS = 3;
export const BANK_REVERSAL_DATE_WINDOW_DAYS = 7;
export const MAX_BANK_MATCH_CANDIDATES = 3;

export const BANK_RECONCILIATION_SOURCE_KINDS = ["CSV_UPLOAD"] as const;
export type BankReconciliationSourceKind =
  (typeof BANK_RECONCILIATION_SOURCE_KINDS)[number];

export const BANK_RECONCILIATION_STATUSES = ["REVIEW"] as const;
export type BankReconciliationStatus = (typeof BANK_RECONCILIATION_STATUSES)[number];

export const BANK_ROW_DIRECTIONS = ["DEPOSIT", "WITHDRAWAL", "ZERO"] as const;
export type BankRowDirection = (typeof BANK_ROW_DIRECTIONS)[number];

export const BANK_ROW_REVIEW_STATUSES = [
  "UNMATCHED",
  "CANDIDATE",
  "DUPLICATE",
  "REVERSED",
  "INVALID",
  "ALREADY_SEEN",
  "ACCEPTED",
  "REJECTED",
  "IGNORED",
] as const;
export type BankRowReviewStatus = (typeof BANK_ROW_REVIEW_STATUSES)[number];

export const BANK_MATCH_KINDS = ["PAYMENT", "EXPENSE"] as const;
export type BankMatchKind = (typeof BANK_MATCH_KINDS)[number];

export const BANK_MATCH_STATUSES = ["SUGGESTED", "ACCEPTED", "REJECTED"] as const;
export type BankMatchStatus = (typeof BANK_MATCH_STATUSES)[number];

export const OWNER_ONLY_BANK_RECONCILIATION_MESSAGE =
  "Only the business owner can import a bank CSV for reconciliation review.";

export const BANK_IMPORT_NOT_AVAILABLE_MESSAGE = "That bank CSV workspace is not available.";

export const BANK_CSV_REQUIRED_MESSAGE =
  "Upload a CSV file you already have. TBBT does not connect to a bank or fetch owner-supplied source URLs.";

export const NOT_CSV_MESSAGE = "That file is not a CSV.";

export const EMPTY_BANK_CSV_MESSAGE = "CSV has no data rows.";

export const INVALID_BANK_CSV_MESSAGE = "That CSV could not be read.";

export const BANK_CSV_NUL_MESSAGE =
  "That CSV contains NUL bytes and cannot be imported.";

export const MISSING_BANK_COLUMNS_MESSAGE =
  "CSV must include a date column and an amount, debit, or credit column.";

export const FILE_TOO_LARGE_MESSAGE = `CSV must be ${MAX_BANK_CSV_BYTES / 1024} KB or smaller.`;

export const TOO_MANY_BANK_ROWS_MESSAGE = `CSV may include at most ${MAX_BANK_CSV_ROWS} data rows.`;

export const BANK_NOT_A_PAYMENT_MESSAGE =
  "Reviewing a bank row never creates a Payment and never changes an invoice.";

export const BANK_NOT_A_BALANCE_MESSAGE =
  "This workspace is not a verified bank balance. Banking is Not Connected.";

export const BANK_NO_LIVE_FEED_MESSAGE =
  "TBBT does not open a live bank feed. Upload a CSV exported from your bank.";

export const BANK_CREDITS_ARE_NOT_DEPOSITS_MESSAGE =
  "Invoice credits are internal write-downs, not bank deposits. They are never match candidates.";

export const BANK_MATCH_ALREADY_DECIDED_MESSAGE = "That match was already reviewed.";

export const BANK_MATCH_NOT_AVAILABLE_MESSAGE = "That suggested match is not available.";

export const BANK_CANDIDATE_ALREADY_ACCEPTED_MESSAGE =
  "That recorded transaction is already accepted on another bank row.";

export const BANK_ROW_NOT_REVIEWABLE_MESSAGE = "That bank row cannot be reviewed.";

export function bankRowStatusLabel(status: string): string {
  switch (status) {
    case "UNMATCHED":
      return "Unmatched";
    case "CANDIDATE":
      return "Candidate";
    case "DUPLICATE":
      return "Duplicate row";
    case "REVERSED":
      return "Reversed";
    case "INVALID":
      return "Invalid";
    case "ALREADY_SEEN":
      return "Already imported";
    case "ACCEPTED":
      return "Accepted";
    case "REJECTED":
      return "Rejected";
    case "IGNORED":
      return "Ignored";
    default:
      return status;
  }
}

export function bankDirectionLabel(direction: string): string {
  switch (direction) {
    case "DEPOSIT":
      return "Deposit";
    case "WITHDRAWAL":
      return "Withdrawal";
    case "ZERO":
      return "Zero";
    default:
      return direction;
  }
}

export function bankMatchKindLabel(kind: string): string {
  return kind === "EXPENSE" ? "Expense" : "Payment";
}

export function formatSignedCents(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = String(abs % 100).padStart(2, "0");
  const body = `${dollars.toLocaleString("en-US")}.${remainder}`;
  return negative ? `($${body})` : `$${body}`;
}
