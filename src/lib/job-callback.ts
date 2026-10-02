/**
 * Trade-neutral OWNER customer-reported callback against a completed Job.
 *
 * Displays recorded warranty terms only. Never invents coverage, never
 * makes a legal determination, and never creates an invoice, schedules a
 * Job, or messages the customer.
 */
import type { MembershipRole } from "@prisma/client";

export const JOB_CALLBACK_STATUSES = [
  "RECORDED",
  "UNDER_REVIEW",
  "OUTCOME_RECORDED",
] as const;
export type JobCallbackStatus = (typeof JOB_CALLBACK_STATUSES)[number];

export const JOB_CALLBACK_OPEN_STATUSES = ["RECORDED", "UNDER_REVIEW"] as const;
export type JobCallbackOpenStatus = (typeof JOB_CALLBACK_OPEN_STATUSES)[number];

export const JOB_CALLBACK_EVENT_TYPES = [
  "RECORDED",
  "REVIEWED",
  "OUTCOME_RECORDED",
] as const;
export type JobCallbackEventType = (typeof JOB_CALLBACK_EVENT_TYPES)[number];

export const JOB_CALLBACK_REPORTED_VIA = [
  "PHONE",
  "TEXT",
  "EMAIL",
  "IN_PERSON",
  "PORTAL",
  "OTHER",
] as const;
export type JobCallbackReportedVia = (typeof JOB_CALLBACK_REPORTED_VIA)[number];

export const JOB_CALLBACK_REPORTED_VIA_LABELS: Record<JobCallbackReportedVia, string> = {
  PHONE: "Phone",
  TEXT: "Text",
  EMAIL: "Email",
  IN_PERSON: "In person",
  PORTAL: "Customer portal",
  OTHER: "Other",
};

/**
 * Operational outcomes only. COVERED / NOT_COVERED are refused — those
 * would be a coverage determination this workflow does not make.
 */
export const JOB_CALLBACK_OUTCOMES = [
  "WILL_FOLLOW_UP",
  "NO_RETURN_VISIT",
  "CUSTOMER_WITHDREW",
  "RECORDED_ONLY",
] as const;
export type JobCallbackOutcome = (typeof JOB_CALLBACK_OUTCOMES)[number];

export const JOB_CALLBACK_OUTCOME_LABELS: Record<JobCallbackOutcome, string> = {
  WILL_FOLLOW_UP: "Will follow up later",
  NO_RETURN_VISIT: "No return visit",
  CUSTOMER_WITHDREW: "Customer withdrew",
  RECORDED_ONLY: "Recorded only",
};

export const JOB_CALLBACK_FORBIDDEN_OUTCOMES = [
  "COVERED",
  "NOT_COVERED",
  "IN_WARRANTY",
  "OUT_OF_WARRANTY",
  "APPROVED",
  "DENIED",
] as const;

export const JOB_CALLBACK_CATEGORIES = [
  "INCOMPLETE_WORK",
  "QUALITY_CONCERN",
  "DAMAGE",
  "NOT_WORKING",
  "OTHER",
] as const;
export type JobCallbackCategory = (typeof JOB_CALLBACK_CATEGORIES)[number];

export const JOB_CALLBACK_CATEGORY_LABELS: Record<JobCallbackCategory, string> = {
  INCOMPLETE_WORK: "Incomplete work",
  QUALITY_CONCERN: "Quality concern",
  DAMAGE: "Damage",
  NOT_WORKING: "Something is not working",
  OTHER: "Something else",
};

export const JOB_CALLBACK_CUSTOMER_STATUSES = [
  "received",
  "in_review",
  "closed",
] as const;
export type JobCallbackCustomerStatus = (typeof JOB_CALLBACK_CUSTOMER_STATUSES)[number];

export const MAX_JOB_CALLBACK_DESCRIPTION_LENGTH = 2000;
export const MAX_JOB_CALLBACK_OUTCOME_NOTES_LENGTH = 2000;
export const MAX_JOB_CALLBACK_OWNER_NOTES_LENGTH = 2000;
export const MAX_PORTAL_JOB_CALLBACK_DESCRIPTION_LENGTH = 500;
export const MAX_PORTAL_PROJECT_TOKEN_LENGTH = 128;
export const MAX_JOB_CALLBACK_ATTACHMENTS = 5;

export const JOB_CALLBACK_PREFERRED_CONTACT = ["PHONE", "TEXT", "EMAIL"] as const;
export type JobCallbackPreferredContact = (typeof JOB_CALLBACK_PREFERRED_CONTACT)[number];

export const JOB_CALLBACK_PREFERRED_CONTACT_LABELS: Record<
  JobCallbackPreferredContact,
  string
> = {
  PHONE: "Phone",
  TEXT: "Text",
  EMAIL: "Email",
};

export const PORTAL_CALLBACK_PREFERRED_CONTACT_PREFIX = "Preferred contact: ";

export const JOB_CALLBACK_OWNER_ONLY_MESSAGE =
  "Only the business owner can record, review, or close a customer-reported callback.";

export const JOB_CALLBACK_COMPLETED_JOB_MESSAGE =
  "A customer-reported callback can only be recorded against a completed job.";

export const JOB_CALLBACK_JOB_REQUIRED_MESSAGE = "That job could not be found.";

export const JOB_CALLBACK_UNKNOWN_MESSAGE = "That callback could not be found.";

export const JOB_CALLBACK_DESCRIPTION_REQUIRED_MESSAGE =
  "Record what the customer reported.";

export const JOB_CALLBACK_REPORTED_VIA_REQUIRED_MESSAGE =
  "Record how the customer reported this callback.";

export const JOB_CALLBACK_ALREADY_OPEN_MESSAGE =
  "This job already has an open customer-reported callback. Review or record an outcome on that one first.";

export const JOB_CALLBACK_REVIEW_FIRST_MESSAGE =
  "Review this callback before recording an outcome.";

export const JOB_CALLBACK_OUTCOME_REQUIRED_MESSAGE =
  "Choose an operational outcome. This is not a coverage or legal determination.";

export const JOB_CALLBACK_OUTCOME_ALREADY_RECORDED_MESSAGE =
  "An outcome is already recorded for this callback.";

export const JOB_CALLBACK_NOT_REVIEWABLE_MESSAGE =
  "That callback cannot be reviewed.";

export const JOB_CALLBACK_COVERAGE_REFUSED_MESSAGE =
  "This workflow does not determine coverage or legal obligation. Choose an operational outcome instead.";

export const JOB_CALLBACK_RECORDED_MESSAGE =
  "Customer-reported callback recorded. No invoice, job, or customer message was created.";

export const JOB_CALLBACK_REVIEWED_MESSAGE =
  "Callback review recorded. Recorded warranty terms are shown as stored — this is not a coverage determination.";

export const JOB_CALLBACK_OUTCOME_RECORDED_MESSAGE =
  "Callback outcome recorded. No invoice, job, or customer message was created.";

export const JOB_CALLBACK_STATUS_UNCHANGED_MESSAGE =
  "That callback status is already recorded. No invoice, job, or customer message was created.";

export const JOB_CALLBACK_WARRANTY_DISCLAIMER =
  "These are recorded warranty or workmanship terms from Business Protection and this job's approved estimate, if any. TBBT does not determine coverage, invent missing terms, or give legal advice.";

export const JOB_CALLBACK_NO_WARRANTY_TERMS_MESSAGE =
  "No warranty terms are recorded for this business or this job.";

export const JOB_CALLBACK_OWNER_WORKFLOW_MESSAGE =
  "Record a customer-reported callback on a completed job, review any recorded warranty terms, and record an operational outcome. This does not create an invoice, schedule a job, or message the customer.";

export const JOB_CALLBACK_PORTAL_UNAVAILABLE_MESSAGE =
  "This project link is not available.";

export const JOB_CALLBACK_PORTAL_COMPLETED_JOB_MESSAGE =
  "A callback request can only be submitted after this job is complete.";

export const JOB_CALLBACK_PORTAL_DESCRIPTION_REQUIRED_MESSAGE =
  "Describe what you would like the team to review.";

export const JOB_CALLBACK_PORTAL_CONTACT_REQUIRED_MESSAGE =
  "Choose how you would like to be contacted.";

export const JOB_CALLBACK_PORTAL_RECEIVED_MESSAGE =
  "We received your callback request. The team will review it. This is not a warranty decision and does not schedule a visit or send a message.";

export const JOB_CALLBACK_PORTAL_WORKFLOW_MESSAGE =
  "Ask the team to review a concern about the completed work. This is not a warranty claim, does not promise coverage, does not schedule a visit, and does not send a message.";

/** Bounded portal re-file wait after an OWNER records an outcome. */
export const PORTAL_JOB_CALLBACK_COOLDOWN_HOURS = 24;
export const PORTAL_JOB_CALLBACK_COOLDOWN_MS =
  PORTAL_JOB_CALLBACK_COOLDOWN_HOURS * 60 * 60 * 1000;

export const JOB_CALLBACK_PORTAL_COOLDOWN_MESSAGE =
  "The team already recorded an outcome on a recent callback request for this job. You can send another request after 24 hours. This is not a warranty decision, does not promise coverage, does not schedule a visit, and does not send a message.";

export const JOB_CALLBACK_PORTAL_CLOSED_MESSAGE =
  "The team closed this request and is not planning a return visit. You cannot send another request for this job. This is not a warranty claim, does not promise coverage, does not schedule a visit, and does not send a message.";

export const JOB_CALLBACK_CATEGORY_INVALID_MESSAGE =
  "Choose what kind of concern the customer reported.";

export const JOB_CALLBACK_ATTACHMENT_INVALID_MESSAGE =
  "That file is not a private document for this job.";

export const JOB_CALLBACK_ATTACHMENT_LIMIT_MESSAGE =
  `You can attach up to ${MAX_JOB_CALLBACK_ATTACHMENTS} private documents.`;

export const JOB_CALLBACK_UNAVAILABLE_MESSAGE =
  "Customer-reported callbacks are unavailable on this environment until the callback issue migration is applied.";

export function portalJobCallbackCooldownAvailableAt(resolvedAt: Date): Date {
  return new Date(resolvedAt.getTime() + PORTAL_JOB_CALLBACK_COOLDOWN_MS);
}

export function isPortalJobCallbackCoolingDown(
  resolvedAt: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!resolvedAt) return false;
  return now.getTime() - resolvedAt.getTime() < PORTAL_JOB_CALLBACK_COOLDOWN_MS;
}

export function portalJobCallbackCooldownMessage(availableAtLabel?: string): string {
  if (!availableAtLabel) return JOB_CALLBACK_PORTAL_COOLDOWN_MESSAGE;
  return `The team already recorded an outcome on a recent callback request for this job. You can send another request after 24 hours. Next available ${availableAtLabel}. This is not a warranty decision, does not promise coverage, does not schedule a visit, and does not send a message.`;
}

export function jobCallbackWriteAllowed(role: MembershipRole | string): boolean {
  return role === "OWNER";
}

export function isJobCallbackStatus(value: string): value is JobCallbackStatus {
  return (JOB_CALLBACK_STATUSES as readonly string[]).includes(value);
}

export function isJobCallbackOpenStatus(value: string): value is JobCallbackOpenStatus {
  return (JOB_CALLBACK_OPEN_STATUSES as readonly string[]).includes(value);
}

export function isJobCallbackReportedVia(value: string): value is JobCallbackReportedVia {
  return (JOB_CALLBACK_REPORTED_VIA as readonly string[]).includes(value);
}

export function isJobCallbackOutcome(value: string): value is JobCallbackOutcome {
  return (JOB_CALLBACK_OUTCOMES as readonly string[]).includes(value);
}

export function isForbiddenCoverageOutcome(value: string): boolean {
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return (JOB_CALLBACK_FORBIDDEN_OUTCOMES as readonly string[]).includes(normalized);
}

export function recordedCallbackStatusLabel(status: string): string {
  if (status === "RECORDED") return "Recorded";
  if (status === "UNDER_REVIEW") return "Under review";
  if (status === "OUTCOME_RECORDED") return "Outcome recorded";
  return status;
}

export function recordedCallbackOutcomeLabel(outcome: string | null | undefined): string | null {
  if (!outcome) return null;
  if (isJobCallbackOutcome(outcome)) return JOB_CALLBACK_OUTCOME_LABELS[outcome];
  return outcome;
}

export function reportedViaLabel(value: string): string {
  if (isJobCallbackReportedVia(value)) return JOB_CALLBACK_REPORTED_VIA_LABELS[value];
  return value;
}

export function parseJobCallbackDescription(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  return value.slice(0, MAX_JOB_CALLBACK_DESCRIPTION_LENGTH);
}

export function parsePortalProjectToken(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value || value.length > MAX_PORTAL_PROJECT_TOKEN_LENGTH) return null;
  return value;
}

export function parsePortalJobCallbackDescription(
  raw: string | null | undefined,
): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  return value.slice(0, MAX_PORTAL_JOB_CALLBACK_DESCRIPTION_LENGTH);
}

export function isJobCallbackPreferredContact(
  value: string,
): value is JobCallbackPreferredContact {
  return (JOB_CALLBACK_PREFERRED_CONTACT as readonly string[]).includes(value);
}

export function parsePortalJobCallbackPreferredContact(
  raw: string | null | undefined,
): JobCallbackPreferredContact | null {
  const value = (raw ?? "").trim().toUpperCase();
  return isJobCallbackPreferredContact(value) ? value : null;
}

export function formatPortalCallbackDescription(
  description: string,
  preferredContact: JobCallbackPreferredContact,
): string {
  const header = `${PORTAL_CALLBACK_PREFERRED_CONTACT_PREFIX}${JOB_CALLBACK_PREFERRED_CONTACT_LABELS[preferredContact]}`;
  return `${header}\n\n${description}`.slice(0, MAX_JOB_CALLBACK_DESCRIPTION_LENGTH);
}

export function parseJobCallbackOutcomeNotes(raw: string | null | undefined): string {
  return (raw ?? "").trim().slice(0, MAX_JOB_CALLBACK_OUTCOME_NOTES_LENGTH);
}

export function parseJobCallbackOwnerNotes(raw: string | null | undefined): string {
  return (raw ?? "").trim().slice(0, MAX_JOB_CALLBACK_OWNER_NOTES_LENGTH);
}

export function isJobCallbackCategory(value: string): value is JobCallbackCategory {
  return (JOB_CALLBACK_CATEGORIES as readonly string[]).includes(value);
}

export function parseJobCallbackCategory(
  raw: string | null | undefined,
): JobCallbackCategory | null {
  const value = (raw ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (!value) return null;
  return isJobCallbackCategory(value) ? value : null;
}

export function recordedCallbackCategoryLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  if (isJobCallbackCategory(value)) return JOB_CALLBACK_CATEGORY_LABELS[value];
  return value;
}

export function customerVisibleCallbackStatus(status: string): JobCallbackCustomerStatus {
  if (status === "UNDER_REVIEW") return "in_review";
  if (status === "OUTCOME_RECORDED") return "closed";
  return "received";
}

export function customerVisibleCallbackStatusLabel(status: string): string {
  const visible = customerVisibleCallbackStatus(status);
  if (visible === "in_review") return "In review";
  if (visible === "closed") return "Closed";
  return "Received";
}

export function parseJobCallbackAttachmentIds(
  raw: readonly string[] | null | undefined,
): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const value of raw ?? []) {
    const id = value.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length > MAX_JOB_CALLBACK_ATTACHMENTS) {
      return ids;
    }
  }
  return ids;
}

export function isPortalJobCallbackClosed(
  outcome: string | null | undefined,
): boolean {
  return outcome === "NO_RETURN_VISIT";
}

export function missingJobCallbackIssueSchema(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: string }).code)
      : "";
  return code === "P2021" || code === "P2022";
}

export type OwnerJobCallbackAttachment = {
  id: string;
  storedAssetId: string;
  originalFilename: string;
};

export type CustomerVisibleCallbackAttachment = {
  originalFilename: string;
};

export function parseJobCallbackReportedVia(raw: string | null | undefined): JobCallbackReportedVia | null {
  const value = (raw ?? "").trim().toUpperCase();
  return isJobCallbackReportedVia(value) ? value : null;
}

export function parseJobCallbackOutcome(raw: string | null | undefined): JobCallbackOutcome | null {
  const value = (raw ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  return isJobCallbackOutcome(value) ? value : null;
}

export function completedSameBusinessJobEligible(job: {
  status: string;
  businessId: string;
} | null | undefined, businessId: string): boolean {
  return Boolean(job && job.businessId === businessId && job.status === "COMPLETED");
}

export type RecordedWarrantyTermSource = "VAULT" | "AGREEMENT" | "ESTIMATE";

export type RecordedWarrantyTerm = {
  source: RecordedWarrantyTermSource;
  sourceId: string;
  title: string;
  body: string | null;
  effectiveOn: string | null;
  expiresOn: string | null;
  recordStatus: string | null;
};

export function warrantyTermLooksRecorded(input: {
  id?: string | null;
  title?: string | null;
  body?: string | null;
}): boolean {
  const haystack = [input.id, input.title, input.body]
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .toLowerCase();
  return /\bwarrant/.test(haystack) || /\bworkmanship\b/.test(haystack);
}
