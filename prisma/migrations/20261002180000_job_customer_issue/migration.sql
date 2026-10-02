-- Structured customer-reported issue on a completed same-business Job.
-- ONE queue: reuse JobCallback. Additive only. Preview shares Production
-- and skips migrate, so every statement is IF NOT EXISTS. No Job column
-- changes — concurrent Job-column chats do not collide. No backfill.
-- Application code must never send a customer message from these rows,
-- never invent a second callback queue, and never invent warranty
-- coverage. Timestamp is 20261002180000 so it sits after
-- 20261002050000_job_project_link. Do not reuse that timestamp.

ALTER TABLE "JobCallback"
  ADD COLUMN IF NOT EXISTS "category" TEXT;

ALTER TABLE "JobCallback"
  ADD COLUMN IF NOT EXISTS "ownerNotes" TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS "JobCallbackAttachment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "callbackId" TEXT NOT NULL,
    "storedAssetId" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JobCallbackAttachment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "JobCallbackAttachment_callbackId_storedAssetId_key"
  ON "JobCallbackAttachment"("callbackId", "storedAssetId");
CREATE INDEX IF NOT EXISTS "JobCallbackAttachment_businessId_idx"
  ON "JobCallbackAttachment"("businessId");
CREATE INDEX IF NOT EXISTS "JobCallbackAttachment_jobId_idx"
  ON "JobCallbackAttachment"("jobId");
CREATE INDEX IF NOT EXISTS "JobCallbackAttachment_storedAssetId_idx"
  ON "JobCallbackAttachment"("storedAssetId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobCallbackAttachment_businessId_fkey'
  ) THEN
    ALTER TABLE "JobCallbackAttachment"
      ADD CONSTRAINT "JobCallbackAttachment_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobCallbackAttachment_jobId_fkey'
  ) THEN
    ALTER TABLE "JobCallbackAttachment"
      ADD CONSTRAINT "JobCallbackAttachment_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "Job"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobCallbackAttachment_callbackId_fkey'
  ) THEN
    ALTER TABLE "JobCallbackAttachment"
      ADD CONSTRAINT "JobCallbackAttachment_callbackId_fkey"
      FOREIGN KEY ("callbackId") REFERENCES "JobCallback"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobCallbackAttachment_storedAssetId_fkey'
  ) THEN
    ALTER TABLE "JobCallbackAttachment"
      ADD CONSTRAINT "JobCallbackAttachment_storedAssetId_fkey"
      FOREIGN KEY ("storedAssetId") REFERENCES "StoredAsset"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
