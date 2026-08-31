/**
 * Deals / Pipeline domain -- a visual sales layer over existing
 * ServiceRequest, Customer, Property, Estimate, and Job records.
 *
 * This is not a second CRM. Automatic stages are derived from Estimate
 * and Job lifecycle. Owner-managed stages persist only the facts that
 * do not already exist elsewhere. Stronger downstream business facts
 * always win over contradictory manual state.
 *
 * No next/headers dependency -- authorization/isolation check scripts
 * import these helpers directly.
 */

import { parseScheduleDate, startOfDay } from "@/lib/schedule";

export const PIPELINE_STAGES = [
  "NEW_LEAD",
  "CONTACTED",
  "SITE_VISIT_NEEDS_INFO",
  "ESTIMATE_IN_PROGRESS",
  "ESTIMATE_SENT",
  "FOLLOW_UP",
  "WON",
  "LOST",
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const PIPELINE_STAGE_LABELS: Record<PipelineStage, string> = {
  NEW_LEAD: "New Lead",
  CONTACTED: "Contacted",
  SITE_VISIT_NEEDS_INFO: "Site Visit / Needs Info",
  ESTIMATE_IN_PROGRESS: "Estimate in Progress",
  ESTIMATE_SENT: "Estimate Sent",
  FOLLOW_UP: "Follow-Up",
  WON: "Won",
  LOST: "Lost",
};

export const OWNER_MANAGED_STAGES = [
  "CONTACTED",
  "SITE_VISIT_NEEDS_INFO",
  "FOLLOW_UP",
  "LOST",
] as const;
export type PipelineOwnerStage = (typeof OWNER_MANAGED_STAGES)[number];

export function isPipelineStage(value: string | undefined): value is PipelineStage {
  return (PIPELINE_STAGES as readonly string[]).includes(value ?? "");
}

export function isOwnerManagedStage(value: string | null | undefined): value is PipelineOwnerStage {
  return (OWNER_MANAGED_STAGES as readonly string[]).includes(value ?? "");
}

export const PIPELINE_LOSS_REASONS = [
  "PRICE",
  "OTHER_CONTRACTOR",
  "POSTPONED",
  "UNABLE_TO_REACH",
  "OUTSIDE_SCOPE",
  "SCHEDULING",
  "OTHER",
] as const;
export type PipelineLossReason = (typeof PIPELINE_LOSS_REASONS)[number];

export const PIPELINE_LOSS_REASON_LABELS: Record<PipelineLossReason, string> = {
  PRICE: "Price",
  OTHER_CONTRACTOR: "Customer chose another contractor",
  POSTPONED: "Customer postponed",
  UNABLE_TO_REACH: "Unable to reach",
  OUTSIDE_SCOPE: "Outside service scope",
  SCHEDULING: "Scheduling",
  OTHER: "Other",
};

export function isPipelineLossReason(value: string | undefined): value is PipelineLossReason {
  return (PIPELINE_LOSS_REASONS as readonly string[]).includes(value ?? "");
}

export const PIPELINE_ACTIVITY_FILTERS = ["all", "today", "week", "older"] as const;
export type PipelineActivityFilter = (typeof PIPELINE_ACTIVITY_FILTERS)[number];

export const PIPELINE_ACTIVITY_FILTER_LABELS: Record<PipelineActivityFilter, string> = {
  all: "All activity",
  today: "Updated today",
  week: "Updated this week",
  older: "Older than a week",
};

export function isPipelineActivityFilter(value: string | undefined): value is PipelineActivityFilter {
  return (PIPELINE_ACTIVITY_FILTERS as readonly string[]).includes(value ?? "");
}

export function parsePipelineStageFilter(raw: string | undefined): PipelineStage | "all" {
  return isPipelineStage(raw) ? raw : "all";
}

export function parsePipelineActivityFilter(raw: string | undefined): PipelineActivityFilter {
  return isPipelineActivityFilter(raw) ? raw : "all";
}

export type FollowUpStatus = "none" | "overdue" | "due_today" | "upcoming";

export const FOLLOW_UP_STATUS_LABELS: Record<FollowUpStatus, string> = {
  none: "No follow-up date",
  overdue: "Overdue",
  due_today: "Due today",
  upcoming: "Upcoming",
};

export function followUpStatus(
  followUpOn: Date | null | undefined,
  now: Date = new Date(),
): FollowUpStatus {
  if (!followUpOn) return "none";
  const due = startOfDay(followUpOn).getTime();
  const today = startOfDay(now).getTime();
  if (due < today) return "overdue";
  if (due === today) return "due_today";
  return "upcoming";
}

export function parsePipelineDate(raw: string | undefined): Date | null {
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

export type PipelineFacts = {
  ownerStage: string | null | undefined;
  estimateStatus: string | null | undefined;
  hasJob: boolean;
};

/**
 * Resolve the displayed pipeline stage.
 *
 * Automatic (stronger, cannot be contradicted):
 *   approved estimate or resulting Job → WON
 *   SENT estimate → ESTIMATE_SENT (unless owner set FOLLOW_UP or LOST)
 *   DRAFT estimate → ESTIMATE_IN_PROGRESS (unless owner set FOLLOW_UP or LOST)
 *   unconverted request with no estimate → NEW_LEAD
 *
 * Owner-managed (persist because they may not exist elsewhere):
 *   CONTACTED, SITE_VISIT_NEEDS_INFO, FOLLOW_UP, LOST
 */
export function resolvePipelineStage(input: PipelineFacts): PipelineStage {
  if (input.hasJob || input.estimateStatus === "APPROVED") {
    return "WON";
  }

  const owner = isOwnerManagedStage(input.ownerStage) ? input.ownerStage : null;

  if (input.estimateStatus === "SENT") {
    if (owner === "FOLLOW_UP" || owner === "LOST") return owner;
    return "ESTIMATE_SENT";
  }

  if (input.estimateStatus === "DRAFT") {
    if (owner === "FOLLOW_UP" || owner === "LOST") return owner;
    return "ESTIMATE_IN_PROGRESS";
  }

  if (owner) return owner;
  return "NEW_LEAD";
}

export function allowedOwnerStages(input: PipelineFacts): PipelineOwnerStage[] {
  if (input.hasJob || input.estimateStatus === "APPROVED") return [];
  if (input.estimateStatus === "SENT" || input.estimateStatus === "DRAFT") {
    return ["FOLLOW_UP", "LOST"];
  }
  return ["CONTACTED", "SITE_VISIT_NEEDS_INFO", "FOLLOW_UP", "LOST"];
}

export function canClearOwnerStage(input: PipelineFacts): boolean {
  return allowedOwnerStages(input).length > 0;
}

export function isOpenPipelineStage(stage: PipelineStage): boolean {
  return stage !== "WON" && stage !== "LOST";
}

const ESTIMATE_STATUS_RANK: Record<string, number> = {
  APPROVED: 3,
  SENT: 2,
  DRAFT: 1,
};

export function pickPrimaryEstimate<T extends { status: string; updatedAt: Date }>(
  estimates: readonly T[],
): T | null {
  if (estimates.length === 0) return null;
  return [...estimates].sort((a, b) => {
    const rank =
      (ESTIMATE_STATUS_RANK[b.status] ?? 0) - (ESTIMATE_STATUS_RANK[a.status] ?? 0);
    if (rank !== 0) return rank;
    return b.updatedAt.getTime() - a.updatedAt.getTime();
  })[0]!;
}

/**
 * Deal value comes only from a real estimate (live total or the sent /
 * approved version snapshot). Catalog starting prices are never used.
 * A DRAFT estimate with a default 0 total is not treated as a deal value.
 */
export function estimateDealValue(estimate: {
  status: string;
  total: { toString(): string } | number | string;
  approvedVersion?: { total: { toString(): string } | number | string } | null;
  versions?: readonly { total: { toString(): string } | number | string }[];
} | null): string | null {
  if (!estimate) return null;
  if (estimate.status === "APPROVED" && estimate.approvedVersion) {
    return decimalString(estimate.approvedVersion.total);
  }
  if (estimate.status === "SENT" && estimate.versions && estimate.versions.length > 0) {
    return decimalString(estimate.versions[0]!.total);
  }
  const raw = decimalString(estimate.total);
  if (estimate.status === "DRAFT" && Number(raw) <= 0) return null;
  return raw;
}

function decimalString(value: { toString(): string } | number | string): string {
  return typeof value === "number" ? value.toFixed(2) : Number(value.toString()).toFixed(2);
}

export function sumDealValues(values: readonly (string | null | undefined)[]): string | null {
  let total = 0;
  let any = false;
  for (const value of values) {
    if (value == null) continue;
    const amount = Number(value);
    if (!Number.isFinite(amount)) continue;
    total += amount;
    any = true;
  }
  return any ? total.toFixed(2) : null;
}

export function opportunityKey(input: {
  serviceRequestId?: string | null;
  estimateId?: string | null;
  jobId?: string | null;
}): string {
  if (input.serviceRequestId) return `request:${input.serviceRequestId}`;
  if (input.estimateId) return `estimate:${input.estimateId}`;
  if (input.jobId) return `job:${input.jobId}`;
  throw new Error("An opportunity must be keyed by a request, estimate, or job.");
}

export function parseOpportunityKey(raw: string | undefined): {
  serviceRequestId?: string;
  estimateId?: string;
  jobId?: string;
} | null {
  if (!raw) return null;
  const [kind, id] = raw.split(":");
  if (!id) return null;
  if (kind === "request") return { serviceRequestId: id };
  if (kind === "estimate") return { estimateId: id };
  if (kind === "job") return { jobId: id };
  return null;
}

export function daysSince(date: Date, now: Date = new Date()): number {
  const start = startOfDay(date).getTime();
  const today = startOfDay(now).getTime();
  return Math.max(0, Math.round((today - start) / 86_400_000));
}

export function matchesActivityFilter(
  lastActivity: Date,
  filter: PipelineActivityFilter,
  now: Date = new Date(),
): boolean {
  if (filter === "all") return true;
  const activity = startOfDay(lastActivity).getTime();
  const today = startOfDay(now).getTime();
  const weekAgo = today - 6 * 86_400_000;
  if (filter === "today") return activity === today;
  if (filter === "week") return activity >= weekAgo;
  return activity < weekAgo;
}

export function matchesPipelineSearch(
  haystacks: readonly (string | null | undefined)[],
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return haystacks.some((value) => (value ?? "").toLowerCase().includes(needle));
}

export function needsFollowUpAttention(input: {
  stage: PipelineStage;
  followUp: FollowUpStatus;
}): boolean {
  if (input.stage === "WON" || input.stage === "LOST") return false;
  return input.followUp === "overdue" || input.followUp === "due_today";
}

export function needsOwnerLeadAction(stage: PipelineStage): boolean {
  return stage === "NEW_LEAD" || stage === "SITE_VISIT_NEEDS_INFO";
}

export type AttentionKind = "follow_up_overdue" | "estimate_sent_follow_up" | "lead_action";

export const ATTENTION_KIND_LABELS: Record<AttentionKind, string> = {
  follow_up_overdue: "Follow-up overdue",
  estimate_sent_follow_up: "Sent estimate with follow-up due",
  lead_action: "Lead requiring owner action",
};

export function attentionKinds(input: {
  stage: PipelineStage;
  followUp: FollowUpStatus;
  estimateStatus: string | null;
}): AttentionKind[] {
  const kinds: AttentionKind[] = [];
  if (input.stage !== "WON" && input.stage !== "LOST" && input.followUp === "overdue") {
    kinds.push("follow_up_overdue");
  }
  if (
    (input.stage === "ESTIMATE_SENT" || input.estimateStatus === "SENT") &&
    input.stage !== "WON" &&
    input.stage !== "LOST" &&
    (input.followUp === "overdue" || input.followUp === "due_today")
  ) {
    kinds.push("estimate_sent_follow_up");
  }
  if (needsOwnerLeadAction(input.stage)) {
    kinds.push("lead_action");
  }
  return kinds;
}
