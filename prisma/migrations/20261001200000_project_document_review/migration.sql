-- OWNER review decision for a customer-uploaded private project document.
-- Additive only. Preview shares Production and skips migrate, so every
-- statement is IF NOT EXISTS. No StoredAsset, Job, Invoice, or
-- CustomerCommunication column changes — concurrent chats on those
-- models do not collide. No backfill. Recording a decision must never
-- publish the file, attach it to an invoice, or send a customer message.
-- Timestamp is 20261001200000 so it sits after
-- 20261001180000_job_aftercare_instruction.

CREATE TABLE IF NOT EXISTS "ProjectDocumentReview" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "storedAssetId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "decidedByMembershipId" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProjectDocumentReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProjectDocumentReview_storedAssetId_key"
  ON "ProjectDocumentReview"("storedAssetId");
CREATE INDEX IF NOT EXISTS "ProjectDocumentReview_businessId_jobId_idx"
  ON "ProjectDocumentReview"("businessId", "jobId");
CREATE INDEX IF NOT EXISTS "ProjectDocumentReview_businessId_storedAssetId_idx"
  ON "ProjectDocumentReview"("businessId", "storedAssetId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ProjectDocumentReview_businessId_fkey'
  ) THEN
    ALTER TABLE "ProjectDocumentReview"
      ADD CONSTRAINT "ProjectDocumentReview_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ProjectDocumentReview_jobId_fkey'
  ) THEN
    ALTER TABLE "ProjectDocumentReview"
      ADD CONSTRAINT "ProjectDocumentReview_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "Job"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ProjectDocumentReview_storedAssetId_fkey'
  ) THEN
    ALTER TABLE "ProjectDocumentReview"
      ADD CONSTRAINT "ProjectDocumentReview_storedAssetId_fkey"
      FOREIGN KEY ("storedAssetId") REFERENCES "StoredAsset"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ProjectDocumentReview_decidedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "ProjectDocumentReview"
      ADD CONSTRAINT "ProjectDocumentReview_decidedByMembershipId_fkey"
      FOREIGN KEY ("decidedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
