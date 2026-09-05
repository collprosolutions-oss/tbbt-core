import {
  DEFAULT_MANAGED_STORAGE_LIMIT_BYTES,
  StorageError,
} from "@/lib/business-storage/types";

export type ManagedStorageConfig = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  endpoint: string;
  region: string;
  publicBaseUrl: string | null;
  defaultLimitBytes: number;
};

function readEnv(name: string) {
  const value = process.env[name]?.trim();
  return value || "";
}

export function readManagedStorageConfig(): ManagedStorageConfig | null {
  const accountId = readEnv("R2_ACCOUNT_ID");
  const accessKeyId = readEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = readEnv("R2_SECRET_ACCESS_KEY");
  const bucketName = readEnv("R2_BUCKET_NAME");
  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName) {
    return null;
  }
  const endpoint =
    readEnv("R2_ENDPOINT") || `https://${accountId}.r2.cloudflarestorage.com`;
  const publicBase = readEnv("STORAGE_PUBLIC_BASE_URL").replace(/\/+$/, "");
  const limitRaw = Number(readEnv("STORAGE_DEFAULT_LIMIT_BYTES"));
  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucketName,
    endpoint,
    region: readEnv("R2_REGION") || "auto",
    publicBaseUrl: publicBase || null,
    defaultLimitBytes:
      Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.floor(limitRaw)
        : DEFAULT_MANAGED_STORAGE_LIMIT_BYTES,
  };
}

export function isBusinessStorageConfigured() {
  return readManagedStorageConfig() != null;
}

export function requireManagedStorageConfig() {
  const config = readManagedStorageConfig();
  if (!config) {
    throw new StorageError(
      "Platform file storage is not configured. Add the R2 environment variables on the server.",
    );
  }
  return config;
}
