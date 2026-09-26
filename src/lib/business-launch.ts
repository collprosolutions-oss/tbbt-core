/**
 * Business Launch Experience domain.
 *
 * Progressive, resumable OWNER setup. This is not a second settings store.
 * Progress is always completedDefinedSteps / definedStepCount — never a
 * fake or dynamic percentage.
 */

export const BUSINESS_LAUNCH_PATH = "/launch";
export const BUSINESS_LAUNCH_BUILD_PATH = "/launch/build";

export const LAUNCH_STEP_KEYS = [
  "identity",
  "trades",
  "service_area",
  "services",
  "pricing",
  "hours",
  "scheduling",
  "team",
  "payments",
  "communication",
  "brand_voice",
  "website",
  "goals",
  "stage",
] as const;
export type LaunchStepKey = (typeof LAUNCH_STEP_KEYS)[number];

export const LAUNCH_STEP_LABELS: Record<LaunchStepKey, string> = {
  identity: "Business identity",
  trades: "Active trade(s)",
  service_area: "Service area",
  services: "Services offered",
  pricing: "Pricing approach",
  hours: "Operating hours",
  scheduling: "Scheduling preferences",
  team: "Team structure",
  payments: "Payment preferences",
  communication: "Customer communication",
  brand_voice: "Brand voice",
  website: "Website readiness",
  goals: "Business goals",
  stage: "Current business stage",
};

export const LAUNCH_STEP_SUMMARIES: Record<LaunchStepKey, string> = {
  identity: "Name and public contact customers already see.",
  trades: "Confirm the trades already active on this workspace.",
  service_area: "Where you actually take work.",
  services: "The services you offer today. Prices stay owner-controlled.",
  pricing: "How you charge, plus an optional minimum service charge.",
  hours: "Normal working days and hours.",
  scheduling: "Buffer and how you like jobs booked.",
  team: "Who does the work — notes only, no invented employees.",
  payments: "How customers pay you. This is not TBBT software billing.",
  communication: "Estimate, schedule, and invoice preferences.",
  brand_voice: "How TBBT should sound when it writes for you.",
  website: "About copy and readiness. Publishing stays a separate action.",
  goals: "What you want the business to get better at.",
  stage: "Where the company is today so later advice stays honest.",
};

export function isLaunchStepKey(value: string | undefined): value is LaunchStepKey {
  return (LAUNCH_STEP_KEYS as readonly string[]).includes(value ?? "");
}

export function parseLaunchStepKey(raw: string | undefined): LaunchStepKey {
  return isLaunchStepKey(raw) ? raw : "identity";
}

export const LAUNCH_STEP_STATUSES = ["PENDING", "COMPLETED", "SKIPPED", "DEFERRED"] as const;
export type LaunchStepStatus = (typeof LAUNCH_STEP_STATUSES)[number];

export function isLaunchStepStatus(value: string | undefined): value is LaunchStepStatus {
  return (LAUNCH_STEP_STATUSES as readonly string[]).includes(value ?? "");
}

export const LAUNCH_PROGRESS_STATUSES = ["IN_PROGRESS", "COMPLETED"] as const;
export type LaunchProgressStatus = (typeof LAUNCH_PROGRESS_STATUSES)[number];

export const BUSINESS_STAGES = ["STARTING", "GROWING", "ESTABLISHED", "STABILIZING"] as const;
export type BusinessStage = (typeof BUSINESS_STAGES)[number];

export const BUSINESS_STAGE_LABELS: Record<BusinessStage, string> = {
  STARTING: "Just starting",
  GROWING: "Growing",
  ESTABLISHED: "Established",
  STABILIZING: "Stabilizing operations",
};

export function isBusinessStage(value: string | undefined): value is BusinessStage {
  return (BUSINESS_STAGES as readonly string[]).includes(value ?? "");
}

export const PRICING_APPROACHES = ["HOURLY", "FLAT", "MIXED", "CUSTOM"] as const;
export type PricingApproach = (typeof PRICING_APPROACHES)[number];

export const PRICING_APPROACH_LABELS: Record<PricingApproach, string> = {
  HOURLY: "Mostly hourly",
  FLAT: "Mostly flat-rate",
  MIXED: "Mix of hourly and flat",
  CUSTOM: "Custom / quote each job",
};

export function isPricingApproach(value: string | undefined): value is PricingApproach {
  return (PRICING_APPROACHES as readonly string[]).includes(value ?? "");
}

export type LaunchStepRecord = {
  stepKey: LaunchStepKey;
  status: LaunchStepStatus;
  completedAt: Date | null;
  skippedAt: Date | null;
  deferredAt: Date | null;
};

export type LaunchProgressSummary = {
  status: LaunchProgressStatus;
  hasRecordedProgress: boolean;
  definedStepCount: number;
  completedCount: number;
  skippedCount: number;
  deferredCount: number;
  pendingCount: number;
  progressPercent: number;
  recommendedNext: LaunchStepKey | null;
  resumeLaterAt: Date | null;
  completedAt: Date | null;
  lastStepKey: LaunchStepKey | null;
  steps: LaunchStepRecord[];
};

export function buildLaunchProgressSummary(input: {
  status?: string | null;
  lastStepKey?: string | null;
  resumeLaterAt?: Date | null;
  completedAt?: Date | null;
  hasRecordedProgress?: boolean;
  steps?: Array<{
    stepKey: string;
    status: string;
    completedAt?: Date | null;
    skippedAt?: Date | null;
    deferredAt?: Date | null;
  }>;
}): LaunchProgressSummary {
  const byKey = new Map((input.steps ?? []).map((step) => [step.stepKey, step]));
  const steps: LaunchStepRecord[] = LAUNCH_STEP_KEYS.map((stepKey) => {
    const row = byKey.get(stepKey);
    const status = isLaunchStepStatus(row?.status) ? row.status : "PENDING";
    return {
      stepKey,
      status,
      completedAt: row?.completedAt ?? null,
      skippedAt: row?.skippedAt ?? null,
      deferredAt: row?.deferredAt ?? null,
    };
  });
  const completedCount = steps.filter((step) => step.status === "COMPLETED").length;
  const skippedCount = steps.filter((step) => step.status === "SKIPPED").length;
  const deferredCount = steps.filter((step) => step.status === "DEFERRED").length;
  const pendingCount = steps.filter((step) => step.status === "PENDING").length;
  const definedStepCount = LAUNCH_STEP_KEYS.length;
  const recommendedNext =
    steps.find((step) => step.status === "PENDING")?.stepKey ??
    steps.find((step) => step.status === "DEFERRED")?.stepKey ??
    null;
  const allResolved = pendingCount === 0 && deferredCount === 0;
  const lastStepKey =
    input.lastStepKey && isLaunchStepKey(input.lastStepKey) ? input.lastStepKey : null;
  return {
    status: input.status === "COMPLETED" || allResolved ? "COMPLETED" : "IN_PROGRESS",
    hasRecordedProgress: Boolean(input.hasRecordedProgress),
    definedStepCount,
    completedCount,
    skippedCount,
    deferredCount,
    pendingCount,
    progressPercent: Math.round((completedCount / definedStepCount) * 100),
    recommendedNext,
    resumeLaterAt: input.resumeLaterAt ?? null,
    completedAt: input.completedAt ?? null,
    lastStepKey,
    steps,
  };
}

export function ownerNeedsBusinessLaunch(input: {
  role: string;
  launch?: { status: string; resumeLaterAt?: Date | null } | null;
}) {
  return (
    input.role === "OWNER" &&
    Boolean(input.launch) &&
    input.launch?.status === "IN_PROGRESS" &&
    !input.launch?.resumeLaterAt
  );
}

export const LAUNCH_TRADE_CONFIRM_ONLY_MESSAGE =
  "Launch can only confirm trades already active on this business. It cannot enable a new trade or change the subscription.";

export const LAUNCH_NO_PUBLISH_MESSAGE =
  "Website publishing is a separate owner action. Launch never publishes the public site.";

export const LAUNCH_NO_SUBSCRIPTION_MESSAGE =
  "Launch never changes the TBBT subscription or plan.";

export const LAUNCH_NO_SILENT_PRICING_MESSAGE =
  "Pricing is not saved unless the owner confirms the change. Suggested prices stay a proposal.";
