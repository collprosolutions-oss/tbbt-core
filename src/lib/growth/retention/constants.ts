/**
 * Customer Retention & Repeat-Business Recovery Center.
 *
 * Page load is read/explain only. Groups exist only when persisted TBBT
 * rows prove the condition. An OWNER may explicitly record a
 * same-business CustomerFollowUp from a listed finding. This module does
 * not invent churn, readiness, or a contact cadence.
 */

export const RETENTION_CANDIDATE_LIMIT = 50;

export const RETENTION_ROUTE = "/growth/retention";

export const RETENTION_GROUPS = [
  "NO_REVIEW_REQUEST",
  "NO_LATER_JOB",
  "RECORDED_FOLLOW_UP",
  "NO_REFERRAL_REQUEST",
  "INCOMPLETE_JOURNEY",
] as const;

export type RetentionGroup = (typeof RETENTION_GROUPS)[number];

export const RETENTION_GROUP_TITLES: Record<RetentionGroup, string> = {
  NO_REVIEW_REQUEST: "Completed job — no review request recorded",
  NO_LATER_JOB: "Past customer with no later job recorded",
  RECORDED_FOLLOW_UP: "Recorded follow-up status",
  NO_REFERRAL_REQUEST: "Completed job — no referral request recorded",
  INCOMPLETE_JOURNEY: "Incomplete customer journey",
};

export const NO_REVIEW_REQUEST_FACT =
  "Recorded completed work exists and no same-business ReviewRequest is recorded for that completed job.";

export const NO_LATER_JOB_FACT = "Past customer with no later job recorded";

export const RECORDED_FOLLOW_UP_FACT =
  "CustomerFollowUp status is the recorded row status. SENT is not delivery.";

export const NO_REFERRAL_REQUEST_FACT =
  "Recorded completed work exists and no same-business ReferralRequest is recorded for that completed job.";

export const INCOMPLETE_JOURNEY_FACT =
  "These are the same Growth recovery queues already defined for incomplete recorded journeys. They are not a new scoring model.";

export const RETENTION_FOLLOW_UP_FINDING_GROUPS = [
  "NO_REVIEW_REQUEST",
  "NO_LATER_JOB",
  "NO_REFERRAL_REQUEST",
] as const;

export type RetentionFollowUpFindingGroup = (typeof RETENTION_FOLLOW_UP_FINDING_GROUPS)[number];

export const RETENTION_READ_ONLY_MESSAGE =
  "This center lists recorded TBBT facts only. It does not send SMS or email, create review or referral requests, generate coupons, modify the pipeline, or create Controlled AI actions.";

export const RETENTION_OWNER_FOLLOW_UP_MESSAGE =
  "An owner can record or update a same-business follow-up task from a listed finding. This action does not send SMS or email.";

export const RETENTION_FOLLOW_UP_RECORDED_MESSAGE =
  "Follow-up task recorded. It has not been sent.";

export const RETENTION_FOLLOW_UP_UPDATED_MESSAGE =
  "Follow-up task already on file was updated. It has not been sent.";

export const RETENTION_FOLLOW_UP_OWNER_ONLY_MESSAGE = "Only the business owner can record this follow-up task.";

export const RETENTION_FOLLOW_UP_FOREIGN_CUSTOMER_MESSAGE = "That customer is not in this business.";

export const RETENTION_FOLLOW_UP_FOREIGN_JOB_MESSAGE = "That completed job is not in this business.";

export const RETENTION_FOLLOW_UP_JOB_CUSTOMER_MISMATCH_MESSAGE =
  "That job does not belong to this customer.";

export const RETENTION_FOLLOW_UP_JOB_NOT_COMPLETED_MESSAGE = "That job is not recorded as completed.";

export const RETENTION_FOLLOW_UP_UNKNOWN_FINDING_MESSAGE = "Choose a recorded retention finding.";

export const RETENTION_FOLLOW_UP_STALE_FINDING_MESSAGE = "This finding is no longer recorded.";

export const RETENTION_NO_CADENCE_MESSAGE =
  "TBBT does not invent a universal re-engagement interval here. Age since the last completed job is shown so the owner can decide.";

export const RETENTION_AGE_PREFIX = "Last completed job:";

export const CUSTOMER_FOLLOW_UP_STATUSES = ["OPEN", "SENT", "FAILED", "CANCELLED"] as const;
export type CustomerFollowUpStatus = (typeof CUSTOMER_FOLLOW_UP_STATUSES)[number];

export const CUSTOMER_FOLLOW_UP_STATUS_LABELS: Record<CustomerFollowUpStatus, string> = {
  OPEN: "OPEN",
  SENT: "SENT",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
};

export const CUSTOMER_FOLLOW_UP_KINDS = ["JOB_COMPLETE", "REPEAT"] as const;

export const FORBIDDEN_RETENTION_CLAIM_PATTERNS = [
  /likely to buy/i,
  /ready to buy/i,
  /ready to rebook/i,
  /churn risk/i,
  /customer owes us a review/i,
  /call today/i,
  /contact everyone after/i,
  /contact after \d+ days/i,
] as const;

export const FORBIDDEN_CADENCE_PATTERNS = [
  /contact everyone after 30 days/i,
  /contact everyone after 60 days/i,
  /contact everyone after 90 days/i,
  /call after 30 days/i,
  /call after 60 days/i,
  /call after 90 days/i,
] as const;
