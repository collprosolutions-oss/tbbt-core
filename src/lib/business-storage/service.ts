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

async function releaseExpiredReservations(db: Db, businessId: string, now: Date) {
  const expired = await db.storedAsset.findMany({
    where: {
      businessId,
      status: "PENDING",
      expiresAt: { lte: now },
    },
    select: { id: true, fileSizeBytes: true, storageAccountId: true },
  });
  if (expired.length === 0) return;
  const reserved = expired.reduce((sum, row) => sum + row.fileSizeBytes, 0);
  await db.storedAsset.updateMany({
    where: { id: { in: expired.map((row) => row.id) } },
    data: { status: "FAILED", deletedAt: now },
  });
  if (reserved > 0) {
    await db.businessStorageAccount.update({
      where: { id: expired[0]!.storageAccountId },
      data: { storageReservedBytes: { decrement: reserved } },
    });
  }
}

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

  await releaseExpiredReservations(deps.db, businessId, now);

  const fresh = await deps.db.businessStorageAccount.findUniqueOrThrow({
    where: { id: account.id },
  });
  if (
    !hasEnoughStorage({
      usedBytes: fresh.storageUsedBytes,
      reservedBytes: fresh.storageReservedBytes,
      incomingBytes: input.fileSizeBytes,
      limitBytes: fresh.storageLimitBytes,
    })
  ) {
    throw new StorageQuotaError();
  }

  const key = buildBusinessStorageKey({
    businessId,
    category: input.category,
    mimeType: input.mimeType,
  });
  assertKeyBelongsToBusiness(key, businessId);

  const asset = await deps.db.$transaction(async (tx) => {
    const locked = await tx.businessStorageAccount.findUniqueOrThrow({
      where: { id: account.id },
    });
    if (
      !hasEnoughStorage({
        usedBytes: locked.storageUsedBytes,
        reservedBytes: locked.storageReservedBytes,
        incomingBytes: input.fileSizeBytes,
        limitBytes: locked.storageLimitBytes,
      })
    ) {
      throw new StorageQuotaError();
    }
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
      },
    });
    await tx.businessStorageAccount.update({
      where: { id: account.id },
      data: { storageReservedBytes: { increment: input.fileSizeBytes } },
    });
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
  const asset = await deps.db.storedAsset.findFirst({
    where: { id: assetId, businessId },
  });
  if (!asset) throw new StorageAccessError();
  if (asset.status !== "PENDING") return asset;
  const now = deps.now?.() ?? new Date();
  await deps.db.$transaction(async (tx) => {
    await tx.storedAsset.update({
      where: { id: asset.id },
      data: { status: "FAILED", deletedAt: now },
    });
    await tx.businessStorageAccount.update({
      where: { id: asset.storageAccountId },
      data: { storageReservedBytes: { decrement: asset.fileSizeBytes } },
    });
  });
  return { ...asset, status: "FAILED" as const };
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
    await provider.deleteObject({
      bucket: asset.storageAccount.bucketName,
      key: asset.storageKey,
    }).catch(() => undefined);
    throw new StorageQuotaError("The uploaded file is larger than what was authorized.");
  }

  const publicPath =
    asset.visibility === "PUBLIC" ? publicAssetPath(asset.id) : null;
  const now = deps.now?.() ?? new Date();
  const reserved = asset.fileSizeBytes;
  const actual = meta.sizeBytes;

  return deps.db.$transaction(async (tx) => {
    const updated = await tx.storedAsset.update({
      where: { id: asset.id },
      data: {
        status: "READY",
        fileSizeBytes: actual,
        mimeType: meta.contentType || asset.mimeType,
        publicPath,
        expiresAt: null,
        updatedAt: now,
      },
    });
    await tx.businessStorageAccount.update({
      where: { id: asset.storageAccountId },
      data: {
        storageReservedBytes: { decrement: reserved },
        storageUsedBytes: { increment: actual },
      },
    });
    return updated;
  });
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
    if (asset.status === "PENDING" && asset.fileSizeBytes > 0) {
      await tx.businessStorageAccount.update({
        where: { id: asset.storageAccountId },
        data: { storageReservedBytes: { decrement: asset.fileSizeBytes } },
      });
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
    expiresInSeconds: 120,
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
