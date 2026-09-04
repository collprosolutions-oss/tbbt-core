import { randomUUID } from "node:crypto";
import { del, put } from "@vercel/blob";

/**
 * Vercel Blob is the only storage provider this module knows about.
 * Business logic (job-photo actions, UI) must go through the functions
 * below rather than importing "@vercel/blob" directly, so moving to R2/S3
 * later only means rewriting this file.
 */

export const SUPPORTED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
] as const;

export type SupportedImageMimeType = (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];

export function isSupportedImageMimeType(
  value: string,
): value is SupportedImageMimeType {
  return (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

const EXTENSION_TO_MIME: Record<string, SupportedImageMimeType> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
};

/**
 * Browsers sometimes send `image/jpg`, an empty type, or only a filename.
 * Resolve a supported MIME from type first, then from the file extension.
 */
export function resolveSupportedImageMimeType(file: {
  type?: string | null;
  name?: string | null;
}): SupportedImageMimeType | null {
  const type = (file.type || "").trim().toLowerCase();
  if (type === "image/jpg") return "image/jpeg";
  if (isSupportedImageMimeType(type)) return type;
  const name = (file.name || "").trim().toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return EXTENSION_TO_MIME[name.slice(dot + 1)] ?? null;
}

// Vercel Functions cap request bodies at 4.5 MB, which this direct
// server-action upload passes through. We stay safely under that so a
// rejected upload is always our own clear validation error, never an
// opaque platform-level failure. Uploading larger camera photos would
// require Vercel Blob's client-upload flow (browser -> Blob directly),
// which is a larger change left for a later Phase 2 step.
export const MAX_JOB_PHOTO_UPLOAD_BYTES = 4 * 1024 * 1024;

const EXTENSION_BY_MIME_TYPE: Record<SupportedImageMimeType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
};

export function isStorageConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

const BLOB_HOST_PATTERN = /\.blob\.vercel-storage\.com$/i;

/** True only for URLs this app itself uploaded to Vercel Blob. */
export function isManagedBlobUrl(url: string) {
  try {
    return BLOB_HOST_PATTERN.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export type UploadedJobPhoto = {
  url: string;
};

export async function uploadJobPhoto({
  businessId,
  jobId,
  file,
}: {
  businessId: string;
  jobId: string;
  file: File;
}): Promise<UploadedJobPhoto> {
  return uploadManagedImage({
    pathnamePrefix: `job-photos/${businessId}/${jobId}`,
    file,
  });
}

/**
 * Same Vercel Blob path as job photos -- no second storage system.
 * Expense receipts reuse the existing image MIME allow-list and size cap.
 */
export async function uploadExpenseReceipt({
  businessId,
  expenseId,
  file,
}: {
  businessId: string;
  expenseId: string;
  file: File;
}): Promise<UploadedJobPhoto> {
  return uploadManagedImage({
    pathnamePrefix: `expense-receipts/${businessId}/${expenseId}`,
    file,
  });
}

/**
 * Same Vercel Blob helper as job photos and expense receipts -- no second
 * storage system. Used for optional public intake project photos.
 */
export async function uploadRequestPhoto({
  businessId,
  requestId,
  file,
}: {
  businessId: string;
  requestId: string;
  file: File;
}): Promise<UploadedJobPhoto> {
  return uploadManagedImage({
    pathnamePrefix: `request-photos/${businessId}/${requestId}`,
    file,
  });
}

/**
 * Same Vercel Blob helper as job / request / expense photos — no second
 * storage system. Used for owner-editable public-site marketing images.
 */
export async function uploadPublicSitePhoto({
  businessId,
  page,
  slot,
  file,
}: {
  businessId: string;
  page: string;
  slot: string;
  file: File;
}): Promise<UploadedJobPhoto> {
  const safePage = page.replace(/[^a-z0-9-]+/gi, "-").toLowerCase() || "page";
  const safeSlot = slot.replace(/[^a-z0-9-]+/gi, "-").toLowerCase() || "slot";
  return uploadManagedImage({
    pathnamePrefix: `public-site-photos/${businessId}/${safePage}/${safeSlot}`,
    file,
  });
}

async function uploadManagedImage({
  pathnamePrefix,
  file,
}: {
  pathnamePrefix: string;
  file: File;
}): Promise<UploadedJobPhoto> {
  const mimeType = resolveSupportedImageMimeType(file) ?? "image/jpeg";
  const extension = EXTENSION_BY_MIME_TYPE[mimeType];
  // Never derive the storage path from the browser-supplied filename.
  const pathname = `${pathnamePrefix}/${randomUUID()}.${extension}`;

  const blob = await put(pathname, file, {
    access: "public",
    addRandomSuffix: true,
    contentType: file.type || mimeType,
  });

  return { url: blob.url };
}

/**
 * Best-effort delete: never throws. Pre-existing JobPhoto rows created by
 * pasting an already-hosted URL are never touched here, since this app
 * doesn't own that storage.
 */
export async function deleteJobPhotoBlob(url: string): Promise<void> {
  if (!isManagedBlobUrl(url)) {
    return;
  }

  try {
    await del(url);
  } catch (error) {
    console.error("Failed to delete job photo blob", error);
  }
}
