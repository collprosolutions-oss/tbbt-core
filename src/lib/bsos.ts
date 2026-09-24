/**
 * BSOS Business Health + Coach.
 *
 * Recommendations are derived from recorded TBBT facts only. Revenue,
 * bank balances, and external analytics are never fabricated. Each
 * recommendation carries the recorded facts that explain why it exists.
 */

export const BSOS_AREAS = [
  "health",
  "coach",
  "recommendations",
  "goals",
  "feed",
] as const;
export type BsosArea = (typeof BSOS_AREAS)[number];

export const BSOS_AREA_LABELS: Record<BsosArea, string> = {
  health: "Business Health",
  coach: "BSOS Coach",
  recommendations: "Recommendations",
  goals: "Goals & action plan",
  feed: "Attention & opportunities",
};

export function isBsosArea(value: string | undefined): value is BsosArea {
  return (BSOS_AREAS as readonly string[]).includes(value ?? "");
}

export function parseBsosArea(raw: string | undefined): BsosArea {
  return isBsosArea(raw) ? raw : "health";
}

export const GOAL_STATUSES = ["ACTIVE", "DONE", "PAUSED"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const ACTION_STATUSES = ["OPEN", "DONE", "DISMISSED"] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export function isGoalStatus(value: string): value is GoalStatus {
  return (GOAL_STATUSES as readonly string[]).includes(value);
}

export function isActionStatus(value: string): value is ActionStatus {
  return (ACTION_STATUSES as readonly string[]).includes(value);
}

export type RecordedFact = {
  key: string;
  label: string;
  value: string;
  href: string;
};

export type BsosRecommendation = {
  key: string;
  title: string;
  kind: "recommendation";
  priority: number;
  why: string;
  facts: RecordedFact[];
  href: string;
};

export type BsosHealthMetric = {
  key: string;
  label: string;
  value: string;
  kind: "fact";
  href: string;
  note: string;
};

export type BsosFacts = {
  unpaidInvoices: { count: number; amount: number };
  sentEstimates: { count: number };
  draftEstimates: { count: number };
  unscheduledJobs: { count: number };
  completedJobsWithoutReview: { count: number };
  completedJobsReadyForMarketing: { count: number };
  lowMarginJobs: { count: number };
  missingWageEntries: { count: number };
  availableCapacityDays: { count: number };
  repeatCustomers: { count: number };
  outsideAreaRequests: { count: number };
  recurringExpenses: { count: number; amount: number };
  paidRevenue: { amount: number };
  recordedExpenses: { amount: number };
};

export function buildBsosRecommendations(facts: BsosFacts): BsosRecommendation[] {
  const items: BsosRecommendation[] = [];

  if (facts.unpaidInvoices.count > 0) {
    items.push({
      key: "collect-unpaid-invoices",
      title: "Follow up on unpaid invoices",
      kind: "recommendation",
      priority: 10,
      why: "SENT invoices are still unpaid in TBBT records.",
      facts: [
        {
          key: "unpaid-count",
          label: "Unpaid invoices",
          value: String(facts.unpaidInvoices.count),
          href: "/invoices",
        },
      ],
      href: "/invoices",
    });
  }

  if (facts.sentEstimates.count > 0) {
    items.push({
      key: "follow-up-sent-estimates",
      title: "Follow up on sent estimates",
      kind: "recommendation",
      priority: 20,
      why: "Estimates remain SENT and have not been approved in TBBT.",
      facts: [
        {
          key: "sent-estimates",
          label: "Sent estimates",
          value: String(facts.sentEstimates.count),
          href: "/estimates",
        },
      ],
      href: "/pipeline",
    });
  }

  if (facts.lowMarginJobs.count > 0) {
    items.push({
      key: "review-low-margin-jobs",
      title: "Review low-margin jobs and services",
      kind: "recommendation",
      priority: 25,
      why: "Recorded paid revenue is below recorded labor plus job expenses on one or more jobs.",
      facts: [
        {
          key: "low-margin",
          label: "Low-margin jobs",
          value: String(facts.lowMarginJobs.count),
          href: "/reports?area=job-profitability",
        },
      ],
      href: "/reports?area=job-profitability",
    });
  }

  if (facts.missingWageEntries.count > 0) {
    items.push({
      key: "missing-wage-data",
      title: "Add missing wage / cost data",
      kind: "recommendation",
      priority: 15,
      why: "Approved time exists without a wage snapshot, so labor cost is incomplete.",
      facts: [
        {
          key: "missing-wage",
          label: "Approved entries missing wage",
          value: String(facts.missingWageEntries.count),
          href: "/time-cards",
        },
      ],
      href: "/time-cards",
    });
  }

  if (facts.availableCapacityDays.count > 0) {
    items.push({
      key: "available-schedule-capacity",
      title: "Fill available schedule capacity",
      kind: "recommendation",
      priority: 40,
      why: "Upcoming working days have no scheduled job on record.",
      facts: [
        {
          key: "open-days",
          label: "Open working days (next 7)",
          value: String(facts.availableCapacityDays.count),
          href: "/jobs",
        },
      ],
      href: "/jobs",
    });
  }

  if (facts.completedJobsReadyForMarketing.count > 0) {
    items.push({
      key: "market-completed-jobs",
      title: "Turn completed jobs into marketing content",
      kind: "recommendation",
      priority: 35,
      why: "Completed jobs have marketing-approved photos and no approved content yet.",
      facts: [
        {
          key: "ready-jobs",
          label: "Ready completed jobs",
          value: String(facts.completedJobsReadyForMarketing.count),
          href: "/marketing?area=grow",
        },
      ],
      href: "/marketing?area=grow",
    });
  }

  if (facts.completedJobsWithoutReview.count > 0) {
    items.push({
      key: "request-reviews",
      title: "Ask completed-job customers for an honest review",
      kind: "recommendation",
      priority: 30,
      why: "Completed jobs have no recorded review request. TBBT does not gate on expected rating.",
      facts: [
        {
          key: "no-review",
          label: "Completed jobs without a review request",
          value: String(facts.completedJobsWithoutReview.count),
          href: "/reviews?area=opportunities",
        },
      ],
      href: "/reviews?area=opportunities",
    });
  }

  if (facts.repeatCustomers.count > 0) {
    items.push({
      key: "repeat-customer-follow-up",
      title: "Reconnect with repeat customers",
      kind: "recommendation",
      priority: 45,
      why: "Customers with more than one completed job or paid invoice are on file.",
      facts: [
        {
          key: "repeat",
          label: "Repeat customers",
          value: String(facts.repeatCustomers.count),
          href: "/reviews?area=follow-up",
        },
      ],
      href: "/customers",
    });
  }

  if (facts.outsideAreaRequests.count > 0) {
    items.push({
      key: "outside-area-leads",
      title: "Review leads outside the preferred service area",
      kind: "recommendation",
      priority: 50,
      why: "Recorded requests were qualified as outside the owner-configured area.",
      facts: [
        {
          key: "outside",
          label: "Outside-area requests",
          value: String(facts.outsideAreaRequests.count),
          href: "/requests",
        },
      ],
      href: "/requests",
    });
  }

  if (facts.unscheduledJobs.count > 0) {
    items.push({
      key: "schedule-unscheduled-jobs",
      title: "Schedule unscheduled jobs",
      kind: "recommendation",
      priority: 22,
      why: "Approved work is sitting in UNSCHEDULED status.",
      facts: [
        {
          key: "unscheduled",
          label: "Unscheduled jobs",
          value: String(facts.unscheduledJobs.count),
          href: "/jobs",
        },
      ],
      href: "/jobs",
    });
  }

  return items.sort((a, b) => a.priority - b.priority);
}

export function buildBsosHealthMetrics(facts: BsosFacts): BsosHealthMetric[] {
  return [
    {
      key: "paid-revenue",
      label: "Recorded paid revenue",
      value: facts.paidRevenue.amount.toFixed(2),
      kind: "fact",
      href: "/reports",
      note: "PAID invoices only. Not a bank balance.",
    },
    {
      key: "recorded-expenses",
      label: "Recorded expenses",
      value: facts.recordedExpenses.amount.toFixed(2),
      kind: "fact",
      href: "/expenses",
      note: "Active expense rows only.",
    },
    {
      key: "outstanding",
      label: "Outstanding receivables",
      value: `${facts.unpaidInvoices.count} / ${facts.unpaidInvoices.amount.toFixed(2)}`,
      kind: "fact",
      href: "/invoices",
      note: "SENT invoices still unpaid.",
    },
    {
      key: "pipeline",
      label: "Sent estimates",
      value: String(facts.sentEstimates.count),
      kind: "fact",
      href: "/pipeline",
      note: "Recorded SENT estimates awaiting a decision.",
    },
  ];
}

export function coachSummary(recommendations: readonly BsosRecommendation[]): string {
  if (recommendations.length === 0) {
    return "No prioritized recommendations from recorded TBBT activity right now. Health metrics below are facts, not advice.";
  }
  const top = recommendations[0]!;
  return `Top recommendation: ${top.title}. ${top.why}`;
}
