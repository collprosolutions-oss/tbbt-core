-- Additive Business Location foundation.
-- Preview shares Production and skips migrate, so every statement is IF NOT EXISTS.
-- No backfill. Existing businesses keep zero locations.
-- Does not write Business.timezone, Stripe accounts, ServiceArea rows,
-- or assign historical Jobs. Job.businessLocationId is nullable.
-- Separate from Network (20260927150000_bsos_network_participation)
-- and Cleaning visit workflow (20260927180000_job_crew_visit).

CREATE TABLE IF NOT EXISTS "BusinessLocation" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "addressLine1" TEXT NOT NULL DEFAULT '',
    "addressLine2" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "region" TEXT NOT NULL DEFAULT '',
    "postalCode" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BusinessLocation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BusinessLocation_businessId_idx"
  ON "BusinessLocation"("businessId");
CREATE INDEX IF NOT EXISTS "BusinessLocation_businessId_status_idx"
  ON "BusinessLocation"("businessId", "status");

ALTER TABLE "Job"
  ADD COLUMN IF NOT EXISTS "businessLocationId" TEXT;

CREATE INDEX IF NOT EXISTS "Job_businessLocationId_idx"
  ON "Job"("businessLocationId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessLocation_businessId_fkey'
  ) THEN
    ALTER TABLE "BusinessLocation"
      ADD CONSTRAINT "BusinessLocation_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessLocation_createdByMembershipId_fkey'
  ) THEN
    ALTER TABLE "BusinessLocation"
      ADD CONSTRAINT "BusinessLocation_createdByMembershipId_fkey"
      FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Job_businessLocationId_fkey'
  ) THEN
    ALTER TABLE "Job"
      ADD CONSTRAINT "Job_businessLocationId_fkey"
      FOREIGN KEY ("businessLocationId") REFERENCES "BusinessLocation"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
