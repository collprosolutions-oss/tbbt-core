/**
 * Client-safe copy and bounds for OWNER-reviewed external lead import.
 * Keep Node built-ins out of this file so preview forms can import it.
 */

export const EXTERNAL_LEAD_IMPORT_ROUTE = "/requests/import-leads";

export const MAX_EXTERNAL_LEAD_IMPORT_BYTES = 256 * 1024;
export const MAX_EXTERNAL_LEAD_IMPORT_ROWS = 200;
export const MAX_EXTERNAL_LEAD_IMPORT_FIELD = 200;
export const MAX_EXTERNAL_LEAD_IMPORT_SUMMARY = 200;

export const EXTERNAL_LEAD_IMPORT_SOURCE_KINDS = ["CSV_UPLOAD"] as const;
export type ExternalLeadImportSourceKind =
  (typeof EXTERNAL_LEAD_IMPORT_SOURCE_KINDS)[number];

export const EXTERNAL_LEAD_IMPORT_STATUSES = ["PREVIEW", "CONFIRMING", "CONFIRMED"] as const;
export type ExternalLeadImportStatus = (typeof EXTERNAL_LEAD_IMPORT_STATUSES)[number];

export const EXTERNAL_LEAD_IMPORT_ROW_STATUSES = [
  "VALID",
  "INVALID",
  "POSSIBLE_DUPLICATE",
  "REJECTED",
] as const;
export type ExternalLeadImportRowStatus =
  (typeof EXTERNAL_LEAD_IMPORT_ROW_STATUSES)[number];

export const OWNER_ONLY_IMPORT_MESSAGE =
  "Only the business owner can import external leads.";

export const IMPORT_NOT_AVAILABLE_MESSAGE = "That import is not available.";

export const IMPORT_CONFIRM_REQUIRED_MESSAGE =
  "Leads are created only after the owner confirms this preview.";

export const IMPORT_RESOLVE_INVALID_MESSAGE =
  "Correct or reject every invalid row before creating leads.";

export const IMPORT_ALREADY_CONFIRMED_MESSAGE =
  "This preview was already confirmed.";

export const IMPORT_ROW_NOT_EDITABLE_MESSAGE =
  "Only invalid or rejected preview rows can be corrected.";

export const IMPORT_ROW_NOT_REJECTABLE_MESSAGE =
  "Only invalid preview rows can be rejected.";

export const ROW_REJECTED_BY_OWNER_MESSAGE =
  "Rejected by owner. This row will not create a lead.";

export const IMPORT_NO_SCRAPE_MESSAGE =
  "TBBT does not scrape directories, crawl websites, fetch source URLs, or buy lead lists. Upload a CSV you already have.";

export const IMPORT_CSV_REQUIRED_MESSAGE =
  "Upload a CSV file. TBBT does not fetch owner-supplied source URLs.";

export const NOT_CSV_MESSAGE = "That file is not a CSV.";

export const IMPORT_NO_SCORE_MESSAGE =
  "TBBT does not invent a lead score. Possible duplicates are same-business email or phone matches only.";

export const IMPORT_NO_OUTREACH_MESSAGE =
  "Import does not send email, SMS, or any other outreach.";

export const FILE_TOO_LARGE_MESSAGE = `CSV must be ${MAX_EXTERNAL_LEAD_IMPORT_BYTES / 1024} KB or smaller.`;
export const TOO_MANY_ROWS_MESSAGE = `CSV may include at most ${MAX_EXTERNAL_LEAD_IMPORT_ROWS} data rows.`;
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
