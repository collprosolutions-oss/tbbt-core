-- Additive OWNER-confirmed same-business customer merge audit.
-- Preview shares Production and skips migrate, so every statement is IF NOT EXISTS.
-- Re-running is safe. Statements are additive only. No destructive statements.
-- The absorbed customer id has no FK so that row can be deleted after relations move.
-- mergedByMembershipId is nullable with ON DELETE SET NULL so removing a
-- membership keeps the audit row.

CREATE TABLE IF NOT EXISTS "CustomerMerge" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "survivorCustomerId" TEXT NOT NULL,
    "absorbedCustomerId" TEXT NOT NULL,
    "absorbedSnapshot" JSONB NOT NULL,
    "matchReasons" TEXT NOT NULL,
    "mergedByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CustomerMerge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CustomerMerge_businessId_absorbedCustomerId_key"
  ON "CustomerMerge"("businessId", "absorbedCustomerId");
CREATE INDEX IF NOT EXISTS "CustomerMerge_businessId_idx"
  ON "CustomerMerge"("businessId");
CREATE INDEX IF NOT EXISTS "CustomerMerge_survivorCustomerId_idx"
  ON "CustomerMerge"("survivorCustomerId");
CREATE INDEX IF NOT EXISTS "CustomerMerge_absorbedCustomerId_idx"
  ON "CustomerMerge"("absorbedCustomerId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CustomerMerge_businessId_fkey'
  ) THEN
    ALTER TABLE "CustomerMerge"
      ADD CONSTRAINT "CustomerMerge_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CustomerMerge_mergedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "CustomerMerge"
      ADD CONSTRAINT "CustomerMerge_mergedByMembershipId_fkey"
      FOREIGN KEY ("mergedByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
