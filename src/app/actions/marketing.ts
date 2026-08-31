"use server";

/**
 * Marketing server actions. Tenant scope always comes from
 * requireBusinessAccess() (session workspace), never from a client
 * businessId. OWNER/ADMIN only (MANAGE_MARKETING).
 */
import { revalidatePath } from "next/cache";
import { requireBusinessAccess } from "@/lib/access";
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
    const access = await requireBusinessAccess();
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
    const access = await requireBusinessAccess();
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
    const access = await requireBusinessAccess();
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
    const access = await requireBusinessAccess();
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
    const access = await requireBusinessAccess();
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
