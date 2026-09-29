-- Trade-neutral OWNER warranty statements and customer-reported callbacks.
-- Additive only. New tables for this feature. Does not alter Job, Invoice,
-- Customer, CustomerCommunication, CommunicationThread, or PhoneInteraction.
-- No backfill. Existing businesses keep zero rows. No default coverage or
-- duration is stored. Timestamp 20260929003117 stays clear of
-- 20260928200000_estimate_line_template_archive.

CREATE TABLE IF NOT EXISTS "JobWarrantyTerm" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "recordedByMembershipId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JobWarrantyTerm_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "JobWarrantyCallback" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "customerId" TEXT,
    "report" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REPORTED',
    "reviewNote" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedByMembershipId" TEXT,
    "outcomeNote" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByMembershipId" TEXT,
    "recordedByMembershipId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "JobWarrantyCallback_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "JobWarrantyTerm_businessId_idx"
  ON "JobWarrantyTerm"("businessId");
CREATE INDEX IF NOT EXISTS "JobWarrantyTerm_jobId_idx"
  ON "JobWarrantyTerm"("jobId");
CREATE INDEX IF NOT EXISTS "JobWarrantyTerm_recordedByMembershipId_idx"
  ON "JobWarrantyTerm"("recordedByMembershipId");

CREATE INDEX IF NOT EXISTS "JobWarrantyCallback_businessId_idx"
  ON "JobWarrantyCallback"("businessId");
CREATE INDEX IF NOT EXISTS "JobWarrantyCallback_jobId_idx"
  ON "JobWarrantyCallback"("jobId");
CREATE INDEX IF NOT EXISTS "JobWarrantyCallback_businessId_status_idx"
  ON "JobWarrantyCallback"("businessId", "status");
CREATE INDEX IF NOT EXISTS "JobWarrantyCallback_recordedByMembershipId_idx"
  ON "JobWarrantyCallback"("recordedByMembershipId");
CREATE INDEX IF NOT EXISTS "JobWarrantyCallback_reviewedByMembershipId_idx"
  ON "JobWarrantyCallback"("reviewedByMembershipId");
CREATE INDEX IF NOT EXISTS "JobWarrantyCallback_resolvedByMembershipId_idx"
  ON "JobWarrantyCallback"("resolvedByMembershipId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobWarrantyTerm_businessId_fkey'
  ) THEN
    ALTER TABLE "JobWarrantyTerm"
      ADD CONSTRAINT "JobWarrantyTerm_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobWarrantyTerm_jobId_fkey'
  ) THEN
    ALTER TABLE "JobWarrantyTerm"
      ADD CONSTRAINT "JobWarrantyTerm_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "Job"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobWarrantyTerm_recordedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "JobWarrantyTerm"
      ADD CONSTRAINT "JobWarrantyTerm_recordedByMembershipId_fkey"
      FOREIGN KEY ("recordedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobWarrantyCallback_businessId_fkey'
  ) THEN
    ALTER TABLE "JobWarrantyCallback"
      ADD CONSTRAINT "JobWarrantyCallback_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobWarrantyCallback_jobId_fkey'
  ) THEN
    ALTER TABLE "JobWarrantyCallback"
      ADD CONSTRAINT "JobWarrantyCallback_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "Job"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobWarrantyCallback_recordedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "JobWarrantyCallback"
      ADD CONSTRAINT "JobWarrantyCallback_recordedByMembershipId_fkey"
      FOREIGN KEY ("recordedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobWarrantyCallback_reviewedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "JobWarrantyCallback"
      ADD CONSTRAINT "JobWarrantyCallback_reviewedByMembershipId_fkey"
      FOREIGN KEY ("reviewedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobWarrantyCallback_resolvedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "JobWarrantyCallback"
      ADD CONSTRAINT "JobWarrantyCallback_resolvedByMembershipId_fkey"
      FOREIGN KEY ("resolvedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
