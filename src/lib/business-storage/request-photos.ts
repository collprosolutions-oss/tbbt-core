import type { Prisma, PrismaClient } from "@prisma/client";
import {
  abortManagedUpload,
  authorizeManagedUpload,
  finalizeManagedUpload,
  resolveStorageProvider,
  type StorageServiceDeps,
} from "@/lib/business-storage/service";
import { inspectRequestPhotoUpload } from "@/lib/business-storage/request-photo-rules";
import { privateAssetPath } from "@/lib/business-storage/keys";
import { StorageError } from "@/lib/business-storage/types";
import { MAX_INTAKE_PHOTOS } from "@/lib/service-request-work";
import { resolveSupportedImageMimeType } from "@/lib/storage";

export { inspectRequestPhotoUpload, requestPhotoMaxBytesLabel } from "@/lib/business-storage/request-photo-rules";

const NOT_PRIVATE_REQUEST_PHOTO = "That photo is not a private request photo.";
const REQUEST_PHOTO_CANNOT_BE_PUBLISHED = "Request photos cannot be published.";

export type PublicRequestFallbackPhotoFile = {
  name: string;
  type?: string | null;
  size?: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

export function remainingIntakePhotoSlots(attachedCount: number) {
  const recorded = Number.isFinite(attachedCount) ? Math.max(0, Math.floor(attachedCount)) : 0;
  return Math.max(0, MAX_INTAKE_PHOTOS - recorded);
}

function isPrivateUnpublishedCustomerPhoto(asset: {
  category: string;
  visibility: string;
  publicPath: string | null;
  deletedAt: Date | null;
  status: string;
}) {
  return (
    asset.deletedAt == null &&
    asset.status !== "DELETED" &&
    asset.category === "CUSTOMER_PHOTO" &&
    asset.visibility === "PRIVATE" &&
    !asset.publicPath
  );
}

export async function resolvePublicStorageBusiness(
  db: PrismaClient | Prisma.TransactionClient,
  slug: string,
) {
  const safeSlug = slug.trim().toLowerCase();
  if (!safeSlug) return null;
  return db.business.findUnique({
    where: { slug: safeSlug },
    select: { id: true, slug: true },
  });
}

export async function authorizePublicRequestPhoto(
  deps: StorageServiceDeps,
  slug: string,
  input: { originalFilename: string; mimeType: string; fileSizeBytes: number },
) {
  const business = await resolvePublicStorageBusiness(deps.db, slug);
  if (!business) {
    throw new StorageError("This request could not be submitted.");
  }
  const inspection = inspectRequestPhotoUpload({
    type: input.mimeType,
    name: input.originalFilename,
    size: input.fileSizeBytes,
  });
  if (!inspection.ok) {
    throw new StorageError(inspection.error);
  }
  return authorizeManagedUpload(deps, business.id, {
    category: "CUSTOMER_PHOTO",
    purpose: "public-request-photo",
    originalFilename: inspection.fileName,
    mimeType: inspection.mimeType,
    fileSizeBytes: inspection.fileSizeBytes,
    visibility: "PRIVATE",
  });
}

export async function finalizePublicRequestPhoto(
  deps: StorageServiceDeps,
  slug: string,
  assetId: string,
) {
  const business = await resolvePublicStorageBusiness(deps.db, slug);
  if (!business) {
    throw new StorageError("This request could not be submitted.");
  }

  const candidate = await deps.db.storedAsset.findFirst({
    where: { id: assetId, businessId: business.id },
  });
  if (!candidate) {
    throw new StorageError(NOT_PRIVATE_REQUEST_PHOTO);
  }
  if (candidate.publicPath) {
    throw new StorageError(REQUEST_PHOTO_CANNOT_BE_PUBLISHED);
  }
  if (!isPrivateUnpublishedCustomerPhoto(candidate)) {
    throw new StorageError(NOT_PRIVATE_REQUEST_PHOTO);
  }
  if (candidate.status === "READY") {
    return candidate;
  }

  const now = deps.now?.() ?? new Date();
  if (
    candidate.status !== "PENDING" ||
    (candidate.expiresAt != null && candidate.expiresAt.getTime() <= now.getTime())
  ) {
    throw new StorageError(NOT_PRIVATE_REQUEST_PHOTO);
  }

  return finalizeManagedUpload(deps, business.id, assetId);
}

export async function abortPublicRequestPhoto(
  deps: StorageServiceDeps,
  slug: string,
  assetId: string,
) {
  const business = await resolvePublicStorageBusiness(deps.db, slug);
  if (!business) {
    throw new StorageError("This request could not be submitted.");
  }
  return abortManagedUpload(deps, business.id, assetId);
}

export function requestPhotoOwnerSrc(photo: {
  storedAssetId?: string | null;
  url: string;
}) {
  if (photo.storedAssetId) {
    return privateAssetPath(photo.storedAssetId);
  }
  return photo.url;
}

export async function putPublicRequestPhotoFromBytes(
  deps: StorageServiceDeps,
  slug: string,
  input: {
    originalFilename: string;
    mimeType: string;
    body: Buffer | Uint8Array;
  },
) {
  const authorized = await authorizePublicRequestPhoto(deps, slug, {
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
    return finalizePublicRequestPhoto(deps, slug, authorized.asset.id);
  } catch (error) {
    await abortPublicRequestPhoto(deps, slug, authorized.asset.id);
    throw error;
  }
}

export async function attachRemainingPublicRequestFallbackPhotos(
  deps: StorageServiceDeps,
  slug: string,
  input: {
    requestId: string;
    files: PublicRequestFallbackPhotoFile[];
  },
) {
  if (input.files.length === 0) {
    return { attached: 0, remainingSlots: 0 };
  }

  const business = await resolvePublicStorageBusiness(deps.db, slug);
  if (!business) {
    return { attached: 0, remainingSlots: 0 };
  }

  const request = await deps.db.serviceRequest.findFirst({
    where: { id: input.requestId, businessId: business.id },
    select: { id: true },
  });
  if (!request) {
    return { attached: 0, remainingSlots: 0 };
  }

  const attachedCount = await deps.db.serviceRequestPhoto.count({
    where: {
      serviceRequestId: request.id,
      businessId: business.id,
    },
  });
  const remainingSlots = remainingIntakePhotoSlots(attachedCount);
  if (remainingSlots <= 0) {
    return { attached: 0, remainingSlots: 0 };
  }

  const files = input.files.slice(0, remainingSlots);
  const uploaded: Array<{ url: string; storedAssetId: string }> = [];
  for (const file of files) {
    const mimeType = resolveSupportedImageMimeType(file);
    if (!mimeType) continue;
    try {
      const asset = await putPublicRequestPhotoFromBytes(deps, slug, {
        originalFilename: file.name,
        mimeType,
        body: new Uint8Array(await file.arrayBuffer()),
      });
      uploaded.push({
        url: privateAssetPath(asset.id),
        storedAssetId: asset.id,
      });
    } catch {
      // Request already exists. A failed photo must not roll it back.
    }
  }

  if (uploaded.length === 0) {
    return { attached: 0, remainingSlots };
  }

  const latestCount = await deps.db.serviceRequestPhoto.count({
    where: {
      serviceRequestId: request.id,
      businessId: business.id,
    },
  });
  const stillRemaining = remainingIntakePhotoSlots(latestCount);
  const toInsert = uploaded.slice(0, stillRemaining);
  if (toInsert.length === 0) {
    return { attached: 0, remainingSlots: stillRemaining };
  }

  await deps.db.serviceRequestPhoto.createMany({
    data: toInsert.map((photo) => ({
      businessId: business.id,
      serviceRequestId: request.id,
      url: photo.url,
      storedAssetId: photo.storedAssetId,
    })),
  });

  return { attached: toInsert.length, remainingSlots: stillRemaining };
}
