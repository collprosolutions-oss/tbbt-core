/**
 * Client-safe copy and bounds for OWNER-reviewed service catalog CSV import.
 * Keep Node built-ins out of this file so preview forms can import it.
 */

export const SERVICE_CATALOG_IMPORT_ROUTE = "/services/import-catalog";

export const MAX_SERVICE_CATALOG_IMPORT_BYTES = 256 * 1024;
export const MAX_SERVICE_CATALOG_IMPORT_ROWS = 200;
export const MAX_SERVICE_CATALOG_IMPORT_NAME = 200;
export const MAX_SERVICE_CATALOG_IMPORT_DESCRIPTION = 2000;
export const MAX_SERVICE_CATALOG_IMPORT_CATEGORY = 80;
export const MAX_SERVICE_CATALOG_IMPORT_UNIT = 40;

export const SERVICE_CATALOG_IMPORT_SOURCE_KINDS = ["CSV_UPLOAD"] as const;
export type ServiceCatalogImportSourceKind =
  (typeof SERVICE_CATALOG_IMPORT_SOURCE_KINDS)[number];

export const SERVICE_CATALOG_IMPORT_STATUSES = [
  "PREVIEW",
  "CONFIRMING",
  "CONFIRMED",
] as const;
export type ServiceCatalogImportStatus =
  (typeof SERVICE_CATALOG_IMPORT_STATUSES)[number];

export const SERVICE_CATALOG_IMPORT_ROW_STATUSES = [
  "VALID",
  "INVALID",
  "NAME_MATCH",
] as const;
export type ServiceCatalogImportRowStatus =
  (typeof SERVICE_CATALOG_IMPORT_ROW_STATUSES)[number];

export const SERVICE_CATALOG_IMPORT_WRITE_ACTIONS = ["ADD", "UPDATE"] as const;
export type ServiceCatalogImportWriteAction =
  (typeof SERVICE_CATALOG_IMPORT_WRITE_ACTIONS)[number];

export const SERVICE_CATALOG_IMPORT_MATCH_DECISIONS = [
  "SKIP",
  "UPDATE",
  "ADD_NEW",
] as const;
export type ServiceCatalogImportMatchDecision =
  (typeof SERVICE_CATALOG_IMPORT_MATCH_DECISIONS)[number];

export const OWNER_ONLY_CATALOG_IMPORT_MESSAGE =
  "Only the business owner can import a service catalog CSV.";

export const CATALOG_IMPORT_NOT_AVAILABLE_MESSAGE =
  "That catalog import is not available.";

export const CATALOG_IMPORT_CONFIRM_REQUIRED_MESSAGE =
  "Catalog services are added or updated only after the owner confirms this preview.";

export const CATALOG_IMPORT_RESOLVE_INVALID_MESSAGE =
  "Fix every invalid row in the CSV and upload again before writing the catalog.";

export const CATALOG_IMPORT_ALREADY_CONFIRMED_MESSAGE =
  "This catalog preview was already confirmed.";

export const CATALOG_IMPORT_CSV_REQUIRED_MESSAGE =
  "Upload a CSV file. TBBT does not fetch owner-supplied source URLs.";

export const CATALOG_IMPORT_NOT_CSV_MESSAGE = "That file is not a CSV.";

export const CATALOG_IMPORT_NO_HOURLY_MESSAGE =
  "TBBT does not publish hourly rates. Use Fixed, Starting at, Unit / production, or Custom Quote.";

export const CATALOG_IMPORT_NO_HISTORY_REWRITE_MESSAGE =
  "Confirm updates this business's catalog only. Historical estimate lines keep their recorded titles, scope, and prices.";

export const CATALOG_IMPORT_NAME_MATCH_MESSAGE =
  "Same-business name matches are shown before writing. Matched services change only when you pick update. Blank cells keep the existing description, category, recurrence, unit label, and active status.";

export const CATALOG_IMPORT_IN_PROGRESS_MESSAGE =
  "This catalog import is already being confirmed.";

export const CATALOG_IMPORT_STALE_MATCHES_MESSAGE =
  "The catalog changed after this preview. Review the updated name matches before confirming.";

export const CATALOG_IMPORT_SLUG_CONFLICT_MESSAGE =
  "That service website slug is already used on this business. Review the preview and confirm again.";

export const CATALOG_IMPORT_PRICING_MODE_REQUIRED_MESSAGE =
  "pricingMode is required. Use Fixed, Starting at, Unit / production, or Custom Quote.";

export const CATALOG_IMPORT_PRICE_REQUIRED_MESSAGE =
  "price is required except for Custom Quote.";

export const CATALOG_IMPORT_FILE_TOO_LARGE_MESSAGE = `CSV must be ${MAX_SERVICE_CATALOG_IMPORT_BYTES / 1024} KB or smaller.`;
export const CATALOG_IMPORT_TOO_MANY_ROWS_MESSAGE = `CSV may include at most ${MAX_SERVICE_CATALOG_IMPORT_ROWS} data rows.`;
export const CATALOG_IMPORT_MISSING_NAME_HEADER_MESSAGE =
  "CSV must include a name column (name, service, or service_name).";
export const CATALOG_IMPORT_EMPTY_MESSAGE = "CSV has no data rows.";
export const CATALOG_IMPORT_INVALID_MESSAGE = "That CSV could not be read.";

export function catalogImportOverLengthMessage(field: string, max: number) {
  return `${field} must be ${max} characters or fewer.`;
}

export function catalogImportSourceKindLabel(_kind: string): string {
  return "Manual CSV";
}

export function catalogImportPreviewStatusLabel(status: string): string {
  if (status === "INVALID") return "Invalid";
  if (status === "NAME_MATCH") return "Matching name — skipped unless you pick update";
  return "Ready to add";
}

export function catalogImportMatchDecisionLabel(decision: string): string {
  if (decision === "UPDATE") return "Update matching service";
  if (decision === "ADD_NEW") return "Add as new service";
  return "Skip";
}
