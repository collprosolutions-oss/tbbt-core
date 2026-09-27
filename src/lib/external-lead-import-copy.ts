/**
 * Client-safe copy and bounds for OWNER-reviewed external lead import.
 * Keep Node built-ins out of this file so preview forms can import it.
 */

export const EXTERNAL_LEAD_IMPORT_ROUTE = "/requests/import-leads";

export const MAX_EXTERNAL_LEAD_IMPORT_BYTES = 256 * 1024;
export const MAX_EXTERNAL_LEAD_IMPORT_ROWS = 200;
export const MAX_EXTERNAL_LEAD_IMPORT_FIELD = 200;
export const MAX_EXTERNAL_LEAD_IMPORT_SUMMARY = 200;
export const MAX_EXTERNAL_LEAD_IMPORT_URL = 2048;
export const EXTERNAL_LEAD_IMPORT_FETCH_TIMEOUT_MS = 8_000;

export const EXTERNAL_LEAD_IMPORT_SOURCE_KINDS = ["CSV_UPLOAD", "SOURCE_URL"] as const;
export type ExternalLeadImportSourceKind =
  (typeof EXTERNAL_LEAD_IMPORT_SOURCE_KINDS)[number];

export const EXTERNAL_LEAD_IMPORT_STATUSES = ["PREVIEW", "CONFIRMING", "CONFIRMED"] as const;
export type ExternalLeadImportStatus = (typeof EXTERNAL_LEAD_IMPORT_STATUSES)[number];

export const EXTERNAL_LEAD_IMPORT_ROW_STATUSES = [
  "VALID",
  "INVALID",
  "POSSIBLE_DUPLICATE",
] as const;
export type ExternalLeadImportRowStatus =
  (typeof EXTERNAL_LEAD_IMPORT_ROW_STATUSES)[number];

export const OWNER_ONLY_IMPORT_MESSAGE =
  "Only the business owner can import external leads.";

export const IMPORT_NOT_AVAILABLE_MESSAGE = "That import is not available.";

export const IMPORT_CONFIRM_REQUIRED_MESSAGE =
  "Leads are created only after the owner confirms this preview.";

export const IMPORT_NO_SCRAPE_MESSAGE =
  "TBBT does not scrape directories, crawl websites, or buy lead lists. Supply a CSV you already have, or a direct CSV URL you control.";

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
export const BLOCKED_SOURCE_URL_MESSAGE =
  "That source URL is not allowed. Use a public http(s) URL that points at a CSV you control.";
export const SOURCE_URL_NOT_CSV_MESSAGE =
  "The source URL must return a CSV. HTML pages and directory listings are rejected.";
export const SOURCE_URL_FETCH_MESSAGE =
  "That source URL could not be read as a CSV.";

export function sourceKindLabel(kind: string): string {
  if (kind === "SOURCE_URL") return "Owner-supplied source URL";
  return "Manual CSV";
}

export function previewStatusLabel(status: string): string {
  if (status === "INVALID") return "Invalid";
  if (status === "POSSIBLE_DUPLICATE") return "Possible same-business duplicate";
  return "Ready";
}
