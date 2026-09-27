/**
 * Owner review for staffing recommendations.
 *
 * Accept and dismiss reuse existing BsosRecommendationState / action-item
 * writes. Live availability, skill, and schedule facts are reloaded and
 * compared before any write. These paths never assign a worker, send a
 * message, create a hire, or change a Job schedule.
 */
import type { PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, ForbiddenError, requireBusinessCapability, requireBusinessRole } from "@/lib/authorization";
import {
  createActionFromRecommendation,
  partitionRecommendations,
  upsertRecommendationState,
} from "@/lib/bsos-actions";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { requireProductCapability } from "@/lib/product-entitlements";
import { loadWorkforceSnapshot } from "@/lib/workforce-data";
import { WorkforceError } from "@/lib/workforce-ops";
import {
  buildStaffingReviewRecommendations,
  findLiveStaffingRecommendation,
  isStaffingReviewKey,
  staffingReviewEvidenceKey,
  type StaffingReviewDecision,
} from "@/lib/workforce-staffing";

type Db = PrismaClient;

const STALE_MESSAGE =
  "Those staffing facts changed. Refresh and review again. TBBT did not assign anyone or change the schedule.";

export function staffingReviewErrorMessage(error: unknown, fallback: string) {
  if (error instanceof WorkforceError) return error.message;
  if (error instanceof ForbiddenError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  return fallback;
}

async function requireStaffingReviewAccess(db: Db, access: BusinessAccess) {
  requireBusinessRole(access, "OWNER");
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MEMBERS);
  await requireProductCapability(db, access.businessId, PRODUCT_CAPABILITIES.TEAM_MANAGEMENT);
}

export async function loadOwnedStaffingReview(db: Db, access: BusinessAccess, now = new Date()) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MEMBERS);
  await requireProductCapability(db, access.businessId, PRODUCT_CAPABILITIES.TEAM_MANAGEMENT);
  const snapshot = await loadWorkforceSnapshot(db, access.businessId, now);
  const recommendations = buildStaffingReviewRecommendations(snapshot, now);
  const states = await db.bsosRecommendationState.findMany({
    where: {
      businessId: access.businessId,
      recommendationKey: { startsWith: "workforce-staffing:" },
    },
    select: {
      recommendationKey: true,
      status: true,
      evidenceKey: true,
      actionItemId: true,
    },
  });
  const { active, history } = partitionRecommendations(recommendations, states);
  const pending = active.filter((item) => {
    const evidenceKey = staffingReviewEvidenceKey(item);
    const match = states.find(
      (row) => row.recommendationKey === item.key && (row.evidenceKey ?? "") === evidenceKey,
    );
    return !match?.actionItemId;
  });
  const accepted = active.filter((item) => {
    const evidenceKey = staffingReviewEvidenceKey(item);
    const match = states.find(
      (row) => row.recommendationKey === item.key && (row.evidenceKey ?? "") === evidenceKey,
    );
    return Boolean(match?.actionItemId);
  });
  return {
    snapshot,
    recommendations,
    states,
    pending,
    accepted,
    history,
    canReview: access.workspace.role === "OWNER",
  };
}

export async function reviewStaffingRecommendationOp(
  db: Db,
  access: BusinessAccess,
  input: {
    recommendationKey: string;
    evidenceKey: string;
    decision: StaffingReviewDecision;
  },
) {
  await requireStaffingReviewAccess(db, access);

  const recommendationKey = input.recommendationKey.trim();
  const submittedEvidence = input.evidenceKey.trim();
  if (!isStaffingReviewKey(recommendationKey) || !submittedEvidence) {
    throw new WorkforceError("Choose a staffing recommendation to review.");
  }

  const snapshot = await loadWorkforceSnapshot(db, access.businessId);
  const live = findLiveStaffingRecommendation(snapshot, recommendationKey);
  if (!live) {
    throw new WorkforceError(STALE_MESSAGE);
  }
  const liveEvidence = staffingReviewEvidenceKey(live);
  if (liveEvidence !== submittedEvidence) {
    throw new WorkforceError(STALE_MESSAGE);
  }

  if (input.decision === "DISMISS") {
    const state = await upsertRecommendationState(db, access, {
      recommendationKey: live.key,
      status: "DISMISSED",
      evidenceKey: liveEvidence,
    });
    return {
      decision: "DISMISS" as const,
      recommendationKey: live.key,
      evidenceKey: liveEvidence,
      recordId: state.id,
      recordType: "BsosRecommendationState" as const,
    };
  }

  const action = await createActionFromRecommendation(db, access, live);
  return {
    decision: "ACCEPT" as const,
    recommendationKey: live.key,
    evidenceKey: liveEvidence,
    recordId: action.id,
    recordType: "BusinessActionItem" as const,
  };
}
