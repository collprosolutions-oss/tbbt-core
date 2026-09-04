export const STORAGE_PROVIDERS = ["R2", "S3_COMPATIBLE"] as const;
export type StorageProviderId = (typeof STORAGE_PROVIDERS)[number];

export const STORAGE_MODES = ["MANAGED", "BYO"] as const;
export type StorageMode = (typeof STORAGE_MODES)[number];

export const STORAGE_ACCOUNT_STATUSES = ["ACTIVE", "SUSPENDED"] as const;
export type StorageAccountStatus = (typeof STORAGE_ACCOUNT_STATUSES)[number];

export const STORED_ASSET_CATEGORIES = [
  "WEBSITE_IMAGE",
  "BRAND_ASSET",
  "CUSTOMER_PHOTO",
  "JOB_PHOTO",
  "BEFORE_PHOTO",
  "AFTER_PHOTO",
  "DOCUMENT",
  "INVOICE_ASSET",
  "ATTACHMENT",
  "OTHER",
] as const;
export type StoredAssetCategory = (typeof STORED_ASSET_CATEGORIES)[number];

export const STORED_ASSET_VISIBILITIES = ["PUBLIC", "PRIVATE"] as const;
export type StoredAssetVisibility = (typeof STORED_ASSET_VISIBILITIES)[number];

export const STORED_ASSET_STATUSES = ["PENDING", "READY", "FAILED", "DELETED"] as const;
export type StoredAssetStatus = (typeof STORED_ASSET_STATUSES)[number];

export const STORAGE_KEY_FOLDERS: Record<StoredAssetCategory, string> = {
  WEBSITE_IMAGE: "website",
  BRAND_ASSET: "branding",
  CUSTOMER_PHOTO: "customers",
  JOB_PHOTO: "jobs",
  BEFORE_PHOTO: "jobs",
  AFTER_PHOTO: "jobs",
  DOCUMENT: "documents",
  INVOICE_ASSET: "documents",
  ATTACHMENT: "documents",
  OTHER: "other",
};

/** Technical managed default. Plan-specific entitlements can override later. */
export const DEFAULT_MANAGED_STORAGE_LIMIT_BYTES = 5 * 1024 * 1024 * 1024;
export const STORAGE_UPLOAD_URL_TTL_SECONDS = 5 * 60;
export const STORAGE_PENDING_TTL_MS = 15 * 60 * 1000;
export const WEBSITE_PHOTO_MAX_BYTES = 4 * 1024 * 1024;

export type StorageObjectMeta = {
  key: string;
  sizeBytes: number;
  contentType?: string;
  etag?: string;
};

export type StorageObjectBody = StorageObjectMeta & {
  body: Uint8Array;
};

export type PresignedUpload = {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresInSeconds: number;
};

export type PresignedDownload = {
  url: string;
  expiresInSeconds: number;
};

export interface StorageProvider {
  readonly id: StorageProviderId | "MEMORY";
  putObject(input: {
    bucket: string;
    key: string;
    body: Buffer | Uint8Array;
    contentType: string;
    cacheControl?: string;
  }): Promise<StorageObjectMeta>;
  deleteObject(input: { bucket: string; key: string }): Promise<void>;
  getObjectMetadata(input: {
    bucket: string;
    key: string;
  }): Promise<StorageObjectMeta | null>;
  getObject(input: {
    bucket: string;
    key: string;
  }): Promise<StorageObjectBody | null>;
  objectExists(input: { bucket: string; key: string }): Promise<boolean>;
  createUploadUrl(input: {
    bucket: string;
    key: string;
    contentType: string;
    contentLength: number;
    expiresInSeconds: number;
  }): Promise<PresignedUpload>;
  createDownloadUrl(input: {
    bucket: string;
    key: string;
    expiresInSeconds: number;
  }): Promise<PresignedDownload>;
}

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}

export class StorageQuotaError extends StorageError {
  constructor(message = "This business does not have enough storage remaining.") {
    super(message);
    this.name = "StorageQuotaError";
  }
}

export class StorageAccessError extends StorageError {
  constructor(message = "That file is not in this business workspace.") {
    super(message);
    this.name = "StorageAccessError";
  }
}
