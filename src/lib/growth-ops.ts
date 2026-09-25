/**
 * Growth mutations. Every write re-checks tenant + role. Growth never
 * sends customer messages — Communications owns delivery.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability, requireBusinessRole } from "@/lib/authorization";
import { emitAndProcessBusinessEvent } from "@/lib/automation/events";
import { parseLeadSource } from "@/lib/lead-attribution";
import { loadGrowthSource } from "@/lib/growth-data";
import {
  GROWTH_NO_AUTO_MESSAGE,
  OWNER_APPROVAL_REQUIRED_MESSAGE,
  growthActionIdempotencyKey,
  isGrowthActionKind,
  isGrowthActionQueue,
  isGrowthActionStatus,
  type GrowthActionKind,
  type GrowthActionQueue,
} from "@/lib/growth";
import {
  evaluateReactivationEligibility,
  localPageSlugFromPath,
  outreachEligibility,
} from "@/lib/growth-engine";
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

async function loadRelatedGrowthRecords(
  db: Db,
  access: BusinessAccess,
  input: {
    customerId?: string | null;
    serviceRequestId?: string | null;
    estimateId?: string | null;
    jobId?: string | null;
    campaignId?: string | null;
  },
) {
  const customerIds: string[] = [];
  if (input.customerId?.trim()) {
    const customer = access.assertOwned(
      await db.customer.findFirst({
        where: { id: input.customerId, ...access.scope },
        select: { id: true, businessId: true },
      }),
    );
    customerIds.push(customer.id);
  }
  if (input.serviceRequestId) {
    const request = access.assertOwned(
      await db.serviceRequest.findFirst({
        where: { id: input.serviceRequestId, ...access.scope },
        select: { id: true, businessId: true, customerId: true },
      }),
    );
    if (request.customerId) customerIds.push(request.customerId);
  }
  if (input.estimateId) {
    const estimate = access.assertOwned(
      await db.estimate.findFirst({
        where: { id: input.estimateId, ...access.scope },
        select: { id: true, businessId: true, customerId: true },
      }),
    );
    if (estimate.customerId) customerIds.push(estimate.customerId);
  }
  if (input.jobId) {
    const job = access.assertOwned(
      await db.job.findFirst({
        where: { id: input.jobId, ...access.scope },
        select: { id: true, businessId: true, customerId: true },
      }),
    );
    if (job.customerId) customerIds.push(job.customerId);
  }
  if (input.campaignId) {
    access.assertOwned(
      await db.marketingCampaign.findFirst({
        where: { id: input.campaignId, ...access.scope },
        select: { id: true, businessId: true },
      }),
    );
  }
  const unique = [...new Set(customerIds)];
  if (unique.length > 1) {
    throw new GrowthError("Related request, estimate, and job must belong to the same customer.");
  }
  return { customerId: unique[0] ?? null };
}

function requireOwnerApproval(access: BusinessAccess) {
  try {
    requireBusinessRole(access, "OWNER");
  } catch {
    throw new GrowthError(OWNER_APPROVAL_REQUIRED_MESSAGE);
  }
}

async function assertCurrentReactivationEligibility(
  db: PrismaClient,
  businessId: string,
  customerId: string | null,
) {
  if (!customerId) {
    throw new GrowthError("Reactivation requires a current same-tenant customer.");
  }
  const source = await loadGrowthSource(db, businessId);
  const result = evaluateReactivationEligibility(source, customerId);
  if (!result.ok) {
    throw new GrowthError("This customer is no longer eligible for reactivation. Current facts were rechecked.");
  }
  return result.candidate;
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

  const related = await loadRelatedGrowthRecords(db, access, input);
  const customerId = related.customerId;
  const customer = customerId
    ? await db.customer.findFirst({
        where: { id: customerId, ...access.scope },
        select: { id: true, businessId: true, email: true, smsConsentStatus: true },
      })
    : null;
  if (customer) access.assertOwned(customer);
  const outreach = customer
    ? outreachEligibility(customer)
    : { smsEligible: false, emailEligible: false, anyOutreachEligible: false };
  if (input.approve && kind === "REACTIVATION") {
    requireOwnerApproval(access);
    await assertCurrentReactivationEligibility(db as PrismaClient, access.businessId, customerId);
  }

  const idempotencyKey = growthActionIdempotencyKey({
    kind,
    queue: input.queue,
    customerId,
    serviceRequestId: input.serviceRequestId,
    estimateId: input.estimateId,
    jobId: input.jobId,
  });
  const existing = await db.growthActionRequest.findFirst({
    where: { businessId: access.businessId, idempotencyKey },
  });
  if (existing) {
    if (input.approve && existing.status !== "APPROVED") {
      return setGrowthActionStatus(db, access, { actionId: existing.id, status: "APPROVED" });
    }
    return existing;
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
      consentEligible: outreach.anyOutreachEligible,
      evidenceJson: JSON.stringify({
        ...(input.evidence ?? {}),
        emailEligible: outreach.emailEligible,
        smsEligible: outreach.smsEligible,
        actorRole: access.workspace.role,
      }),
      notes: input.notes?.trim() ?? "",
      createdByMembershipId: access.workspace.membership.id,
      approvedByMembershipId: input.approve ? access.workspace.membership.id : null,
      approvedAt: input.approve ? new Date() : null,
      idempotencyKey,
    },
  }).catch(async (error) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await db.growthActionRequest.findFirst({
        where: { businessId: access.businessId, idempotencyKey },
      });
      if (raced) return raced;
    }
    throw error;
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
      consentEligible: outreach.anyOutreachEligible,
      emailEligible: outreach.emailEligible,
      smsEligible: outreach.smsEligible,
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
  if (input.status === "APPROVED" && action.kind === "REACTIVATION") {
    requireOwnerApproval(access);
    const current = await assertCurrentReactivationEligibility(
      db as PrismaClient,
      access.businessId,
      action.customerId,
    );
    return db.growthActionRequest.update({
      where: { id: action.id },
      data: {
        status: "APPROVED",
        consentEligible: current.anyOutreachEligible,
        approvedAt: new Date(),
        approvedByMembershipId: access.workspace.membership.id,
      },
    });
  }
  return db.growthActionRequest.update({
    where: { id: action.id },
    data: {
      status: input.status,
      approvedAt: action.approvedAt,
    },
  });
}

export async function approveReactivationCandidates(
  db: Db,
  access: BusinessAccess,
  input: { customerIds: string[]; campaignId?: string | null; notes?: string },
) {
  await requireGrowthWrite(db, access, CAPABILITIES.MANAGE_MARKETING);
  requireOwnerApproval(access);
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
