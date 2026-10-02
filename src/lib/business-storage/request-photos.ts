import type { Prisma, PrismaClient } from "@prisma/client";
import {
  abortManagedUpload,
  authorizeManagedUpload,
  bestEffortCleanupOwnedObject,
  finalizeManagedUpload,
  resolveStorageProvider,
  type StorageServiceDeps,
} from "@/lib/business-storage/service";
import { inspectRequestPhotoUpload } from "@/lib/business-storage/request-photo-rules";
import { privateAssetPath } from "@/lib/business-storage/keys";
import { STORAGE_PENDING_TTL_MS, StorageError } from "@/lib/business-storage/types";
import { MAX_INTAKE_PHOTOS } from "@/lib/service-request-work";
import { resolveSupportedImageMimeType } from "@/lib/storage";

export { inspectRequestPhotoUpload, requestPhotoMaxBytesLabel } from "@/lib/business-storage/request-photo-rules";

export const PUBLIC_REQUEST_PHOTO_PURPOSE = "public-request-photo";
const NOT_PRIVATE_REQUEST_PHOTO = "That photo is not a private request photo.";
const REQUEST_PHOTO_CANNOT_BE_PUBLISHED = "Request photos cannot be published.";

type Db = PrismaClient | Prisma.TransactionClient;

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

async function claimUnattachedRequestPhotoInTx(
  tx: Db,
  businessId: string,
  assetId: string,
  now: Date,
) {
  const referenced = await tx.serviceRequestPhoto.findFirst({
    where: { storedAssetId: assetId, businessId },
    select: { id: true },
  });
  if (referenced) return null;
  const asset = await tx.storedAsset.findFirst({
    where: {
      id: assetId,
      businessId,
      purpose: PUBLIC_REQUEST_PHOTO_PURPOSE,
      category: "CUSTOMER_PHOTO",
      visibility: "PRIVATE",
    },
    include: { storageAccount: true },
  });
  if (!asset || asset.status !== "READY") return null;
  const updated = await tx.storedAsset.updateMany({
    where: {
      id: asset.id,
      businessId,
      purpose: PUBLIC_REQUEST_PHOTO_PURPOSE,
      status: "READY",
    },
    data: { status: "FAILED", deletedAt: now, publicPath: null },
  });
  if (updated.count !== 1) return null;
  if (asset.fileSizeBytes > 0) {
    await tx.businessStorageAccount.update({
      where: { id: asset.storageAccountId },
      data: { storageUsedBytes: { decrement: asset.fileSizeBytes } },
    });
  }
  return {
    bucket: asset.storageAccount.bucketName,
    storageKey: asset.storageKey,
  };
}

export async function rememberAttachedPublicRequestPhotos(
  tx: {
    storedAsset: {
      updateMany: (args: {
        where: {
          id: { in: string[] };
          businessId: string;
          purpose: string;
          status: string;
        };
        data: { expiresAt: Date | null };
      }) => Promise<unknown>;
    };
  },
  businessId: string,
  assetIds: string[],
) {
  const ids = [...new Set(assetIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return;
  await tx.storedAsset.updateMany({
    where: {
      id: { in: ids },
      businessId,
      purpose: PUBLIC_REQUEST_PHOTO_PURPOSE,
      status: "READY",
    },
    data: { expiresAt: null },
  });
}

export async function releaseUnattachedPublicRequestPhotos(
  deps: StorageServiceDeps,
  businessId: string,
  assetIds: string[],
) {
  const ids = [...new Set(assetIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return { released: 0 };
  const now = deps.now?.() ?? new Date();
  const claimed = await deps.db.$transaction(async (tx) => {
    const won: Array<{ bucket: string; storageKey: string }> = [];
    for (const id of ids) {
      const object = await claimUnattachedRequestPhotoInTx(tx, businessId, id, now);
      if (object) won.push(object);
    }
    return won;
  });
  for (const object of claimed) {
    await bestEffortCleanupOwnedObject(deps, businessId, object);
  }
  return { released: claimed.length };
}

export async function releaseExpiredUnattachedPublicRequestPhotos(
  deps: StorageServiceDeps,
  businessId: string,
) {
  const now = deps.now?.() ?? new Date();
  const expired = await deps.db.storedAsset.findMany({
    where: {
      businessId,
      status: "READY",
      purpose: PUBLIC_REQUEST_PHOTO_PURPOSE,
      category: "CUSTOMER_PHOTO",
      visibility: "PRIVATE",
      expiresAt: { lte: now },
      serviceRequestPhotos: { none: {} },
    },
    select: { id: true },
  });
  if (expired.length === 0) return { released: 0 };
  return releaseUnattachedPublicRequestPhotos(
    deps,
    businessId,
    expired.map((row) => row.id),
  );
}

async function stampUnattachedRequestPhotoExpiry(
  deps: StorageServiceDeps,
  businessId: string,
  assetId: string,
) {
  const now = deps.now?.() ?? new Date();
  const referenced = await deps.db.serviceRequestPhoto.findFirst({
    where: { storedAssetId: assetId, businessId },
    select: { id: true },
  });
  if (referenced) return;
  await deps.db.storedAsset.updateMany({
    where: {
      id: assetId,
      businessId,
      status: "READY",
      purpose: PUBLIC_REQUEST_PHOTO_PURPOSE,
      expiresAt: null,
    },
    data: { expiresAt: new Date(now.getTime() + STORAGE_PENDING_TTL_MS) },
  });
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
  await releaseExpiredUnattachedPublicRequestPhotos(deps, business.id);
  return authorizeManagedUpload(deps, business.id, {
    category: "CUSTOMER_PHOTO",
    purpose: PUBLIC_REQUEST_PHOTO_PURPOSE,
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
    await stampUnattachedRequestPhotoExpiry(deps, business.id, candidate.id);
    return deps.db.storedAsset.findFirstOrThrow({
      where: { id: candidate.id, businessId: business.id },
    });
  }

  const now = deps.now?.() ?? new Date();
  if (
    candidate.status !== "PENDING" ||
    (candidate.expiresAt != null && candidate.expiresAt.getTime() <= now.getTime())
  ) {
    throw new StorageError(NOT_PRIVATE_REQUEST_PHOTO);
  }

  const asset = await finalizeManagedUpload(deps, business.id, assetId);
  await stampUnattachedRequestPhotoExpiry(deps, business.id, asset.id);
  return deps.db.storedAsset.findFirstOrThrow({
    where: { id: asset.id, businessId: business.id },
  });
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
    onOwnedRequestLocked?: () => Promise<void> | void;
  },
) {
  if (input.files.length === 0) {
    return { attached: 0, remainingSlots: 0, uploaded: 0 };
  }

  const business = await resolvePublicStorageBusiness(deps.db, slug);
  if (!business) {
    return { attached: 0, remainingSlots: 0, uploaded: 0 };
  }

  return deps.db.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM "ServiceRequest"
        WHERE id = ${input.requestId}
          AND "businessId" = ${business.id}
        FOR UPDATE
      `;
      const request = locked[0];
      if (!request) {
        return { attached: 0, remainingSlots: 0, uploaded: 0 };
      }

      await input.onOwnedRequestLocked?.();

      const attachedCount = await tx.serviceRequestPhoto.count({
        where: {
          serviceRequestId: request.id,
          businessId: business.id,
        },
      });
      const remainingSlots = remainingIntakePhotoSlots(attachedCount);
      if (remainingSlots <= 0) {
        return { attached: 0, remainingSlots: 0, uploaded: 0 };
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
        return { attached: 0, remainingSlots, uploaded: 0 };
      }

      await tx.serviceRequestPhoto.createMany({
        data: uploaded.map((photo) => ({
          businessId: business.id,
          serviceRequestId: request.id,
          url: photo.url,
          storedAssetId: photo.storedAssetId,
        })),
      });
      await rememberAttachedPublicRequestPhotos(
        tx,
        business.id,
        uploaded.map((photo) => photo.storedAssetId),
      );

      return {
        attached: uploaded.length,
        remainingSlots,
        uploaded: uploaded.length,
      };
    },
    { maxWait: 10_000, timeout: 30_000 },
  );
}
