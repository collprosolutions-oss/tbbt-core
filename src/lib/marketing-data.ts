/**
 * Tenant-scoped Marketing loader. Every query is keyed by the
 * authenticated workspace businessId -- never a client-supplied id.
 */

import type { PrismaClient } from "@prisma/client";
import { getBusinessLogoSrc } from "@/lib/business-branding";
import { listActiveTradeCodes } from "@/lib/business-trades";
import { workspaceTradeLabel } from "@/lib/trade-config";
import { rollupAttribution } from "@/lib/lead-attribution";
import {
  CHANNELS_DISCONNECTED_MESSAGE,
  jobMarketingReadiness,
  LEAD_SOURCE_TRACKED_MESSAGE,
  LEAD_SOURCE_UNTRACKED_MESSAGE,
  PERFORMANCE_UNAVAILABLE_MESSAGE,
  SOCIAL_MANUAL_COPY_MESSAGE,
} from "@/lib/marketing";
import { draftMarketingContent, weeklyContentPlan } from "@/lib/marketing-draft";
import {
  campaignIdeasFromActivity,
  draftMarketingVariations,
  weeklyMarketingPlanFromActivity,
} from "@/lib/ai/marketing";
import { addDays, startOfDay, startOfWeek } from "@/lib/schedule";
import { asNumber } from "@/lib/reports";

function catalogIdForEstimate(
  estimate: {
    serviceRequestId: string | null;
    lineItems: { serviceCatalogItemId: string | null }[];
  } | null,
  requests: { id: string; serviceCatalogItemId: string | null }[],
): string | null {
  if (!estimate) return null;
  if (estimate.serviceRequestId) {
    const request = requests.find((row) => row.id === estimate.serviceRequestId);
    if (request?.serviceCatalogItemId) return request.serviceCatalogItemId;
  }
  const ids = [
    ...new Set(
      estimate.lineItems
        .filter((item) => item.serviceCatalogItemId)
        .map((item) => item.serviceCatalogItemId as string),
    ),
  ];
  return ids.length === 1 ? ids[0]! : null;
}

export async function loadMarketingSource(
  prisma: PrismaClient,
  businessId: string,
) {
  const scope = { businessId } as const;

  const [business, jobs, contents, catalogItems, serviceRequests, campaigns, settings, invoices, reviews, serviceAreas, unpaidInvoices] = await Promise.all([
    prisma.business.findFirst({
      where: { id: businessId },
      select: {
        id: true,
        name: true,
        slug: true,
        tradeCode: true,
        publicServiceAreaLabel: true,
        publicPhone: true,
        publicEmail: true,
      },
    }),
    prisma.job.findMany({
      where: { ...scope, status: "COMPLETED" },
      select: {
        id: true,
        businessId: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        customerId: true,
        estimateId: true,
        leadSource: true,
        campaignId: true,
        customer: { select: { id: true, name: true } },
        estimate: {
          select: {
            serviceRequestId: true,
            lineItems: { select: { description: true, serviceCatalogItemId: true } },
          },
        },
        photos: {
          select: {
            id: true,
            jobId: true,
            stage: true,
            url: true,
            caption: true,
            createdAt: true,
            marketingPermissionStatus: true,
            marketingPermissionGrantedAt: true,
            marketingPermissionGrantedByMembershipId: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.marketingContent.findMany({
      where: scope,
      include: {
        photos: {
          include: {
            jobPhoto: {
              select: {
                id: true,
                url: true,
                caption: true,
                stage: true,
                marketingPermissionStatus: true,
                jobId: true,
              },
            },
          },
        },
        job: { select: { id: true, status: true, customer: { select: { name: true } } } },
      },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.serviceCatalogItem.findMany({
      where: scope,
      select: { id: true, name: true, active: true },
    }),
    prisma.serviceRequest.findMany({
      where: scope,
      select: {
        id: true,
        serviceCatalogItemId: true,
        leadSource: true,
        campaignId: true,
        originalLeadSource: true,
        originalCampaignId: true,
      },
    }),
    prisma.marketingCampaign.findMany({
      where: scope,
      orderBy: { updatedAt: "desc" },
    }),
    prisma.businessSettings.findUnique({
      where: { businessId },
      select: {
        marketingBrandVoice: true,
        marketingIdentityNotes: true,
        seoTitleHome: true,
        seoDescriptionHome: true,
        approvedPublicAboutCopy: true,
      },
    }),
    prisma.invoice.findMany({
      where: { ...scope, status: "PAID" },
      select: { total: true, jobId: true },
    }),
    prisma.review.count({ where: scope }),
    prisma.serviceArea.count({ where: scope }),
    prisma.invoice.count({ where: { ...scope, status: "SENT" } }),
  ]);

  const catalogName = (id: string | null) =>
    id ? catalogItems.find((item) => item.id === id)?.name ?? null : null;

  const opportunities = jobs.map((job) => {
    const catalogId = catalogIdForEstimate(job.estimate, serviceRequests);
    const workPerformed =
      catalogName(catalogId) ??
      job.estimate?.lineItems[0]?.description ??
      "Service not attributed";
    const approvedPhotoCount = job.photos.filter(
      (photo) => photo.marketingPermissionStatus === "APPROVED",
    ).length;
    return {
      jobId: job.id,
      customerName: job.customer?.name ?? "Customer",
      workPerformed,
      catalogId,
      lastUpdated: job.updatedAt,
      createdAt: job.createdAt,
      photoCount: job.photos.length,
      approvedPhotoCount,
      readiness: jobMarketingReadiness({
        photoCount: job.photos.length,
        approvedPhotoCount,
      }),
      photos: job.photos,
      href: `/jobs/${job.id}`,
    };
  });

  const drafts = contents.filter((row) => row.status === "DRAFT");
  const awaitingReview = contents.filter((row) => row.status === "READY_FOR_REVIEW");
  const approved = contents.filter((row) => row.status === "APPROVED");

  const servicesWithoutContent = catalogItems
    .filter((item) => item.active)
    .filter((item) => {
      const used = opportunities.some(
        (opportunity) =>
          opportunity.catalogId === item.id &&
          contents.some((content) => content.jobId === opportunity.jobId),
      );
      return !used;
    })
    .map((item) => item.name);

  const tradeLabel = business
    ? workspaceTradeLabel(await listActiveTradeCodes(prisma, businessId))
    : "Handyman";

  return {
    businessId,
    brand: {
      name: business?.name ?? "Business",
      slug: business?.slug ?? "",
      tradeLabel,
      logoSrc: business ? getBusinessLogoSrc(business.slug) : null,
      serviceAreaOnFile: Boolean(business?.publicServiceAreaLabel?.trim()),
      descriptionOnFile: Boolean(settings?.approvedPublicAboutCopy?.trim() || settings?.marketingIdentityNotes?.trim()),
      publicContactOnFile: Boolean(business?.publicPhone?.trim() || business?.publicEmail?.trim()),
      voice: settings?.marketingBrandVoice ?? "",
      identityNotes: settings?.marketingIdentityNotes ?? "",
    },
    opportunities,
    contents: contents.map((content) => ({
      id: content.id,
      contentType: content.contentType,
      title: content.title,
      body: content.body,
      channelIntent: content.channelIntent,
      status: content.status,
      plannedFor: content.plannedFor,
      jobId: content.jobId,
      jobCustomerName: content.job?.customer?.name ?? null,
      createdAt: content.createdAt,
      updatedAt: content.updatedAt,
      photos: content.photos.map((row) => ({
        id: row.jobPhoto.id,
        url: row.jobPhoto.url,
        caption: row.jobPhoto.caption,
        stage: row.jobPhoto.stage,
        approved: row.jobPhoto.marketingPermissionStatus === "APPROVED",
      })),
    })),
    counts: {
      completedJobs: opportunities.length,
      drafts: drafts.length,
      awaitingReview: awaitingReview.length,
      approved: approved.length,
      readyOpportunities: opportunities.filter((row) => row.readiness === "ready").length,
      needsPermission: opportunities.filter((row) => row.readiness === "needs_permission").length,
    },
    grow: {
      readyJobs: opportunities.filter((row) => row.readiness === "ready"),
      needsPermission: opportunities.filter((row) => row.readiness === "needs_permission"),
      reviewReferralFuture: true,
      servicesWithoutContent,
    },
    leadSources: {
      tracked: serviceRequests.some((row) => row.leadSource),
      message: serviceRequests.some((row) => row.leadSource)
        ? LEAD_SOURCE_TRACKED_MESSAGE
        : LEAD_SOURCE_UNTRACKED_MESSAGE,
      rows: rollupAttribution({
        requests: serviceRequests.map((row) => ({
          leadSource: row.originalLeadSource ?? row.leadSource,
          campaignId: row.originalCampaignId ?? row.campaignId,
        })),
        estimates: [],
        jobs: jobs.map((job) => ({
          leadSource: job.leadSource,
          campaignId: job.campaignId,
          paidRevenue: invoices
            .filter((invoice) => invoice.jobId === job.id)
            .reduce((sum, invoice) => sum + asNumber(invoice.total), 0),
        })),
        campaigns: campaigns.map((row) => ({ id: row.id, name: row.name })),
      }),
    },
    campaigns,
    weeklyPlan: weeklyContentPlan(
      contents,
      startOfWeek(startOfDay(new Date())),
      addDays(startOfWeek(startOfDay(new Date())), 7),
    ),
    draftAssist: draftMarketingContent({
      contentType: "GENERAL_POST",
      businessName: business?.name ?? "Business",
      brandVoice: settings?.marketingBrandVoice,
      identityNotes: settings?.marketingIdentityNotes,
    }),
    draftVariations: draftMarketingVariations({
      contentType: "COMPLETED_JOB",
      businessName: business?.name ?? "Business",
      brandVoice: settings?.marketingBrandVoice,
      identityNotes: settings?.marketingIdentityNotes,
      workPerformed: opportunities[0]?.workPerformed,
      photoCount: opportunities[0]?.approvedPhotoCount,
      city: business?.publicServiceAreaLabel,
    }),
    activityPlan: weeklyMarketingPlanFromActivity({
      completedJobs: opportunities.length,
      approvedPhotos: opportunities.reduce((sum, row) => sum + row.approvedPhotoCount, 0),
      reviews,
      campaigns: campaigns.length,
      serviceAreas,
    }),
    campaignIdeas: campaignIdeasFromActivity({
      leadSources: [...new Set(serviceRequests.map((row) => row.leadSource).filter(Boolean))] as string[],
      completedJobs: opportunities.length,
      unpaidInvoices,
    }),
    recordedActivity: {
      completedJobs: opportunities.length,
      approvedPhotos: opportunities.reduce((sum, row) => sum + row.approvedPhotoCount, 0),
      reviews,
      campaigns: campaigns.length,
      serviceAreas,
      unpaidInvoices,
      leadSources: [...new Set(serviceRequests.map((row) => row.leadSource).filter(Boolean))] as string[],
      workPerformed: opportunities[0]?.workPerformed,
      photoCount: opportunities[0]?.approvedPhotoCount,
      city: business?.publicServiceAreaLabel,
      businessName: business?.name ?? "Business",
    },
    seo: {
      homeTitle: settings?.seoTitleHome ?? "",
      homeDescription: settings?.seoDescriptionHome ?? "",
    },
    channels: {
      connected: false,
      message: CHANNELS_DISCONNECTED_MESSAGE,
      manualCopy: SOCIAL_MANUAL_COPY_MESSAGE,
    },
    performance: {
      available: false,
      message: PERFORMANCE_UNAVAILABLE_MESSAGE,
      internal: {
        approvedContent: approved.length,
        completedJobs: opportunities.length,
        paidInvoices: invoices.length,
        note: "Recorded TBBT activity only. Channel analytics are not connected.",
      },
    },
  };
}

export type MarketingSource = Awaited<ReturnType<typeof loadMarketingSource>>;
