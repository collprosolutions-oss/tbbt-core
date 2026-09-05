import type { PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  abortBusinessUpload,
  authorizeBusinessUpload,
  deleteStoredAsset,
  finalizeBusinessUpload,
  putBusinessObject,
  type StorageServiceDeps,
} from "@/lib/business-storage/service";
import {
  WEBSITE_PHOTO_MAX_BYTES,
  StorageError,
} from "@/lib/business-storage/types";
import {
  PUBLIC_SITE_HOME_PAGE,
  isEditablePublicSitePage,
  upsertPublicSiteImageOp,
} from "@/lib/public-site-images";
import { resolveSupportedImageMimeType } from "@/lib/storage";

const WEBSITE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function inspectWebsitePhotoUpload(file: {
  type?: string | null;
  name?: string | null;
  size: number;
}) {
  const mimeType = resolveSupportedImageMimeType(file);
  if (!mimeType || !WEBSITE_IMAGE_TYPES.has(mimeType)) {
    return {
      ok: false as const,
      error: "Unsupported file type. Choose a JPEG, PNG, or WebP photo.",
    };
  }
  if (file.size <= 0 || file.size > WEBSITE_PHOTO_MAX_BYTES) {
    return {
      ok: false as const,
      error: "That photo is too large. The limit is 4 MB.",
    };
  }
  return {
    ok: true as const,
    mimeType,
    fileName: (file.name || "").trim() || "photo",
    fileSizeBytes: file.size,
  };
}

export async function authorizeWebsitePhotoUploadOp(
  deps: StorageServiceDeps,
  access: BusinessAccess,
  input: {
    page: string;
    slot: string;
    originalFilename: string;
    mimeType: string;
    fileSizeBytes: number;
  },
) {
  const page = input.page || PUBLIC_SITE_HOME_PAGE;
  if (!isEditablePublicSitePage(page) || !input.slot.trim()) {
    throw new StorageError("Choose an image slot to update.");
  }
  const inspection = inspectWebsitePhotoUpload({
    type: input.mimeType,
    name: input.originalFilename,
    size: input.fileSizeBytes,
  });
  if (!inspection.ok) {
    throw new StorageError(inspection.error);
  }
  return authorizeBusinessUpload(deps, access, {
    category: "WEBSITE_IMAGE",
    purpose: `website:${page}:${input.slot}`,
    originalFilename: inspection.fileName,
    mimeType: inspection.mimeType,
    fileSizeBytes: inspection.fileSizeBytes,
    visibility: "PUBLIC",
  });
}

export async function finalizeWebsitePhotoUploadOp(
  deps: StorageServiceDeps,
  access: BusinessAccess,
  input: { assetId: string; page: string; slot: string },
) {
  const asset = await finalizeBusinessUpload(deps, access, input.assetId);
  const imageUrl = asset.publicPath;
  if (!imageUrl) {
    throw new StorageError("That website photo could not be published.");
  }
  const previous = await deps.db.publicSiteImage.findUnique({
    where: {
      businessId_page_slot: {
        businessId: access.businessId,
        page: input.page,
        slot: input.slot,
      },
    },
  });
  const saved = await upsertPublicSiteImageOp(deps.db, access, {
    page: input.page,
    slot: input.slot,
    imageUrl,
    storedAssetId: asset.id,
  });
  if (
    previous?.storedAssetId &&
    previous.storedAssetId !== asset.id
  ) {
    await deleteStoredAsset(deps, access, previous.storedAssetId).catch(() => undefined);
  }
  return { asset, saved, imageUrl };
}

export async function abortWebsitePhotoUploadOp(
  deps: StorageServiceDeps,
  access: BusinessAccess,
  assetId: string,
) {
  return abortBusinessUpload(deps, access, assetId);
}

export async function replaceWebsitePhotoFromBytes(
  deps: StorageServiceDeps,
  access: BusinessAccess,
  input: {
    page: string;
    slot: string;
    originalFilename: string;
    mimeType: string;
    body: Buffer | Uint8Array;
  },
) {
  const asset = await putBusinessObject(deps, access, {
    category: "WEBSITE_IMAGE",
    purpose: `website:${input.page}:${input.slot}`,
    originalFilename: input.originalFilename,
    mimeType: input.mimeType,
    body: input.body,
    visibility: "PUBLIC",
  });
  return finalizeWebsitePhotoUploadOp(deps, access, {
    assetId: asset.id,
    page: input.page,
    slot: input.slot,
  });
}

export async function loadWebsitePhotoStorageSummary(
  db: PrismaClient,
  businessId: string,
) {
  const account = await db.businessStorageAccount.findUnique({
    where: { businessId },
  });
  if (!account) return null;
  return {
    usedBytes: Number(account.storageUsedBytes),
    reservedBytes: Number(account.storageReservedBytes),
    limitBytes: Number(account.storageLimitBytes),
  };
}
