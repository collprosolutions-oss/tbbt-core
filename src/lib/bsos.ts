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
  collectedRevenue?: { amount: number };
  recordedExpenses: { amount: number };
  growthRecoveryOpen?: { count: number };
  growthReactivationEligible?: { count: number };
  agedReceivables?: { count: number; amount: number };
  lowMarginServices?: { count: number };
  estimateLaborOverruns?: { count: number };
  expenseGrowthPercent?: number | null;
  customerConcentration?: { share: number | null; customerName: string | null };
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
      why: "Billed revenue is below recorded wage plus job expenses on one or more jobs.",
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

  if (facts.recurringExpenses.count > 0) {
    items.push({
      key: "review-recurring-expenses",
      title: "Review recorded recurring expenses",
      kind: "recommendation",
      priority: 40,
      why: "Recurring expense flags are on file. These are owner-recorded rows, not bank drafts.",
      facts: [
        {
          key: "recurring",
          label: "Recurring expenses",
          value: `${facts.recurringExpenses.count} / ${facts.recurringExpenses.amount.toFixed(2)}`,
          href: "/expenses",
        },
      ],
      href: "/expenses",
    });
  }

  if ((facts.growthRecoveryOpen?.count ?? 0) > 0) {
    items.push({
      key: "growth-lost-lead-recovery",
      title: "Work the lost-lead recovery queue",
      kind: "recommendation",
      priority: 18,
      why: "Recorded requests or estimates meet Growth recovery rules and have no auto-message.",
      facts: [
        {
          key: "recovery",
          label: "Recovery items",
          value: String(facts.growthRecoveryOpen!.count),
          href: "/growth?area=recovery",
        },
      ],
      href: "/growth?area=recovery",
    });
  }

  if ((facts.growthReactivationEligible?.count ?? 0) > 0) {
    items.push({
      key: "growth-reactivate-customers",
      title: "Reactivate prior customers",
      kind: "recommendation",
      priority: 32,
      why: "Completed customers meet elapsed-time, no-active-work, and consent rules.",
      facts: [
        {
          key: "reactivation",
          label: "Consent-eligible reactivation candidates",
          value: String(facts.growthReactivationEligible!.count),
          href: "/growth?area=reactivation",
        },
      ],
      href: "/growth?area=reactivation",
    });
  }

  if ((facts.agedReceivables?.count ?? 0) > 0) {
    items.push({
      key: "receivable-needs-attention",
      title: "Unpaid invoices are aging",
      kind: "recommendation",
      priority: 8,
      why: "SENT invoices have been outstanding more than 30 days. Age uses the issued date. Due dates are not invented.",
      facts: [
        {
          key: "aged-receivables",
          label: "Invoices older than 30 days",
          value: `${facts.agedReceivables!.count} / ${facts.agedReceivables!.amount.toFixed(2)}`,
          href: "/reports?area=receivables",
        },
      ],
      href: "/reports?area=receivables",
    });
  }

  if ((facts.lowMarginServices?.count ?? 0) > 0) {
    items.push({
      key: "service-margin-below-target",
      title: "Review services with negative recorded margin",
      kind: "recommendation",
      priority: 24,
      why: "Attributed completed work has billed revenue below recorded direct cost.",
      facts: [
        {
          key: "low-margin-services",
          label: "Services with negative recorded margin",
          value: String(facts.lowMarginServices!.count),
          href: "/reports?area=services",
        },
      ],
      href: "/reports?area=services",
    });
  }

  if ((facts.estimateLaborOverruns?.count ?? 0) > 0) {
    items.push({
      key: "estimate-labor-overrun",
      title: "Approved labor exceeded a recorded hours baseline",
      kind: "recommendation",
      priority: 23,
      why: "Approved time exceeded a trustworthy hours snapshot. Generic LABOR quantity is not treated as hours.",
      facts: [
        {
          key: "labor-overruns",
          label: "Jobs over a recorded hours baseline",
          value: String(facts.estimateLaborOverruns!.count),
          href: "/reports?area=estimate-accuracy",
        },
      ],
      href: "/reports?area=estimate-accuracy",
    });
  }

  if (facts.expenseGrowthPercent != null && facts.expenseGrowthPercent >= 25) {
    items.push({
      key: "expense-growth",
      title: "Recorded expenses grew versus the prior period",
      kind: "recommendation",
      priority: 38,
      why: "Active expense rows increased compared with the prior equivalent period.",
      facts: [
        {
          key: "expense-growth",
          label: "Expense change",
          value: `${facts.expenseGrowthPercent.toFixed(1)}%`,
          href: "/reports?area=expenses",
        },
      ],
      href: "/reports?area=expenses",
    });
  }

  if (facts.customerConcentration?.share != null && facts.customerConcentration.share >= 0.4) {
    items.push({
      key: "high-value-customer-concentration",
      title: "Collected revenue is concentrated in one customer",
      kind: "recommendation",
      priority: 36,
      why: "One customer accounts for a large share of recorded collected cash.",
      facts: [
        {
          key: "concentration",
          label: facts.customerConcentration.customerName ?? "Top customer",
          value: `${Math.round(facts.customerConcentration.share * 100)}%`,
          href: "/reports?area=customers",
        },
      ],
      href: "/reports?area=customers",
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
      label: facts.collectedRevenue ? "Collected cash" : "PAID invoice status",
      value: (facts.collectedRevenue ?? facts.paidRevenue).amount.toFixed(2),
      kind: "fact",
      href: "/reports",
      note: facts.collectedRevenue
        ? "Recorded payments plus legacy PAID invoices with no Payment rows. Not a bank balance."
        : "Invoice status PAID totals. Not collected cash unless a Payment exists.",
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
      note: "SENT invoices remaining balance after recorded payments.",
    },
    {
      key: "pipeline",
      label: "Sent estimates",
      value: String(facts.sentEstimates.count),
      kind: "fact",
      href: "/pipeline",
      note: "Recorded SENT estimates awaiting a decision.",
    },
    {
      key: "growth-recovery",
      label: "Growth recovery items",
      value: String(facts.growthRecoveryOpen?.count ?? 0),
      kind: "fact",
      href: "/growth?area=recovery",
      note: "Deterministic lost-lead recovery queue. No auto-message.",
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
