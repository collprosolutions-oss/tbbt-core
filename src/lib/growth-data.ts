/**
 * Tenant-scoped Growth loader. Every query is keyed by workspace businessId.
 */
import type { PrismaClient } from "@prisma/client";
import { parseWebsiteSnapshot } from "@/lib/website-engine/snapshot";
import {
  CHANNELS_DISCONNECTED_MESSAGE,
  SOCIAL_MANUAL_COPY_MESSAGE,
} from "@/lib/marketing";
import {
  RANKING_UNAVAILABLE_MESSAGE,
  SOCIAL_DISCONNECTED_MESSAGE,
} from "@/lib/growth";
import {
  buildCampaignPerformance,
  buildGrowthFunnel,
  buildGrowthRecommendations,
  buildLocalGrowth,
  buildReactivationCandidates,
  buildRecoveryQueue,
  buildReferralAttribution,
  buildReviewConversion,
  buildSourcePerformance,
  classifyAttribution,
  type GrowthSource,
} from "@/lib/growth-engine";
import { invoicedAmount, resolveCollectedCash } from "@/lib/collected-cash";

function referredIds(source: GrowthSource) {
  return new Set(
    source.referrals
      .filter((row) => row.status !== "CANCELLED" && row.referredCustomerId)
      .map((row) => row.referredCustomerId as string),
  );
}

let growthSourceLoadCount = 0;

export function getGrowthSourceLoadCount() {
  return growthSourceLoadCount;
}

export function resetGrowthSourceLoadCount() {
  growthSourceLoadCount = 0;
}

export async function loadGrowthSource(
  prisma: PrismaClient,
  businessId: string,
  now = new Date(),
): Promise<GrowthSource> {
  growthSourceLoadCount += 1;
  const scope = { businessId } as const;
  const [
    requests,
    estimates,
    jobs,
    invoices,
    payments,
    jobCompletionEvents,
    pipeline,
    customers,
    campaigns,
    reviews,
    reviewRequests,
    referrals,
    referralRequests,
    followUps,
    serviceAreas,
    localPageDrafts,
    business,
  ] = await Promise.all([
    prisma.serviceRequest.findMany({
      where: scope,
      select: {
        id: true,
        customerId: true,
        leadSource: true,
        campaignId: true,
        originalLeadSource: true,
        originalCampaignId: true,
        landingPagePath: true,
        localPageSlug: true,
        matchedServiceAreaId: true,
        serviceAreaQualification: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.estimate.findMany({
      where: scope,
      select: {
        id: true,
        customerId: true,
        serviceRequestId: true,
        status: true,
        total: true,
        leadSource: true,
        campaignId: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.job.findMany({
      where: scope,
      select: {
        id: true,
        customerId: true,
        estimateId: true,
        status: true,
        leadSource: true,
        campaignId: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.invoice.findMany({
      where: scope,
      select: {
        id: true,
        jobId: true,
        customerId: true,
        status: true,
        total: true,
        paidAt: true,
        createdAt: true,
      },
    }),
    prisma.payment.findMany({
      where: scope,
      select: {
        id: true,
        invoiceId: true,
        jobId: true,
        customerId: true,
        amount: true,
      },
    }),
    prisma.businessEvent.findMany({
      where: { ...scope, type: "JOB_COMPLETED", subjectType: "JOB" },
      select: { subjectId: true, occurredAt: true },
    }),
    prisma.pipelineOpportunity.findMany({
      where: scope,
      select: {
        serviceRequestId: true,
        standaloneEstimateId: true,
        ownerStage: true,
        followUpOn: true,
        lossReason: true,
        updatedAt: true,
      },
    }),
    prisma.customer.findMany({
      where: scope,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        smsConsentStatus: true,
        firstLeadSource: true,
        firstCampaignId: true,
        createdAt: true,
      },
    }),
    prisma.marketingCampaign.findMany({
      where: scope,
      select: {
        id: true,
        name: true,
        sourceKey: true,
        status: true,
        recordedCost: true,
        createdAt: true,
      },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.review.findMany({
      where: scope,
      select: {
        id: true,
        customerId: true,
        jobId: true,
        reviewRequestId: true,
        websiteSelected: true,
        responseStatus: true,
      },
    }),
    prisma.reviewRequest.findMany({
      where: scope,
      select: { id: true, customerId: true, jobId: true, status: true },
    }),
    prisma.referral.findMany({
      where: scope,
      select: {
        id: true,
        sourceCustomerId: true,
        referredCustomerId: true,
        referralRequestId: true,
        campaignId: true,
        status: true,
      },
    }),
    prisma.referralRequest.findMany({
      where: scope,
      select: { id: true, customerId: true, jobId: true, status: true },
    }),
    prisma.customerFollowUp.findMany({
      where: scope,
      select: { id: true, customerId: true, kind: true, status: true },
    }),
    prisma.serviceArea.findMany({
      where: scope,
      select: { id: true, label: true, kind: true, enabled: true, city: true },
    }),
    prisma.websiteLocalPageDraft.findMany({
      where: scope,
      select: { id: true, serviceAreaId: true, catalogItemId: true },
    }),
    prisma.business.findFirst({
      where: { id: businessId },
      select: { publishedWebsiteId: true },
    }),
  ]);

  let publishedLocalPages: GrowthSource["publishedLocalPages"] = [];
  if (business?.publishedWebsiteId) {
    const publish = await prisma.websitePublish.findFirst({
      where: { id: business.publishedWebsiteId, businessId },
      select: { snapshotJson: true },
    });
    if (publish) {
      try {
        const snapshot = parseWebsiteSnapshot(publish.snapshotJson);
        publishedLocalPages = snapshot.localPages.map((page) => ({
          citySlug: page.citySlug,
          serviceSlug: page.serviceSlug,
          serviceAreaId: null,
        }));
      } catch {
        publishedLocalPages = [];
      }
    }
  }

  return {
    now,
    requests,
    estimates,
    jobs,
    invoices,
    payments,
    jobCompletions: jobCompletionEvents.map((row) => ({
      jobId: row.subjectId,
      completedAt: row.occurredAt,
    })),
    pipeline,
    customers,
    campaigns,
    reviews,
    reviewRequests,
    referrals,
    referralRequests,
    followUps,
    serviceAreas,
    localPageDrafts,
    publishedLocalPages,
  };
}

export async function loadGrowthWorkspace(
  prisma: PrismaClient,
  businessId: string,
  now = new Date(),
) {
  const [source, actionRequests, corrections] = await Promise.all([
    loadGrowthSource(prisma, businessId, now),
    prisma.growthActionRequest.findMany({
      where: { businessId },
      orderBy: { updatedAt: "desc" },
      take: 80,
    }),
    prisma.leadAttributionCorrection.findMany({
      where: { businessId },
      orderBy: { createdAt: "desc" },
      take: 40,
    }),
  ]);

  const funnel = buildGrowthFunnel(source);
  const sources = buildSourcePerformance(source);
  const campaigns = buildCampaignPerformance(source);
  const recovery = buildRecoveryQueue(source);
  const reactivation = buildReactivationCandidates(source);
  const reviews = buildReviewConversion(source);
  const referrals = buildReferralAttribution(source);
  const local = buildLocalGrowth(source);
  const recommendations = buildGrowthRecommendations({
    recovery,
    reactivation,
    campaigns,
    sources,
    referrals,
    reviews,
  });
  const referred = referredIds(source);
  const attributions = source.requests.map((request) => {
    const customer = source.customers.find((row) => row.id === request.customerId);
    return {
      requestId: request.id,
      customerName: customer?.name ?? "Customer",
      ...classifyAttribution({
        leadSource: request.leadSource,
        campaignId: request.campaignId,
        originalLeadSource: request.originalLeadSource,
        originalCampaignId: request.originalCampaignId,
        landingPagePath: request.landingPagePath,
        localPageSlug: request.localPageSlug,
        isReferral: Boolean(request.customerId && referred.has(request.customerId)),
        isRepeatCustomer: Boolean(
          customer?.firstLeadSource &&
            customer.createdAt.getTime() < request.createdAt.getTime(),
        ),
      }),
    };
  });

  const collected = resolveCollectedCash({
    invoices: source.invoices,
    payments: source.payments ?? [],
  }).totalCollected;
  const invoiced = invoicedAmount(source.invoices);

  return {
    businessId,
    funnel,
    sources,
    campaigns,
    recovery,
    reactivation,
    reviews,
    referrals,
    local,
    recommendations,
    attributions,
    actionRequests,
    corrections,
    social: {
      connected: false,
      message: SOCIAL_DISCONNECTED_MESSAGE,
      channelsMessage: CHANNELS_DISCONNECTED_MESSAGE,
      manualCopy: SOCIAL_MANUAL_COPY_MESSAGE,
    },
    localHonesty: RANKING_UNAVAILABLE_MESSAGE,
    totals: {
      leads: source.requests.length,
      estimates: source.estimates.length,
      collected,
      invoiced,
      recoveryOpen: recovery.length,
      reactivationEligible: reactivation.filter((row) => row.anyOutreachEligible).length,
    },
  };
}

export type GrowthWorkspace = Awaited<ReturnType<typeof loadGrowthWorkspace>>;
