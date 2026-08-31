/**
 * Tenant-scoped Marketing loader. Every query is keyed by the
 * authenticated workspace businessId -- never a client-supplied id.
 */

import type { PrismaClient } from "@prisma/client";
import { getBusinessLogoSrc } from "@/lib/business-branding";
import { getTrade } from "@/lib/trades";
import {
  CHANNELS_DISCONNECTED_MESSAGE,
  jobMarketingReadiness,
  LEAD_SOURCE_UNTRACKED_MESSAGE,
  PERFORMANCE_UNAVAILABLE_MESSAGE,
} from "@/lib/marketing";

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

export async function loadMarketingSource(prisma: PrismaClient, businessId: string) {
  const scope = { businessId } as const;

  const [business, jobs, contents, catalogItems, serviceRequests] = await Promise.all([
    prisma.business.findFirst({
      where: { id: businessId },
      select: { id: true, name: true, slug: true, tradeCode: true },
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
      select: { id: true, serviceCatalogItemId: true },
    }),
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

  const trade = business ? getTrade(business.tradeCode) : null;

  return {
    businessId,
    brand: {
      name: business?.name ?? "Business",
      slug: business?.slug ?? "",
      tradeLabel: trade?.name ?? "Handyman",
      logoSrc: business ? getBusinessLogoSrc(business.slug) : null,
      serviceAreaOnFile: false,
      descriptionOnFile: false,
      publicContactOnFile: false,
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
      tracked: false,
      message: LEAD_SOURCE_UNTRACKED_MESSAGE,
    },
    channels: {
      connected: false,
      message: CHANNELS_DISCONNECTED_MESSAGE,
    },
    performance: {
      available: false,
      message: PERFORMANCE_UNAVAILABLE_MESSAGE,
    },
  };
}

export type MarketingSource = Awaited<ReturnType<typeof loadMarketingSource>>;
