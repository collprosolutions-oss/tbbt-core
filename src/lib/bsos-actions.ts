import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { createBusinessActionItem } from "@/lib/bsos-ops";
import type { BsosRecommendation } from "@/lib/bsos";

type Db = PrismaClient | Prisma.TransactionClient;

const RECOMMENDATION_ACTION_TITLES: Record<string, string> = {
  "collect-unpaid-invoices": "Review unpaid invoices and follow up",
  "follow-up-sent-estimates": "Follow up on sent estimates",
  "review-low-margin-jobs": "Inspect low-margin jobs and service pricing",
  "missing-wage-data": "Update missing labor cost / wage data",
  "available-schedule-capacity": "Fill open schedule capacity",
  "market-completed-jobs": "Draft marketing from a completed job",
  "request-reviews": "Prepare an honest review request",
  "repeat-customer-follow-up": "Reconnect with a repeat customer",
  "outside-area-leads": "Review outside-area requests",
  "review-recurring-expenses": "Add or review recurring expense information",
  "schedule-unscheduled-jobs": "Schedule unscheduled jobs",
  "receivable-needs-attention": "Follow up on aging unpaid invoices",
  "unbilled-completed-jobs": "Create or send invoices for completed unbilled work",
  "service-margin-below-target": "Review services with negative recorded margin",
  "estimate-labor-overrun": "Review estimate labor hours against actual time",
  "expense-growth": "Review expense growth versus the prior period",
  "high-value-customer-concentration": "Review customer concentration risk",
  "workforce-overloaded-day": "Relieve an overloaded scheduled day",
  "workforce-unassigned-job": "Assign a worker to scheduled jobs",
  "workforce-poor-skill-match": "Review jobs assigned without required skills",
  "workforce-double-booked": "Resolve a double-booked worker",
  "workforce-capacity-gap": "Fill upcoming open workforce capacity",
  "workforce-staffing-shortage": "Review staffing for upcoming work",
};

export function actionTitleForRecommendation(recommendation: BsosRecommendation) {
  return RECOMMENDATION_ACTION_TITLES[recommendation.key] ?? recommendation.title;
}

export function recommendationEvidenceKey(recommendation: BsosRecommendation) {
  return recommendation.facts
    .map((fact) => `${fact.key}:${fact.value}`)
    .sort()
    .join("|");
}

export async function upsertRecommendationState(
  db: Db,
  access: BusinessAccess,
  input: {
    recommendationKey: string;
    status: "OPEN" | "DISMISSED" | "COMPLETED";
    actionItemId?: string;
    evidenceKey?: string;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.VIEW_REPORTS);
  const existing = await db.bsosRecommendationState.findUnique({
    where: {
      businessId_recommendationKey: {
        businessId: access.businessId,
        recommendationKey: input.recommendationKey,
      },
    },
  });
  const evidenceKey = input.evidenceKey ?? existing?.evidenceKey ?? "";
  const history =
    existing && existing.evidenceKey && existing.evidenceKey !== evidenceKey
      ? [
          ...((Array.isArray(existing.history) ? existing.history : []) as Array<Record<string, unknown>>),
          {
            evidenceKey: existing.evidenceKey,
            status: existing.status,
            actionItemId: existing.actionItemId,
            at: existing.updatedAt.toISOString(),
          },
        ]
      : existing?.history;
  return db.bsosRecommendationState.upsert({
    where: {
      businessId_recommendationKey: {
        businessId: access.businessId,
        recommendationKey: input.recommendationKey,
      },
    },
    create: {
      businessId: access.businessId,
      recommendationKey: input.recommendationKey,
      status: input.status,
      evidenceKey,
      history: history === undefined ? undefined : (history as Prisma.InputJsonValue),
      actionItemId: input.actionItemId ?? null,
      updatedByMembershipId: access.workspace.membership.id,
    },
    update: {
      status: input.status,
      evidenceKey,
      history: history === undefined ? undefined : (history as Prisma.InputJsonValue),
      actionItemId: input.actionItemId ?? undefined,
      updatedByMembershipId: access.workspace.membership.id,
    },
  });
}

export async function createActionFromRecommendation(
  db: Db,
  access: BusinessAccess,
  recommendation: BsosRecommendation,
) {
  requireBusinessCapability(access, CAPABILITIES.VIEW_REPORTS);
  const action = await createBusinessActionItem(db, access, {
    title: actionTitleForRecommendation(recommendation),
    recommendationKey: recommendation.key,
    notes: recommendation.why,
  });
  await upsertRecommendationState(db, access, {
    recommendationKey: recommendation.key,
    status: "OPEN",
    evidenceKey: recommendationEvidenceKey(recommendation),
    actionItemId: action.id,
  });
  return action;
}

export function partitionRecommendations(
  recommendations: BsosRecommendation[],
  states: Array<{ recommendationKey: string; status: string; evidenceKey?: string | null }>,
) {
  const active = recommendations.filter((item) => {
    const evidenceKey = recommendationEvidenceKey(item);
    const match = states.find(
      (row) => row.recommendationKey === item.key && (row.evidenceKey ?? "") === evidenceKey,
    );
    return match?.status !== "DISMISSED" && match?.status !== "COMPLETED";
  });
  const history = recommendations.filter((item) => {
    const evidenceKey = recommendationEvidenceKey(item);
    const match = states.find(
      (row) => row.recommendationKey === item.key && (row.evidenceKey ?? "") === evidenceKey,
    );
    return match?.status === "DISMISSED" || match?.status === "COMPLETED";
  });
  return { active, history };
}
