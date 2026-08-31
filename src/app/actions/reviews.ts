"use server";

/**
 * Reviews server actions. Tenant scope always comes from
 * requireBusinessAccess() (session workspace), never from a client
 * businessId. OWNER/ADMIN only (MANAGE_REVIEWS).
 */
import { revalidatePath } from "next/cache";
import { requireBusinessAccess } from "@/lib/access";
import {
  advanceReviewRequestStatus,
  advanceReviewResponseStatus,
  cancelReviewRequest,
  createReviewRequest,
  recordReceivedReview,
  reviewsErrorMessage,
  updateReviewRecovery,
  updateReviewRequest,
  upsertReviewResponse,
} from "@/lib/reviews-ops";
import { prisma } from "@/lib/prisma";

export type ReviewsActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function revalidateReviews(customerId?: string, jobId?: string) {
  revalidatePath("/reviews");
  revalidatePath("/marketing");
  if (customerId) revalidatePath(`/customers/${customerId}`);
  if (jobId) revalidatePath(`/jobs/${jobId}`);
}

export async function createReviewRequestAction(
  _prev: ReviewsActionState,
  formData: FormData,
): Promise<ReviewsActionState> {
  try {
    const access = await requireBusinessAccess();
    const customerId = readString(formData, "customerId");
    const jobId = readString(formData, "jobId") || undefined;
    await createReviewRequest(prisma, access, {
      customerId,
      jobId,
      intendedPlatform: readString(formData, "intendedPlatform") || undefined,
      requestText: readString(formData, "requestText") || undefined,
      notes: readString(formData, "notes") || undefined,
      reminderAt: readString(formData, "reminderAt") || undefined,
    });
    revalidateReviews(customerId, jobId);
    return { message: "Review request draft saved. The customer has not been contacted." };
  } catch (error) {
    return { error: reviewsErrorMessage(error, "That review request could not be saved.") };
  }
}

export async function updateReviewRequestAction(
  _prev: ReviewsActionState,
  formData: FormData,
): Promise<ReviewsActionState> {
  try {
    const access = await requireBusinessAccess();
    await updateReviewRequest(prisma, access, {
      requestId: readString(formData, "requestId"),
      intendedPlatform: formData.has("intendedPlatform")
        ? readString(formData, "intendedPlatform")
        : undefined,
      requestText: formData.has("requestText") ? readString(formData, "requestText") : undefined,
      notes: formData.has("notes") ? readString(formData, "notes") : undefined,
      reminderAt: formData.has("reminderAt") ? readString(formData, "reminderAt") : undefined,
    });
    revalidateReviews();
    return { message: "Review request updated. No message was sent." };
  } catch (error) {
    return { error: reviewsErrorMessage(error, "That review request could not be updated.") };
  }
}

export async function advanceReviewRequestAction(
  _prev: ReviewsActionState,
  formData: FormData,
): Promise<ReviewsActionState> {
  try {
    const access = await requireBusinessAccess();
    const updated = await advanceReviewRequestStatus(prisma, access, {
      requestId: readString(formData, "requestId"),
    });
    revalidateReviews();
    return {
      message:
        updated.status === "SENT"
          ? "Request recorded as sent. TBBT did not send SMS or email."
          : "Request marked ready. The customer has not been contacted.",
    };
  } catch (error) {
    return { error: reviewsErrorMessage(error, "That review request status could not be updated.") };
  }
}

export async function cancelReviewRequestAction(
  _prev: ReviewsActionState,
  formData: FormData,
): Promise<ReviewsActionState> {
  try {
    const access = await requireBusinessAccess();
    await cancelReviewRequest(prisma, access, {
      requestId: readString(formData, "requestId"),
    });
    revalidateReviews();
    return { message: "Review request cancelled." };
  } catch (error) {
    return { error: reviewsErrorMessage(error, "That review request could not be cancelled.") };
  }
}

export async function recordReceivedReviewAction(
  _prev: ReviewsActionState,
  formData: FormData,
): Promise<ReviewsActionState> {
  try {
    const access = await requireBusinessAccess();
    const customerId = readString(formData, "customerId");
    const jobId = readString(formData, "jobId") || undefined;
    await recordReceivedReview(prisma, access, {
      customerId,
      jobId,
      reviewRequestId: readString(formData, "reviewRequestId") || undefined,
      platform: readString(formData, "platform"),
      rating: readString(formData, "rating") || undefined,
      reviewText: readString(formData, "reviewText") || undefined,
      externalReviewDate: readString(formData, "externalReviewDate") || undefined,
      externalUrl: readString(formData, "externalUrl") || undefined,
      notes: readString(formData, "notes") || undefined,
      recoveryNotes: readString(formData, "recoveryNotes") || undefined,
    });
    revalidateReviews(customerId, jobId);
    return { message: "Review recorded. This is owner-entered activity, not an imported platform review." };
  } catch (error) {
    return { error: reviewsErrorMessage(error, "That review could not be recorded.") };
  }
}

export async function updateReviewRecoveryAction(
  _prev: ReviewsActionState,
  formData: FormData,
): Promise<ReviewsActionState> {
  try {
    const access = await requireBusinessAccess();
    await updateReviewRecovery(prisma, access, {
      reviewId: readString(formData, "reviewId"),
      recoveryNotes: readString(formData, "recoveryNotes"),
    });
    revalidateReviews();
    return { message: "Recovery notes saved. No public reply was published." };
  } catch (error) {
    return { error: reviewsErrorMessage(error, "Those recovery notes could not be saved.") };
  }
}

export async function upsertReviewResponseAction(
  _prev: ReviewsActionState,
  formData: FormData,
): Promise<ReviewsActionState> {
  try {
    const access = await requireBusinessAccess();
    await upsertReviewResponse(prisma, access, {
      reviewId: readString(formData, "reviewId"),
      body: readString(formData, "body") || undefined,
    });
    revalidateReviews();
    return { message: "Response draft saved. It has not been published." };
  } catch (error) {
    return { error: reviewsErrorMessage(error, "That response draft could not be saved.") };
  }
}

export async function advanceReviewResponseAction(
  _prev: ReviewsActionState,
  formData: FormData,
): Promise<ReviewsActionState> {
  try {
    const access = await requireBusinessAccess();
    const updated = await advanceReviewResponseStatus(prisma, access, {
      responseId: readString(formData, "responseId"),
    });
    revalidateReviews();
    return {
      message:
        updated.status === "APPROVED"
          ? "Response approved internally. It has not been published externally."
          : "Response marked ready for review. It has not been published.",
    };
  } catch (error) {
    return { error: reviewsErrorMessage(error, "That response status could not be updated.") };
  }
}
