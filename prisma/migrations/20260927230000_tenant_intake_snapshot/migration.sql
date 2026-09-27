-- Additive OWNER-reviewed tenant intake snapshots.
-- Preview shares Production and skips migrate, so every statement is IF NOT EXISTS.
-- Immutable published rows. Historical ServiceRequest snapshots and archived
-- Cleaning public V1/V2 / Handyman V1 are never rewritten from this table.

CREATE TABLE IF NOT EXISTS "TenantIntakeSnapshot" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "tradeCode" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PUBLISHED',
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "snapshotJson" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedByMembershipId" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TenantIntakeSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TenantIntakeSnapshot_businessId_tradeCode_versionNumber_key"
  ON "TenantIntakeSnapshot"("businessId", "tradeCode", "versionNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "TenantIntakeSnapshot_businessId_tradeCode_idempotencyKey_key"
  ON "TenantIntakeSnapshot"("businessId", "tradeCode", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "TenantIntakeSnapshot_businessId_idx"
  ON "TenantIntakeSnapshot"("businessId");
CREATE INDEX IF NOT EXISTS "TenantIntakeSnapshot_businessId_tradeCode_idx"
  ON "TenantIntakeSnapshot"("businessId", "tradeCode");
CREATE INDEX IF NOT EXISTS "TenantIntakeSnapshot_publishedByMembershipId_idx"
  ON "TenantIntakeSnapshot"("publishedByMembershipId");

ALTER TABLE "BusinessTrade"
  ADD COLUMN IF NOT EXISTS "publishedIntakeSnapshotId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "BusinessTrade_publishedIntakeSnapshotId_key"
  ON "BusinessTrade"("publishedIntakeSnapshotId");

ALTER TABLE "ServiceRequest"
  ADD COLUMN IF NOT EXISTS "tenantIntakeSnapshotId" TEXT;
ALTER TABLE "ServiceRequest"
  ADD COLUMN IF NOT EXISTS "tenantIntakeSnapshotVersion" INTEGER;

CREATE INDEX IF NOT EXISTS "ServiceRequest_businessId_tenantIntakeSnapshotId_idx"
  ON "ServiceRequest"("businessId", "tenantIntakeSnapshotId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'TenantIntakeSnapshot_businessId_fkey'
  ) THEN
    ALTER TABLE "TenantIntakeSnapshot"
      ADD CONSTRAINT "TenantIntakeSnapshot_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'TenantIntakeSnapshot_publishedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "TenantIntakeSnapshot"
      ADD CONSTRAINT "TenantIntakeSnapshot_publishedByMembershipId_fkey"
      FOREIGN KEY ("publishedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessTrade_publishedIntakeSnapshotId_fkey'
  ) THEN
    ALTER TABLE "BusinessTrade"
      ADD CONSTRAINT "BusinessTrade_publishedIntakeSnapshotId_fkey"
      FOREIGN KEY ("publishedIntakeSnapshotId") REFERENCES "TenantIntakeSnapshot"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
