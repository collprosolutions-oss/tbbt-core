/**
 * Reviews workspace domain -- internal reputation workflow over real
 * TBBT completed jobs and recorded review activity.
 *
 * No Google/Facebook ingestion. No automatic SMS/email. SENT means the
 * owner recorded that a request was sent. Every eligible customer can
 * be asked for an honest review -- this module never review-gates.
 *
 * No next/headers dependency -- authorization/isolation check scripts
 * import these helpers directly.
 */

import { parseScheduleDate, startOfDay } from "@/lib/schedule";

export const REVIEW_AREAS = [
  "overview",
  "opportunities",
  "requests",
  "reviews",
  "responses",
  "performance",
] as const;
export type ReviewArea = (typeof REVIEW_AREAS)[number];

export const REVIEW_AREA_LABELS: Record<ReviewArea, string> = {
  overview: "Overview",
  opportunities: "Opportunities",
  requests: "Requests",
  reviews: "Reviews",
  responses: "Responses",
  performance: "Performance",
};

export function isReviewArea(value: string | undefined): value is ReviewArea {
  return (REVIEW_AREAS as readonly string[]).includes(value ?? "");
}

export function parseReviewArea(raw: string | undefined): ReviewArea {
  return isReviewArea(raw) ? raw : "overview";
}

export const REVIEW_REQUEST_STATUSES = [
  "DRAFT",
  "READY",
  "SENT",
  "COMPLETED",
  "CANCELLED",
] as const;
export type ReviewRequestStatus = (typeof REVIEW_REQUEST_STATUSES)[number];

export const REVIEW_REQUEST_STATUS_LABELS: Record<ReviewRequestStatus, string> = {
  DRAFT: "Draft",
  READY: "Ready",
  SENT: "Recorded as sent",
  COMPLETED: "Review received",
  CANCELLED: "Cancelled",
};

export function isReviewRequestStatus(value: string): value is ReviewRequestStatus {
  return (REVIEW_REQUEST_STATUSES as readonly string[]).includes(value);
}

export const REVIEW_PLATFORMS = ["UNASSIGNED", "GOOGLE", "FACEBOOK", "OTHER"] as const;
export type ReviewPlatform = (typeof REVIEW_PLATFORMS)[number];

export const REVIEW_PLATFORM_LABELS: Record<ReviewPlatform, string> = {
  UNASSIGNED: "Unassigned",
  GOOGLE: "Google (intent only)",
  FACEBOOK: "Facebook (intent only)",
  OTHER: "Other (intent only)",
};

export const REVIEW_RECEIVED_PLATFORMS = ["GOOGLE", "FACEBOOK", "OTHER"] as const;
export type ReviewReceivedPlatform = (typeof REVIEW_RECEIVED_PLATFORMS)[number];

export const REVIEW_RECEIVED_PLATFORM_LABELS: Record<ReviewReceivedPlatform, string> = {
  GOOGLE: "Google",
  FACEBOOK: "Facebook",
  OTHER: "Other",
};

export function isReviewPlatform(value: string): value is ReviewPlatform {
  return (REVIEW_PLATFORMS as readonly string[]).includes(value);
}

export function isReviewReceivedPlatform(value: string): value is ReviewReceivedPlatform {
  return (REVIEW_RECEIVED_PLATFORMS as readonly string[]).includes(value);
}

export const REVIEW_RESPONSE_STATUSES = ["DRAFT", "READY_FOR_REVIEW", "APPROVED"] as const;
export type ReviewResponseStatus = (typeof REVIEW_RESPONSE_STATUSES)[number];

export const REVIEW_RESPONSE_STATUS_LABELS: Record<ReviewResponseStatus, string> = {
  DRAFT: "Draft",
  READY_FOR_REVIEW: "Ready for review",
  APPROVED: "Approved",
};

export function isReviewResponseStatus(value: string): value is ReviewResponseStatus {
  return (REVIEW_RESPONSE_STATUSES as readonly string[]).includes(value);
}

export const PLATFORMS_DISCONNECTED_MESSAGE =
  "No Google or Facebook review platform is connected. External review counts, ratings, and publishing are not available.";

export const REQUEST_SEND_DISCLAIMER =
  "Recording SENT means you asked the customer. TBBT did not send SMS or email — no messaging integration is connected.";

export const RESPONSE_PUBLISH_DISCLAIMER =
  "Approving a response does not publish it. External reply posting is not available.";

export const PERFORMANCE_INTERNAL_MESSAGE =
  "These numbers are TBBT-recorded activity only — not complete Google or Facebook performance.";

export const NO_REVIEW_GATING_MESSAGE =
  "Every eligible customer can be asked for an honest review. TBBT does not suppress a request because a review might be negative.";

export const MARKETING_LINK_MESSAGE =
  "A recorded review may become a future Marketing opportunity. Review text is not copied into public content automatically. Permission and usage rules still apply.";

/** Extension point only — no AI provider is called in this step. */
export function reviewAiAssistAvailable(): false {
  return false;
}

export function parseReviewDate(raw: string | undefined): Date | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = parseScheduleDate(raw);
  const [year, month, day] = raw.split("-").map(Number);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null;
  }
  return startOfDay(parsed);
}

export function nextRequestStatus(current: string): ReviewRequestStatus | null {
  if (current === "DRAFT") return "READY";
  if (current === "READY") return "SENT";
  return null;
}

export function nextResponseStatus(current: string): ReviewResponseStatus | null {
  if (current === "DRAFT") return "READY_FOR_REVIEW";
  if (current === "READY_FOR_REVIEW") return "APPROVED";
  return null;
}

export function isActiveReviewRequestStatus(status: string): boolean {
  return status === "DRAFT" || status === "READY" || status === "SENT" || status === "COMPLETED";
}

export function requestBlocksNewOpportunity(status: string): boolean {
  return status === "DRAFT" || status === "READY" || status === "SENT" || status === "COMPLETED";
}

const NEGATIVE_RATING_THRESHOLD = 3;

export function reviewNeedsAttention(input: { rating?: number | null }): boolean {
  return typeof input.rating === "number" && input.rating <= NEGATIVE_RATING_THRESHOLD;
}

export function reviewMayBeMarketingEligible(input: { rating?: number | null; reviewText?: string }): boolean {
  if (typeof input.rating === "number") return input.rating >= 4;
  return Boolean(input.reviewText?.trim());
}

export function suggestedRequestText(input: { customerName: string; businessName: string }): string {
  const customerName = input.customerName.trim() || "there";
  const businessName = input.businessName.trim() || "us";
  return `Hi ${customerName},\n\nThank you for choosing ${businessName}. If you have a moment, we would appreciate an honest review of the work we recently completed. Please share your genuine experience — it helps other homeowners and helps us keep improving.\n\nThank you,\n${businessName}`;
}

export function suggestedResponseText(): string {
  return "Thank you for taking the time to share your experience. We appreciate your feedback.";
}

export type ReviewOpportunityAction =
  | "prepare_request"
  | "finish_draft"
  | "record_as_sent"
  | "follow_up_due"
  | "waiting_for_review"
  | "review_recorded"
  | "prepare_new_request";

export const REVIEW_OPPORTUNITY_ACTION_LABELS: Record<ReviewOpportunityAction, string> = {
  prepare_request: "Prepare a review request",
  finish_draft: "Finish the draft request",
  record_as_sent: "Record as sent when you have asked the customer",
  follow_up_due: "Follow-up is due",
  waiting_for_review: "Waiting for a recorded review",
  review_recorded: "Review already recorded",
  prepare_new_request: "Previous request cancelled — you can prepare a new one",
};

export function recommendedOpportunityAction(input: {
  requestStatus: string | null;
  reminderDue: boolean;
  hasReview: boolean;
}): ReviewOpportunityAction {
  if (input.hasReview || input.requestStatus === "COMPLETED") return "review_recorded";
  if (!input.requestStatus || input.requestStatus === "CANCELLED") {
    return input.requestStatus === "CANCELLED" ? "prepare_new_request" : "prepare_request";
  }
  if (input.requestStatus === "DRAFT") return "finish_draft";
  if (input.requestStatus === "READY") return "record_as_sent";
  if (input.requestStatus === "SENT") {
    return input.reminderDue ? "follow_up_due" : "waiting_for_review";
  }
  return "prepare_request";
}

export function isReminderDue(input: {
  status: string;
  reminderAt: Date | null | undefined;
  hasReview: boolean;
  now?: Date;
}): boolean {
  if (input.hasReview || input.status !== "SENT" || !input.reminderAt) return false;
  const now = startOfDay(input.now ?? new Date());
  return startOfDay(input.reminderAt).getTime() <= now.getTime();
}

export function requestWorkflowState(input: {
  status: string;
  reminderDue: boolean;
  hasReview: boolean;
}): "none" | "draft" | "sent" | "follow_up_due" | "received" | "cancelled" {
  if (input.hasReview || input.status === "COMPLETED") return "received";
  if (input.status === "CANCELLED") return "cancelled";
  if (input.status === "SENT" && input.reminderDue) return "follow_up_due";
  if (input.status === "SENT") return "sent";
  if (input.status === "DRAFT" || input.status === "READY") return "draft";
  return "none";
}

export const REQUEST_WORKFLOW_LABELS: Record<
  ReturnType<typeof requestWorkflowState>,
  string
> = {
  none: "No request has been made",
  draft: "Request is being prepared",
  sent: "Request was recorded as sent",
  follow_up_due: "Follow-up is due",
  received: "Review was received",
  cancelled: "Request was cancelled",
};

export function parseOptionalRating(raw: string | undefined): number | null {
  if (!raw || !raw.trim()) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    return Number.NaN;
  }
  return value;
}

export function parseOptionalUrl(raw: string | undefined): string | null {
  const value = raw?.trim() ?? "";
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.toString();
  } catch {
    return "";
  }
}

export function rateWhenValid(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 100);
}
