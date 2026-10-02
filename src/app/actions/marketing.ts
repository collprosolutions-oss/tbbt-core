"use server";

/**
 * Marketing server actions. Tenant scope always comes from
 * requireBusinessAccess() (session workspace), never from a client
 * businessId. OWNER/ADMIN only (MANAGE_MARKETING).
 */
import { revalidatePath } from "next/cache";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { requireOperatingProductAccess } from "@/lib/saas-billing/enforce";
import { requestOwnerMarketingContentDraft } from "@/lib/marketing-ai-draft";
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
  planStudioPublicationDay,
  updateMarketingStudioPackage,
} from "@/lib/marketing-ops";
import {
  MARKETING_AI_UNAVAILABLE_LABEL,
  OWNER_MARKETING_AI_DRAFT_MESSAGE,
  OWNER_STUDIO_CALENDAR_MESSAGE,
  STUDIO_APPROVED_INTERNAL_MESSAGE,
  STUDIO_PLANNED_DAY_SAVED_MESSAGE,
  STUDIO_RETURNED_MESSAGE,
  STUDIO_WEEKLY_REMINDER_OWNER_ONLY_MESSAGE,
  STUDIO_WEEKLY_REMINDER_OWNER_SMS_OWNER_ONLY_MESSAGE,
} from "@/lib/marketing";
import {
  setStudioWeeklyReminderOwnerSms,
  setStudioWeeklyReviewReminderOptIn,
} from "@/lib/marketing-studio-reminder";
import { prisma } from "@/lib/prisma";

export type MarketingActionState = {
  error?: string;
  message?: string;
};

export type MarketingAiActionState = {
  error?: string;
  message?: string;
  text?: string;
  mode?: "AI" | "UNAVAILABLE";
  task?: string;
  inProgress?: boolean;
  contentId?: string;
  unavailable?: boolean;
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

export async function setStudioWeeklyReviewReminderOptInAction(
  _prev: MarketingActionState,
  formData: FormData,
): Promise<MarketingActionState> {
  try {
    const access = await requireOperatingProductAccess(PRODUCT_CAPABILITIES.MARKETING_TOOLS);
    if (access.workspace.role !== "OWNER") {
      return { error: STUDIO_WEEKLY_REMINDER_OWNER_ONLY_MESSAGE };
    }
    const optedIn = readString(formData, "optedIn") === "true";
    const result = await setStudioWeeklyReviewReminderOptIn(prisma, access, optedIn);
    revalidateMarketing();
    return { message: result.message };
  } catch (error) {
    return { error: marketingErrorMessage(error, "That weekly reminder preference could not be saved.") };
  }
}

export async function setStudioWeeklyReminderOwnerSmsAction(
  _prev: MarketingActionState,
  formData: FormData,
): Promise<MarketingActionState> {
  try {
    const access = await requireOperatingProductAccess(PRODUCT_CAPABILITIES.MARKETING_TOOLS);
    if (access.workspace.role !== "OWNER") {
      return { error: STUDIO_WEEKLY_REMINDER_OWNER_SMS_OWNER_ONLY_MESSAGE };
    }
    const result = await setStudioWeeklyReminderOwnerSms(prisma, access, {
      destination: readString(formData, "ownerSmsTo"),
      optedIn: readString(formData, "ownerSmsOptedIn") === "true",
    });
    revalidateMarketing();
    return { message: result.message };
  } catch (error) {
    return { error: marketingErrorMessage(error, "That OWNER SMS destination could not be saved.") };
  }
}

export async function planStudioPublicationDayAction(
  _prev: MarketingActionState,
  formData: FormData,
): Promise<MarketingActionState> {
  try {
    const access = await requireOperatingProductAccess(PRODUCT_CAPABILITIES.MARKETING_TOOLS);
    if (access.workspace.role !== "OWNER") {
      return { error: OWNER_STUDIO_CALENDAR_MESSAGE };
    }
    await planStudioPublicationDay(prisma, access, {
      contentId: readString(formData, "contentId"),
      plannedFor: readString(formData, "plannedFor"),
      expectedUpdatedAt: readString(formData, "expectedUpdatedAt"),
    });
    revalidateMarketing();
    return { message: STUDIO_PLANNED_DAY_SAVED_MESSAGE };
  } catch (error) {
    return { error: marketingErrorMessage(error, "That planned publication day could not be saved.") };
  }
}

export async function setMarketingPlannedDateAction(
  _prev: MarketingActionState,
  formData: FormData,
): Promise<MarketingActionState> {
  return planStudioPublicationDayAction(_prev, formData);
}

export async function generateMarketingAiAction(
  _prev: MarketingAiActionState,
  formData: FormData,
): Promise<MarketingAiActionState> {
  try {
    const access = await requireOperatingProductAccess(PRODUCT_CAPABILITIES.MARKETING_TOOLS);
    if (access.workspace.role !== "OWNER") {
      return { error: OWNER_MARKETING_AI_DRAFT_MESSAGE };
    }
    const attemptId = readString(formData, "attemptId");
    const result = await requestOwnerMarketingContentDraft(prisma, access, { attemptId });
    if (result.status === "UNAVAILABLE") {
      return {
        message: MARKETING_AI_UNAVAILABLE_LABEL,
        mode: "UNAVAILABLE",
        task: "MARKETING_DRAFT",
        unavailable: true,
      };
    }
    if (result.inProgress) {
      return { message: result.message, task: "MARKETING_DRAFT", inProgress: true };
    }
    revalidateMarketing();
    return {
      message: result.message,
      text: result.text,
      mode: result.status === "COMPLETED" ? "AI" : undefined,
      task: "MARKETING_DRAFT",
      contentId: result.contentId ?? undefined,
    };
  } catch (error) {
    return { error: marketingErrorMessage(error, "That marketing draft could not be generated.") };
  }
}
