import { randomUUID } from "node:crypto";
import {
  STORAGE_KEY_FOLDERS,
  StorageAccessError,
  type StoredAssetCategory,
} from "@/lib/business-storage/types";

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
};

export function businessNamespacePrefix(businessId: string) {
  if (!businessId.trim()) {
    throw new StorageAccessError("A business is required for storage keys.");
  }
  return `businesses/${businessId.trim()}`;
}

export function extensionForMimeType(mimeType: string) {
  return EXTENSION_BY_MIME[mimeType] ?? "bin";
}

/**
 * Every managed object key starts with the immutable tenant namespace.
 * Authorization still uses the server-resolved business, never the key alone.
 */
export function buildBusinessStorageKey(input: {
  businessId: string;
  category: StoredAssetCategory;
  mimeType: string;
}) {
  const prefix = businessNamespacePrefix(input.businessId);
  const folder = STORAGE_KEY_FOLDERS[input.category];
  const extension = extensionForMimeType(input.mimeType);
  return `${prefix}/${folder}/${randomUUID()}.${extension}`;
}

export function assertKeyBelongsToBusiness(key: string, businessId: string) {
  const expected = `${businessNamespacePrefix(businessId)}/`;
  if (!key.startsWith(expected) || key.includes("..") || key.includes("//")) {
    throw new StorageAccessError();
  }
}

export function publicAssetPath(assetId: string) {
  return `/api/storage/public/${assetId}`;
}

export function isManagedPublicAssetPath(url: string) {
  return /^\/api\/storage\/public\/[a-zA-Z0-9_-]+$/.test(url.trim());
}

export function formatStorageBytes(bytes: number | bigint) {
  const value = typeof bytes === "bigint" ? Number(bytes) : bytes;
  if (!Number.isFinite(value) || value < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let remaining = value;
  let unit = 0;
  while (remaining >= 1024 && unit < units.length - 1) {
    remaining /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : remaining >= 10 ? 1 : 2;
  return `${remaining.toFixed(digits)} ${units[unit]}`;
}
