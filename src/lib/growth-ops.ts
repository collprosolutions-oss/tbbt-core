/**
 * Growth mutations. Every write re-checks tenant + role. Growth never
 * sends customer messages — Communications owns delivery.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { emitAndProcessBusinessEvent } from "@/lib/automation/events";
import { parseLeadSource } from "@/lib/lead-attribution";
import {
  GROWTH_NO_AUTO_MESSAGE,
  isGrowthActionKind,
  isGrowthActionQueue,
  isGrowthActionStatus,
  type GrowthActionKind,
  type GrowthActionQueue,
} from "@/lib/growth";
import { isConsentEligible, localPageSlugFromPath } from "@/lib/growth-engine";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog/codes";
import { requireProductCapability } from "@/lib/product-entitlements";

type Db = PrismaClient | Prisma.TransactionClient;

export class GrowthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrowthError";
  }
}

export function growthErrorMessage(error: unknown, fallback: string) {
  if (error instanceof GrowthError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  if (error instanceof Error && error.name === "ProductCapabilityRequiredError") return error.message;
  return fallback;
}

async function requireGrowthWrite(
  db: Db,
  access: BusinessAccess,
  capability: typeof CAPABILITIES.MANAGE_MARKETING | typeof CAPABILITIES.MANAGE_REVIEWS | typeof CAPABILITIES.MANAGE_PIPELINE,
) {
  requireBusinessCapability(access, capability);
  await requireProductCapability(db, access.businessId, PRODUCT_CAPABILITIES.MARKETING_TOOLS);
}

export async function correctLeadAttribution(
  db: Db,
  access: BusinessAccess,
  input: {
    requestId: string;
    leadSource?: string | null;
    campaignId?: string | null;
    landingPagePath?: string | null;
    reason?: string;
  },
) {
  await requireGrowthWrite(db, access, CAPABILITIES.MANAGE_MARKETING);
  const request = access.assertOwned(
    await db.serviceRequest.findFirst({
      where: { id: input.requestId, ...access.scope },
    }),
  );
  const nextSource = input.leadSource != null ? parseLeadSource(input.leadSource) : parseLeadSource(request.leadSource);
  if (input.leadSource != null && input.leadSource.trim() && !nextSource) {
    throw new GrowthError("Choose a recorded lead source.");
  }
  let nextCampaignId = input.campaignId === undefined ? request.campaignId : input.campaignId?.trim() || null;
  if (nextCampaignId) {
    const campaign = await db.marketingCampaign.findFirst({
      where: { id: nextCampaignId, ...access.scope },
      select: { id: true, businessId: true },
    });
    nextCampaignId = access.assertOwned(campaign).id;
  }
  const nextLanding =
    input.landingPagePath === undefined
      ? request.landingPagePath
      : input.landingPagePath?.trim() || null;
  const nextLocal = localPageSlugFromPath(nextLanding) ?? request.localPageSlug;

  await db.leadAttributionCorrection.create({
    data: {
      businessId: access.businessId,
      recordType: "SERVICE_REQUEST",
      recordId: request.id,
      previousLeadSource: request.leadSource,
      previousCampaignId: request.campaignId,
      previousLandingPagePath: request.landingPagePath,
      newLeadSource: nextSource,
      newCampaignId: nextCampaignId,
      newLandingPagePath: nextLanding,
      reason: input.reason?.trim() ?? "",
      actorMembershipId: access.workspace.membership.id,
    },
  });

  return db.serviceRequest.update({
    where: { id: request.id },
    data: {
      leadSource: nextSource,
      campaignId: nextCampaignId,
      landingPagePath: nextLanding,
      localPageSlug: nextLocal,
      originalLeadSource: request.originalLeadSource ?? request.leadSource,
      originalCampaignId: request.originalCampaignId ?? request.campaignId,
    },
  });
}

export async function recordCampaignCost(
  db: Db,
  access: BusinessAccess,
  input: { campaignId: string; recordedCost?: string | null },
) {
  await requireGrowthWrite(db, access, CAPABILITIES.MANAGE_MARKETING);
  const campaign = access.assertOwned(
    await db.marketingCampaign.findFirst({
      where: { id: input.campaignId, ...access.scope },
    }),
  );
  const raw = input.recordedCost?.trim() ?? "";
  let recordedCost: Prisma.Decimal | null = null;
  if (raw) {
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new GrowthError("Enter a recorded campaign cost of zero or more, or leave it blank.");
    }
    recordedCost = new Prisma.Decimal(amount.toFixed(2));
  }
  return db.marketingCampaign.update({
    where: { id: campaign.id },
    data: { recordedCost },
  });
}

export async function createGrowthActionRequest(
  db: Db,
  access: BusinessAccess,
  input: {
    kind: string;
    queue: string;
    customerId?: string | null;
    serviceRequestId?: string | null;
    estimateId?: string | null;
    jobId?: string | null;
    campaignId?: string | null;
    notes?: string;
    evidence?: Record<string, unknown>;
    approve?: boolean;
  },
) {
  const kind = input.kind as GrowthActionKind;
  if (!isGrowthActionKind(kind)) throw new GrowthError("Choose a growth action kind.");
  if (!isGrowthActionQueue(input.queue)) throw new GrowthError("Choose a growth queue.");
  const capability =
    kind === "REVIEW_ASK" || kind === "REFERRAL_ASK"
      ? CAPABILITIES.MANAGE_REVIEWS
      : kind === "RECOVERY"
        ? CAPABILITIES.MANAGE_PIPELINE
        : CAPABILITIES.MANAGE_MARKETING;
  await requireGrowthWrite(db, access, capability);

  let customerId = input.customerId?.trim() || null;
  if (customerId) {
    access.assertOwned(
      await db.customer.findFirst({
        where: { id: customerId, ...access.scope },
        select: { id: true, businessId: true },
      }),
    );
  }
  if (input.serviceRequestId) {
    const request = access.assertOwned(
      await db.serviceRequest.findFirst({
        where: { id: input.serviceRequestId, ...access.scope },
        select: { id: true, businessId: true, customerId: true },
      }),
    );
    customerId = customerId ?? request.customerId;
  }
  if (input.estimateId) {
    const estimate = access.assertOwned(
      await db.estimate.findFirst({
        where: { id: input.estimateId, ...access.scope },
        select: { id: true, businessId: true, customerId: true },
      }),
    );
    customerId = customerId ?? estimate.customerId;
  }
  if (input.jobId) {
    const job = access.assertOwned(
      await db.job.findFirst({
        where: { id: input.jobId, ...access.scope },
        select: { id: true, businessId: true, customerId: true },
      }),
    );
    customerId = customerId ?? job.customerId;
  }
  if (input.campaignId) {
    access.assertOwned(
      await db.marketingCampaign.findFirst({
        where: { id: input.campaignId, ...access.scope },
        select: { id: true, businessId: true },
      }),
    );
  }

  const customer = customerId
    ? await db.customer.findFirst({
        where: { id: customerId, ...access.scope },
        select: { id: true, businessId: true, email: true, smsConsentStatus: true },
      })
    : null;
  if (customer) access.assertOwned(customer);
  const consentEligible = customer ? isConsentEligible(customer) : false;
  if (input.approve && kind === "REACTIVATION" && !consentEligible) {
    throw new GrowthError("This customer is not eligible for reactivation outreach. Consent is missing or revoked.");
  }

  const created = await db.growthActionRequest.create({
    data: {
      businessId: access.businessId,
      kind,
      queue: input.queue,
      status: input.approve ? "APPROVED" : "OPEN",
      customerId,
      serviceRequestId: input.serviceRequestId ?? null,
      estimateId: input.estimateId ?? null,
      jobId: input.jobId ?? null,
      campaignId: input.campaignId ?? null,
      consentEligible,
      evidenceJson: JSON.stringify(input.evidence ?? {}),
      notes: input.notes?.trim() ?? "",
      createdByMembershipId: access.workspace.membership.id,
      approvedAt: input.approve ? new Date() : null,
    },
  });

  await emitAndProcessBusinessEvent(db as PrismaClient, {
    businessId: access.businessId,
    type: kind === "REACTIVATION" ? "GROWTH_REACTIVATION_APPROVED" : "GROWTH_RECOVERY_QUEUED",
    subjectType: "GROWTH_ACTION_REQUEST",
    subjectId: created.id,
    idempotencyKey: `${kind}:${created.id}`,
    payload: {
      kind,
      queue: input.queue,
      consentEligible,
      autoMessage: false,
      note: GROWTH_NO_AUTO_MESSAGE,
    },
  });

  return created;
}

export async function setGrowthActionStatus(
  db: Db,
  access: BusinessAccess,
  input: { actionId: string; status: string },
) {
  await requireGrowthWrite(db, access, CAPABILITIES.MANAGE_MARKETING);
  if (!isGrowthActionStatus(input.status)) {
    throw new GrowthError("Choose a valid growth action status.");
  }
  const action = access.assertOwned(
    await db.growthActionRequest.findFirst({
      where: { id: input.actionId, ...access.scope },
    }),
  );
  if (input.status === "APPROVED" && action.kind === "REACTIVATION" && !action.consentEligible) {
    throw new GrowthError("This customer is not eligible for reactivation outreach. Consent is missing or revoked.");
  }
  return db.growthActionRequest.update({
    where: { id: action.id },
    data: {
      status: input.status,
      approvedAt: input.status === "APPROVED" ? new Date() : action.approvedAt,
    },
  });
}

export async function approveReactivationCandidates(
  db: Db,
  access: BusinessAccess,
  input: { customerIds: string[]; campaignId?: string | null; notes?: string },
) {
  await requireGrowthWrite(db, access, CAPABILITIES.MANAGE_MARKETING);
  const ids = [...new Set(input.customerIds.filter(Boolean))];
  if (ids.length === 0) throw new GrowthError("Select at least one customer to approve.");
  const created = [];
  for (const customerId of ids) {
    created.push(
      await createGrowthActionRequest(db, access, {
        kind: "REACTIVATION",
        queue: "REACTIVATION",
        customerId,
        campaignId: input.campaignId,
        notes: input.notes,
        approve: true,
        evidence: { customerId },
      }),
    );
  }
  return created;
}
