import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  CAPABILITIES,
  ForbiddenError,
  requireBusinessCapability,
} from "@/lib/authorization";
import {
  isBusinessStorageConfigured,
  readManagedStorageConfig,
  requireManagedStorageConfig,
} from "@/lib/business-storage/config";
import {
  assertKeyBelongsToBusiness,
  buildBusinessStorageKey,
  businessNamespacePrefix,
  publicAssetPath,
} from "@/lib/business-storage/keys";
import { createR2StorageProvider } from "@/lib/business-storage/r2-provider";
import {
  DEFAULT_MANAGED_STORAGE_LIMIT_BYTES,
  PRIVATE_DOWNLOAD_URL_TTL_SECONDS,
  PUBLIC_REQUEST_PHOTO_PURPOSE,
  STORAGE_PENDING_TTL_MS,
  STORAGE_UPLOAD_URL_TTL_SECONDS,
  StorageAccessError,
  StorageError,
  StorageQuotaError,
  type StoredAssetCategory,
  type StoredAssetVisibility,
  type StorageProvider,
} from "@/lib/business-storage/types";

type Db = PrismaClient | Prisma.TransactionClient;

export type StorageServiceDeps = {
  db: PrismaClient;
  provider?: StorageProvider;
  now?: () => Date;
  bucketName?: string;
  defaultLimitBytes?: number;
};

function toBigInt(value: number | bigint) {
  return typeof value === "bigint" ? value : BigInt(value);
}

function reservedBytesForPendingAsset(purpose: string | null | undefined, fileSizeBytes: number) {
  if (purpose === PUBLIC_REQUEST_PHOTO_PURPOSE) return 0;
  return fileSizeBytes;
}

type PendingReservationAsset = {
  purpose?: string | null;
  fileSizeBytes: number;
  width?: number | null;
};

/**
 * Bytes this PENDING row still holds on storageReservedBytes.
 * New public-request-photo rows record width=0 (reserved nothing).
 * Pre-deploy public rows have width=null and reserved fileSizeBytes.
 * Never report more than the account still has reserved.
 */
function pendingReservationBytesToRelease(
  asset: PendingReservationAsset,
  accountReservedBytes: number,
) {
  const available = Math.max(0, accountReservedBytes);
  if (asset.purpose === PUBLIC_REQUEST_PHOTO_PURPOSE) {
    if (asset.width === 0) return 0;
    return Math.min(Number(asset.fileSizeBytes), available);
  }
  return Math.min(reservedBytesForPendingAsset(asset.purpose, asset.fileSizeBytes), available);
}

async function lockStorageAccountRow(
  tx: Prisma.TransactionClient,
  accountId: string,
) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "BusinessStorageAccount" WHERE id = ${accountId} FOR UPDATE
  `;
  if (rows.length === 0) {
    throw new StorageError("File storage is not configured for this business.");
  }
  return tx.businessStorageAccount.findUniqueOrThrow({ where: { id: accountId } });
}

async function lockPendingAssetRow(
  tx: Prisma.TransactionClient,
  input: { businessId: string; assetId: string },
) {
  await tx.$queryRaw`
    SELECT id FROM "StoredAsset"
    WHERE id = ${input.assetId} AND "businessId" = ${input.businessId}
    FOR UPDATE
  `;
}

/** Account row first, then the PENDING asset. The opposite order deadlocks finalize against abort/expiry. */
async function lockAccountThenPendingAsset(
  tx: Prisma.TransactionClient,
  input: { accountId: string; businessId: string; assetId: string },
) {
  const account = await lockStorageAccountRow(tx, input.accountId);
  await lockPendingAssetRow(tx, input);
  return account;
}

async function releasePendingReservationInTx(
  tx: Prisma.TransactionClient,
  accountId: string,
  asset: PendingReservationAsset,
) {
  const account = await tx.businessStorageAccount.findUniqueOrThrow({
    where: { id: accountId },
    select: { storageReservedBytes: true },
  });
  const held = pendingReservationBytesToRelease(asset, Number(account.storageReservedBytes));
  if (held <= 0) return 0;
  await tx.businessStorageAccount.update({
    where: { id: accountId },
    data: { storageReservedBytes: { decrement: held } },
  });
  return held;
}

async function failPendingAssetAndReleaseReservation(
  tx: Prisma.TransactionClient,
  input: {
    businessId: string;
    assetId: string;
    storageAccountId: string;
    purpose: string | null;
    fileSizeBytes: number;
    width: number | null;
    now: Date;
  },
) {
  const updated = await tx.storedAsset.updateMany({
    where: { id: input.assetId, businessId: input.businessId, status: "PENDING" },
    data: { status: "FAILED", deletedAt: input.now, publicPath: null },
  });
  if (updated.count !== 1) return false;
  await releasePendingReservationInTx(tx, input.storageAccountId, input);
  return true;
}

export function hasEnoughStorage(input: {
  usedBytes: number | bigint;
  reservedBytes: number | bigint;
  incomingBytes: number;
  limitBytes: number | bigint;
}) {
  if (input.incomingBytes < 0) return false;
  return (
    toBigInt(input.usedBytes) +
      toBigInt(input.reservedBytes) +
      toBigInt(input.incomingBytes) <=
    toBigInt(input.limitBytes)
  );
}

export async function resolveStorageProvider(deps?: {
  provider?: StorageProvider;
}): Promise<StorageProvider> {
  if (deps?.provider) return deps.provider;
  return createR2StorageProvider(requireManagedStorageConfig());
}

export async function ensureBusinessStorageAccount(
  db: Db,
  businessId: string,
  options?: { bucketName?: string; defaultLimitBytes?: number },
) {
  const existing = await db.businessStorageAccount.findUnique({
    where: { businessId },
  });
  if (existing) return existing;
  const config = readManagedStorageConfig();
  const bucketName = options?.bucketName || config?.bucketName;
  if (!bucketName) {
    throw new StorageError(
      "Platform file storage is not configured. Add the R2 environment variables on the server.",
    );
  }
  const limit = options?.defaultLimitBytes ?? config?.defaultLimitBytes ?? DEFAULT_MANAGED_STORAGE_LIMIT_BYTES;
  return db.businessStorageAccount.create({
    data: {
      businessId,
      provider: "R2",
      mode: "MANAGED",
      bucketName,
      namespacePrefix: businessNamespacePrefix(businessId),
      status: "ACTIVE",
      storageLimitBytes: BigInt(limit),
    },
  });
}

async function bestEffortDeleteOwnedObject(
  provider: StorageProvider,
  businessId: string,
  input: { bucket: string; storageKey: string },
) {
  assertKeyBelongsToBusiness(input.storageKey, businessId);
  await provider.deleteObject({
    bucket: input.bucket,
    key: input.storageKey,
  });
}

export async function bestEffortCleanupOwnedObject(
  deps: StorageServiceDeps,
  businessId: string,
  input: { bucket: string; storageKey: string },
) {
  try {
    const provider = await resolveStorageProvider(deps);
    await bestEffortDeleteOwnedObject(provider, businessId, input);
  } catch (error) {
    console.error("Failed to delete stored object", {
      businessId,
      storageKey: input.storageKey,
      error,
    });
  }
}

async function releaseExpiredReservations(
  db: PrismaClient,
  businessId: string,
  now: Date,
  provider: StorageProvider,
) {
  const expired = await db.storedAsset.findMany({
    where: {
      businessId,
      status: "PENDING",
      expiresAt: { lte: now },
    },
    select: {
      id: true,
      purpose: true,
      fileSizeBytes: true,
      width: true,
      storageAccountId: true,
      storageKey: true,
      storageAccount: { select: { bucketName: true } },
    },
  });
  if (expired.length === 0) return;
  const claimed = await db.$transaction(async (tx) => {
    const accountIds = [...new Set(expired.map((row) => row.storageAccountId))].sort();
    for (const accountId of accountIds) {
      // LOCK_ACCOUNT_BEFORE_ASSET: expiry must match finalize (account, then asset).
      await lockStorageAccountRow(tx, accountId);
    }
    const won: typeof expired = [];
    for (const row of [...expired].sort((left, right) => (left.id < right.id ? -1 : 1))) {
      await lockPendingAssetRow(tx, { businessId, assetId: row.id });
      const updated = await tx.storedAsset.updateMany({
        where: { id: row.id, businessId, status: "PENDING" },
        data: { status: "FAILED", deletedAt: now },
      });
      if (updated.count === 1) won.push(row);
    }
    for (const row of won) {
      await releasePendingReservationInTx(tx, row.storageAccountId, row);
    }
    return won;
  });
  for (const row of claimed) {
    try {
      await bestEffortDeleteOwnedObject(provider, businessId, {
        bucket: row.storageAccount.bucketName,
        storageKey: row.storageKey,
      });
    } catch {
      // One provider delete failure must not block the rest of the expired set.
    }
  }
}

export type AuthorizeManagedUploadOptions = {
  beforeCreate?: (tx: Prisma.TransactionClient) => Promise<void>;
};

export type FinalizeManagedUploadOptions = {
  beforeClaim?: (tx: Prisma.TransactionClient) => Promise<void>;
};

export async function authorizeManagedUpload(
  deps: StorageServiceDeps,
  businessId: string,
  input: {
    category: StoredAssetCategory;
    purpose?: string;
    originalFilename: string;
    mimeType: string;
    fileSizeBytes: number;
    visibility: StoredAssetVisibility;
    customerId?: string | null;
    propertyId?: string | null;
    jobId?: string | null;
  },
  options?: AuthorizeManagedUploadOptions,
) {
  if (input.fileSizeBytes <= 0) {
    throw new StorageError("Choose a file to upload.");
  }
  const now = deps.now?.() ?? new Date();
  const provider = await resolveStorageProvider(deps);
  const account = await ensureBusinessStorageAccount(deps.db, businessId, {
    bucketName: deps.bucketName,
    defaultLimitBytes: deps.defaultLimitBytes,
  });
  if (account.status !== "ACTIVE") {
    throw new StorageError("File storage is suspended for this business.");
  }

  await releaseExpiredReservations(deps.db, businessId, now, provider);

  const fresh = await deps.db.businessStorageAccount.findUniqueOrThrow({
    where: { id: account.id },
  });
  const { resolveEffectiveStorageLimitBytes } = await import("@/lib/product-entitlements/limits");
  const limitBytes = await resolveEffectiveStorageLimitBytes(
    deps.db,
    businessId,
    fresh.storageLimitBytes,
  );
  if (
    !hasEnoughStorage({
      usedBytes: fresh.storageUsedBytes,
      reservedBytes: fresh.storageReservedBytes,
      incomingBytes: input.fileSizeBytes,
      limitBytes,
    })
  ) {
    throw new StorageQuotaError(
      Number(fresh.storageUsedBytes) > limitBytes
        ? "Stored files are kept. Additional uploads are blocked until storage is within the entitled limit or Extra Storage is added."
        : "This upload would exceed the entitled storage limit. Existing files are kept.",
    );
  }

  const key = buildBusinessStorageKey({
    businessId,
    category: input.category,
    mimeType: input.mimeType,
  });
  assertKeyBelongsToBusiness(key, businessId);

  const asset = await deps.db.$transaction(async (tx) => {
    await options?.beforeCreate?.(tx);
    if (input.customerId) {
      const customer = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Customer"
        WHERE id = ${input.customerId} AND "businessId" = ${businessId}
        FOR KEY SHARE
      `;
      if (customer.length === 0) {
        throw new StorageAccessError("That customer is not available.");
      }
    }
    const locked = await tx.businessStorageAccount.findUniqueOrThrow({
      where: { id: account.id },
    });
    if (
      !hasEnoughStorage({
        usedBytes: locked.storageUsedBytes,
        reservedBytes: locked.storageReservedBytes,
        incomingBytes: input.fileSizeBytes,
        limitBytes,
      })
    ) {
      throw new StorageQuotaError(
        "This upload would exceed the entitled storage limit. Existing files are kept.",
      );
    }
    const reservedBytes = reservedBytesForPendingAsset(input.purpose, input.fileSizeBytes);
    const created = await tx.storedAsset.create({
      data: {
        businessId,
        storageAccountId: account.id,
        customerId: input.customerId ?? null,
        propertyId: input.propertyId ?? null,
        jobId: input.jobId ?? null,
        category: input.category,
        purpose: input.purpose ?? null,
        originalFilename: input.originalFilename,
        storageKey: key,
        mimeType: input.mimeType,
        fileSizeBytes: input.fileSizeBytes,
        visibility: input.visibility,
        status: "PENDING",
        expiresAt: new Date(now.getTime() + STORAGE_PENDING_TTL_MS),
        // New public-request-photo rows record 0 so abort/expire/finalize
        // can tell them apart from pre-deploy rows that reserved fileSizeBytes.
        ...(input.purpose === PUBLIC_REQUEST_PHOTO_PURPOSE ? { width: 0 } : {}),
      },
    });
    if (reservedBytes > 0) {
      await tx.businessStorageAccount.update({
        where: { id: account.id },
        data: { storageReservedBytes: { increment: reservedBytes } },
      });
    }
    return created;
  });

  const upload = await provider.createUploadUrl({
    bucket: account.bucketName,
    key,
    contentType: input.mimeType,
    contentLength: input.fileSizeBytes,
    expiresInSeconds: STORAGE_UPLOAD_URL_TTL_SECONDS,
  });

  return { asset, account, upload };
}

export async function authorizeBusinessUpload(
  deps: StorageServiceDeps,
  access: BusinessAccess,
  input: {
    category: StoredAssetCategory;
    purpose?: string;
    originalFilename: string;
    mimeType: string;
    fileSizeBytes: number;
    visibility: StoredAssetVisibility;
    customerId?: string | null;
    propertyId?: string | null;
    jobId?: string | null;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  return authorizeManagedUpload(deps, access.businessId, input);
}

export async function abortManagedUpload(
  deps: StorageServiceDeps,
  businessId: string,
  assetId: string,
) {
  const existing = await deps.db.storedAsset.findFirst({
    where: { id: assetId, businessId },
    include: { storageAccount: true },
  });
  if (!existing) throw new StorageAccessError();
  const now = deps.now?.() ?? new Date();
  const claimed = await deps.db.$transaction(async (tx) => {
    // LOCK_ACCOUNT_BEFORE_ASSET: abort must match finalize (account, then asset).
    await lockAccountThenPendingAsset(tx, {
      accountId: existing.storageAccountId,
      businessId,
      assetId: existing.id,
    });
    const updated = await tx.storedAsset.updateMany({
      where: { id: existing.id, businessId, status: "PENDING" },
      data: { status: "FAILED", deletedAt: now },
    });
    if (updated.count !== 1) return false;
    await releasePendingReservationInTx(tx, existing.storageAccountId, existing);
    return true;
  });
  if (claimed) {
    await bestEffortCleanupOwnedObject(deps, businessId, {
      bucket: existing.storageAccount.bucketName,
      storageKey: existing.storageKey,
    });
  }
  const current = await deps.db.storedAsset.findFirst({
    where: { id: assetId, businessId },
    include: { storageAccount: true },
  });
  if (!current) throw new StorageAccessError();
  return current;
}

export type DiscardReadyManagedUploadMatch = {
  jobId: string;
  category: StoredAssetCategory;
  purpose: string;
  visibility: StoredAssetVisibility;
};

/**
 * Releases a READY asset that never became a domain attachment.
 * Abort stays PENDING-only so a successful finalize cannot be undone
 * from the abort route. The claim is limited to the matching private
 * field job photo (business, job, category, purpose, visibility).
 */
export async function discardReadyManagedUpload(
  deps: StorageServiceDeps,
  businessId: string,
  assetId: string,
  match: DiscardReadyManagedUploadMatch,
) {
  const existing = await deps.db.storedAsset.findFirst({
    where: { id: assetId, businessId },
    include: { storageAccount: true },
  });
  if (!existing) throw new StorageAccessError();
  const now = deps.now?.() ?? new Date();
  const claimed = await deps.db.$transaction(async (tx) => {
    const updated = await tx.storedAsset.updateMany({
      where: {
        id: existing.id,
        businessId,
        status: "READY",
        jobId: match.jobId,
        category: match.category,
        purpose: match.purpose,
        visibility: match.visibility,
      },
      data: { status: "FAILED", deletedAt: now, publicPath: null },
    });
    if (updated.count !== 1) return false;
    if (existing.fileSizeBytes > 0) {
      await tx.businessStorageAccount.update({
        where: { id: existing.storageAccountId },
        data: { storageUsedBytes: { decrement: existing.fileSizeBytes } },
      });
    }
    return true;
  });
  if (claimed) {
    await bestEffortCleanupOwnedObject(deps, businessId, {
      bucket: existing.storageAccount.bucketName,
      storageKey: existing.storageKey,
    });
  }
  const current = await deps.db.storedAsset.findFirst({
    where: { id: assetId, businessId },
    include: { storageAccount: true },
  });
  if (!current) throw new StorageAccessError();
  return current;
}

export async function abortBusinessUpload(
  deps: StorageServiceDeps,
  access: BusinessAccess,
  assetId: string,
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  return abortManagedUpload(deps, access.businessId, assetId);
}

export async function finalizeManagedUpload(
  deps: StorageServiceDeps,
  businessId: string,
  assetId: string,
  options?: FinalizeManagedUploadOptions,
) {
  const asset = await deps.db.storedAsset.findFirst({
    where: { id: assetId, businessId },
    include: { storageAccount: true },
  });
  if (!asset) throw new StorageAccessError();
  if (asset.status === "READY") return asset;
  if (asset.status !== "PENDING") {
    throw new StorageError("That upload is no longer pending.");
  }
  assertKeyBelongsToBusiness(asset.storageKey, businessId);
  const provider = await resolveStorageProvider(deps);
  const meta = await provider.getObjectMetadata({
    bucket: asset.storageAccount.bucketName,
    key: asset.storageKey,
  });
  if (!meta || meta.sizeBytes <= 0) {
    throw new StorageError("The file was not found in storage. Upload it again.");
  }
  if (meta.sizeBytes > asset.fileSizeBytes) {
    await abortManagedUpload(deps, businessId, asset.id);
    throw new StorageQuotaError("The uploaded file is larger than what was authorized.");
  }

  const publicPath =
    asset.visibility === "PUBLIC" ? publicAssetPath(asset.id) : null;
  const now = deps.now?.() ?? new Date();
  const actual = meta.sizeBytes;

  const result = await deps.db.$transaction(async (tx) => {
    await options?.beforeClaim?.(tx);
    const lockedAccount = await lockAccountThenPendingAsset(tx, {
      accountId: asset.storageAccountId,
      businessId,
      assetId: asset.id,
    });
    const { resolveEffectiveStorageLimitBytes } = await import("@/lib/product-entitlements/limits");
    const limitBytes = await resolveEffectiveStorageLimitBytes(
      tx,
      businessId,
      lockedAccount.storageLimitBytes,
    );
    const heldReserved = pendingReservationBytesToRelease(
      asset,
      Number(lockedAccount.storageReservedBytes),
    );
    if (
      !hasEnoughStorage({
        usedBytes: lockedAccount.storageUsedBytes,
        reservedBytes: Number(lockedAccount.storageReservedBytes) - heldReserved,
        incomingBytes: actual,
        limitBytes,
      })
    ) {
      await failPendingAssetAndReleaseReservation(tx, {
        businessId,
        assetId: asset.id,
        storageAccountId: asset.storageAccountId,
        purpose: asset.purpose,
        fileSizeBytes: asset.fileSizeBytes,
        width: asset.width,
        now,
      });
      return { kind: "quota" as const };
    }
    const claimed = await tx.storedAsset.updateMany({
      where: {
        id: asset.id,
        businessId,
        status: "PENDING",
      },
      data: {
        status: "READY",
        fileSizeBytes: actual,
        mimeType: meta.contentType || asset.mimeType,
        publicPath,
        expiresAt: null,
        updatedAt: now,
      },
    });
    if (claimed.count === 1) {
      await tx.businessStorageAccount.update({
        where: { id: asset.storageAccountId },
        data: {
          ...(heldReserved > 0 ? { storageReservedBytes: { decrement: heldReserved } } : {}),
          storageUsedBytes: { increment: actual },
        },
      });
      return {
        kind: "ready" as const,
        asset: await tx.storedAsset.findFirstOrThrow({
          where: { id: asset.id, businessId },
        }),
      };
    }
    const current = await tx.storedAsset.findFirst({
      where: { id: asset.id, businessId },
    });
    if (current?.status === "READY") return { kind: "ready" as const, asset: current };
    throw new StorageError("That upload is no longer pending.");
  });
  if (result.kind === "quota") {
    await bestEffortCleanupOwnedObject(deps, businessId, {
      bucket: asset.storageAccount.bucketName,
      storageKey: asset.storageKey,
    });
    throw new StorageQuotaError(
      "This upload would exceed the entitled storage limit. Existing files are kept.",
    );
  }
  return result.asset;
}

export async function finalizeBusinessUpload(
  deps: StorageServiceDeps,
  access: BusinessAccess,
  assetId: string,
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  return finalizeManagedUpload(deps, access.businessId, assetId);
}

export async function putBusinessObject(
  deps: StorageServiceDeps,
  access: BusinessAccess,
  input: {
    category: StoredAssetCategory;
    purpose?: string;
    originalFilename: string;
    mimeType: string;
    body: Buffer | Uint8Array;
    visibility: StoredAssetVisibility;
  },
) {
  const authorized = await authorizeBusinessUpload(deps, access, {
    category: input.category,
    purpose: input.purpose,
    originalFilename: input.originalFilename,
    mimeType: input.mimeType,
    fileSizeBytes: input.body.byteLength,
    visibility: input.visibility,
  });
  const provider = await resolveStorageProvider(deps);
  try {
    await provider.putObject({
      bucket: authorized.account.bucketName,
      key: authorized.asset.storageKey,
      body: input.body,
      contentType: input.mimeType,
    });
    return finalizeBusinessUpload(deps, access, authorized.asset.id);
  } catch (error) {
    await abortBusinessUpload(deps, access, authorized.asset.id);
    throw error;
  }
}

export async function deleteStoredAsset(
  deps: StorageServiceDeps,
  access: BusinessAccess,
  assetId: string,
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  const asset = await deps.db.storedAsset.findFirst({
    where: { id: assetId, businessId: access.businessId },
    include: { storageAccount: true },
  });
  if (!asset) throw new StorageAccessError();
  if (asset.status === "DELETED") return asset;
  const provider = await resolveStorageProvider(deps);
  await provider.deleteObject({
    bucket: asset.storageAccount.bucketName,
    key: asset.storageKey,
  }).catch(() => undefined);
  const now = deps.now?.() ?? new Date();
  return deps.db.$transaction(async (tx) => {
    const updated = await tx.storedAsset.update({
      where: { id: asset.id },
      data: { status: "DELETED", deletedAt: now, publicPath: null },
    });
    if (asset.status === "READY" && asset.fileSizeBytes > 0) {
      await tx.businessStorageAccount.update({
        where: { id: asset.storageAccountId },
        data: { storageUsedBytes: { decrement: asset.fileSizeBytes } },
      });
    }
    if (asset.status === "PENDING") {
      await releasePendingReservationInTx(tx, asset.storageAccountId, asset);
    }
    return updated;
  });
}

export async function assertOwnedStoredAsset(
  db: Db,
  access: BusinessAccess,
  assetId: string,
) {
  const asset = await db.storedAsset.findFirst({
    where: { id: assetId, businessId: access.businessId },
  });
  if (!asset) throw new StorageAccessError();
  return asset;
}

export async function readPublicStoredAsset(db: Db, assetId: string) {
  return db.storedAsset.findFirst({
    where: {
      id: assetId,
      status: "READY",
      visibility: "PUBLIC",
      deletedAt: null,
    },
    include: { storageAccount: true },
  });
}

export async function createPrivateDownloadUrl(
  deps: StorageServiceDeps,
  access: BusinessAccess,
  assetId: string,
) {
  const asset = await assertOwnedStoredAsset(deps.db, access, assetId);
  if (asset.status !== "READY" || asset.visibility !== "PRIVATE") {
    throw new StorageAccessError();
  }
  const account = await deps.db.businessStorageAccount.findUniqueOrThrow({
    where: { id: asset.storageAccountId },
  });
  const provider = await resolveStorageProvider(deps);
  return provider.createDownloadUrl({
    bucket: account.bucketName,
    key: asset.storageKey,
    expiresInSeconds: PRIVATE_DOWNLOAD_URL_TTL_SECONDS,
  });
}

export function getBusinessStorageUsage(account: {
  storageUsedBytes: bigint;
  storageReservedBytes: bigint;
  storageLimitBytes: bigint;
}) {
  return {
    usedBytes: Number(account.storageUsedBytes),
    reservedBytes: Number(account.storageReservedBytes),
    limitBytes: Number(account.storageLimitBytes),
  };
}

export { isBusinessStorageConfigured };

export function memberCannotUseStorage(access: BusinessAccess) {
  try {
    requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
    return false;
  } catch (error) {
    return error instanceof ForbiddenError;
  }
}
