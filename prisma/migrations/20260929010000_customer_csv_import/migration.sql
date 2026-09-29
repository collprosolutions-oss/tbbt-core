-- Additive OWNER-reviewed existing-customer CSV import preview/confirm tables.
-- Preview shares Production and skips migrate, so every statement is IF NOT EXISTS.
-- Re-running is safe. Statements are additive only. No destructive statements.

CREATE TABLE IF NOT EXISTS "CustomerCsvImport" (
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
    "possibleDuplicateCount" INTEGER NOT NULL,
    "createdByMembershipId" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "confirmedByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CustomerCsvImport_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CustomerCsvImport_businessId_contentSha256_key"
  ON "CustomerCsvImport"("businessId", "contentSha256");
CREATE INDEX IF NOT EXISTS "CustomerCsvImport_businessId_idx"
  ON "CustomerCsvImport"("businessId");
CREATE INDEX IF NOT EXISTS "CustomerCsvImport_createdByMembershipId_idx"
  ON "CustomerCsvImport"("createdByMembershipId");
CREATE INDEX IF NOT EXISTS "CustomerCsvImport_confirmedByMembershipId_idx"
  ON "CustomerCsvImport"("confirmedByMembershipId");

CREATE TABLE IF NOT EXISTS "CustomerCsvImportRow" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "previewStatus" TEXT NOT NULL,
    "invalidReason" TEXT,
    "rowFingerprint" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "propertyLabel" TEXT,
    "streetAddress" TEXT,
    "unit" TEXT,
    "city" TEXT,
    "region" TEXT,
    "postalCode" TEXT,
    "possibleDuplicateCustomerId" TEXT,
    "createdCustomerId" TEXT,
    "createdPropertyId" TEXT,
    "reusedExistingCustomer" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CustomerCsvImportRow_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CustomerCsvImportRow_importId_rowNumber_key"
  ON "CustomerCsvImportRow"("importId", "rowNumber");
CREATE INDEX IF NOT EXISTS "CustomerCsvImportRow_businessId_idx"
  ON "CustomerCsvImportRow"("businessId");
CREATE INDEX IF NOT EXISTS "CustomerCsvImportRow_importId_idx"
  ON "CustomerCsvImportRow"("importId");
CREATE INDEX IF NOT EXISTS "CustomerCsvImportRow_rowFingerprint_idx"
  ON "CustomerCsvImportRow"("rowFingerprint");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CustomerCsvImport_businessId_fkey'
  ) THEN
    ALTER TABLE "CustomerCsvImport"
      ADD CONSTRAINT "CustomerCsvImport_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CustomerCsvImport_createdByMembershipId_fkey'
  ) THEN
    ALTER TABLE "CustomerCsvImport"
      ADD CONSTRAINT "CustomerCsvImport_createdByMembershipId_fkey"
      FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CustomerCsvImport_confirmedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "CustomerCsvImport"
      ADD CONSTRAINT "CustomerCsvImport_confirmedByMembershipId_fkey"
      FOREIGN KEY ("confirmedByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CustomerCsvImportRow_businessId_fkey'
  ) THEN
    ALTER TABLE "CustomerCsvImportRow"
      ADD CONSTRAINT "CustomerCsvImportRow_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CustomerCsvImportRow_importId_fkey'
  ) THEN
    ALTER TABLE "CustomerCsvImportRow"
      ADD CONSTRAINT "CustomerCsvImportRow_importId_fkey"
      FOREIGN KEY ("importId") REFERENCES "CustomerCsvImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
