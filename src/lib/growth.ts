/**
 * Growth Department domain — lead-to-revenue loop over recorded TBBT
 * records. Never invents stages, ROI, rankings, or social publishing.
 *
 * No next/headers dependency — authorization/isolation check scripts
 * import these helpers directly.
 */

export const GROWTH_AREAS = [
  "overview",
  "funnel",
  "attribution",
  "campaigns",
  "recovery",
  "reactivation",
  "reviews",
  "referrals",
  "local",
  "recommendations",
  "social",
] as const;
export type GrowthArea = (typeof GROWTH_AREAS)[number];

export const GROWTH_AREA_LABELS: Record<GrowthArea, string> = {
  overview: "Overview",
  funnel: "Funnel",
  attribution: "Attribution",
  campaigns: "Campaigns",
  recovery: "Lost-lead recovery",
  reactivation: "Reactivation",
  reviews: "Reviews",
  referrals: "Referrals",
  local: "Local growth",
  recommendations: "Recommendations",
  social: "Social",
};

export function isGrowthArea(value: string | undefined): value is GrowthArea {
  return (GROWTH_AREAS as readonly string[]).includes(value ?? "");
}

export function parseGrowthArea(raw: string | undefined): GrowthArea {
  return isGrowthArea(raw) ? raw : "overview";
}

export const GROWTH_FUNNEL_STAGES = [
  "lead",
  "estimate",
  "approved",
  "lost",
  "job",
  "invoice",
  "collected",
  "review",
  "referral",
] as const;
export type GrowthFunnelStage = (typeof GROWTH_FUNNEL_STAGES)[number];

export const GROWTH_FUNNEL_STAGE_LABELS: Record<GrowthFunnelStage, string> = {
  lead: "Lead / request",
  estimate: "Estimate",
  approved: "Approved",
  lost: "Lost",
  job: "Job",
  invoice: "Invoice",
  collected: "Collected revenue",
  review: "Review",
  referral: "Referral / reactivation",
};

export const ATTRIBUTION_KINDS = [
  "SOURCE",
  "CAMPAIGN",
  "LANDING_PAGE",
  "REFERRAL",
  "REPEAT_CUSTOMER",
  "UNKNOWN",
] as const;
export type AttributionKind = (typeof ATTRIBUTION_KINDS)[number];

export const ATTRIBUTION_KIND_LABELS: Record<AttributionKind, string> = {
  SOURCE: "Recorded source",
  CAMPAIGN: "Campaign",
  LANDING_PAGE: "Landing / local page",
  REFERRAL: "Referral",
  REPEAT_CUSTOMER: "Repeat customer",
  UNKNOWN: "Unknown",
};

export const RECOVERY_QUEUES = [
  "NEVER_ESTIMATED",
  "ESTIMATE_NO_RESPONSE",
  "ESTIMATE_LOST",
  "MISSED_FOLLOW_UP",
  "DORMANT",
] as const;
export type RecoveryQueue = (typeof RECOVERY_QUEUES)[number];

export const RECOVERY_QUEUE_LABELS: Record<RecoveryQueue, string> = {
  NEVER_ESTIMATED: "Request never estimated",
  ESTIMATE_NO_RESPONSE: "Estimate sent / no response",
  ESTIMATE_LOST: "Estimate lost",
  MISSED_FOLLOW_UP: "Missed follow-up",
  DORMANT: "Dormant opportunity",
};

export const GROWTH_ACTION_KINDS = [
  "RECOVERY",
  "REACTIVATION",
  "REVIEW_ASK",
  "REFERRAL_ASK",
] as const;
export type GrowthActionKind = (typeof GROWTH_ACTION_KINDS)[number];

export const GROWTH_ACTION_QUEUES = [
  ...RECOVERY_QUEUES,
  "REACTIVATION",
] as const;
export type GrowthActionQueue = (typeof GROWTH_ACTION_QUEUES)[number];

export const GROWTH_ACTION_STATUSES = ["OPEN", "APPROVED", "CANCELLED", "COMPLETED"] as const;
export type GrowthActionStatus = (typeof GROWTH_ACTION_STATUSES)[number];

export function isGrowthActionKind(value: string): value is GrowthActionKind {
  return (GROWTH_ACTION_KINDS as readonly string[]).includes(value);
}

export function isGrowthActionQueue(value: string): value is GrowthActionQueue {
  return (GROWTH_ACTION_QUEUES as readonly string[]).includes(value);
}

export function isGrowthActionStatus(value: string): value is GrowthActionStatus {
  return (GROWTH_ACTION_STATUSES as readonly string[]).includes(value);
}

export function isRecoveryQueue(value: string): value is RecoveryQueue {
  return (RECOVERY_QUEUES as readonly string[]).includes(value);
}

/** SENT estimates with no owner response after this many days. */
export const ESTIMATE_NO_RESPONSE_AFTER_DAYS = 3;
/** Open opportunities with no recorded activity after this many days. */
export const DORMANT_OPPORTUNITY_AFTER_DAYS = 14;
/** Completed customers with no active work after this many days. */
export const REACTIVATION_AFTER_DAYS = 90;

export const COST_ROI_UNAVAILABLE_MESSAGE =
  "Campaign cost is not on file. Cost and ROI are unavailable. TBBT will not invent spend.";

export { COLLECTED_CASH_MESSAGE } from "@/lib/collected-cash";

export const OWNER_APPROVAL_REQUIRED_MESSAGE =
  "Approving reactivation requires the OWNER role. ADMIN may prepare an open action, but cannot approve it.";

export const SOCIAL_DISCONNECTED_MESSAGE =
  "No Facebook or Instagram account is connected. Growth keeps content planning and drafting only. Automatic publishing is not available.";

export const RANKING_UNAVAILABLE_MESSAGE =
  "Google ranking data is not connected. Local growth uses recorded service-area and website activity only.";

export const ORIGINAL_SOURCE_PRESERVED_MESSAGE =
  "The original acquisition source is preserved. A later campaign or owner correction does not overwrite first-touch fields.";

export const GROWTH_NO_AUTO_MESSAGE =
  "Growth does not message customers. Communications owns delivery. This creates a durable follow-up request only.";

export const GROWTH_NO_SPAM_MESSAGE =
  "Reactivation requires OWNER approval. TBBT will not blast customers.";

export const GROWTH_ATTEMPT_ID_REQUIRED_MESSAGE = "Retry that request from the form.";

const GROWTH_ATTEMPT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Browser-generated id for one logical create/approve click. */
export function isGrowthAttemptId(value: string | null | undefined): value is string {
  return Boolean(value && GROWTH_ATTEMPT_ID_PATTERN.test(value.trim()));
}

/**
 * Attempt-scoped key for one logical GrowthActionRequest click.
 * Customer is only a disambiguator for a multi-select submit, never a
 * permanent "this customer forever" key.
 */
export function growthActionIdempotencyKey(input: {
  attemptId: string;
  customerId?: string | null;
}) {
  const attemptId = input.attemptId.trim();
  const customerId = input.customerId?.trim();
  return customerId ? `GROWTH_ACTION:${attemptId}:${customerId}` : `GROWTH_ACTION:${attemptId}`;
}

export function growthReactivationApprovedEventKey(actionId: string) {
  return `GROWTH_REACTIVATION_APPROVED:${actionId}`;
}

export function growthRecoveryQueuedEventKey(actionId: string) {
  return `GROWTH_RECOVERY_QUEUED:${actionId}`;
}

export type GrowthEvidence = {
  key: string;
  label: string;
  value: string;
  href: string;
};

export type GrowthRecommendation = {
  key: string;
  title: string;
  why: string;
  evidence: GrowthEvidence[];
  href: string;
  priority: number;
};
