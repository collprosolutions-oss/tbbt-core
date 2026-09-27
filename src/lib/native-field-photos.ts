/**
 * Native assigned-job photo writes and authorized preview.
 *
 * Reuses the existing private field-job-photo storage path
 * (`authorizeAssignedFieldJobPhoto` → PUT to R2 →
 * `finalizeAssignedFieldJobPhoto`) and the same assigned-job clause as
 * native reads (`nativeAssignedJobWhere`: businessId + assignedMembershipId).
 * Image bytes never enter these helpers — only filename, MIME, size,
 * asset id, stage, and caption.
 */
import type { PrismaClient } from "@prisma/client";
import {
  abortAssignedFieldJobPhoto,
  authorizeAssignedFieldJobPhoto,
  inspectFieldJobPhotoUpload,
  persistReadyJobPhoto,
} from "@/lib/business-storage/field-job-photos";
import { isBusinessStorageConfigured } from "@/lib/business-storage/config";
import { authorizePrivateStoredAssetDownload } from "@/lib/business-storage/private-serve";
import {
  abortManagedUpload,
  finalizeManagedUpload,
} from "@/lib/business-storage/service";
import {
  StorageAccessError,
  StorageError,
  StorageQuotaError,
  type StorageProvider,
} from "@/lib/business-storage/types";
import {
  assignmentStillHeld,
  NATIVE_JOB_NOT_AVAILABLE,
} from "@/lib/native-field-ops";
import { lockTenantOwnedJob } from "@/lib/time-card-ops";
import {
  loadNativeAssignedJob,
  nativeAssignedJobWhere,
  nativeJobPhotoTooManyMessage,
  NATIVE_JOB_PHOTO_LIMIT,
  type NativeJobDetail,
  type NativeJobPhotoStage,
} from "@/lib/native-field";
import type { NativeFieldAccess } from "@/lib/native-session";
import { NATIVE_SESSION_TOO_LARGE } from "@/lib/native-session-limits";
import {
  requireSaasOperatingEntitlement,
  saasOperatingErrorMessage,
  SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE,
} from "@/lib/saas-billing/entitlement";

export const NATIVE_JOB_PHOTO_JSON_MAX_BYTES = 4096;
export const NATIVE_JOB_PHOTO_CAPTION_MAX_CHARS = 200;
export const NATIVE_JOB_PHOTO_FILENAME_MAX_CHARS = 200;
export const NATIVE_JOB_PHOTO_MIME_MAX_CHARS = 80;
export const NATIVE_JOB_PHOTO_ASSET_ID_MAX_CHARS = 80;
export const NATIVE_STORAGE_NOT_CONFIGURED =
  "Photo storage isn't set up yet. Ask an admin to connect platform file storage (Cloudflare R2) before uploading job photos.";
export const NATIVE_JOB_PHOTO_STAGE_ERROR = "Choose Before, During, or After.";
export const NATIVE_JOB_PHOTO_CHOOSE_ERROR = "Choose a photo to upload.";

const PHOTO_JSON_FIELD_LIMITS = {
  originalFilename: NATIVE_JOB_PHOTO_FILENAME_MAX_CHARS,
  mimeType: NATIVE_JOB_PHOTO_MIME_MAX_CHARS,
  assetId: NATIVE_JOB_PHOTO_ASSET_ID_MAX_CHARS,
  caption: NATIVE_JOB_PHOTO_CAPTION_MAX_CHARS,
  stage: 16,
} as const;

export type NativePhotoStorageDeps = {
  provider?: StorageProvider;
  bucketName?: string;
  defaultLimitBytes?: number;
};

export type NativeAssignedJobPhotoFailure = {
  ok: false;
  status: number;
  error: string;
};

export type NativeAuthorizeAssignedJobPhotoResult =
  | {
      ok: true;
      assetId: string;
      uploadUrl: string;
      uploadHeaders: Record<string, string>;
      uploadMethod: "PUT";
      expiresInSeconds: number;
    }
  | NativeAssignedJobPhotoFailure;

export type NativeFinalizeAssignedJobPhotoResult =
  | { ok: true; job: NativeJobDetail }
  | NativeAssignedJobPhotoFailure;

export type NativeAbortAssignedJobPhotoResult =
  | { ok: true }
  | NativeAssignedJobPhotoFailure;

export type NativePreviewAssignedJobPhotoResult =
  | { ok: true; url: string; expiresInSeconds: number }
  | NativeAssignedJobPhotoFailure;

function photoError(error: unknown): NativeAssignedJobPhotoFailure {
  if (error instanceof StorageAccessError) {
    return { ok: false, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
  }
  if (error instanceof StorageQuotaError) {
    return { ok: false, status: 409, error: error.message };
  }
  if (error instanceof StorageError) {
    return { ok: false, status: 400, error: error.message };
  }
  return { ok: false, status: 400, error: "That photo could not be uploaded. Try again." };
}

function isPhotoStage(value: string): value is NativeJobPhotoStage {
  return value === "BEFORE" || value === "DURING" || value === "AFTER";
}

function readLimitedString(
  payload: Record<string, unknown>,
  key: keyof typeof PHOTO_JSON_FIELD_LIMITS,
) {
  const value = payload[key];
  if (typeof value !== "string") return "";
  return value.trim();
}

function fieldTooLong(payload: Record<string, unknown>) {
  return Object.entries(PHOTO_JSON_FIELD_LIMITS).some(([key, max]) => {
    const value = payload[key];
    return typeof value === "string" && value.length > max;
  });
}

function parsePhotoJson(text: string):
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; status: 400 | 413; error: string } {
  if (!text.trim()) {
    return { ok: false, status: 400, error: NATIVE_JOB_PHOTO_CHOOSE_ERROR };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, error: NATIVE_JOB_PHOTO_CHOOSE_ERROR };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, status: 400, error: NATIVE_JOB_PHOTO_CHOOSE_ERROR };
  }
  const payload = parsed as Record<string, unknown>;
  if (fieldTooLong(payload)) {
    return { ok: false, status: 413, error: NATIVE_SESSION_TOO_LARGE };
  }
  return { ok: true, payload };
}

export function parseNativeJobPhotoAuthorizeJson(text: string):
  | {
      ok: true;
      originalFilename: string;
      mimeType: string;
      fileSizeBytes: number;
    }
  | { ok: false; status: 400 | 413; error: string } {
  const parsed = parsePhotoJson(text);
  if (!parsed.ok) return parsed;
  const originalFilename = readLimitedString(parsed.payload, "originalFilename");
  const mimeType = readLimitedString(parsed.payload, "mimeType");
  const fileSizeBytes = parsed.payload.fileSizeBytes;
  if (typeof fileSizeBytes !== "number" || !Number.isFinite(fileSizeBytes)) {
    return { ok: false, status: 400, error: NATIVE_JOB_PHOTO_CHOOSE_ERROR };
  }
  const inspection = inspectFieldJobPhotoUpload({
    type: mimeType,
    name: originalFilename,
    size: fileSizeBytes,
  });
  if (!inspection.ok) {
    return { ok: false, status: 400, error: inspection.error };
  }
  return {
    ok: true,
    originalFilename: inspection.fileName,
    mimeType: inspection.mimeType,
    fileSizeBytes: inspection.fileSizeBytes,
  };
}

export function parseNativeJobPhotoFinalizeJson(text: string):
  | { ok: true; assetId: string; stage: NativeJobPhotoStage; caption: string }
  | { ok: false; status: 400 | 413; error: string } {
  const parsed = parsePhotoJson(text);
  if (!parsed.ok) return parsed;
  const assetId = readLimitedString(parsed.payload, "assetId");
  const stage = readLimitedString(parsed.payload, "stage");
  const caption = readLimitedString(parsed.payload, "caption");
  if (!assetId) {
    return { ok: false, status: 400, error: "That photo could not be uploaded. Try again." };
  }
  if (!isPhotoStage(stage)) {
    return { ok: false, status: 400, error: NATIVE_JOB_PHOTO_STAGE_ERROR };
  }
  return { ok: true, assetId, stage, caption };
}

export function parseNativeJobPhotoAbortJson(text: string):
  | { ok: true; assetId: string }
  | { ok: false; status: 400 | 413; error: string } {
  const parsed = parsePhotoJson(text);
  if (!parsed.ok) return parsed;
  const assetId = readLimitedString(parsed.payload, "assetId");
  if (!assetId) {
    return { ok: false, status: 400, error: "That photo could not be uploaded. Try again." };
  }
  return { ok: true, assetId };
}

async function requireAssignedPhotoJob(
  db: PrismaClient,
  access: NativeFieldAccess,
  jobId: string,
) {
  try {
    await requireSaasOperatingEntitlement(db, {
      businessId: access.businessId,
      workspace: { role: access.workspace.role },
    });
  } catch (error) {
    return {
      ok: false as const,
      status: 403,
      error: saasOperatingErrorMessage(error) ?? SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE,
    };
  }

  const assigned = await db.job.findFirst({
    where: nativeAssignedJobWhere(jobId, access),
    select: { id: true },
  });
  if (!assigned) {
    return { ok: false as const, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
  }
  return { ok: true as const, jobId: assigned.id };
}

async function assignedJobPhotoOccupancy(
  db: PrismaClient,
  access: NativeFieldAccess,
  jobId: string,
) {
  const photos = await db.jobPhoto.count({
    where: { businessId: access.businessId, jobId },
  });
  return { photos, occupied: photos };
}

function storageDeps(db: PrismaClient, storage?: NativePhotoStorageDeps) {
  return {
    db,
    provider: storage?.provider,
    bucketName: storage?.bucketName,
    defaultLimitBytes: storage?.defaultLimitBytes,
  };
}

function requireStorage(storage?: NativePhotoStorageDeps): NativeAssignedJobPhotoFailure | null {
  if (storage?.provider || isBusinessStorageConfigured()) {
    return null;
  }
  return { ok: false, status: 503, error: NATIVE_STORAGE_NOT_CONFIGURED };
}

export async function authorizeNativeAssignedJobPhoto(
  db: PrismaClient,
  access: NativeFieldAccess,
  jobId: string,
  input: {
    originalFilename: string;
    mimeType: string;
    fileSizeBytes: number;
  },
  storage?: NativePhotoStorageDeps,
): Promise<NativeAuthorizeAssignedJobPhotoResult> {
  const configured = requireStorage(storage);
  if (configured) return configured;

  const assigned = await requireAssignedPhotoJob(db, access, jobId);
  if (!assigned.ok) return assigned;

  const occupancy = await assignedJobPhotoOccupancy(db, access, assigned.jobId);
  if (occupancy.occupied >= NATIVE_JOB_PHOTO_LIMIT) {
    return { ok: false, status: 409, error: nativeJobPhotoTooManyMessage() };
  }

  try {
    const authorized = await authorizeAssignedFieldJobPhoto(
      storageDeps(db, storage),
      { businessId: access.businessId, membershipId: access.membershipId },
      {
        jobId: assigned.jobId,
        originalFilename: input.originalFilename,
        mimeType: input.mimeType,
        fileSizeBytes: input.fileSizeBytes,
      },
    );
    return {
      ok: true,
      assetId: authorized.asset.id,
      uploadUrl: authorized.upload.url,
      uploadHeaders: authorized.upload.headers,
      uploadMethod: authorized.upload.method,
      expiresInSeconds: authorized.upload.expiresInSeconds,
    };
  } catch (error) {
    return photoError(error);
  }
}

export async function finalizeNativeAssignedJobPhoto(
  db: PrismaClient,
  access: NativeFieldAccess,
  jobId: string,
  input: { assetId: string; stage: NativeJobPhotoStage; caption?: string | null },
  storage?: NativePhotoStorageDeps,
  options?: {
    /** Proof hook: runs after the authorize read and before the Job lock. */
    afterInitialRead?: () => Promise<void>;
  },
): Promise<NativeFinalizeAssignedJobPhotoResult> {
  const configured = requireStorage(storage);
  if (configured) return configured;

  const assigned = await requireAssignedPhotoJob(db, access, jobId);
  if (!assigned.ok) return assigned;

  if (options?.afterInitialRead) {
    await options.afterInitialRead();
  }

  const deps = storageDeps(db, storage);
  let asset;
  try {
    asset = await finalizeManagedUpload(deps, access.businessId, input.assetId);
  } catch (error) {
    return photoError(error);
  }
  if (
    asset.visibility !== "PRIVATE" ||
    asset.category !== "JOB_PHOTO" ||
    asset.jobId !== assigned.jobId
  ) {
    await abortManagedUpload(deps, access.businessId, input.assetId).catch(() => undefined);
    return { ok: false, status: 400, error: "That photo is not a private field job photo." };
  }

  try {
    const written = await db.$transaction(async (tx) => {
      const locked = await lockTenantOwnedJob(tx, access.businessId, assigned.jobId);
      if (!assignmentStillHeld(locked, access)) {
        return { ok: false as const, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
      }

      const existing = await tx.jobPhoto.findFirst({
        where: {
          businessId: access.businessId,
          jobId: locked.id,
          storedAssetId: input.assetId,
        },
        select: { id: true },
      });
      if (!existing) {
        const photos = await tx.jobPhoto.count({
          where: { businessId: access.businessId, jobId: locked.id },
        });
        if (photos >= NATIVE_JOB_PHOTO_LIMIT) {
          return { ok: false as const, status: 409, error: nativeJobPhotoTooManyMessage() };
        }
      }

      await persistReadyJobPhoto(
        tx,
        access.businessId,
        locked.id,
        { id: asset.id },
        input.stage,
        input.caption,
      );
      return { ok: true as const };
    });

    if (!written.ok) {
      const persisted = await db.jobPhoto.findFirst({
        where: {
          businessId: access.businessId,
          storedAssetId: input.assetId,
        },
        select: { id: true },
      });
      if (!persisted) {
        await abortManagedUpload(deps, access.businessId, input.assetId).catch(() => undefined);
      }
      return written;
    }
  } catch (error) {
    return photoError(error);
  }

  const job = await loadNativeAssignedJob(db, access, assigned.jobId, { storage });
  if (!job) {
    return { ok: false, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
  }
  return { ok: true, job };
}

export async function abortNativeAssignedJobPhoto(
  db: PrismaClient,
  access: NativeFieldAccess,
  jobId: string,
  input: { assetId: string },
  storage?: NativePhotoStorageDeps,
): Promise<NativeAbortAssignedJobPhotoResult> {
  const assigned = await requireAssignedPhotoJob(db, access, jobId);
  if (!assigned.ok) return assigned;

  try {
    await abortAssignedFieldJobPhoto(
      storageDeps(db, storage),
      { businessId: access.businessId, membershipId: access.membershipId },
      { jobId: assigned.jobId, assetId: input.assetId },
    );
    return { ok: true };
  } catch (error) {
    return photoError(error);
  }
}

export async function previewNativeAssignedJobPhoto(
  db: PrismaClient,
  access: NativeFieldAccess,
  jobId: string,
  photoId: string,
  storage?: NativePhotoStorageDeps,
): Promise<NativePreviewAssignedJobPhotoResult> {
  const assigned = await db.job.findFirst({
    where: nativeAssignedJobWhere(jobId, access),
    select: { id: true },
  });
  if (!assigned) {
    return { ok: false, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
  }

  const photo = await db.jobPhoto.findFirst({
    where: {
      id: photoId,
      businessId: access.businessId,
      jobId: assigned.id,
    },
    select: { id: true, url: true, storedAssetId: true },
  });
  if (!photo) {
    return { ok: false, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
  }

  if (photo.storedAssetId) {
    const download = await authorizePrivateStoredAssetDownload(
      db,
      photo.storedAssetId,
      access.businessId,
      {
        provider: storage?.provider,
        viewer: {
          role: access.workspace.role,
          membershipId: access.membershipId,
        },
      },
    );
    if (!download.ok) {
      return { ok: false, status: download.status, error: NATIVE_JOB_NOT_AVAILABLE };
    }
    return { ok: true, url: download.url, expiresInSeconds: download.expiresInSeconds };
  }

  if (photo.url.startsWith("https://") || photo.url.startsWith("http://")) {
    return { ok: true, url: photo.url, expiresInSeconds: 0 };
  }
  return { ok: false, status: 404, error: NATIVE_JOB_NOT_AVAILABLE };
}
