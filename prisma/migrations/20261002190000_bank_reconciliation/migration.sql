-- OWNER-reviewed bank CSV workspace. Additive only. Preview shares
-- Production and skips migrate, so every statement is IF NOT EXISTS.
-- Import never creates a Payment, never changes an Invoice, never writes
-- InvoiceCredit, and never marks banking CONNECTED or a verified balance.
-- Timestamp is 20261002190000 so it sits after 20261002050000_job_project_link.

CREATE TABLE IF NOT EXISTS "BankReconciliationImport" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceLabel" TEXT NOT NULL,
    "contentSha256" TEXT NOT NULL,
    "sourceBytes" BYTEA NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REVIEW',
    "rowCount" INTEGER NOT NULL,
    "depositCount" INTEGER NOT NULL,
    "withdrawalCount" INTEGER NOT NULL,
    "unmatchedCount" INTEGER NOT NULL,
    "candidateMatchCount" INTEGER NOT NULL,
    "duplicateRowCount" INTEGER NOT NULL,
    "reversedCount" INTEGER NOT NULL,
    "invalidCount" INTEGER NOT NULL,
    "createdByMembershipId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BankReconciliationImport_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BankReconciliationImport_businessId_contentSha256_key"
  ON "BankReconciliationImport"("businessId", "contentSha256");
CREATE INDEX IF NOT EXISTS "BankReconciliationImport_businessId_idx"
  ON "BankReconciliationImport"("businessId");
CREATE INDEX IF NOT EXISTS "BankReconciliationImport_createdByMembershipId_idx"
  ON "BankReconciliationImport"("createdByMembershipId");

CREATE TABLE IF NOT EXISTS "BankReconciliationRow" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "postedOn" TEXT,
    "description" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "direction" TEXT NOT NULL,
    "rowFingerprint" TEXT NOT NULL,
    "rawLine" TEXT NOT NULL,
    "reviewStatus" TEXT NOT NULL,
    "invalidReason" TEXT,
    "reversalOfRowNumber" INTEGER,
    "duplicateOfRowNumber" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BankReconciliationRow_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BankReconciliationRow_importId_rowNumber_key"
  ON "BankReconciliationRow"("importId", "rowNumber");
CREATE INDEX IF NOT EXISTS "BankReconciliationRow_businessId_idx"
  ON "BankReconciliationRow"("businessId");
CREATE INDEX IF NOT EXISTS "BankReconciliationRow_importId_idx"
  ON "BankReconciliationRow"("importId");
CREATE INDEX IF NOT EXISTS "BankReconciliationRow_rowFingerprint_idx"
  ON "BankReconciliationRow"("rowFingerprint");

CREATE TABLE IF NOT EXISTS "BankReconciliationMatch" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "rowId" TEXT NOT NULL,
    "candidateKind" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "matchReason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUGGESTED',
    "decidedAt" TIMESTAMP(3),
    "decidedByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BankReconciliationMatch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BankReconciliationMatch_rowId_candidateKind_candidateId_key"
  ON "BankReconciliationMatch"("rowId", "candidateKind", "candidateId");
CREATE INDEX IF NOT EXISTS "BankReconciliationMatch_businessId_idx"
  ON "BankReconciliationMatch"("businessId");
CREATE INDEX IF NOT EXISTS "BankReconciliationMatch_importId_idx"
  ON "BankReconciliationMatch"("importId");
CREATE INDEX IF NOT EXISTS "BankReconciliationMatch_rowId_idx"
  ON "BankReconciliationMatch"("rowId");
CREATE INDEX IF NOT EXISTS "BankReconciliationMatch_importId_candidateKind_candidateId_idx"
  ON "BankReconciliationMatch"("importId", "candidateKind", "candidateId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BankReconciliationImport_businessId_fkey'
  ) THEN
    ALTER TABLE "BankReconciliationImport"
      ADD CONSTRAINT "BankReconciliationImport_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BankReconciliationImport_createdByMembershipId_fkey'
  ) THEN
    ALTER TABLE "BankReconciliationImport"
      ADD CONSTRAINT "BankReconciliationImport_createdByMembershipId_fkey"
      FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BankReconciliationRow_businessId_fkey'
  ) THEN
    ALTER TABLE "BankReconciliationRow"
      ADD CONSTRAINT "BankReconciliationRow_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BankReconciliationRow_importId_fkey'
  ) THEN
    ALTER TABLE "BankReconciliationRow"
      ADD CONSTRAINT "BankReconciliationRow_importId_fkey"
      FOREIGN KEY ("importId") REFERENCES "BankReconciliationImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BankReconciliationMatch_businessId_fkey'
  ) THEN
    ALTER TABLE "BankReconciliationMatch"
      ADD CONSTRAINT "BankReconciliationMatch_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BankReconciliationMatch_importId_fkey'
  ) THEN
    ALTER TABLE "BankReconciliationMatch"
      ADD CONSTRAINT "BankReconciliationMatch_importId_fkey"
      FOREIGN KEY ("importId") REFERENCES "BankReconciliationImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BankReconciliationMatch_rowId_fkey'
  ) THEN
    ALTER TABLE "BankReconciliationMatch"
      ADD CONSTRAINT "BankReconciliationMatch_rowId_fkey"
      FOREIGN KEY ("rowId") REFERENCES "BankReconciliationRow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BankReconciliationMatch_decidedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "BankReconciliationMatch"
      ADD CONSTRAINT "BankReconciliationMatch_decidedByMembershipId_fkey"
      FOREIGN KEY ("decidedByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
