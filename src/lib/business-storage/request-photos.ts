import type { Prisma, PrismaClient } from "@prisma/client";
import {
  abortManagedUpload,
  authorizeManagedUpload,
  bestEffortCleanupOwnedObject,
  ensureBusinessStorageAccount,
  finalizeManagedUpload,
  resolveStorageProvider,
  type StorageServiceDeps,
} from "@/lib/business-storage/service";
import { inspectRequestPhotoUpload } from "@/lib/business-storage/request-photo-rules";
import { privateAssetPath } from "@/lib/business-storage/keys";
import {
  MAX_UNATTACHED_PUBLIC_REQUEST_PHOTOS,
  PUBLIC_REQUEST_PHOTO_CAP_REACHED,
  PUBLIC_REQUEST_PHOTO_PURPOSE,
  UNATTACHED_PUBLIC_REQUEST_PHOTO_QUOTA_RATIO,
  UNATTACHED_REQUEST_PHOTO_TTL_MS,
  StorageError,
} from "@/lib/business-storage/types";
import { MAX_INTAKE_PHOTOS } from "@/lib/service-request-work";
import { resolveSupportedImageMimeType } from "@/lib/storage";

export { inspectRequestPhotoUpload, requestPhotoMaxBytesLabel } from "@/lib/business-storage/request-photo-rules";
export {
  MAX_PUBLIC_INTAKE_REQUEST_PHOTOS,
  MAX_UNATTACHED_PUBLIC_REQUEST_PHOTOS,
  PUBLIC_REQUEST_PHOTO_CAP_REACHED,
  PUBLIC_REQUEST_PHOTO_PURPOSE,
  UNATTACHED_PUBLIC_REQUEST_PHOTO_QUOTA_RATIO,
  UNATTACHED_REQUEST_PHOTO_TTL_MS,
} from "@/lib/business-storage/types";
/** Bound the public form's photoAssetIds list before any StoredAsset lookup. */
export const MAX_PUBLIC_REQUEST_PHOTO_ID_LOOKUP = 50;
/** Keep leftover/overflow claim transactions short; extras release in later batches. */
export const MAX_UNATTACHED_REQUEST_PHOTO_RELEASE_BATCH = 50;

export const requestPhotoTestHooks: {
  afterStoredAssetLock?: (input: {
    businessId: string;
    assetId: string;
  }) => Promise<void> | void;
  beforeReleaseUnattached?: (input: {
    businessId: string;
    assetIds: string[];
  }) => Promise<void> | void;
  afterUnattachedCapLock?: () => Promise<void> | void;
  unattachedCountCap?: number;
  unattachedByteCap?: number;
  /** Test-only: keep first-seen id order so opposite-order lock races can deadlock. */
  skipAssetIdSort?: boolean;
} = {};

export function sortedStoredAssetIds(assetIds: string[]) {
  const unique = [...new Set(assetIds.map((id) => id.trim()).filter(Boolean))];
  if (requestPhotoTestHooks.skipAssetIdSort) return unique;
  return unique.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}
const NOT_PRIVATE_REQUEST_PHOTO = "That photo is not a private request photo.";
const REQUEST_PHOTO_CANNOT_BE_PUBLISHED = "Request photos cannot be published.";

type Db = PrismaClient | Prisma.TransactionClient;

type AssetLockClient = Pick<Prisma.TransactionClient, "$queryRaw">;

type LockedStoredAssetRow = {
  id: string;
  status: string;
  purpose: string | null;
  category: string;
  visibility: string;
  fileSizeBytes: number;
  storageAccountId: string;
  storageKey: string;
};

function unattachedPublicRequestPhotoByteCeiling(limitBytes: number) {
  const fromHook = requestPhotoTestHooks.unattachedByteCap;
  if (typeof fromHook === "number" && Number.isFinite(fromHook)) {
    return Math.max(0, Math.floor(fromHook));
  }
  return Math.max(0, Math.floor(limitBytes * UNATTACHED_PUBLIC_REQUEST_PHOTO_QUOTA_RATIO));
}

function unattachedPublicRequestPhotoCountCap() {
  const fromHook = requestPhotoTestHooks.unattachedCountCap;
  if (typeof fromHook === "number" && Number.isFinite(fromHook)) {
    return Math.max(0, Math.floor(fromHook));
  }
  return MAX_UNATTACHED_PUBLIC_REQUEST_PHOTOS;
}

async function loadUnattachedPublicRequestUsage(
  tx: Prisma.TransactionClient,
  businessId: string,
  excludeAssetId?: string,
) {
  const rows = await tx.storedAsset.findMany({
    where: {
      businessId,
      purpose: PUBLIC_REQUEST_PHOTO_PURPOSE,
      category: "CUSTOMER_PHOTO",
      visibility: "PRIVATE",
      deletedAt: null,
      status: { in: ["READY", "PENDING"] },
      serviceRequestPhotos: { none: {} },
      ...(excludeAssetId ? { id: { not: excludeAssetId } } : {}),
    },
    select: { fileSizeBytes: true, status: true },
  });
  const ready = rows.filter((row) => row.status === "READY");
  return {
    count: rows.length,
    bytes: ready.reduce((sum, row) => sum + Number(row.fileSizeBytes), 0),
  };
}

async function assertUnattachedPublicRequestPhotoCapacity(
  tx: Prisma.TransactionClient,
  businessId: string,
  input: { incomingCount: number; incomingBytes: number; limitBytes: number; excludeAssetId?: string },
) {
  const usage = await loadUnattachedPublicRequestUsage(tx, businessId, input.excludeAssetId);
  const countCap = unattachedPublicRequestPhotoCountCap();
  const byteCap = unattachedPublicRequestPhotoByteCeiling(input.limitBytes);
  if (
    usage.count + input.incomingCount > countCap ||
    usage.bytes + input.incomingBytes > byteCap
  ) {
    throw new StorageError(PUBLIC_REQUEST_PHOTO_CAP_REACHED);
  }
}

async function lockBusinessStorageAccountForUpdate(
  tx: Prisma.TransactionClient,
  businessId: string,
) {
  await tx.$queryRaw`
    SELECT id
    FROM "BusinessStorageAccount"
    WHERE "businessId" = ${businessId}
    FOR UPDATE
  `;
}

async function resolvePublicRequestPhotoLimitBytes(
  deps: StorageServiceDeps,
  businessId: string,
) {
  const account = await ensureBusinessStorageAccount(deps.db, businessId, {
    bucketName: deps.bucketName,
    defaultLimitBytes: deps.defaultLimitBytes,
  });
  const { resolveEffectiveStorageLimitBytes } = await import("@/lib/product-entitlements/limits");
  return resolveEffectiveStorageLimitBytes(deps.db, businessId, account.storageLimitBytes);
}

export async function lockStoredAssetRowForUpdate(
  tx: AssetLockClient,
  businessId: string,
  assetId: string,
): Promise<LockedStoredAssetRow | null> {
  const rows = await tx.$queryRaw<LockedStoredAssetRow[]>`
    SELECT id, status, purpose, category, visibility,
           "fileSizeBytes", "storageAccountId", "storageKey"
    FROM "StoredAsset"
    WHERE id = ${assetId}
      AND "businessId" = ${businessId}
    FOR UPDATE
  `;
  const row = rows[0] ?? null;
  if (row) {
    await requestPhotoTestHooks.afterStoredAssetLock?.({ businessId, assetId });
  }
  return row;
}

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
  const asset = await lockStoredAssetRowForUpdate(tx, businessId, assetId);
  if (
    !asset ||
    asset.status !== "READY" ||
    asset.purpose !== PUBLIC_REQUEST_PHOTO_PURPOSE ||
    asset.category !== "CUSTOMER_PHOTO" ||
    asset.visibility !== "PRIVATE"
  ) {
    return null;
  }
  const account = await tx.businessStorageAccount.findUnique({
    where: { id: asset.storageAccountId },
    select: { bucketName: true },
  });
  if (!account) return null;
  const referenced = await tx.serviceRequestPhoto.findFirst({
    where: { storedAssetId: assetId, businessId },
    select: { id: true },
  });
  if (referenced) return null;
  const fileSizeBytes = Number(asset.fileSizeBytes);
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
  if (fileSizeBytes > 0) {
    await tx.businessStorageAccount.update({
      where: { id: asset.storageAccountId },
      data: { storageUsedBytes: { decrement: fileSizeBytes } },
    });
  }
  return {
    bucket: account.bucketName,
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
  const ids = sortedStoredAssetIds(assetIds);
  if (ids.length === 0) return { released: 0 };
  await requestPhotoTestHooks.beforeReleaseUnattached?.({ businessId, assetIds: ids });
  const now = deps.now?.() ?? new Date();
  let released = 0;
  for (
    let offset = 0;
    offset < ids.length;
    offset += MAX_UNATTACHED_REQUEST_PHOTO_RELEASE_BATCH
  ) {
    const batch = ids.slice(offset, offset + MAX_UNATTACHED_REQUEST_PHOTO_RELEASE_BATCH);
    const claimed = await deps.db.$transaction(async (tx) => {
      const won: Array<{ bucket: string; storageKey: string }> = [];
      for (const id of batch) {
        const object = await claimUnattachedRequestPhotoInTx(tx, businessId, id, now);
        if (object) won.push(object);
      }
      return won;
    });
    for (const object of claimed) {
      await bestEffortCleanupOwnedObject(deps, businessId, object);
    }
    released += claimed.length;
  }
  return { released };
}

export async function releaseExpiredUnattachedPublicRequestPhotos(
  deps: StorageServiceDeps,
  businessId: string,
) {
  const now = deps.now?.() ?? new Date();
  const staleWithoutExpiry = new Date(now.getTime() - UNATTACHED_REQUEST_PHOTO_TTL_MS);
  const expired = await deps.db.storedAsset.findMany({
    where: {
      businessId,
      status: "READY",
      purpose: PUBLIC_REQUEST_PHOTO_PURPOSE,
      category: "CUSTOMER_PHOTO",
      visibility: "PRIVATE",
      serviceRequestPhotos: { none: {} },
      OR: [
        { expiresAt: { lte: now } },
        { expiresAt: null, updatedAt: { lte: staleWithoutExpiry } },
      ],
    },
    select: { id: true },
  });
  if (expired.length === 0) return { released: 0 };
  return releaseUnattachedPublicRequestPhotos(
    deps,
    businessId,
    sortedStoredAssetIds(expired.map((row) => row.id)),
  );
}

export async function releasePublicRequestPhotos(
  deps: StorageServiceDeps,
  slug: string,
  assetIds: string[],
) {
  const business = await resolvePublicStorageBusiness(deps.db, slug);
  if (!business) {
    throw new StorageError("This request could not be submitted.");
  }
  return releaseUnattachedPublicRequestPhotos(
    deps,
    business.id,
    sortedStoredAssetIds(assetIds).slice(0, MAX_PUBLIC_REQUEST_PHOTO_ID_LOOKUP),
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
    data: { expiresAt: new Date(now.getTime() + UNATTACHED_REQUEST_PHOTO_TTL_MS) },
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
  const limitBytes = await resolvePublicRequestPhotoLimitBytes(deps, business.id);
  return authorizeManagedUpload(
    deps,
    business.id,
    {
      category: "CUSTOMER_PHOTO",
      purpose: PUBLIC_REQUEST_PHOTO_PURPOSE,
      originalFilename: inspection.fileName,
      mimeType: inspection.mimeType,
      fileSizeBytes: inspection.fileSizeBytes,
      visibility: "PRIVATE",
    },
    {
      async beforeCreate(tx) {
        await lockBusinessStorageAccountForUpdate(tx, business.id);
        await requestPhotoTestHooks.afterUnattachedCapLock?.();
        await assertUnattachedPublicRequestPhotoCapacity(tx, business.id, {
          incomingCount: 1,
          incomingBytes: 0,
          limitBytes,
        });
      },
    },
  );
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
  await releaseExpiredUnattachedPublicRequestPhotos(deps, business.id);
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

  const limitBytes = await resolvePublicRequestPhotoLimitBytes(deps, business.id);
  const asset = await finalizeManagedUpload(deps, business.id, assetId, {
    async beforeClaim(tx) {
      await lockBusinessStorageAccountForUpdate(tx, business.id);
      await requestPhotoTestHooks.afterUnattachedCapLock?.();
      await assertUnattachedPublicRequestPhotoCapacity(tx, business.id, {
        incomingCount: 1,
        incomingBytes: candidate.fileSizeBytes,
        excludeAssetId: candidate.id,
        limitBytes,
      });
    },
  });
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
