-- OWNER-reviewed service catalog CSV preview and confirm.
-- Additive only. Preview shares Production and skips migrate, so every
-- statement is IF NOT EXISTS. No backfill. Existing businesses keep zero rows.
-- Confirm writes ServiceCatalogItem only — never LineItem,
-- EstimateVersionLineItem, invoices, jobs, or published hourly rates.
-- Timestamp is 20260929010000 so it does not collide with
-- 20260928200000_estimate_line_template_archive.

CREATE TABLE IF NOT EXISTS "ServiceCatalogImport" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceLabel" TEXT NOT NULL,
    "contentSha256" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PREVIEW',
    "rowCount" INTEGER NOT NULL,
    "validCount" INTEGER NOT NULL,
    "invalidCount" INTEGER NOT NULL,
    "nameMatchCount" INTEGER NOT NULL,
    "createdByMembershipId" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "confirmedByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ServiceCatalogImport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ServiceCatalogImportRow" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "previewStatus" TEXT NOT NULL,
    "invalidReason" TEXT,
    "rowFingerprint" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "pricingMode" TEXT NOT NULL,
    "price" DECIMAL(65,30),
    "category" TEXT NOT NULL,
    "tradeCode" TEXT NOT NULL,
    "unitLabel" TEXT NOT NULL DEFAULT '',
    "recurrenceEligible" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "matchedCatalogItemId" TEXT,
    "writtenCatalogItemId" TEXT,
    "writeAction" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ServiceCatalogImportRow_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ServiceCatalogImport_businessId_contentSha256_key"
  ON "ServiceCatalogImport"("businessId", "contentSha256");
CREATE INDEX IF NOT EXISTS "ServiceCatalogImport_businessId_idx"
  ON "ServiceCatalogImport"("businessId");
CREATE INDEX IF NOT EXISTS "ServiceCatalogImport_createdByMembershipId_idx"
  ON "ServiceCatalogImport"("createdByMembershipId");
CREATE INDEX IF NOT EXISTS "ServiceCatalogImport_confirmedByMembershipId_idx"
  ON "ServiceCatalogImport"("confirmedByMembershipId");
CREATE UNIQUE INDEX IF NOT EXISTS "ServiceCatalogImportRow_importId_rowNumber_key"
  ON "ServiceCatalogImportRow"("importId", "rowNumber");
CREATE INDEX IF NOT EXISTS "ServiceCatalogImportRow_businessId_idx"
  ON "ServiceCatalogImportRow"("businessId");
CREATE INDEX IF NOT EXISTS "ServiceCatalogImportRow_importId_idx"
  ON "ServiceCatalogImportRow"("importId");
CREATE INDEX IF NOT EXISTS "ServiceCatalogImportRow_rowFingerprint_idx"
  ON "ServiceCatalogImportRow"("rowFingerprint");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ServiceCatalogImport_businessId_fkey'
  ) THEN
    ALTER TABLE "ServiceCatalogImport"
      ADD CONSTRAINT "ServiceCatalogImport_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ServiceCatalogImport_createdByMembershipId_fkey'
  ) THEN
    ALTER TABLE "ServiceCatalogImport"
      ADD CONSTRAINT "ServiceCatalogImport_createdByMembershipId_fkey"
      FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ServiceCatalogImport_confirmedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "ServiceCatalogImport"
      ADD CONSTRAINT "ServiceCatalogImport_confirmedByMembershipId_fkey"
      FOREIGN KEY ("confirmedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ServiceCatalogImportRow_businessId_fkey'
  ) THEN
    ALTER TABLE "ServiceCatalogImportRow"
      ADD CONSTRAINT "ServiceCatalogImportRow_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ServiceCatalogImportRow_importId_fkey'
  ) THEN
    ALTER TABLE "ServiceCatalogImportRow"
      ADD CONSTRAINT "ServiceCatalogImportRow_importId_fkey"
      FOREIGN KEY ("importId") REFERENCES "ServiceCatalogImport"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
