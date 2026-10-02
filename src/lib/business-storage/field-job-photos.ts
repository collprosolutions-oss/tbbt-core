/**
 * Assignment-scoped field job photos on the existing private R2
 * browser-upload path (same authorize → PUT → finalize pattern as
 * public request photos). The caller must already have resolved the
 * session workspace; this module never reads a browser businessId.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  abortManagedUpload,
  authorizeManagedUpload,
  discardReadyManagedUpload,
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
import { exactActiveMembershipHeld } from "@/lib/exact-active-membership";
import { lockTenantOwnedJob } from "@/lib/time-card-ops";

export const FIELD_JOB_PHOTO_MAX_BYTES = REQUEST_PHOTO_MAX_BYTES;
export const FIELD_JOB_PHOTO_PURPOSE = "field-job-photo";
export const MANAGEMENT_JOB_PHOTO_PURPOSE = "management-job-photo";

export {
  inspectRequestPhotoUpload as inspectFieldJobPhotoUpload,
  requestPhotoMaxBytesLabel as fieldJobPhotoMaxBytesLabel,
  isRequestPhotoMimeType as isFieldJobPhotoMimeType,
} from "@/lib/business-storage/request-photo-rules";

export type FieldJobPhotoScope = {
  businessId: string;
  membershipId: string;
};

export type ManagementJobPhotoScope = {
  businessId: string;
};

const NOT_ASSIGNED_ERROR = "That job isn't assigned to you.";
const NOT_FOUND_ERROR = "That job could not be found.";

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

async function loadOwnedJobPhotoCandidate(
  db: PrismaClient,
  input: {
    businessId: string;
    jobId: string;
    assetId: string;
    purpose: string;
  },
) {
  return db.storedAsset.findFirst({
    where: {
      id: input.assetId,
      businessId: input.businessId,
      jobId: input.jobId,
      category: "JOB_PHOTO",
      purpose: input.purpose,
      visibility: "PRIVATE",
    },
  });
}

function isPrivateJobPhotoForJob(
  asset: {
    visibility: string;
    category: string;
    jobId: string | null;
    purpose: string | null;
  },
  jobId: string,
  purpose: string,
) {
  return (
    asset.visibility === "PRIVATE" &&
    asset.category === "JOB_PHOTO" &&
    asset.jobId === jobId &&
    asset.purpose === purpose
  );
}

/**
 * Releases a READY job photo that never became a JobPhoto row.
 * Abort stays PENDING-only so a successful persist cannot be undone
 * from the abort route.
 */
export async function releaseUnpersistedJobPhoto(
  deps: StorageServiceDeps,
  input: {
    businessId: string;
    jobId: string;
    assetId: string;
    purpose: string;
  },
) {
  const persisted = await deps.db.jobPhoto.findFirst({
    where: { businessId: input.businessId, storedAssetId: input.assetId },
    select: { id: true },
  });
  if (persisted) return { released: false as const };
  await discardReadyManagedUpload(deps, input.businessId, input.assetId, {
    jobId: input.jobId,
    category: "JOB_PHOTO",
    purpose: input.purpose,
    visibility: "PRIVATE",
  }).catch(() => undefined);
  return { released: true as const };
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
    purpose: FIELD_JOB_PHOTO_PURPOSE,
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
  options?: {
    /** Proof hook: runs after the authorize read and before the Job lock. */
    afterInitialRead?: () => Promise<void>;
  },
) {
  const job = await findAssignedJobForPhoto(deps.db, field, input.jobId);
  if (!job) {
    throw new StorageAccessError(NOT_ASSIGNED_ERROR);
  }

  if (options?.afterInitialRead) {
    await options.afterInitialRead();
  }

  const candidate = await loadOwnedJobPhotoCandidate(deps.db, {
    businessId: field.businessId,
    jobId: job.id,
    assetId: input.assetId,
    purpose: FIELD_JOB_PHOTO_PURPOSE,
  });
  if (!candidate) {
    throw new StorageError("That photo is not a private field job photo.");
  }

  const asset =
    candidate.status === "READY"
      ? candidate
      : candidate.status === "PENDING"
        ? await finalizeManagedUpload(deps, field.businessId, candidate.id)
        : null;
  if (!asset || !isPrivateJobPhotoForJob(asset, job.id, FIELD_JOB_PHOTO_PURPOSE)) {
    throw new StorageError("That photo is not a private field job photo.");
  }

  try {
    return await deps.db.$transaction(async (tx) => {
      const locked = await lockTenantOwnedJob(tx, field.businessId, job.id);
      if (!locked || locked.assignedMembershipId !== field.membershipId) {
        throw new StorageAccessError(NOT_ASSIGNED_ERROR);
      }
      if (!(await exactActiveMembershipHeld(tx, field))) {
        throw new StorageAccessError(NOT_ASSIGNED_ERROR);
      }
      return persistReadyJobPhoto(tx, field.businessId, locked.id, asset, input.stage, input.caption);
    });
  } catch (error) {
    await releaseUnpersistedJobPhoto(deps, {
      businessId: field.businessId,
      jobId: job.id,
      assetId: asset.id,
      purpose: FIELD_JOB_PHOTO_PURPOSE,
    });
    throw error;
  }
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

async function findOwnedJobForPhoto(
  db: PrismaClient,
  businessId: string,
  jobId: string,
) {
  return db.job.findFirst({
    where: { id: jobId, businessId },
    select: { id: true, businessId: true, customerId: true, propertyId: true },
  });
}

export async function persistReadyJobPhoto(
  db: PrismaClient | Prisma.TransactionClient,
  businessId: string,
  jobId: string,
  asset: { id: string },
  stage: "BEFORE" | "DURING" | "AFTER",
  caption?: string | null,
) {
  const existing = await db.jobPhoto.findFirst({
    where: { storedAssetId: asset.id, businessId },
    select: { id: true },
  });
  if (existing) {
    return {
      photo: await db.jobPhoto.findUniqueOrThrow({ where: { id: existing.id } }),
      asset,
    };
  }

  const photo = await db.jobPhoto.create({
    data: {
      businessId,
      jobId,
      stage,
      url: privateAssetPath(asset.id),
      storedAssetId: asset.id,
      caption: caption?.trim() || null,
    },
  });
  return { photo, asset };
}

/**
 * OWNER/ADMIN job photos on the same private R2 path as field photos.
 * Scoped to the workspace business, not Job.assignedMembershipId.
 */
export async function authorizeManagementJobPhoto(
  deps: StorageServiceDeps,
  management: ManagementJobPhotoScope,
  input: {
    jobId: string;
    originalFilename: string;
    mimeType: string;
    fileSizeBytes: number;
  },
) {
  const job = await findOwnedJobForPhoto(deps.db, management.businessId, input.jobId);
  if (!job) {
    throw new StorageAccessError(NOT_FOUND_ERROR);
  }

  const inspection = inspectRequestPhotoUpload({
    type: input.mimeType,
    name: input.originalFilename,
    size: input.fileSizeBytes,
  });
  if (!inspection.ok) {
    throw new StorageError(inspection.error);
  }

  return authorizeManagedUpload(deps, management.businessId, {
    category: "JOB_PHOTO",
    purpose: MANAGEMENT_JOB_PHOTO_PURPOSE,
    originalFilename: inspection.fileName,
    mimeType: inspection.mimeType,
    fileSizeBytes: inspection.fileSizeBytes,
    visibility: "PRIVATE",
    jobId: job.id,
    customerId: job.customerId,
    propertyId: job.propertyId,
  });
}

export async function finalizeManagementJobPhoto(
  deps: StorageServiceDeps,
  management: ManagementJobPhotoScope,
  input: {
    jobId: string;
    assetId: string;
    stage: "BEFORE" | "DURING" | "AFTER";
    caption?: string | null;
  },
) {
  const job = await findOwnedJobForPhoto(deps.db, management.businessId, input.jobId);
  if (!job) {
    throw new StorageAccessError(NOT_FOUND_ERROR);
  }

  const candidate = await loadOwnedJobPhotoCandidate(deps.db, {
    businessId: management.businessId,
    jobId: job.id,
    assetId: input.assetId,
    purpose: MANAGEMENT_JOB_PHOTO_PURPOSE,
  });
  if (!candidate) {
    throw new StorageError("That photo is not a private job photo.");
  }

  const asset =
    candidate.status === "READY"
      ? candidate
      : candidate.status === "PENDING"
        ? await finalizeManagedUpload(deps, management.businessId, candidate.id)
        : null;
  if (!asset || !isPrivateJobPhotoForJob(asset, job.id, MANAGEMENT_JOB_PHOTO_PURPOSE)) {
    throw new StorageError("That photo is not a private job photo.");
  }

  try {
    return await persistReadyJobPhoto(
      deps.db,
      management.businessId,
      job.id,
      asset,
      input.stage,
      input.caption,
    );
  } catch (error) {
    await releaseUnpersistedJobPhoto(deps, {
      businessId: management.businessId,
      jobId: job.id,
      assetId: asset.id,
      purpose: MANAGEMENT_JOB_PHOTO_PURPOSE,
    });
    throw error;
  }
}

export async function abortManagementJobPhoto(
  deps: StorageServiceDeps,
  management: ManagementJobPhotoScope,
  input: { jobId: string; assetId: string },
) {
  const job = await findOwnedJobForPhoto(deps.db, management.businessId, input.jobId);
  if (!job) {
    throw new StorageAccessError(NOT_FOUND_ERROR);
  }
  const pending = await deps.db.storedAsset.findFirst({
    where: {
      id: input.assetId,
      businessId: management.businessId,
      jobId: job.id,
    },
    select: { id: true },
  });
  if (!pending) {
    throw new StorageAccessError(NOT_FOUND_ERROR);
  }
  return abortManagedUpload(deps, management.businessId, pending.id);
}

export async function putManagementJobPhotoFromBytes(
  deps: StorageServiceDeps,
  management: ManagementJobPhotoScope,
  input: {
    jobId: string;
    originalFilename: string;
    mimeType: string;
    body: Buffer | Uint8Array;
    stage: "BEFORE" | "DURING" | "AFTER";
    caption?: string | null;
  },
) {
  const authorized = await authorizeManagementJobPhoto(deps, management, {
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
    return finalizeManagementJobPhoto(deps, management, {
      jobId: input.jobId,
      assetId: authorized.asset.id,
      stage: input.stage,
      caption: input.caption,
    });
  } catch (error) {
    await abortManagementJobPhoto(deps, management, {
      jobId: input.jobId,
      assetId: authorized.asset.id,
    });
    throw error;
  }
}
