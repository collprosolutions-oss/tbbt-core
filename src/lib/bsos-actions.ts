import type { Prisma, PrismaClient } from "@prisma/client";
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
};

export function actionTitleForRecommendation(recommendation: BsosRecommendation) {
  return RECOMMENDATION_ACTION_TITLES[recommendation.key] ?? recommendation.title;
}

export async function upsertRecommendationState(
  db: Db,
  access: BusinessAccess,
  input: { recommendationKey: string; status: "OPEN" | "DISMISSED" | "COMPLETED"; actionItemId?: string },
) {
  requireBusinessCapability(access, CAPABILITIES.VIEW_REPORTS);
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
      actionItemId: input.actionItemId ?? null,
      updatedByMembershipId: access.workspace.membership.id,
    },
    update: {
      status: input.status,
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
    actionItemId: action.id,
  });
  return action;
}

export function partitionRecommendations(
  recommendations: BsosRecommendation[],
  states: Array<{ recommendationKey: string; status: string }>,
) {
  const byKey = new Map(states.map((row) => [row.recommendationKey, row.status]));
  const active = recommendations.filter((item) => {
    const status = byKey.get(item.key);
    return status !== "DISMISSED" && status !== "COMPLETED";
  });
  const history = recommendations.filter((item) => {
    const status = byKey.get(item.key);
    return status === "DISMISSED" || status === "COMPLETED";
  });
  return { active, history };
}
