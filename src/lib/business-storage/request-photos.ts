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

export { inspectRequestPhotoUpload } from "@/lib/business-storage/request-photo-rules";

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
  const asset = await finalizeManagedUpload(deps, business.id, assetId);
  if (asset.visibility !== "PRIVATE" || asset.category !== "CUSTOMER_PHOTO") {
    throw new StorageError("That photo is not a private request photo.");
  }
  if (asset.publicPath) {
    throw new StorageError("Request photos cannot be published.");
  }
  return asset;
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
