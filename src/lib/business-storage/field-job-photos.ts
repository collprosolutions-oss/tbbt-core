/**
 * Assignment-scoped field job photos on the existing private R2
 * browser-upload path (same authorize → PUT → finalize pattern as
 * public request photos). The caller must already have resolved the
 * session workspace; this module never reads a browser businessId.
 */
import type { PrismaClient } from "@prisma/client";
import {
  abortManagedUpload,
  authorizeManagedUpload,
  finalizeManagedUpload,
  resolveStorageProvider,
  type StorageServiceDeps,
} from "@/lib/business-storage/service";
import { inspectRequestPhotoUpload } from "@/lib/business-storage/request-photo-rules";
import { privateAssetPath } from "@/lib/business-storage/keys";
import {
  REQUEST_PHOTO_MAX_BYTES,
  StorageAccessError,
  StorageError,
} from "@/lib/business-storage/types";

export const FIELD_JOB_PHOTO_MAX_BYTES = REQUEST_PHOTO_MAX_BYTES;

export {
  inspectRequestPhotoUpload as inspectFieldJobPhotoUpload,
  requestPhotoMaxBytesLabel as fieldJobPhotoMaxBytesLabel,
  isRequestPhotoMimeType as isFieldJobPhotoMimeType,
} from "@/lib/business-storage/request-photo-rules";

export type FieldJobPhotoScope = {
  businessId: string;
  membershipId: string;
};

const NOT_ASSIGNED_ERROR = "That job isn't assigned to you.";

async function findAssignedJobForPhoto(
  db: PrismaClient,
  field: FieldJobPhotoScope,
  jobId: string,
) {
  return db.job.findFirst({
    where: {
      id: jobId,
      businessId: field.businessId,
      assignedMembershipId: field.membershipId,
    },
    select: { id: true, businessId: true, customerId: true, propertyId: true },
  });
}

export function jobPhotoSrc(photo: {
  storedAssetId?: string | null;
  url: string;
}) {
  if (photo.storedAssetId) {
    return privateAssetPath(photo.storedAssetId);
  }
  return photo.url;
}

export async function authorizeAssignedFieldJobPhoto(
  deps: StorageServiceDeps,
  field: FieldJobPhotoScope,
  input: {
    jobId: string;
    originalFilename: string;
    mimeType: string;
    fileSizeBytes: number;
  },
) {
  const job = await findAssignedJobForPhoto(deps.db, field, input.jobId);
  if (!job) {
    throw new StorageAccessError(NOT_ASSIGNED_ERROR);
  }

  const inspection = inspectRequestPhotoUpload({
    type: input.mimeType,
    name: input.originalFilename,
    size: input.fileSizeBytes,
  });
  if (!inspection.ok) {
    throw new StorageError(inspection.error);
  }

  return authorizeManagedUpload(deps, field.businessId, {
    category: "JOB_PHOTO",
    purpose: "field-job-photo",
    originalFilename: inspection.fileName,
    mimeType: inspection.mimeType,
    fileSizeBytes: inspection.fileSizeBytes,
    visibility: "PRIVATE",
    jobId: job.id,
    customerId: job.customerId,
    propertyId: job.propertyId,
  });
}

export async function finalizeAssignedFieldJobPhoto(
  deps: StorageServiceDeps,
  field: FieldJobPhotoScope,
  input: {
    jobId: string;
    assetId: string;
    stage: "BEFORE" | "DURING" | "AFTER";
    caption?: string | null;
  },
) {
  const job = await findAssignedJobForPhoto(deps.db, field, input.jobId);
  if (!job) {
    throw new StorageAccessError(NOT_ASSIGNED_ERROR);
  }

  const asset = await finalizeManagedUpload(deps, field.businessId, input.assetId);
  if (
    asset.visibility !== "PRIVATE" ||
    asset.category !== "JOB_PHOTO" ||
    asset.jobId !== job.id
  ) {
    throw new StorageError("That photo is not a private field job photo.");
  }

  const existing = await deps.db.jobPhoto.findFirst({
    where: { storedAssetId: asset.id, businessId: field.businessId },
    select: { id: true },
  });
  if (existing) {
    return {
      photo: await deps.db.jobPhoto.findUniqueOrThrow({ where: { id: existing.id } }),
      asset,
    };
  }

  const photo = await deps.db.jobPhoto.create({
    data: {
      businessId: field.businessId,
      jobId: job.id,
      stage: input.stage,
      url: privateAssetPath(asset.id),
      storedAssetId: asset.id,
      caption: input.caption?.trim() || null,
    },
  });
  return { photo, asset };
}

export async function abortAssignedFieldJobPhoto(
  deps: StorageServiceDeps,
  field: FieldJobPhotoScope,
  input: { jobId: string; assetId: string },
) {
  const job = await findAssignedJobForPhoto(deps.db, field, input.jobId);
  if (!job) {
    throw new StorageAccessError(NOT_ASSIGNED_ERROR);
  }
  const pending = await deps.db.storedAsset.findFirst({
    where: {
      id: input.assetId,
      businessId: field.businessId,
      jobId: job.id,
    },
    select: { id: true },
  });
  if (!pending) {
    throw new StorageAccessError(NOT_ASSIGNED_ERROR);
  }
  return abortManagedUpload(deps, field.businessId, pending.id);
}

export async function putAssignedFieldJobPhotoFromBytes(
  deps: StorageServiceDeps,
  field: FieldJobPhotoScope,
  input: {
    jobId: string;
    originalFilename: string;
    mimeType: string;
    body: Buffer | Uint8Array;
    stage: "BEFORE" | "DURING" | "AFTER";
    caption?: string | null;
  },
) {
  const authorized = await authorizeAssignedFieldJobPhoto(deps, field, {
    jobId: input.jobId,
    originalFilename: input.originalFilename,
    mimeType: input.mimeType,
    fileSizeBytes: input.body.byteLength,
  });
  const provider = await resolveStorageProvider(deps);
  try {
    await provider.putObject({
      bucket: authorized.account.bucketName,
      key: authorized.asset.storageKey,
      body: input.body,
      contentType: input.mimeType,
    });
    return finalizeAssignedFieldJobPhoto(deps, field, {
      jobId: input.jobId,
      assetId: authorized.asset.id,
      stage: input.stage,
      caption: input.caption,
    });
  } catch (error) {
    await abortAssignedFieldJobPhoto(deps, field, {
      jobId: input.jobId,
      assetId: authorized.asset.id,
    });
    throw error;
  }
}
