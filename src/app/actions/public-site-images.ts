"use server";

import { revalidatePath } from "next/cache";
import { requireBusinessAccess } from "@/lib/access";
import { prisma } from "@/lib/prisma";
import {
  PUBLIC_SITE_HOME_PAGE,
  PUBLIC_SITE_IMAGE_STORAGE_UNAVAILABLE,
  clampObjectZoom,
  formatObjectPosition,
  publicSiteImageErrorMessage,
  resetPublicSiteImageOp,
  upsertPublicSiteImageOp,
} from "@/lib/public-site-images";
import { assertSettingsBusinessScope } from "@/lib/settings-ops";
import {
  isStorageConfigured,
  isSupportedImageMimeType,
  MAX_JOB_PHOTO_UPLOAD_BYTES,
  uploadPublicSitePhoto,
} from "@/lib/storage";

export type PublicSiteImageActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function revalidatePublicSite(slug: string) {
  revalidatePath("/settings");
  revalidatePath("/");
  revalidatePath(`/hire/${slug}`);
}

export async function replacePublicSiteImage(
  _prev: PublicSiteImageActionState,
  formData: FormData,
): Promise<PublicSiteImageActionState> {
  try {
    const access = await requireBusinessAccess();
    assertSettingsBusinessScope(access, readString(formData, "businessId") || null);
    const page = readString(formData, "page") || PUBLIC_SITE_HOME_PAGE;
    const slot = readString(formData, "slot");
    const file = formData.get("file");

    if (!slot) {
      return { error: "Choose an image slot to update." };
    }
    if (!(file instanceof File) || file.size === 0) {
      return { error: "Choose a photo to upload." };
    }
    if (!isSupportedImageMimeType(file.type)) {
      return {
        error: "Unsupported file type. Upload a JPEG, PNG, WebP, GIF, or HEIC photo.",
      };
    }
    if (file.size > MAX_JOB_PHOTO_UPLOAD_BYTES) {
      const maxMb = (MAX_JOB_PHOTO_UPLOAD_BYTES / (1024 * 1024)).toFixed(0);
      return { error: `That photo is too large. The limit is ${maxMb} MB.` };
    }
    if (!isStorageConfigured()) {
      return { error: PUBLIC_SITE_IMAGE_STORAGE_UNAVAILABLE };
    }

    const uploaded = await uploadPublicSitePhoto({
      businessId: access.businessId,
      page,
      slot,
      file,
    });
    await upsertPublicSiteImageOp(prisma, access, {
      page,
      slot,
      imageUrl: uploaded.url,
    });
    revalidatePublicSite(access.workspace.business.slug);
    return { message: "Website photo saved." };
  } catch (error) {
    return {
      error: publicSiteImageErrorMessage(error, "That website photo could not be saved."),
    };
  }
}

export async function repositionPublicSiteImage(
  _prev: PublicSiteImageActionState,
  formData: FormData,
): Promise<PublicSiteImageActionState> {
  try {
    const access = await requireBusinessAccess();
    assertSettingsBusinessScope(access, readString(formData, "businessId") || null);
    const page = readString(formData, "page") || PUBLIC_SITE_HOME_PAGE;
    const slot = readString(formData, "slot");
    const currentSrc = readString(formData, "currentSrc");
    const x = Number(readString(formData, "positionX"));
    const y = Number(readString(formData, "positionY"));
    const zoom = Number(readString(formData, "objectZoom"));

    if (!slot) {
      return { error: "Choose an image slot to update." };
    }

    await upsertPublicSiteImageOp(prisma, access, {
      page,
      slot,
      imageUrl: currentSrc || undefined,
      objectPosition: formatObjectPosition(x, y),
      objectZoom: clampObjectZoom(zoom),
    });
    revalidatePublicSite(access.workspace.business.slug);
    return { message: "Image position saved." };
  } catch (error) {
    return {
      error: publicSiteImageErrorMessage(error, "That image position could not be saved."),
    };
  }
}

export async function resetPublicSiteImage(
  _prev: PublicSiteImageActionState,
  formData: FormData,
): Promise<PublicSiteImageActionState> {
  try {
    const access = await requireBusinessAccess();
    assertSettingsBusinessScope(access, readString(formData, "businessId") || null);
    const page = readString(formData, "page") || PUBLIC_SITE_HOME_PAGE;
    const slot = readString(formData, "slot");
    if (!slot) {
      return { error: "Choose an image slot to reset." };
    }
    const result = await resetPublicSiteImageOp(prisma, access, { page, slot });
    revalidatePublicSite(access.workspace.business.slug);
    return result.unchanged
      ? { message: "This image is already using the default." }
      : { message: "Default website photo restored." };
  } catch (error) {
    return {
      error: publicSiteImageErrorMessage(error, "That website photo could not be reset."),
    };
  }
}
