-- Additive OWNER-reviewed external lead import preview/confirm tables.
-- Preview shares Production and skips migrate, so every statement is IF NOT EXISTS.
-- Re-running is safe. Statements are additive only. No destructive statements.

CREATE TABLE IF NOT EXISTS "ExternalLeadImport" (
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
    CONSTRAINT "ExternalLeadImport_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ExternalLeadImport_businessId_contentSha256_key"
  ON "ExternalLeadImport"("businessId", "contentSha256");
CREATE INDEX IF NOT EXISTS "ExternalLeadImport_businessId_idx"
  ON "ExternalLeadImport"("businessId");
CREATE INDEX IF NOT EXISTS "ExternalLeadImport_createdByMembershipId_idx"
  ON "ExternalLeadImport"("createdByMembershipId");
CREATE INDEX IF NOT EXISTS "ExternalLeadImport_confirmedByMembershipId_idx"
  ON "ExternalLeadImport"("confirmedByMembershipId");

CREATE TABLE IF NOT EXISTS "ExternalLeadImportRow" (
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
    "summary" TEXT,
    "notes" TEXT,
    "streetAddress" TEXT,
    "unit" TEXT,
    "city" TEXT,
    "region" TEXT,
    "postalCode" TEXT,
    "leadSource" TEXT NOT NULL,
    "possibleDuplicateCustomerId" TEXT,
    "possibleDuplicateRequestId" TEXT,
    "createdRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExternalLeadImportRow_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ExternalLeadImportRow_importId_rowNumber_key"
  ON "ExternalLeadImportRow"("importId", "rowNumber");
CREATE INDEX IF NOT EXISTS "ExternalLeadImportRow_businessId_idx"
  ON "ExternalLeadImportRow"("businessId");
CREATE INDEX IF NOT EXISTS "ExternalLeadImportRow_importId_idx"
  ON "ExternalLeadImportRow"("importId");
CREATE INDEX IF NOT EXISTS "ExternalLeadImportRow_rowFingerprint_idx"
  ON "ExternalLeadImportRow"("rowFingerprint");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ExternalLeadImport_businessId_fkey'
  ) THEN
    ALTER TABLE "ExternalLeadImport"
      ADD CONSTRAINT "ExternalLeadImport_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ExternalLeadImport_createdByMembershipId_fkey'
  ) THEN
    ALTER TABLE "ExternalLeadImport"
      ADD CONSTRAINT "ExternalLeadImport_createdByMembershipId_fkey"
      FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ExternalLeadImport_confirmedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "ExternalLeadImport"
      ADD CONSTRAINT "ExternalLeadImport_confirmedByMembershipId_fkey"
      FOREIGN KEY ("confirmedByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ExternalLeadImportRow_businessId_fkey'
  ) THEN
    ALTER TABLE "ExternalLeadImportRow"
      ADD CONSTRAINT "ExternalLeadImportRow_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ExternalLeadImportRow_importId_fkey'
  ) THEN
    ALTER TABLE "ExternalLeadImportRow"
      ADD CONSTRAINT "ExternalLeadImportRow_importId_fkey"
      FOREIGN KEY ("importId") REFERENCES "ExternalLeadImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
