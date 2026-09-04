-- Per-business object storage allocation and reusable stored-asset metadata.
-- Website Photos keep crop/zoom on PublicSiteImage; the original file is
-- referenced through storedAssetId.

CREATE TABLE "BusinessStorageAccount" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'R2',
    "mode" TEXT NOT NULL DEFAULT 'MANAGED',
    "bucketName" TEXT NOT NULL,
    "namespacePrefix" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "storageLimitBytes" BIGINT NOT NULL,
    "storageUsedBytes" BIGINT NOT NULL DEFAULT 0,
    "storageReservedBytes" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessStorageAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BusinessStorageAccount_businessId_key" ON "BusinessStorageAccount"("businessId");
CREATE INDEX "BusinessStorageAccount_provider_mode_idx" ON "BusinessStorageAccount"("provider", "mode");

CREATE TABLE "StoredAsset" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "storageAccountId" TEXT NOT NULL,
    "customerId" TEXT,
    "propertyId" TEXT,
    "jobId" TEXT,
    "category" TEXT NOT NULL,
    "purpose" TEXT,
    "originalFilename" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "visibility" TEXT NOT NULL DEFAULT 'PRIVATE',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "publicPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "StoredAsset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StoredAsset_businessId_storageKey_key" ON "StoredAsset"("businessId", "storageKey");
CREATE INDEX "StoredAsset_businessId_category_status_idx" ON "StoredAsset"("businessId", "category", "status");
CREATE INDEX "StoredAsset_storageAccountId_status_idx" ON "StoredAsset"("storageAccountId", "status");
CREATE INDEX "StoredAsset_businessId_visibility_status_idx" ON "StoredAsset"("businessId", "visibility", "status");

ALTER TABLE "PublicSiteImage" ADD COLUMN "storedAssetId" TEXT;

CREATE INDEX "PublicSiteImage_storedAssetId_idx" ON "PublicSiteImage"("storedAssetId");

ALTER TABLE "BusinessStorageAccount" ADD CONSTRAINT "BusinessStorageAccount_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StoredAsset" ADD CONSTRAINT "StoredAsset_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StoredAsset" ADD CONSTRAINT "StoredAsset_storageAccountId_fkey" FOREIGN KEY ("storageAccountId") REFERENCES "BusinessStorageAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PublicSiteImage" ADD CONSTRAINT "PublicSiteImage_storedAssetId_fkey" FOREIGN KEY ("storedAssetId") REFERENCES "StoredAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
