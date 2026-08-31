/**
 * Reviews mutations -- the real write path used by server actions and
 * the focused Reviews check. Every function takes an already-authorized
 * BusinessAccess and re-checks tenant + role before writing. Never trusts
 * a browser-supplied businessId.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  isReviewPlatform,
  isReviewReceivedPlatform,
  isReviewRequestStatus,
  isReviewResponseStatus,
  nextRequestStatus,
  nextResponseStatus,
  parseOptionalRating,
  parseOptionalUrl,
  parseReviewDate,
  requestBlocksNewOpportunity,
  reviewNeedsAttention,
  suggestedRequestText,
  suggestedResponseText,
} from "@/lib/reviews";

type Db = PrismaClient | Prisma.TransactionClient;

async function runInTransaction<T>(
  db: Db,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if ("$transaction" in db) {
    return db.$transaction(fn);
  }
  return fn(db);
}

export class ReviewsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewsError";
  }
}

export function reviewsErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ReviewsError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  return fallback;
}

async function requireOwnedCustomer(
  db: Db,
  access: BusinessAccess,
  customerId: string,
) {
  return access.assertOwned(
    await db.customer.findFirst({
      where: { id: customerId, ...access.scope },
      select: { id: true, businessId: true, name: true },
    }),
  );
}

async function requireOwnedCompletedJob(
  db: Db,
  access: BusinessAccess,
  jobId: string,
) {
  const job = access.assertOwned(
    await db.job.findFirst({
      where: { id: jobId, ...access.scope },
      select: {
        id: true,
        businessId: true,
        status: true,
        customerId: true,
        customer: { select: { name: true } },
      },
    }),
  );
  if (job.status !== "COMPLETED") {
    throw new ReviewsError("Only a completed job can become a review opportunity.");
  }
  return job;
}

async function assertNoActiveRequestForJob(
  db: Db,
  access: BusinessAccess,
  jobId: string,
  exceptRequestId?: string,
) {
  const existing = await db.reviewRequest.findFirst({
    where: {
      jobId,
      ...access.scope,
      status: { in: ["DRAFT", "READY", "SENT", "COMPLETED"] },
      ...(exceptRequestId ? { id: { not: exceptRequestId } } : {}),
    },
    select: { id: true, status: true },
  });
  if (existing && requestBlocksNewOpportunity(existing.status)) {
    throw new ReviewsError("A review request already exists for this completed job.");
  }
}

export type CreateReviewRequestInput = {
  customerId: string;
  jobId?: string;
  intendedPlatform?: string;
  requestText?: string;
  notes?: string;
  reminderAt?: string;
};

export async function createReviewRequest(
  db: Db,
  access: BusinessAccess,
  input: CreateReviewRequestInput,
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_REVIEWS);

  const customer = await requireOwnedCustomer(db, access, input.customerId);
  let jobId: string | null = null;
  let jobCustomerName: string | null = null;
  if (input.jobId) {
    const job = await requireOwnedCompletedJob(db, access, input.jobId);
    if (job.customerId && job.customerId !== customer.id) {
      throw new ReviewsError("That job does not belong to this customer.");
    }
    await assertNoActiveRequestForJob(db, access, job.id);
    jobId = job.id;
    jobCustomerName = job.customer?.name ?? null;
  }

  const intendedPlatform = input.intendedPlatform?.trim() || "UNASSIGNED";
  if (!isReviewPlatform(intendedPlatform)) {
    throw new ReviewsError("Choose an intended review platform.");
  }

  const business = await db.business.findFirst({
    where: { id: access.businessId },
    select: { name: true },
  });
  const requestText =
    input.requestText?.trim() ||
    suggestedRequestText({
      customerName: jobCustomerName ?? customer.name,
      businessName: business?.name ?? "us",
    });
  const reminderAt = input.reminderAt ? parseReviewDate(input.reminderAt) : null;
  if (input.reminderAt && !reminderAt) {
    throw new ReviewsError("Enter a valid follow-up date.");
  }

  return db.reviewRequest.create({
    data: {
      businessId: access.businessId,
      customerId: customer.id,
      jobId,
      status: "DRAFT",
      intendedPlatform,
      requestText,
      notes: input.notes?.trim() || null,
      reminderAt,
      createdByMembershipId: access.workspace.membership.id,
    },
  });
}

export async function updateReviewRequest(
  db: Db,
  access: BusinessAccess,
  input: {
    requestId: string;
    intendedPlatform?: string;
    requestText?: string;
    notes?: string;
    reminderAt?: string;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_REVIEWS);
  const request = access.assertOwned(
    await db.reviewRequest.findFirst({
      where: { id: input.requestId, ...access.scope },
    }),
  );
  if (request.status === "COMPLETED" || request.status === "CANCELLED") {
    throw new ReviewsError("This review request can no longer be edited.");
  }

  const data: Prisma.ReviewRequestUpdateInput = {};
  if (input.intendedPlatform !== undefined) {
    if (!isReviewPlatform(input.intendedPlatform)) {
      throw new ReviewsError("Choose an intended review platform.");
    }
    data.intendedPlatform = input.intendedPlatform;
  }
  if (input.requestText !== undefined) {
    const requestText = input.requestText.trim();
    if (!requestText) throw new ReviewsError("Enter request text.");
    data.requestText = requestText;
  }
  if (input.notes !== undefined) {
    data.notes = input.notes.trim() || null;
  }
  if (input.reminderAt !== undefined) {
    if (!input.reminderAt) {
      data.reminderAt = null;
    } else {
      const reminderAt = parseReviewDate(input.reminderAt);
      if (!reminderAt) throw new ReviewsError("Enter a valid follow-up date.");
      data.reminderAt = reminderAt;
    }
  }

  return db.reviewRequest.update({
    where: { id: request.id },
    data,
  });
}

export async function advanceReviewRequestStatus(
  db: Db,
  access: BusinessAccess,
  input: { requestId: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_REVIEWS);
  const request = access.assertOwned(
    await db.reviewRequest.findFirst({
      where: { id: input.requestId, ...access.scope },
    }),
  );
  const next = nextRequestStatus(request.status);
  if (!next) {
    throw new ReviewsError(
      request.status === "SENT"
        ? "This request is already recorded as sent. TBBT did not send a message."
        : "This review request cannot be advanced.",
    );
  }
  if (!isReviewRequestStatus(next)) {
    throw new ReviewsError("Invalid review request status.");
  }
  return db.reviewRequest.update({
    where: { id: request.id },
    data: {
      status: next,
      requestedAt: next === "SENT" ? request.requestedAt ?? new Date() : request.requestedAt,
    },
  });
}

export async function cancelReviewRequest(
  db: Db,
  access: BusinessAccess,
  input: { requestId: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_REVIEWS);
  const request = access.assertOwned(
    await db.reviewRequest.findFirst({
      where: { id: input.requestId, ...access.scope },
    }),
  );
  if (request.status === "COMPLETED" || request.status === "CANCELLED") {
    throw new ReviewsError("This review request can no longer be cancelled.");
  }
  return db.reviewRequest.update({
    where: { id: request.id },
    data: { status: "CANCELLED" },
  });
}

export type RecordReviewInput = {
  customerId: string;
  jobId?: string;
  reviewRequestId?: string;
  platform: string;
  rating?: string;
  reviewText?: string;
  externalReviewDate?: string;
  externalUrl?: string;
  notes?: string;
  recoveryNotes?: string;
};

export async function recordReceivedReview(
  db: Db,
  access: BusinessAccess,
  input: RecordReviewInput,
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_REVIEWS);

  const customer = await requireOwnedCustomer(db, access, input.customerId);
  if (!isReviewReceivedPlatform(input.platform)) {
    throw new ReviewsError("Choose the platform where the review was received.");
  }

  let jobId: string | null = null;
  if (input.jobId) {
    const job = await requireOwnedCompletedJob(db, access, input.jobId);
    if (job.customerId && job.customerId !== customer.id) {
      throw new ReviewsError("That job does not belong to this customer.");
    }
    jobId = job.id;
  }

  let reviewRequestId: string | null = null;
  if (input.reviewRequestId) {
    const request = access.assertOwned(
      await db.reviewRequest.findFirst({
        where: { id: input.reviewRequestId, ...access.scope },
      }),
    );
    if (request.customerId !== customer.id) {
      throw new ReviewsError("That request does not belong to this customer.");
    }
    if (request.status === "CANCELLED") {
      throw new ReviewsError("A cancelled request cannot receive a review.");
    }
    if (jobId && request.jobId && request.jobId !== jobId) {
      throw new ReviewsError("That request belongs to a different job.");
    }
    if (!jobId && request.jobId) jobId = request.jobId;
    reviewRequestId = request.id;
  }

  const rating = parseOptionalRating(input.rating);
  if (Number.isNaN(rating)) {
    throw new ReviewsError("Rating must be a whole number from 1 to 5, or left blank.");
  }
  const reviewText = (input.reviewText ?? "").trim();
  const externalReviewDate = input.externalReviewDate
    ? parseReviewDate(input.externalReviewDate)
    : null;
  if (input.externalReviewDate && !externalReviewDate) {
    throw new ReviewsError("Enter a valid external review date.");
  }
  const externalUrl = parseOptionalUrl(input.externalUrl);
  if (externalUrl === "") {
    throw new ReviewsError("Enter a valid http(s) URL, or leave it blank.");
  }

  const needsAttention = reviewNeedsAttention({ rating });
  const marketingEligible = false;

  return runInTransaction(db, async (tx) => {
    const review = await tx.review.create({
      data: {
        businessId: access.businessId,
        customerId: customer.id,
        jobId,
        reviewRequestId,
        platform: input.platform,
        rating,
        reviewText,
        externalReviewDate,
        externalUrl,
        responseStatus: "NONE",
        needsAttention,
        recoveryNotes: input.recoveryNotes?.trim() || null,
        notes: input.notes?.trim() || null,
        marketingEligible,
        recordedByMembershipId: access.workspace.membership.id,
      },
    });
    if (reviewRequestId) {
      await tx.reviewRequest.update({
        where: { id: reviewRequestId },
        data: { status: "COMPLETED" },
      });
    }
    return review;
  });
}

export async function updateReviewRecovery(
  db: Db,
  access: BusinessAccess,
  input: { reviewId: string; recoveryNotes: string; needsAttention?: boolean },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_REVIEWS);
  const review = access.assertOwned(
    await db.review.findFirst({
      where: { id: input.reviewId, ...access.scope },
    }),
  );
  return db.review.update({
    where: { id: review.id },
    data: {
      recoveryNotes: input.recoveryNotes.trim() || null,
      needsAttention: input.needsAttention ?? review.needsAttention,
    },
  });
}

export async function upsertReviewResponse(
  db: Db,
  access: BusinessAccess,
  input: { reviewId: string; body?: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_REVIEWS);
  const review = access.assertOwned(
    await db.review.findFirst({
      where: { id: input.reviewId, ...access.scope },
      include: { responses: { orderBy: { createdAt: "desc" }, take: 1 } },
    }),
  );
  const body = (input.body ?? "").trim() || suggestedResponseText();
  const existing = review.responses[0] ?? null;
  if (existing?.status === "APPROVED") {
    throw new ReviewsError("This response is already approved. External publishing is not available.");
  }

  if (existing) {
    return runInTransaction(db, async (tx) => {
      const response = await tx.reviewResponse.update({
        where: { id: existing.id },
        data: { body },
      });
      await tx.review.update({
        where: { id: review.id },
        data: { responseStatus: existing.status },
      });
      return response;
    });
  }

  return runInTransaction(db, async (tx) => {
    const response = await tx.reviewResponse.create({
      data: {
        businessId: access.businessId,
        reviewId: review.id,
        body,
        status: "DRAFT",
        createdByMembershipId: access.workspace.membership.id,
      },
    });
    await tx.review.update({
      where: { id: review.id },
      data: { responseStatus: "DRAFT" },
    });
    return response;
  });
}

export async function advanceReviewResponseStatus(
  db: Db,
  access: BusinessAccess,
  input: { responseId: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_REVIEWS);
  const response = access.assertOwned(
    await db.reviewResponse.findFirst({
      where: { id: input.responseId, ...access.scope },
    }),
  );
  const next = nextResponseStatus(response.status);
  if (!next) {
    throw new ReviewsError("This response is already approved. External publishing is not available.");
  }
  if (!isReviewResponseStatus(next)) {
    throw new ReviewsError("Invalid response status.");
  }
  return runInTransaction(db, async (tx) => {
    const updated = await tx.reviewResponse.update({
      where: { id: response.id },
      data: {
        status: next,
        reviewedByMembershipId:
          next === "APPROVED" ? access.workspace.membership.id : response.reviewedByMembershipId,
        reviewedAt: next === "APPROVED" ? new Date() : response.reviewedAt,
      },
    });
    await tx.review.update({
      where: { id: response.reviewId, ...access.scope },
      data: { responseStatus: next },
    });
    return updated;
  });
}

