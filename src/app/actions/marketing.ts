"use server";

/**
 * Marketing server actions. Tenant scope always comes from
 * requireBusinessAccess() (session workspace), never from a client
 * businessId. OWNER/ADMIN only (MANAGE_MARKETING).
 */
import { revalidatePath } from "next/cache";
import { requireOperatingBusinessAccess } from "@/lib/saas-billing/enforce";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { isAiAttemptId } from "@/lib/ai/types";
import {
  campaignIdeasWithAi,
  draftMarketingVariationsWithAi,
  weeklyMarketingPlanWithAi,
} from "@/lib/ai/marketing";
import { loadMarketingSource } from "@/lib/marketing-data";
import {
  advanceMarketingContentStatus,
  createMarketingContent,
  grantJobPhotoMarketingPermission,
  marketingErrorMessage,
  revokeJobPhotoMarketingPermission,
  setMarketingContentPlannedFor,
} from "@/lib/marketing-ops";
import { prisma } from "@/lib/prisma";

export type MarketingActionState = {
  error?: string;
  message?: string;
};

export type MarketingAiActionState = {
  error?: string;
  message?: string;
  text?: string;
  mode?: "AI" | "TEMPLATE";
  task?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function revalidateMarketing() {
  revalidatePath("/marketing");
}

export async function grantPhotoMarketingPermissionAction(
  _prev: MarketingActionState,
  formData: FormData,
): Promise<MarketingActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await grantJobPhotoMarketingPermission(prisma, access, {
      photoId: readString(formData, "photoId"),
    });
    revalidateMarketing();
    return { message: "Photo approved for marketing." };
  } catch (error) {
    return { error: marketingErrorMessage(error, "That photo permission could not be saved.") };
  }
}

export async function revokePhotoMarketingPermissionAction(
  _prev: MarketingActionState,
  formData: FormData,
): Promise<MarketingActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await revokeJobPhotoMarketingPermission(prisma, access, {
      photoId: readString(formData, "photoId"),
    });
    revalidateMarketing();
    return { message: "Marketing permission removed. Photo is private again." };
  } catch (error) {
    return { error: marketingErrorMessage(error, "That photo permission could not be changed.") };
  }
}

export async function createMarketingContentAction(
  _prev: MarketingActionState,
  formData: FormData,
): Promise<MarketingActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await createMarketingContent(prisma, access, {
      contentType: readString(formData, "contentType"),
      title: readString(formData, "title"),
      body: readString(formData, "body"),
      channelIntent: readString(formData, "channelIntent"),
      jobId: readString(formData, "jobId") || undefined,
      photoIds: formData.getAll("photoIds").filter((value): value is string => typeof value === "string"),
      plannedFor: readString(formData, "plannedFor") || undefined,
    });
    revalidateMarketing();
    return { message: "Content draft saved." };
  } catch (error) {
    return { error: marketingErrorMessage(error, "That content draft could not be saved.") };
  }
}

export async function advanceMarketingContentAction(
  _prev: MarketingActionState,
  formData: FormData,
): Promise<MarketingActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    const updated = await advanceMarketingContentStatus(prisma, access, {
      contentId: readString(formData, "contentId"),
    });
    revalidateMarketing();
    return {
      message:
        updated.status === "APPROVED"
          ? "Content approved for internal use. It has not been published externally."
          : "Content marked ready for review.",
    };
  } catch (error) {
    return { error: marketingErrorMessage(error, "That content status could not be updated.") };
  }
}

export async function setMarketingPlannedDateAction(
  _prev: MarketingActionState,
  formData: FormData,
): Promise<MarketingActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await setMarketingContentPlannedFor(prisma, access, {
      contentId: readString(formData, "contentId"),
      plannedFor: readString(formData, "plannedFor"),
    });
    revalidateMarketing();
    return { message: "Internal planning date saved. This does not publish the post." };
  } catch (error) {
    return { error: marketingErrorMessage(error, "That planning date could not be saved.") };
  }
}

export async function generateMarketingAiAction(
  _prev: MarketingAiActionState,
  formData: FormData,
): Promise<MarketingAiActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    requireBusinessCapability(access, CAPABILITIES.MANAGE_MARKETING);
    const task = readString(formData, "marketingAiTask");
    const attemptId = readString(formData, "attemptId");
    if (!isAiAttemptId(attemptId)) return { error: "Retry that request from the form." };
    const source = await loadMarketingSource(prisma, access.businessId);
    const actor = {
      businessId: access.businessId,
      membershipId: access.workspace.membership.id,
      userId: access.workspace.user.id,
    };
    const key = `marketing:${task}:${access.businessId}:${attemptId}`;
    const facts = source.recordedActivity;
    if (task === "WEEKLY_PLAN") {
      const result = await weeklyMarketingPlanWithAi(prisma, actor, facts, key);
      if (result.status === "PENDING") return { message: result.message, task };
      return { message: result.message, text: result.text, mode: result.mode, task };
    }
    if (task === "CAMPAIGN_IDEAS") {
      const result = await campaignIdeasWithAi(prisma, actor, facts, key);
      if (result.status === "PENDING") return { message: result.message, task };
      return { message: result.message, text: result.text, mode: result.mode, task };
    }
    if (task === "MARKETING_DRAFT") {
      const result = await draftMarketingVariationsWithAi(
        prisma,
        actor,
        {
          contentType: "COMPLETED_JOB",
          businessName: facts.businessName,
          workPerformed: facts.workPerformed,
          photoCount: facts.photoCount,
          city: facts.city,
        },
        key,
      );
      if (result.status === "PENDING") return { message: result.message, task };
      return { message: result.message, text: result.text, mode: result.mode, task };
    }
    return { error: "Choose a marketing AI task." };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "That marketing draft could not be generated." };
  }
}
