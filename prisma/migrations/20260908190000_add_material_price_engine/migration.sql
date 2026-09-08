-- Provider-neutral material price engine. Additive only.
-- Preview skips migrate, so application code also CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS "BusinessSupplierPreference" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "locationZip" TEXT,
    "locationStoreId" TEXT,
    "locationLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessSupplierPreference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BusinessSupplierPreference_businessId_providerId_key"
  ON "BusinessSupplierPreference"("businessId", "providerId");

CREATE INDEX IF NOT EXISTS "BusinessSupplierPreference_businessId_idx"
  ON "BusinessSupplierPreference"("businessId");

CREATE TABLE IF NOT EXISTS "BusinessMaterialSupplierMapping" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "materialIdentity" TEXT NOT NULL,
    "takeoffType" TEXT,
    "providerProductId" TEXT NOT NULL,
    "providerSku" TEXT,
    "providerUrl" TEXT,
    "productName" TEXT NOT NULL,
    "unitLabel" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessMaterialSupplierMapping_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BusinessMaterialSupplierMapping_businessId_providerId_materialIdentity_key"
  ON "BusinessMaterialSupplierMapping"("businessId", "providerId", "materialIdentity");

CREATE INDEX IF NOT EXISTS "BusinessMaterialSupplierMapping_businessId_idx"
  ON "BusinessMaterialSupplierMapping"("businessId");

CREATE INDEX IF NOT EXISTS "BusinessMaterialSupplierMapping_businessId_providerId_idx"
  ON "BusinessMaterialSupplierMapping"("businessId", "providerId");

CREATE TABLE IF NOT EXISTS "SupplierPriceRecord" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "providerProductId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "sku" TEXT,
    "productUrl" TEXT,
    "unitLabel" TEXT NOT NULL,
    "currentPrice" DECIMAL(65,30) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "locationKey" TEXT NOT NULL DEFAULT '_',
    "locationZip" TEXT,
    "locationStoreId" TEXT,
    "locationLabel" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "sourceStatus" TEXT NOT NULL,
    "sourceMode" TEXT NOT NULL,
    "rawMetadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierPriceRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SupplierPriceRecord_businessId_providerId_providerProductId_locationKey_key"
  ON "SupplierPriceRecord"("businessId", "providerId", "providerProductId", "locationKey");

CREATE INDEX IF NOT EXISTS "SupplierPriceRecord_businessId_idx"
  ON "SupplierPriceRecord"("businessId");

CREATE INDEX IF NOT EXISTS "SupplierPriceRecord_businessId_providerId_idx"
  ON "SupplierPriceRecord"("businessId", "providerId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessSupplierPreference_businessId_fkey'
  ) THEN
    ALTER TABLE "BusinessSupplierPreference"
      ADD CONSTRAINT "BusinessSupplierPreference_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessMaterialSupplierMapping_businessId_fkey'
  ) THEN
    ALTER TABLE "BusinessMaterialSupplierMapping"
      ADD CONSTRAINT "BusinessMaterialSupplierMapping_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SupplierPriceRecord_businessId_fkey'
  ) THEN
    ALTER TABLE "SupplierPriceRecord"
      ADD CONSTRAINT "SupplierPriceRecord_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
