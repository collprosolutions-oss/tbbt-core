/**
 * Trade-neutral structured customer-reported issue on a completed Job.
 *
 * Customer-visible status is separate from the OWNER decision and
 * private notes. Displays recorded warranty terms only. Never invents
 * coverage, never creates a JobCallback, invoice, scheduled Job, or
 * customer message.
 */
import type { MembershipRole } from "@prisma/client";
import { completedSameBusinessJobEligible } from "@/lib/job-callback";

export const JOB_CUSTOMER_ISSUE_CUSTOMER_STATUSES = [
  "RECEIVED",
  "IN_REVIEW",
  "CLOSED",
] as const;
export type JobCustomerIssueCustomerStatus =
  (typeof JOB_CUSTOMER_ISSUE_CUSTOMER_STATUSES)[number];

export const JOB_CUSTOMER_ISSUE_OPEN_STATUSES = ["RECEIVED", "IN_REVIEW"] as const;
export type JobCustomerIssueOpenStatus =
  (typeof JOB_CUSTOMER_ISSUE_OPEN_STATUSES)[number];

export const JOB_CUSTOMER_ISSUE_EVENT_TYPES = [
  "RECORDED",
  "REVIEWED",
  "DECIDED",
] as const;
export type JobCustomerIssueEventType =
  (typeof JOB_CUSTOMER_ISSUE_EVENT_TYPES)[number];

export const JOB_CUSTOMER_ISSUE_CATEGORIES = [
  "INCOMPLETE_WORK",
  "QUALITY_CONCERN",
  "DAMAGE",
  "NOT_WORKING",
  "OTHER",
] as const;
export type JobCustomerIssueCategory =
  (typeof JOB_CUSTOMER_ISSUE_CATEGORIES)[number];

export const JOB_CUSTOMER_ISSUE_CATEGORY_LABELS: Record<
  JobCustomerIssueCategory,
  string
> = {
  INCOMPLETE_WORK: "Incomplete work",
  QUALITY_CONCERN: "Quality concern",
  DAMAGE: "Damage",
  NOT_WORKING: "Something is not working",
  OTHER: "Something else",
};

export const JOB_CUSTOMER_ISSUE_REPORTED_VIA = [
  "PHONE",
  "TEXT",
  "EMAIL",
  "IN_PERSON",
  "PORTAL",
  "OTHER",
] as const;
export type JobCustomerIssueReportedVia =
  (typeof JOB_CUSTOMER_ISSUE_REPORTED_VIA)[number];

export const JOB_CUSTOMER_ISSUE_REPORTED_VIA_LABELS: Record<
  JobCustomerIssueReportedVia,
  string
> = {
  PHONE: "Phone",
  TEXT: "Text",
  EMAIL: "Email",
  IN_PERSON: "In person",
  PORTAL: "Customer portal",
  OTHER: "Other",
};

export const JOB_CUSTOMER_ISSUE_PREFERRED_CONTACT = ["PHONE", "TEXT", "EMAIL"] as const;
export type JobCustomerIssuePreferredContact =
  (typeof JOB_CUSTOMER_ISSUE_PREFERRED_CONTACT)[number];

export const JOB_CUSTOMER_ISSUE_PREFERRED_CONTACT_LABELS: Record<
  JobCustomerIssuePreferredContact,
  string
> = {
  PHONE: "Phone",
  TEXT: "Text",
  EMAIL: "Email",
};

/**
 * Operational OWNER findings only. COVERED / NOT_COVERED are refused —
 * those would be a coverage determination this workflow does not make.
 */
export const JOB_CUSTOMER_ISSUE_DECISIONS = [
  "ACKNOWLEDGED",
  "WILL_FOLLOW_UP",
  "NO_RETURN_VISIT",
  "CUSTOMER_WITHDREW",
  "RECORDED_ONLY",
] as const;
export type JobCustomerIssueDecision =
  (typeof JOB_CUSTOMER_ISSUE_DECISIONS)[number];

export const JOB_CUSTOMER_ISSUE_DECISION_LABELS: Record<
  JobCustomerIssueDecision,
  string
> = {
  ACKNOWLEDGED: "Acknowledged",
  WILL_FOLLOW_UP: "Will follow up later",
  NO_RETURN_VISIT: "No return visit",
  CUSTOMER_WITHDREW: "Customer withdrew",
  RECORDED_ONLY: "Recorded only",
};

export const JOB_CUSTOMER_ISSUE_FORBIDDEN_DECISIONS = [
  "COVERED",
  "NOT_COVERED",
  "IN_WARRANTY",
  "OUT_OF_WARRANTY",
  "APPROVED",
  "DENIED",
] as const;

export const MAX_JOB_CUSTOMER_ISSUE_DESCRIPTION_LENGTH = 2000;
export const MAX_JOB_CUSTOMER_ISSUE_OWNER_NOTES_LENGTH = 2000;
export const MAX_PORTAL_JOB_CUSTOMER_ISSUE_DESCRIPTION_LENGTH = 500;
export const MAX_JOB_CUSTOMER_ISSUE_ATTACHMENTS = 5;
export const JOB_CUSTOMER_ISSUE_HISTORY_BOUND = 80;

export const JOB_CUSTOMER_ISSUE_OWNER_ONLY_MESSAGE =
  "Only the business owner can record, review, or decide a customer-reported issue.";

export const JOB_CUSTOMER_ISSUE_COMPLETED_JOB_MESSAGE =
  "A customer-reported issue can only be recorded against a completed job.";

export const JOB_CUSTOMER_ISSUE_JOB_REQUIRED_MESSAGE = "That job could not be found.";

export const JOB_CUSTOMER_ISSUE_UNKNOWN_MESSAGE = "That issue could not be found.";

export const JOB_CUSTOMER_ISSUE_CATEGORY_REQUIRED_MESSAGE =
  "Choose what kind of issue the customer reported.";

export const JOB_CUSTOMER_ISSUE_DESCRIPTION_REQUIRED_MESSAGE =
  "Record what the customer reported.";

export const JOB_CUSTOMER_ISSUE_REPORTED_VIA_REQUIRED_MESSAGE =
  "Record how the customer reported this issue.";

export const JOB_CUSTOMER_ISSUE_ALREADY_OPEN_MESSAGE =
  "This job already has an open customer-reported issue. Review or record a decision on that one first.";

export const JOB_CUSTOMER_ISSUE_DECISION_REQUIRED_MESSAGE =
  "Choose an operational decision. This is not a coverage or legal determination.";

export const JOB_CUSTOMER_ISSUE_DECISION_ALREADY_RECORDED_MESSAGE =
  "A decision is already recorded for this issue.";

export const JOB_CUSTOMER_ISSUE_NOT_REVIEWABLE_MESSAGE =
  "That issue cannot be reviewed.";

export const JOB_CUSTOMER_ISSUE_COVERAGE_REFUSED_MESSAGE =
  "This workflow does not determine coverage or legal obligation. Choose an operational decision instead.";

export const JOB_CUSTOMER_ISSUE_ATTACHMENT_INVALID_MESSAGE =
  "That file is not a private document for this job.";

export const JOB_CUSTOMER_ISSUE_ATTACHMENT_LIMIT_MESSAGE =
  `You can attach up to ${MAX_JOB_CUSTOMER_ISSUE_ATTACHMENTS} private documents.`;

export const JOB_CUSTOMER_ISSUE_RECORDED_MESSAGE =
  "Customer-reported issue recorded. No invoice, job, callback, or customer message was created.";

export const JOB_CUSTOMER_ISSUE_REVIEWED_MESSAGE =
  "Issue review recorded. Private notes stay hidden from the customer project link. This is not a coverage determination.";

export const JOB_CUSTOMER_ISSUE_DECISION_RECORDED_MESSAGE =
  "Issue decision recorded. Private notes stay hidden from the customer project link. No invoice, job, callback, or customer message was created.";

export const JOB_CUSTOMER_ISSUE_STATUS_UNCHANGED_MESSAGE =
  "That issue status is already recorded. No invoice, job, callback, or customer message was created.";

export const JOB_CUSTOMER_ISSUE_OWNER_WORKFLOW_MESSAGE =
  "Record a structured customer-reported issue on a completed job, review any recorded warranty terms, and record a private operational decision. Customer-visible status stays separate from private notes. This does not create a callback, invoice, schedule a job, or message the customer.";

export const JOB_CUSTOMER_ISSUE_UNAVAILABLE_MESSAGE =
  "Customer-reported issues are unavailable on this environment until the issue migration is applied.";

export const JOB_CUSTOMER_ISSUE_PORTAL_UNAVAILABLE_MESSAGE =
  "This project link is not available.";

export const JOB_CUSTOMER_ISSUE_PORTAL_COMPLETED_JOB_MESSAGE =
  "An issue can only be submitted after this job is complete.";

export const JOB_CUSTOMER_ISSUE_PORTAL_DESCRIPTION_REQUIRED_MESSAGE =
  "Describe what you would like the team to review.";

export const JOB_CUSTOMER_ISSUE_PORTAL_CATEGORY_REQUIRED_MESSAGE =
  "Choose what kind of issue this is.";

export const JOB_CUSTOMER_ISSUE_PORTAL_CONTACT_REQUIRED_MESSAGE =
  "Choose how you would like to be contacted.";

export const JOB_CUSTOMER_ISSUE_PORTAL_RECEIVED_MESSAGE =
  "We received your report. The team will review it. This is not a warranty decision and does not schedule a visit or send a message.";

export const JOB_CUSTOMER_ISSUE_PORTAL_CLOSED_MESSAGE =
  "The team recorded a decision. This is not a warranty decision and does not schedule a visit or send a message.";

export const JOB_CUSTOMER_ISSUE_PORTAL_WORKFLOW_MESSAGE =
  "Report a structured concern about the completed work. This is not a warranty claim, does not promise coverage, does not schedule a visit, and does not send a message.";

export const JOB_CUSTOMER_ISSUE_PORTAL_HEADING = "Reported issue";

export { completedSameBusinessJobEligible };

export function jobCustomerIssueWriteAllowed(role: MembershipRole | string): boolean {
  return role === "OWNER";
}

export function isJobCustomerIssueCustomerStatus(
  value: string,
): value is JobCustomerIssueCustomerStatus {
  return (JOB_CUSTOMER_ISSUE_CUSTOMER_STATUSES as readonly string[]).includes(value);
}

export function isJobCustomerIssueOpenStatus(
  value: string,
): value is JobCustomerIssueOpenStatus {
  return (JOB_CUSTOMER_ISSUE_OPEN_STATUSES as readonly string[]).includes(value);
}

export function isJobCustomerIssueCategory(
  value: string,
): value is JobCustomerIssueCategory {
  return (JOB_CUSTOMER_ISSUE_CATEGORIES as readonly string[]).includes(value);
}

export function isJobCustomerIssueReportedVia(
  value: string,
): value is JobCustomerIssueReportedVia {
  return (JOB_CUSTOMER_ISSUE_REPORTED_VIA as readonly string[]).includes(value);
}

export function isJobCustomerIssuePreferredContact(
  value: string,
): value is JobCustomerIssuePreferredContact {
  return (JOB_CUSTOMER_ISSUE_PREFERRED_CONTACT as readonly string[]).includes(value);
}

export function isJobCustomerIssueDecision(
  value: string,
): value is JobCustomerIssueDecision {
  return (JOB_CUSTOMER_ISSUE_DECISIONS as readonly string[]).includes(value);
}

export function isForbiddenIssueCoverageDecision(value: string): boolean {
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return (JOB_CUSTOMER_ISSUE_FORBIDDEN_DECISIONS as readonly string[]).includes(
    normalized,
  );
}

export function recordedIssueCustomerStatusLabel(status: string): string {
  if (status === "RECEIVED") return "Received";
  if (status === "IN_REVIEW") return "In review";
  if (status === "CLOSED") return "Closed";
  return status;
}

export function recordedIssueCategoryLabel(value: string): string {
  if (isJobCustomerIssueCategory(value)) return JOB_CUSTOMER_ISSUE_CATEGORY_LABELS[value];
  return value;
}

export function recordedIssueDecisionLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  if (isJobCustomerIssueDecision(value)) return JOB_CUSTOMER_ISSUE_DECISION_LABELS[value];
  return value;
}

export function recordedIssueReportedViaLabel(value: string): string {
  if (isJobCustomerIssueReportedVia(value)) {
    return JOB_CUSTOMER_ISSUE_REPORTED_VIA_LABELS[value];
  }
  return value;
}

export function recordedIssueEventLabel(eventType: string): string {
  if (eventType === "RECORDED") return "Recorded";
  if (eventType === "REVIEWED") return "Reviewed";
  if (eventType === "DECIDED") return "Decision recorded";
  return eventType;
}

export function parseJobCustomerIssueDescription(
  raw: string | null | undefined,
): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  return value.slice(0, MAX_JOB_CUSTOMER_ISSUE_DESCRIPTION_LENGTH);
}

export function parsePortalJobCustomerIssueDescription(
  raw: string | null | undefined,
): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  return value.slice(0, MAX_PORTAL_JOB_CUSTOMER_ISSUE_DESCRIPTION_LENGTH);
}

export function parseJobCustomerIssueOwnerNotes(raw: string | null | undefined): string {
  return (raw ?? "").trim().slice(0, MAX_JOB_CUSTOMER_ISSUE_OWNER_NOTES_LENGTH);
}

export function parseJobCustomerIssueCategory(
  raw: string | null | undefined,
): JobCustomerIssueCategory | null {
  const value = (raw ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  return isJobCustomerIssueCategory(value) ? value : null;
}

export function parseJobCustomerIssueReportedVia(
  raw: string | null | undefined,
): JobCustomerIssueReportedVia | null {
  const value = (raw ?? "").trim().toUpperCase();
  return isJobCustomerIssueReportedVia(value) ? value : null;
}

export function parseJobCustomerIssuePreferredContact(
  raw: string | null | undefined,
): JobCustomerIssuePreferredContact | null {
  const value = (raw ?? "").trim().toUpperCase();
  return isJobCustomerIssuePreferredContact(value) ? value : null;
}

export function parseJobCustomerIssueDecision(
  raw: string | null | undefined,
): JobCustomerIssueDecision | null {
  const value = (raw ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  return isJobCustomerIssueDecision(value) ? value : null;
}

export function parseJobCustomerIssueAttachmentIds(
  raw: readonly string[] | null | undefined,
): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const value of raw ?? []) {
    const id = value.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length > MAX_JOB_CUSTOMER_ISSUE_ATTACHMENTS) {
      return ids;
    }
  }
  return ids;
}

export function missingJobCustomerIssueSchema(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: string }).code)
      : "";
  return code === "P2021" || code === "P2022";
}

export type OwnerJobCustomerIssueAttachment = {
  id: string;
  storedAssetId: string;
  originalFilename: string;
};

export type OwnerJobCustomerIssueHistoryEvent = {
  id: string;
  eventType: string;
  eventLabel: string;
  fromCustomerVisibleStatus: string | null;
  toCustomerVisibleStatus: string;
  createdAt: Date;
  actorName: string | null;
};

export type OwnerJobCustomerIssue = {
  id: string;
  jobId: string;
  category: string;
  categoryLabel: string;
  description: string;
  reportedVia: string;
  reportedViaLabel: string;
  preferredContact: string | null;
  customerVisibleStatus: JobCustomerIssueCustomerStatus;
  customerVisibleStatusLabel: string;
  decision: string | null;
  decisionLabel: string | null;
  ownerNotes: string;
  recordedAt: Date;
  reviewedAt: Date | null;
  decidedAt: Date | null;
  recordedByName: string | null;
  attachments: OwnerJobCustomerIssueAttachment[];
  history: OwnerJobCustomerIssueHistoryEvent[];
};

export type CustomerVisibleIssueAttachment = {
  originalFilename: string;
};

export type CustomerVisibleIssue = {
  id: string;
  jobId: string;
  businessId: string;
  category: string;
  categoryLabel: string;
  description: string;
  customerVisibleStatus: JobCustomerIssueCustomerStatus;
  customerVisibleStatusLabel: string;
  preferredContact: string | null;
  recordedAt: Date;
  attachments: CustomerVisibleIssueAttachment[];
};
