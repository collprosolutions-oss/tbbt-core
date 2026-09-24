"use server";

import { revalidatePath } from "next/cache";
import { requireOperatingBusinessAccess } from "@/lib/saas-billing/enforce";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { prisma } from "@/lib/prisma";
import { deleteJobPhotoBlob } from "@/lib/storage";
import {
  deleteStoredAsset,
  isBusinessStorageConfigured,
  StorageError,
  StorageQuotaError,
} from "@/lib/business-storage";
import {
  abortManagementJobPhoto,
  authorizeManagementJobPhoto,
  finalizeManagementJobPhoto,
} from "@/lib/business-storage/field-job-photos";

export type JobPhotoActionState = {
  error?: string;
  message?: string;
};

export type JobPhotoUploadState = JobPhotoActionState & {
  assetId?: string;
  uploadUrl?: string;
  uploadHeaders?: Record<string, string>;
  uploadMethod?: "PUT";
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

const STORAGE_NOT_CONFIGURED_ERROR =
  "Photo storage isn't set up yet. Ask an admin to connect platform file storage (Cloudflare R2) before uploading job photos.";

function managementPhotoError(error: unknown) {
  if (error instanceof StorageQuotaError || error instanceof StorageError) {
    return error.message;
  }
  return "That photo could not be uploaded. Try again.";
}

async function requireManagementPhotoAccess() {
  const access = await requireOperatingBusinessAccess();
  // OWNER/ADMIN business-wide job photos. MEMBER stays on the assignment-
  // scoped field upload path and never receives OPERATE_JOBS.
  requireBusinessCapability(access, CAPABILITIES.OPERATE_JOBS);
  return access;
}

/**
 * Authorizes a browser-direct R2 upload. The image body never enters this
 * server action -- only filename, MIME type, and declared size.
 */
export async function authorizeManagementJobPhotoUpload(input: {
  jobId: string;
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
}): Promise<JobPhotoUploadState> {
  try {
    if (!isBusinessStorageConfigured()) {
      return { error: STORAGE_NOT_CONFIGURED_ERROR };
    }
    if (!input.jobId) {
      return { error: "That job could not be found." };
    }
    const access = await requireManagementPhotoAccess();
    const authorized = await authorizeManagementJobPhoto(
      { db: prisma },
      { businessId: access.businessId },
      {
        jobId: input.jobId,
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
    return { error: managementPhotoError(error) };
  }
}

export async function finalizeManagementJobPhotoUpload(input: {
  jobId: string;
  assetId: string;
  stage: string;
  caption?: string;
}): Promise<JobPhotoUploadState> {
  try {
    if (input.stage !== "BEFORE" && input.stage !== "DURING" && input.stage !== "AFTER") {
      return { error: "Choose Before, During, or After." };
    }
    if (!input.jobId) {
      return { error: "That job could not be found." };
    }
    const access = await requireManagementPhotoAccess();
    await finalizeManagementJobPhoto(
      { db: prisma },
      { businessId: access.businessId },
      {
        jobId: input.jobId,
        assetId: input.assetId,
        stage: input.stage,
        caption: input.caption,
      },
    );
    revalidatePath(`/jobs/${input.jobId}`);
    return { message: "Photo added." };
  } catch (error) {
    return { error: managementPhotoError(error) };
  }
}

export async function abortManagementJobPhotoUpload(input: {
  jobId: string;
  assetId: string;
}): Promise<JobPhotoUploadState> {
  try {
    if (!input.jobId) {
      return { error: "That job could not be found." };
    }
    const access = await requireManagementPhotoAccess();
    await abortManagementJobPhoto(
      { db: prisma },
      { businessId: access.businessId },
      { jobId: input.jobId, assetId: input.assetId },
    );
    return {};
  } catch (error) {
    return { error: managementPhotoError(error) };
  }
}

export async function deleteJobPhoto(
  _prev: JobPhotoActionState,
  formData: FormData,
): Promise<JobPhotoActionState> {
  const access = await requireOperatingBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.OPERATE_JOBS);
  const photoId = readString(formData, "photoId");

  if (!photoId) {
    return { error: "That photo could not be found." };
  }

  // Ownership is verified before either the database row or the storage
  // object is touched, so a cross-business request can never reach either.
  const photo = access.assertOwned(
    await prisma.jobPhoto.findFirst({
      where: { id: photoId, ...access.scope },
    }),
  );

  await prisma.jobPhoto.delete({ where: { id: photo.id } });

  // Best-effort: the owner-facing photo is already gone once the row above
  // is deleted, so a storage-side failure here is logged, not surfaced.
  // New rows are private R2 StoredAssets; legacy rows still have a Blob URL.
  if (photo.storedAssetId) {
    await deleteStoredAsset({ db: prisma }, access, photo.storedAssetId).catch((error) => {
      console.error("Job photo stored asset delete failed", error);
    });
  } else {
    await deleteJobPhotoBlob(photo.url);
  }

  revalidatePath(`/jobs/${photo.jobId}`);
  return {};
}
