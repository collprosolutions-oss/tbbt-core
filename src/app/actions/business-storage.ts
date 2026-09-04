"use server";

import { revalidatePath } from "next/cache";
import { requireBusinessAccess } from "@/lib/access";
import {
  isBusinessStorageConfigured,
  StorageError,
  StorageQuotaError,
} from "@/lib/business-storage";
import {
  abortWebsitePhotoUploadOp,
  authorizeWebsitePhotoUploadOp,
  finalizeWebsitePhotoUploadOp,
} from "@/lib/business-storage/website-photos";
import { prisma } from "@/lib/prisma";
import { PUBLIC_SITE_HOME_PAGE } from "@/lib/public-site-images";
import { assertSettingsBusinessScope } from "@/lib/settings-ops";

export type WebsitePhotoUploadState = {
  error?: string;
  message?: string;
  imageUrl?: string;
  assetId?: string;
  uploadUrl?: string;
  uploadHeaders?: Record<string, string>;
  uploadMethod?: "PUT";
};

function ownerStorageError(error: unknown) {
  if (error instanceof StorageQuotaError || error instanceof StorageError) {
    return error.message;
  }
  return error instanceof Error ? error.message : "That website photo could not be saved.";
}

function revalidatePublicSite(slug: string) {
  revalidatePath("/settings");
  revalidatePath("/");
  revalidatePath(`/hire/${slug}`);
}

export async function authorizeWebsitePhotoUpload(input: {
  page: string;
  slot: string;
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
}): Promise<WebsitePhotoUploadState> {
  try {
    if (!isBusinessStorageConfigured()) {
      return {
        error:
          "Image storage is not configured for this environment. Existing photos stay in place. Connect platform file storage (Cloudflare R2) before replacing website photos.",
      };
    }
    const access = await requireBusinessAccess();
    const authorized = await authorizeWebsitePhotoUploadOp(
      { db: prisma },
      access,
      {
        page: input.page || PUBLIC_SITE_HOME_PAGE,
        slot: input.slot,
        originalFilename: input.originalFilename,
        mimeType: input.mimeType,
        fileSizeBytes: input.fileSizeBytes,
      },
    );
    return {
      assetId: authorized.asset.id,
      uploadUrl: authorized.upload.url,
      uploadHeaders: authorized.upload.headers,
      uploadMethod: authorized.upload.method,
    };
  } catch (error) {
    return { error: ownerStorageError(error) };
  }
}

export async function finalizeWebsitePhotoUpload(input: {
  assetId: string;
  page: string;
  slot: string;
}): Promise<WebsitePhotoUploadState> {
  try {
    const access = await requireBusinessAccess();
    const result = await finalizeWebsitePhotoUploadOp({ db: prisma }, access, {
      assetId: input.assetId,
      page: input.page || PUBLIC_SITE_HOME_PAGE,
      slot: input.slot,
    });
    revalidatePublicSite(access.workspace.business.slug);
    return { message: "Website photo saved.", imageUrl: result.imageUrl };
  } catch (error) {
    return { error: ownerStorageError(error) };
  }
}

export async function abortWebsitePhotoUpload(input: {
  assetId: string;
}): Promise<WebsitePhotoUploadState> {
  try {
    const access = await requireBusinessAccess();
    await abortWebsitePhotoUploadOp({ db: prisma }, access, input.assetId);
    return {};
  } catch (error) {
    return { error: ownerStorageError(error) };
  }
}

export async function authorizeWebsitePhotoUploadAction(
  _prev: WebsitePhotoUploadState,
  formData: FormData,
): Promise<WebsitePhotoUploadState> {
  const access = await requireBusinessAccess();
  assertSettingsBusinessScope(access, String(formData.get("businessId") || "") || null);
  return authorizeWebsitePhotoUpload({
    page: String(formData.get("page") || ""),
    slot: String(formData.get("slot") || ""),
    originalFilename: String(formData.get("originalFilename") || ""),
    mimeType: String(formData.get("mimeType") || ""),
    fileSizeBytes: Number(formData.get("fileSizeBytes") || 0),
  });
}
