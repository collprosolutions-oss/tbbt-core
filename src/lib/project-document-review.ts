/**
 * OWNER review of a customer-uploaded private project document.
 *
 * Recording Reviewed or Needs replacement stays on this document. It
 * does not publish the file, attach it to an invoice, or send a
 * customer message. The customer project token may read the recorded
 * status and optional reason only.
 */
import type { MembershipRole } from "@prisma/client";

export const PROJECT_DOCUMENT_REVIEW_STATUSES = [
  "REVIEWED",
  "NEEDS_REPLACEMENT",
] as const;
export type ProjectDocumentReviewStatus =
  (typeof PROJECT_DOCUMENT_REVIEW_STATUSES)[number];

export const MAX_PROJECT_DOCUMENT_REVIEW_REASON_LENGTH = 200;

export const PROJECT_DOCUMENT_REVIEW_OWNER_ONLY_MESSAGE =
  "Only the business owner can mark a project document Reviewed or Needs replacement.";

export const PROJECT_DOCUMENT_REVIEW_UNKNOWN_MESSAGE =
  "That project document could not be found.";

export const PROJECT_DOCUMENT_REVIEW_NOT_PRIVATE_MESSAGE =
  "That file is not a private project document.";

export const PROJECT_DOCUMENT_REVIEW_CONFLICT_MESSAGE =
  "That document was already reviewed. Refresh and try again.";

export const PROJECT_DOCUMENT_REVIEW_STATUS_REQUIRED_MESSAGE =
  "Choose Reviewed or Needs replacement.";

export const PROJECT_DOCUMENT_REVIEW_RECORDED_MESSAGE =
  "Review recorded. The file stays private. No customer message was sent.";

export const PROJECT_DOCUMENT_REVIEW_UNCHANGED_MESSAGE =
  "That document already has this review. The file stays private. No customer message was sent.";

export const PROJECT_DOCUMENT_REVIEW_UNAVAILABLE_MESSAGE =
  "Project document review is unavailable on this environment until the review migration is applied.";

export const PROJECT_DOCUMENT_REVIEW_AWAITING_LABEL = "Awaiting review";
export const PROJECT_DOCUMENT_REVIEW_REVIEWED_LABEL = "Reviewed";
export const PROJECT_DOCUMENT_REVIEW_NEEDS_REPLACEMENT_LABEL = "Needs replacement";

export function projectDocumentReviewWriteAllowed(
  role: MembershipRole | string,
): boolean {
  return role === "OWNER";
}

export function isProjectDocumentReviewStatus(
  value: string,
): value is ProjectDocumentReviewStatus {
  return (PROJECT_DOCUMENT_REVIEW_STATUSES as readonly string[]).includes(value);
}

export function recordedProjectDocumentReviewLabel(
  status: string | null | undefined,
): string {
  if (status === "REVIEWED") return PROJECT_DOCUMENT_REVIEW_REVIEWED_LABEL;
  if (status === "NEEDS_REPLACEMENT") {
    return PROJECT_DOCUMENT_REVIEW_NEEDS_REPLACEMENT_LABEL;
  }
  return PROJECT_DOCUMENT_REVIEW_AWAITING_LABEL;
}

export function parseProjectDocumentReviewReason(
  raw: string | null | undefined,
): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  return value.slice(0, MAX_PROJECT_DOCUMENT_REVIEW_REASON_LENGTH);
}

export function normalizeExpectedProjectDocumentReviewStatus(
  raw: string | null | undefined,
): ProjectDocumentReviewStatus | "" | undefined {
  if (raw === undefined) return undefined;
  const value = (raw ?? "").trim();
  if (!value) return "";
  if (isProjectDocumentReviewStatus(value)) return value;
  return "";
}

export function missingProjectDocumentReviewSchema(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: string }).code)
      : "";
  return code === "P2021" || code === "P2022";
}

export type RecordedProjectDocumentReview = {
  storedAssetId: string;
  status: ProjectDocumentReviewStatus;
  statusLabel: string;
  reason: string | null;
  decidedAt: Date;
};
