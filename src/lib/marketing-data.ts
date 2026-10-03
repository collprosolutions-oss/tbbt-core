/**
 * Tenant-scoped Marketing loader. Every query is keyed by the
 * authenticated workspace businessId -- never a client-supplied id.
 */

import type { PrismaClient } from "@prisma/client";
import { getBusinessLogoSrc } from "@/lib/business-branding";
import { listActiveTradeCodes } from "@/lib/business-trades";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import { workspaceTradeLabel } from "@/lib/trade-config";
import { rollupAttribution } from "@/lib/lead-attribution";
import {
  jobMarketingReadiness,
  LEAD_SOURCE_TRACKED_MESSAGE,
  LEAD_SOURCE_UNTRACKED_MESSAGE,
  PERFORMANCE_UNAVAILABLE_MESSAGE,
  canResolveSocialPublishAttempt,
  presentMarketingSocialDestinations,
  sanitizeSocialPublishProviderError,
  SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
  socialPublishDisplay,
  STUDIO_APPROVAL_QUEUE_LIMIT,
  STUDIO_APPROVAL_QUEUE_STATUS,
  STUDIO_CONTENT_CALENDAR_LIMIT,
  WEEKLY_STUDIO_APPROVAL_QUEUE_MESSAGE,
  parseStudioPublicationDay,
  presentStudioContentCalendar,
  studioApprovalQueueMeta,
  studioCalendarActiveCutoff,
  studioPublicationDayKey,
} from "@/lib/marketing";
import {
  loadStudioWeeklyReminderState,
  presentStudioWeeklyReminderForViewer,
} from "@/lib/marketing-studio-reminder";
import {
  latestSocialPublishAttempt,
  loadMarketingSocialDestinations,
  loadMarketingSocialPublishAttempts,
} from "@/lib/marketing-social-publish";
import { loadMarketingConnectionSummaries } from "@/lib/marketing-connections/service";
import { draftMarketingContent, weeklyContentPlan } from "@/lib/marketing-draft";
import {
  campaignIdeasFromActivity,
  draftMarketingVariations,
  weeklyMarketingPlanFromActivity,
} from "@/lib/ai/marketing";
import { addDays, startOfWeek } from "@/lib/schedule";
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
  now = new Date(),
  viewerRole?: string,
) {
  const scope = { businessId } as const;

  const approvalQueueWhere = { ...scope, status: STUDIO_APPROVAL_QUEUE_STATUS } as const;

  const [business, jobs, contents, catalogItems, serviceRequests, campaigns, settings, invoices, reviews, serviceAreas, unpaidInvoices, approvalQueueRows, approvalQueueTotal, weeklyReminder, socialDestinations, socialPublishAttempts, connectionSummaries] = await Promise.all([
    prisma.business.findFirst({
      where: { id: businessId },
      select: {
        id: true,
        name: true,
        slug: true,
        tradeCode: true,
        timezone: true,
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
    prisma.marketingContent.findMany({
      where: approvalQueueWhere,
      take: STUDIO_APPROVAL_QUEUE_LIMIT,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        contentType: true,
        title: true,
        body: true,
        channelIntent: true,
        status: true,
        plannedFor: true,
        createdAt: true,
        updatedAt: true,
        storyboardJson: true,
        shotListJson: true,
        hashtags: true,
        photos: {
          include: {
            jobPhoto: {
              select: {
                id: true,
                url: true,
                stage: true,
                marketingPermissionStatus: true,
              },
            },
          },
        },
      },
    }),
    prisma.marketingContent.count({ where: approvalQueueWhere }),
    loadStudioWeeklyReminderState(prisma, businessId, now),
    loadMarketingSocialDestinations(prisma, businessId),
    loadMarketingSocialPublishAttempts(prisma, businessId),
    loadMarketingConnectionSummaries(prisma, businessId),
  ]);

  const timeZone = resolveBusinessTimeZone(business);
  const calendarCutoff = studioCalendarActiveCutoff(now, timeZone);
  const calendarSelect = {
    id: true,
    contentType: true,
    title: true,
    channelIntent: true,
    status: true,
    plannedFor: true,
    exportedAt: true,
    updatedAt: true,
  } as const;
  const [fromTodayRows, unplannedRows, pastRows, fromTodayTotal, unplannedTotal, pastTotal] = await Promise.all([
    prisma.marketingContent.findMany({
      where: { ...scope, plannedFor: { gte: calendarCutoff } },
      take: STUDIO_CONTENT_CALENDAR_LIMIT,
      orderBy: [{ plannedFor: "asc" }, { updatedAt: "desc" }, { id: "desc" }],
      select: calendarSelect,
    }),
    prisma.marketingContent.findMany({
      where: { ...scope, plannedFor: null },
      take: STUDIO_CONTENT_CALENDAR_LIMIT,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: calendarSelect,
    }),
    prisma.marketingContent.findMany({
      where: { ...scope, plannedFor: { lt: calendarCutoff } },
      take: STUDIO_CONTENT_CALENDAR_LIMIT,
      orderBy: [{ plannedFor: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
      select: calendarSelect,
    }),
    prisma.marketingContent.count({ where: { ...scope, plannedFor: { gte: calendarCutoff } } }),
    prisma.marketingContent.count({ where: { ...scope, plannedFor: null } }),
    prisma.marketingContent.count({ where: { ...scope, plannedFor: { lt: calendarCutoff } } }),
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
    contents: contents.map((content) => {
      const attempt = latestSocialPublishAttempt(
        socialPublishAttempts,
        content.id,
        SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
      );
      const display = socialPublishDisplay({
        status: attempt?.status,
        claimedAt: attempt?.claimedAt,
        failureLabel: attempt?.failureLabel,
        now,
      });
      const label = display.label ? sanitizeSocialPublishProviderError(display.label) : display.label;
      return {
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
        storyboardJson: content.storyboardJson,
        shotListJson: content.shotListJson,
        hashtags: content.hashtags,
        exportedAt: content.exportedAt,
        photos: content.photos.map((row) => ({
          id: row.jobPhoto.id,
          url: row.jobPhoto.url,
          caption: row.jobPhoto.caption,
          stage: row.jobPhoto.stage,
          approved: row.jobPhoto.marketingPermissionStatus === "APPROVED",
        })),
        socialPublish: {
          destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
          attemptId: attempt?.id ?? null,
          attemptStatus: attempt?.status ?? null,
          published: display.published,
          unconfirmed: display.unconfirmed,
          inFlight: display.inFlight,
          canResolve: canResolveSocialPublishAttempt({
            role: viewerRole ?? "",
            status: attempt?.status,
            claimedAt: attempt?.claimedAt,
            failureLabel: attempt?.failureLabel,
            now,
          }),
          label,
          providerPostId: display.published ? attempt?.providerPostId ?? null : null,
        },
      };
    }),
    weeklyReminder: presentStudioWeeklyReminderForViewer(weeklyReminder, viewerRole),
    contentCalendar: presentStudioContentCalendar({
      fromToday: fromTodayRows,
      unplanned: unplannedRows,
      past: pastRows,
      fromTodayTotal,
      unplannedTotal,
      pastTotal,
      timeZone,
    }),
    approvalQueue: {
      ...studioApprovalQueueMeta(approvalQueueTotal),
      message: WEEKLY_STUDIO_APPROVAL_QUEUE_MESSAGE,
      items: approvalQueueRows.map((content) => ({
        id: content.id,
        contentType: content.contentType,
        title: content.title,
        body: content.body,
        channelIntent: content.channelIntent,
        status: content.status,
        plannedFor: content.plannedFor,
        createdAt: content.createdAt,
        updatedAt: content.updatedAt,
        storyboardJson: content.storyboardJson,
        shotListJson: content.shotListJson,
        hashtags: content.hashtags,
        photos: content.photos.map((row) => ({
          id: row.jobPhoto.id,
          url: row.jobPhoto.url,
          stage: row.jobPhoto.stage,
          approved: row.jobPhoto.marketingPermissionStatus === "APPROVED",
        })),
      })),
    },
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
      contents.map((row) => ({
        ...row,
        plannedFor: row.plannedFor
          ? parseStudioPublicationDay(studioPublicationDayKey(row.plannedFor, timeZone), timeZone)
          : null,
      })),
      startOfWeek(now, timeZone),
      addDays(startOfWeek(now, timeZone), 7, timeZone),
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
    channels: presentMarketingSocialDestinations(
      socialDestinations
        .map((row) => row.destination)
        .filter((destination) => {
          const summary = connectionSummaries.find((item) => item.destination === destination);
          if (!summary?.hasRow) return true;
          return summary.publishable;
        }),
    ),
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
