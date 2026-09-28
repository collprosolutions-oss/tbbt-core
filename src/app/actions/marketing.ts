"use server";

/**
 * Marketing server actions. Tenant scope always comes from
 * requireBusinessAccess() (session workspace), never from a client
 * businessId. OWNER/ADMIN only (MANAGE_MARKETING).
 */
import { revalidatePath } from "next/cache";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { requireOperatingProductAccess } from "@/lib/saas-billing/enforce";
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
  approveMarketingStudioPackage,
  createMarketingStudioPackage,
  downloadMarketingReviewPacket,
  exportMarketingCreatorPackage,
  grantJobPhotoMarketingPermission,
  marketingErrorMessage,
  returnMarketingStudioPackage,
  revokeJobPhotoMarketingPermission,
  setMarketingContentPlannedFor,
  updateMarketingStudioPackage,
} from "@/lib/marketing-ops";
import {
  STUDIO_APPROVED_INTERNAL_MESSAGE,
  STUDIO_RETURNED_MESSAGE,
} from "@/lib/marketing";
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
  inProgress?: boolean;
};

export type MarketingExportState = {
  error?: string;
  message?: string;
  filename?: string;
  packageJson?: string;
};

export type MarketingReviewPacketState = {
  error?: string;
  message?: string;
  filename?: string;
  packetJson?: string;
  downloadNonce?: string;
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
    const access = await requireOperatingProductAccess(PRODUCT_CAPABILITIES.MARKETING_TOOLS);
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
    const access = await requireOperatingProductAccess(PRODUCT_CAPABILITIES.MARKETING_TOOLS);
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
    const access = await requireOperatingProductAccess(PRODUCT_CAPABILITIES.MARKETING_TOOLS);
    await createMarketingStudioPackage(prisma, access, {
      contentType: readString(formData, "contentType") || "COMPLETED_JOB",
      title: readString(formData, "title"),
      body: readString(formData, "body"),
      channelIntent: readString(formData, "channelIntent"),
      jobId: readString(formData, "jobId") || undefined,
      photoIds: formData.getAll("photoIds").filter((value): value is string => typeof value === "string"),
      plannedFor: readString(formData, "plannedFor") || undefined,
      storyboardJson: readString(formData, "storyboardJson") || "[]",
      shotListJson: readString(formData, "shotListJson") || "[]",
      hashtags: readString(formData, "hashtags"),
    });
    revalidateMarketing();
    return { message: "Creator package draft saved. It has not been published." };
  } catch (error) {
    return { error: marketingErrorMessage(error, "That creator package draft could not be saved.") };
  }
}

export async function updateMarketingStudioAction(
  _prev: MarketingActionState,
  formData: FormData,
): Promise<MarketingActionState> {
  try {
    const access = await requireOperatingProductAccess(PRODUCT_CAPABILITIES.MARKETING_TOOLS);
    const photoIds = formData
      .getAll("photoIds")
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    await updateMarketingStudioPackage(prisma, access, {
      contentId: readString(formData, "contentId"),
      title: readString(formData, "title"),
      body: readString(formData, "body"),
      channelIntent: readString(formData, "channelIntent") || undefined,
      plannedFor: readString(formData, "plannedFor") || undefined,
      storyboardJson: readString(formData, "storyboardJson") || "[]",
      shotListJson: readString(formData, "shotListJson") || "[]",
      hashtags: readString(formData, "hashtags"),
      photoIds: photoIds.length > 0 ? photoIds : undefined,
    });
    revalidateMarketing();
    return { message: "Creator package draft updated. It has not been published." };
  } catch (error) {
    return { error: marketingErrorMessage(error, "That creator package could not be updated.") };
  }
}

export async function exportMarketingCreatorPackageAction(
  _prev: MarketingExportState,
  formData: FormData,
): Promise<MarketingExportState> {
  try {
    const access = await requireOperatingProductAccess(PRODUCT_CAPABILITIES.MARKETING_TOOLS);
    const exported = await exportMarketingCreatorPackage(prisma, access, {
      contentId: readString(formData, "contentId"),
    });
    revalidateMarketing();
    return {
      message: "Creator package exported as a handoff file. Nothing was posted.",
      filename: exported.filename,
      packageJson: JSON.stringify(exported.package, null, 2),
    };
  } catch (error) {
    return { error: marketingErrorMessage(error, "That creator package could not be exported.") };
  }
}

export async function downloadMarketingReviewPacketAction(
  _prev: MarketingReviewPacketState,
  formData: FormData,
): Promise<MarketingReviewPacketState> {
  try {
    const access = await requireOperatingProductAccess(PRODUCT_CAPABILITIES.MARKETING_TOOLS);
    const downloaded = await downloadMarketingReviewPacket(prisma, access, {
      contentId: readString(formData, "contentId"),
    });
    return {
      message: downloaded.packet.draft
        ? "Draft review packet downloaded. Text is not approved. Nothing was posted."
        : "Review packet downloaded. Nothing was posted.",
      filename: downloaded.filename,
      packetJson: JSON.stringify(downloaded.packet, null, 2),
      downloadNonce: crypto.randomUUID(),
    };
  } catch (error) {
    return { error: marketingErrorMessage(error, "That review packet could not be downloaded.") };
  }
}

export async function advanceMarketingContentAction(
  _prev: MarketingActionState,
  formData: FormData,
): Promise<MarketingActionState> {
  try {
    const access = await requireOperatingProductAccess(PRODUCT_CAPABILITIES.MARKETING_TOOLS);
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

export async function approveMarketingStudioPackageAction(
  _prev: MarketingActionState,
  formData: FormData,
): Promise<MarketingActionState> {
  try {
    const access = await requireOperatingProductAccess(PRODUCT_CAPABILITIES.MARKETING_TOOLS);
    await approveMarketingStudioPackage(prisma, access, {
      contentId: readString(formData, "contentId"),
    });
    revalidateMarketing();
    return { message: STUDIO_APPROVED_INTERNAL_MESSAGE };
  } catch (error) {
    return { error: marketingErrorMessage(error, "That creator package could not be approved.") };
  }
}

export async function returnMarketingStudioPackageAction(
  _prev: MarketingActionState,
  formData: FormData,
): Promise<MarketingActionState> {
  try {
    const access = await requireOperatingProductAccess(PRODUCT_CAPABILITIES.MARKETING_TOOLS);
    await returnMarketingStudioPackage(prisma, access, {
      contentId: readString(formData, "contentId"),
    });
    revalidateMarketing();
    return { message: STUDIO_RETURNED_MESSAGE };
  } catch (error) {
    return { error: marketingErrorMessage(error, "That creator package could not be returned for changes.") };
  }
}

export async function setMarketingPlannedDateAction(
  _prev: MarketingActionState,
  formData: FormData,
): Promise<MarketingActionState> {
  try {
    const access = await requireOperatingProductAccess(PRODUCT_CAPABILITIES.MARKETING_TOOLS);
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
    const access = await requireOperatingProductAccess(PRODUCT_CAPABILITIES.MARKETING_TOOLS);
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
      if (result.status === "PENDING") return { message: result.message, task, inProgress: true };
      return { message: result.message, text: result.text, mode: result.mode, task };
    }
    if (task === "CAMPAIGN_IDEAS") {
      const result = await campaignIdeasWithAi(prisma, actor, facts, key);
      if (result.status === "PENDING") return { message: result.message, task, inProgress: true };
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
      if (result.status === "PENDING") return { message: result.message, task, inProgress: true };
      return { message: result.message, text: result.text, mode: result.mode, task };
    }
    return { error: "Choose a marketing AI task." };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "That marketing draft could not be generated." };
  }
}
