import {
  DIRECTORY_KIND_LABELS,
  DIRECTORY_KINDS,
  DIRECTORY_READ_LIMIT,
  DIRECTORY_REVIEW_LABELS,
  DIRECTORY_REVIEW_STATUSES,
  DIRECTORY_SOURCE_LABELS,
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

export function resolveDirectoryReadLimit(requested?: number): number {
  if (typeof requested === "number" && Number.isInteger(requested) && requested > 0) {
    return Math.min(requested, DIRECTORY_READ_LIMIT);
  }
  return DIRECTORY_READ_LIMIT;
}

export function boundDirectoryRows<T>(rows: readonly T[], limit: number): {
  items: T[];
  overflow: boolean;
} {
  return {
    overflow: rows.length > limit,
    items: rows.slice(0, limit),
  };
}

export function directoryLabelSearchSources(query: string): DirectorySource[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return DIRECTORY_SOURCES.filter(
    (source) =>
      source.toLowerCase().includes(needle) ||
      DIRECTORY_SOURCE_LABELS[source].toLowerCase().includes(needle),
  );
}

export function directoryLabelSearchKinds(query: string): DirectoryKind[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return DIRECTORY_KINDS.filter(
    (kind) =>
      kind.toLowerCase().includes(needle) ||
      DIRECTORY_KIND_LABELS[kind].toLowerCase().includes(needle),
  );
}

export function directoryLabelSearchReviews(query: string): DirectoryReviewStatus[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return DIRECTORY_REVIEW_STATUSES.filter(
    (status) =>
      status.toLowerCase().includes(needle) ||
      DIRECTORY_REVIEW_LABELS[status].toLowerCase().includes(needle),
  );
}
