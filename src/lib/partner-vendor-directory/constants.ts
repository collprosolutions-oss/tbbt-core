/**
 * Private owner-managed partner and vendor opportunity directory.
 * Tenant-scoped notes only. No marketplace, inventory, affiliate, or
 * Network membership claims live here.
 */

export const DIRECTORY_ROUTE = "/partner-vendor-directory";

export const DIRECTORY_KINDS = ["PARTNER", "VENDOR"] as const;
export type DirectoryKind = (typeof DIRECTORY_KINDS)[number];

export const DIRECTORY_KIND_LABELS: Record<DirectoryKind, string> = {
  PARTNER: "Partner",
  VENDOR: "Vendor",
};

export const DIRECTORY_SOURCES = ["MANUAL", "SUPPLIER", "REFERRAL"] as const;
export type DirectorySource = (typeof DIRECTORY_SOURCES)[number];

export const DIRECTORY_SOURCE_LABELS: Record<DirectorySource, string> = {
  MANUAL: "Owner-entered",
  SUPPLIER: "Existing supplier",
  REFERRAL: "Existing referral",
};

export const DIRECTORY_REVIEW_STATUSES = ["PENDING_REVIEW", "REVIEWED", "REJECTED"] as const;
export type DirectoryReviewStatus = (typeof DIRECTORY_REVIEW_STATUSES)[number];

export const DIRECTORY_REVIEW_LABELS: Record<DirectoryReviewStatus, string> = {
  PENDING_REVIEW: "Pending review",
  REVIEWED: "Reviewed",
  REJECTED: "Rejected",
};

export const DIRECTORY_LIMITS_MESSAGE =
  "This is a private owner-managed directory of partner and vendor opportunities for this business. It is not an external marketplace, not live supplier inventory, not an affiliate payout system, and not BSOS Network membership.";

export const DIRECTORY_SEARCH_MESSAGE =
  "Search and review apply only to opportunities recorded for this workspace.";

export const DIRECTORY_LINK_MESSAGE =
  "Supplier and Referral links reuse existing records from this business. Foreign-business rows cannot be read or linked.";

export const FORBIDDEN_DIRECTORY_CLAIM_PATTERNS = [
  /browse the marketplace/i,
  /live inventory is available/i,
  /earn affiliate payouts/i,
  /join the BSOS Network/i,
] as const;
