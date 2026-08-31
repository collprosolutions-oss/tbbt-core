/**
 * Tenant-scoped Reviews loader. Every query is keyed by the
 * authenticated workspace businessId -- never a client-supplied id.
 */

import type { PrismaClient } from "@prisma/client";
import { startOfDay } from "@/lib/schedule";
import {
  isReminderDue,
  MARKETING_LINK_MESSAGE,
  PERFORMANCE_INTERNAL_MESSAGE,
  PLATFORMS_DISCONNECTED_MESSAGE,
  rateWhenValid,
  recommendedOpportunityAction,
  requestWorkflowState,
  reviewMayBeMarketingEligible,
  REVIEW_OPPORTUNITY_ACTION_LABELS,
  REQUEST_WORKFLOW_LABELS,
} from "@/lib/reviews";

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

export async function loadReviewsSource(prisma: PrismaClient, businessId: string) {
  const scope = { businessId } as const;
  const now = startOfDay(new Date());

  const [business, jobs, requests, reviews, serviceRequests, catalogItems] = await Promise.all([
    prisma.business.findFirst({
      where: { id: businessId },
      select: { id: true, name: true },
    }),
    prisma.job.findMany({
      where: { ...scope, status: "COMPLETED", customerId: { not: null } },
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
        invoices: {
          select: {
            id: true,
            status: true,
            total: true,
            paidAt: true,
            paymentMethod: true,
          },
          orderBy: { createdAt: "asc" },
          take: 1,
        },
      },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.reviewRequest.findMany({
      where: scope,
      include: {
        customer: { select: { id: true, name: true } },
        job: { select: { id: true, status: true, updatedAt: true } },
        reviews: { select: { id: true } },
      },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.review.findMany({
      where: scope,
      include: {
        customer: { select: { id: true, name: true } },
        job: { select: { id: true, status: true } },
        reviewRequest: { select: { id: true, status: true } },
        responses: { orderBy: { createdAt: "desc" }, take: 1 },
        marketingContents: { select: { id: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.serviceRequest.findMany({
      where: scope,
      select: { id: true, serviceCatalogItemId: true },
    }),
    prisma.serviceCatalogItem.findMany({
      where: scope,
      select: { id: true, name: true },
    }),
  ]);

  const catalogName = (id: string | null) =>
    id ? catalogItems.find((item) => item.id === id)?.name ?? null : null;

  const requestByJobId = new Map(
    requests.filter((row) => row.jobId).map((row) => [row.jobId as string, row]),
  );
  const reviewByJobId = new Map(
    reviews.filter((row) => row.jobId).map((row) => [row.jobId as string, row]),
  );

  const opportunities = jobs.map((job) => {
    const catalogId = catalogIdForEstimate(job.estimate, serviceRequests);
    const workPerformed =
      catalogName(catalogId) ??
      job.estimate?.lineItems[0]?.description ??
      "Service not attributed";
    const request = requestByJobId.get(job.id) ?? null;
    const review = reviewByJobId.get(job.id) ?? null;
    const reminderDue = request
      ? isReminderDue({
          status: request.status,
          reminderAt: request.reminderAt,
          hasReview: Boolean(review) || request.reviews.length > 0,
          now,
        })
      : false;
    const nextAction = recommendedOpportunityAction({
      requestStatus: request?.status ?? null,
      reminderDue,
      hasReview: Boolean(review) || Boolean(request && request.reviews.length > 0),
    });
    const invoice = job.invoices[0] ?? null;
    return {
      jobId: job.id,
      customerId: job.customerId as string,
      customerName: job.customer?.name ?? "Customer",
      workPerformed,
      completedAt: job.updatedAt,
      invoice: invoice
        ? {
            id: invoice.id,
            status: invoice.status,
            total: invoice.total.toString(),
            paidAt: invoice.paidAt,
            paymentMethod: invoice.paymentMethod,
          }
        : null,
      requestId: request?.id ?? null,
      requestStatus: request?.status ?? null,
      reminderDue,
      hasReview: Boolean(review),
      nextAction,
      nextActionLabel: REVIEW_OPPORTUNITY_ACTION_LABELS[nextAction],
      workflowState: requestWorkflowState({
        status: request?.status ?? "",
        reminderDue,
        hasReview: Boolean(review),
      }),
      href: `/jobs/${job.id}`,
    };
  });

  const openOpportunities = opportunities.filter(
    (row) => !row.requestId || row.requestStatus === "CANCELLED",
  );

  const requestRows = requests.map((request) => {
    const review = request.reviews[0] ?? reviews.find((row) => row.reviewRequestId === request.id) ?? null;
    const reminderDue = isReminderDue({
      status: request.status,
      reminderAt: request.reminderAt,
      hasReview: Boolean(review),
      now,
    });
    return {
      id: request.id,
      customerId: request.customerId,
      customerName: request.customer.name,
      jobId: request.jobId,
      status: request.status,
      intendedPlatform: request.intendedPlatform,
      requestText: request.requestText,
      notes: request.notes,
      requestedAt: request.requestedAt,
      reminderAt: request.reminderAt,
      reminderDue,
      createdAt: request.createdAt,
      hasReview: Boolean(review),
      workflowState: requestWorkflowState({
        status: request.status,
        reminderDue,
        hasReview: Boolean(review),
      }),
      workflowLabel: REQUEST_WORKFLOW_LABELS[
        requestWorkflowState({
          status: request.status,
          reminderDue,
          hasReview: Boolean(review),
        })
      ],
    };
  });

  const reviewRows = reviews.map((review) => {
    const response = review.responses[0] ?? null;
    const mayBeMarketing = reviewMayBeMarketingEligible({
      rating: review.rating,
      reviewText: review.reviewText,
    });
    return {
      id: review.id,
      customerId: review.customerId,
      customerName: review.customer.name,
      jobId: review.jobId,
      reviewRequestId: review.reviewRequestId,
      platform: review.platform,
      rating: review.rating,
      reviewText: review.reviewText,
      externalReviewDate: review.externalReviewDate,
      externalUrl: review.externalUrl,
      responseStatus: review.responseStatus,
      needsAttention: review.needsAttention,
      recoveryNotes: review.recoveryNotes,
      notes: review.notes,
      marketingEligible: review.marketingEligible,
      mayBeMarketingEligible: mayBeMarketing,
      marketingContentLinked: review.marketingContents.length > 0,
      createdAt: review.createdAt,
      response: response
        ? {
            id: response.id,
            body: response.body,
            status: response.status,
          }
        : null,
    };
  });

  const awaitingAction = requestRows.filter((row) => row.status === "DRAFT" || row.status === "READY");
  const sent = requestRows.filter((row) => row.status === "SENT" || row.status === "COMPLETED");
  const followUpsDue = requestRows.filter((row) => row.reminderDue);
  const attention = reviewRows.filter((row) => row.needsAttention);
  const responsesNeedingAttention = reviewRows.filter(
    (row) => row.needsAttention || row.responseStatus !== "APPROVED",
  );
  const approvedResponses = reviewRows.filter((row) => row.responseStatus === "APPROVED");

  const sentCount = requestRows.filter((row) => row.status === "SENT" || row.status === "COMPLETED").length;
  const recordedSentOnly = requestRows.filter((row) => row.requestedAt).length;

  return {
    businessId,
    businessName: business?.name ?? "Business",
    platforms: {
      connected: false,
      message: PLATFORMS_DISCONNECTED_MESSAGE,
    },
    marketing: {
      message: MARKETING_LINK_MESSAGE,
    },
    opportunities,
    openOpportunities,
    requests: requestRows,
    reviews: reviewRows,
    attention,
    counts: {
      opportunities: openOpportunities.length,
      awaitingAction: awaitingAction.length,
      sent: sent.length,
      received: reviewRows.length,
      responsesNeedingAttention: responsesNeedingAttention.filter((row) => row.needsAttention).length,
      followUpsDue: followUpsDue.length,
      approvedResponses: approvedResponses.length,
    },
    performance: {
      available: true,
      message: PERFORMANCE_INTERNAL_MESSAGE,
      requestsRecordedAsSent: recordedSentOnly,
      reviewsRecorded: reviewRows.length,
      responsesApproved: approvedResponses.length,
      followUpsDue: followUpsDue.length,
      requestToReviewRate: rateWhenValid(reviewRows.length, sentCount),
      responseCompletionRate: rateWhenValid(approvedResponses.length, reviewRows.length),
    },
    customers: [
      ...new Map(
        [
          ...jobs.map((job) => ({
            id: job.customerId as string,
            name: job.customer?.name ?? "Customer",
          })),
          ...requests.map((request) => ({ id: request.customerId, name: request.customer.name })),
          ...reviews.map((review) => ({ id: review.customerId, name: review.customer.name })),
        ].map((row) => [row.id, row]),
      ).values(),
    ],
  };
}

export type ReviewsSource = Awaited<ReturnType<typeof loadReviewsSource>>;
