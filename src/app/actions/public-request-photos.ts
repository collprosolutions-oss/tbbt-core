"use server";

import {
  abortPublicRequestPhoto,
  authorizePublicRequestPhoto,
  finalizePublicRequestPhoto,
} from "@/lib/business-storage/request-photos";
import {
  isBusinessStorageConfigured,
  StorageError,
  StorageQuotaError,
} from "@/lib/business-storage";
import { prisma } from "@/lib/prisma";

export type PublicRequestPhotoUploadState = {
  error?: string;
  assetId?: string;
  uploadUrl?: string;
  uploadHeaders?: Record<string, string>;
  uploadMethod?: "PUT";
};

function publicPhotoError(error: unknown) {
  if (error instanceof StorageQuotaError || error instanceof StorageError) {
    return error.message;
  }
  return "That photo could not be uploaded.";
}

export async function authorizePublicRequestPhotoUpload(input: {
  slug: string;
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
}): Promise<PublicRequestPhotoUploadState> {
  try {
    if (!isBusinessStorageConfigured()) {
      return { error: "Photo upload is not available on this site yet." };
    }
    const authorized = await authorizePublicRequestPhoto(
      { db: prisma },
      input.slug,
      {
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
    return { error: publicPhotoError(error) };
  }
}

export async function finalizePublicRequestPhotoUpload(input: {
  slug: string;
  assetId: string;
}): Promise<PublicRequestPhotoUploadState> {
  try {
    const asset = await finalizePublicRequestPhoto({ db: prisma }, input.slug, input.assetId);
    return { assetId: asset.id };
  } catch (error) {
    return { error: publicPhotoError(error) };
  }
}

export async function abortPublicRequestPhotoUpload(input: {
  slug: string;
  assetId: string;
}): Promise<PublicRequestPhotoUploadState> {
  try {
    await abortPublicRequestPhoto({ db: prisma }, input.slug, input.assetId);
    return {};
  } catch (error) {
    return { error: publicPhotoError(error) };
  }
}
