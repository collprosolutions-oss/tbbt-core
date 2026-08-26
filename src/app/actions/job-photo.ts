"use server";

import { revalidatePath } from "next/cache";
import { requireBusinessAccess } from "@/lib/access";
import { prisma } from "@/lib/prisma";
import {
  deleteJobPhotoBlob,
  isStorageConfigured,
  isSupportedImageMimeType,
  MAX_JOB_PHOTO_UPLOAD_BYTES,
  uploadJobPhoto,
} from "@/lib/storage";

export type JobPhotoActionState = {
  error?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

const STORAGE_NOT_CONFIGURED_ERROR =
  "Photo storage isn't set up yet. Ask an admin to connect Vercel Blob (BLOB_READ_WRITE_TOKEN) before uploading job photos.";

export async function addJobPhoto(
  _prev: JobPhotoActionState,
  formData: FormData,
): Promise<JobPhotoActionState> {
  const access = await requireBusinessAccess();
  const jobId = readString(formData, "jobId");
  const stage = readString(formData, "stage");
  const caption = readString(formData, "caption");
  const file = formData.get("file");

  if (!jobId) {
    return { error: "That job could not be found." };
  }

  if (stage !== "BEFORE" && stage !== "DURING" && stage !== "AFTER") {
    return { error: "Choose Before, During, or After." };
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

  // Fail gracefully (and before touching the job/database) if the storage
  // provider isn't configured, so an unconfigured environment never
  // crashes the Job page - it just can't accept new uploads yet.
  if (!isStorageConfigured()) {
    return { error: STORAGE_NOT_CONFIGURED_ERROR };
  }

  const job = access.assertOwned(
    await prisma.job.findFirst({
      where: { id: jobId, ...access.scope },
    }),
  );

  let uploaded: { url: string };
  try {
    uploaded = await uploadJobPhoto({
      businessId: access.businessId,
      jobId: job.id,
      file,
    });
  } catch (error) {
    console.error("Job photo upload failed", error);
    return { error: "That photo could not be uploaded. Try again." };
  }

  await prisma.jobPhoto.create({
    data: {
      businessId: access.businessId,
      jobId: job.id,
      stage,
      url: uploaded.url,
      caption: caption || null,
    },
  });

  revalidatePath(`/jobs/${job.id}`);
  return {};
}

export async function deleteJobPhoto(
  _prev: JobPhotoActionState,
  formData: FormData,
): Promise<JobPhotoActionState> {
  const access = await requireBusinessAccess();
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
  await deleteJobPhotoBlob(photo.url);

  revalidatePath(`/jobs/${photo.jobId}`);
  return {};
}
