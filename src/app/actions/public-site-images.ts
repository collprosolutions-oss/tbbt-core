"use server";

import { revalidatePath } from "next/cache";
import { requireBusinessAccess } from "@/lib/access";
import {
  deleteStoredAsset,
  isBusinessStorageConfigured,
} from "@/lib/business-storage";
import { replaceWebsitePhotoFromBytes } from "@/lib/business-storage/website-photos";
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
  MAX_JOB_PHOTO_UPLOAD_BYTES,
  resolveSupportedImageMimeType,
} from "@/lib/storage";

export type PublicSiteImageActionState = {
  error?: string;
  message?: string;
  imageUrl?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function ownerUploadError(error: unknown) {
  const detail = error instanceof Error ? error.message : "";
  if (/body.*exceed|too large|size limit|request entity/i.test(detail)) {
    const maxMb = (MAX_JOB_PHOTO_UPLOAD_BYTES / (1024 * 1024)).toFixed(0);
    return `That photo is too large. The limit is ${maxMb} MB.`;
  }
  return publicSiteImageErrorMessage(error, "That website photo could not be saved.");
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
    if (!resolveSupportedImageMimeType(file)) {
      return {
        error: "Unsupported file type. Upload a JPEG, PNG, or WebP photo.",
      };
    }
    if (file.size > MAX_JOB_PHOTO_UPLOAD_BYTES) {
      const maxMb = (MAX_JOB_PHOTO_UPLOAD_BYTES / (1024 * 1024)).toFixed(0);
      return { error: `That photo is too large. The limit is ${maxMb} MB.` };
    }
    if (!isBusinessStorageConfigured()) {
      return { error: PUBLIC_SITE_IMAGE_STORAGE_UNAVAILABLE };
    }

    const mimeType = resolveSupportedImageMimeType(file);
    if (!mimeType) {
      return {
        error: "Unsupported file type. Upload a JPEG, PNG, or WebP photo.",
      };
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const replaced = await replaceWebsitePhotoFromBytes(
      { db: prisma },
      access,
      {
        page,
        slot,
        originalFilename: file.name || "photo",
        mimeType,
        body: bytes,
      },
    );
    revalidatePublicSite(access.workspace.business.slug);
    return { message: "Website photo saved.", imageUrl: replaced.imageUrl };
  } catch (error) {
    return {
      error: ownerUploadError(error),
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
    if (!result.unchanged && result.storedAssetId) {
      await deleteStoredAsset({ db: prisma }, access, result.storedAssetId).catch(
        () => undefined,
      );
    }
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
