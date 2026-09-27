import {
  DIRECTORY_KINDS,
  DIRECTORY_REVIEW_STATUSES,
  DIRECTORY_SOURCES,
  type DirectoryKind,
  type DirectoryReviewStatus,
  type DirectorySource,
} from "@/lib/partner-vendor-directory/constants";

export function isDirectoryKind(value: string | undefined): value is DirectoryKind {
  return (DIRECTORY_KINDS as readonly string[]).includes(value ?? "");
}

export function isDirectorySource(value: string | undefined): value is DirectorySource {
  return (DIRECTORY_SOURCES as readonly string[]).includes(value ?? "");
}

export function isDirectoryReviewStatus(
  value: string | undefined,
): value is DirectoryReviewStatus {
  return (DIRECTORY_REVIEW_STATUSES as readonly string[]).includes(value ?? "");
}

export function parseDirectoryKindFilter(raw: string | undefined): DirectoryKind | "all" {
  return isDirectoryKind(raw) ? raw : "all";
}

export function parseDirectorySourceFilter(raw: string | undefined): DirectorySource | "all" {
  return isDirectorySource(raw) ? raw : "all";
}

export function parseDirectoryReviewFilter(
  raw: string | undefined,
): DirectoryReviewStatus | "all" {
  return isDirectoryReviewStatus(raw) ? raw : "all";
}

export function needsDirectoryReview(status: DirectoryReviewStatus): boolean {
  return status === "PENDING_REVIEW";
}

export function matchesDirectorySearch(
  haystacks: readonly (string | null | undefined)[],
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return haystacks.some((value) => (value ?? "").toLowerCase().includes(needle));
}
