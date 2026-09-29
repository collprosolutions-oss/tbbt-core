/**
 * Client-safe copy and bounds for OWNER-reviewed existing-customer CSV import.
 * Keep Node built-ins out of this file so preview forms can import it.
 */

export const CUSTOMER_CSV_IMPORT_ROUTE = "/customers/import";

export const MAX_CUSTOMER_CSV_IMPORT_BYTES = 256 * 1024;
export const MAX_CUSTOMER_CSV_IMPORT_ROWS = 200;
export const MAX_CUSTOMER_CSV_IMPORT_FIELD = 200;
export const MAX_CUSTOMER_CSV_IMPORT_LABEL = 80;

export const CUSTOMER_CSV_IMPORT_SOURCE_KINDS = ["CSV_UPLOAD"] as const;
export type CustomerCsvImportSourceKind =
  (typeof CUSTOMER_CSV_IMPORT_SOURCE_KINDS)[number];

export const CUSTOMER_CSV_IMPORT_STATUSES = ["PREVIEW", "CONFIRMING", "CONFIRMED"] as const;
export type CustomerCsvImportStatus = (typeof CUSTOMER_CSV_IMPORT_STATUSES)[number];

export const CUSTOMER_CSV_IMPORT_ROW_STATUSES = [
  "VALID",
  "INVALID",
  "POSSIBLE_DUPLICATE",
  "REJECTED",
] as const;
export type CustomerCsvImportRowStatus =
  (typeof CUSTOMER_CSV_IMPORT_ROW_STATUSES)[number];

export const OWNER_ONLY_CUSTOMER_IMPORT_MESSAGE =
  "Only the business owner can import existing customers.";

export const IMPORT_NOT_AVAILABLE_MESSAGE = "That import is not available.";

export const IMPORT_CONFIRM_REQUIRED_MESSAGE =
  "Customers and properties are created only after the owner confirms this preview.";

export const IMPORT_RESOLVE_INVALID_MESSAGE =
  "Correct or reject every invalid row before importing customers.";

export const IMPORT_ALREADY_CONFIRMED_MESSAGE =
  "This preview was already confirmed.";

export const IMPORT_ROW_NOT_EDITABLE_MESSAGE =
  "Only invalid preview rows can be corrected.";

export const IMPORT_ROW_REJECTED_TERMINAL_MESSAGE =
  "Rejected rows cannot be corrected.";

export const IMPORT_ROW_NOT_REJECTABLE_MESSAGE =
  "Only invalid preview rows can be rejected.";

export const ROW_REJECTED_BY_OWNER_MESSAGE =
  "Rejected by owner. This row will not import a customer or property.";

export const IMPORT_NO_SCRAPE_MESSAGE =
  "TBBT does not scrape directories, crawl websites, fetch source URLs, or buy customer lists. Upload a CSV you already have.";

export const IMPORT_CSV_REQUIRED_MESSAGE =
  "Upload a CSV file. TBBT does not fetch owner-supplied source URLs.";

export const NOT_CSV_MESSAGE = "That file is not a CSV.";

export const IMPORT_NO_SCORE_MESSAGE =
  "TBBT does not invent a customer score. Possible duplicates are same-business email or phone matches only.";

export const IMPORT_NO_OUTREACH_MESSAGE =
  "Import does not send email, SMS, or any other outreach.";

export const IMPORT_NO_CONSENT_MESSAGE =
  "Import never grants or changes SMS consent. New customers stay UNKNOWN. Existing consent is left untouched.";

export const IMPORT_NO_OVERWRITE_MESSAGE =
  "Import never overwrites an existing customer's name, email, phone, or SMS consent. A confirmed duplicate can only attach a new property.";

export const FILE_TOO_LARGE_MESSAGE = `CSV must be ${MAX_CUSTOMER_CSV_IMPORT_BYTES / 1024} KB or smaller.`;
export const TOO_MANY_ROWS_MESSAGE = `CSV may include at most ${MAX_CUSTOMER_CSV_IMPORT_ROWS} data rows.`;
export const MISSING_NAME_HEADER_MESSAGE =
  "CSV must include a name column (name, customer, or customer_name).";
export const EMPTY_CSV_MESSAGE = "CSV has no data rows.";
export const INVALID_CSV_MESSAGE = "That CSV could not be read.";

export function sourceKindLabel(_kind: string): string {
  return "Manual CSV";
}

export function previewStatusLabel(status: string): string {
  if (status === "INVALID") return "Invalid";
  if (status === "POSSIBLE_DUPLICATE") return "Possible same-business duplicate";
  if (status === "REJECTED") return "Rejected by owner";
  return "Ready";
}
