-- Structured customer-reported issue on a completed same-business Job.
-- Additive only. Preview shares Production and skips migrate, so every
-- statement is IF NOT EXISTS. No Job column changes — concurrent
-- Job-column chats do not collide. No backfill. Application code must
-- never send a customer message from these rows, never write a
-- JobCallback for the same event, and never invent warranty coverage.
-- Timestamp is 20261002180000 so it sits after
-- 20261002050000_job_project_link. Do not reuse that timestamp.

CREATE TABLE IF NOT EXISTS "JobCustomerIssue" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "customerId" TEXT,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "reportedVia" TEXT NOT NULL,
    "preferredContact" TEXT,
    "customerVisibleStatus" TEXT NOT NULL DEFAULT 'RECEIVED',
    "decision" TEXT,
    "ownerNotes" TEXT NOT NULL DEFAULT '',
    "recordedByMembershipId" TEXT NOT NULL,
    "reviewedByMembershipId" TEXT,
    "decidedByMembershipId" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "JobCustomerIssue_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "JobCustomerIssue_businessId_idx"
  ON "JobCustomerIssue"("businessId");
CREATE INDEX IF NOT EXISTS "JobCustomerIssue_jobId_idx"
  ON "JobCustomerIssue"("jobId");
CREATE INDEX IF NOT EXISTS "JobCustomerIssue_businessId_customerVisibleStatus_idx"
  ON "JobCustomerIssue"("businessId", "customerVisibleStatus");
CREATE INDEX IF NOT EXISTS "JobCustomerIssue_customerId_idx"
  ON "JobCustomerIssue"("customerId");
CREATE UNIQUE INDEX IF NOT EXISTS "JobCustomerIssue_one_open_per_job"
  ON "JobCustomerIssue"("jobId")
  WHERE "customerVisibleStatus" IN ('RECEIVED', 'IN_REVIEW');

CREATE TABLE IF NOT EXISTS "JobCustomerIssueEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "fromCustomerVisibleStatus" TEXT,
    "toCustomerVisibleStatus" TEXT NOT NULL,
    "actorMembershipId" TEXT NOT NULL,
    "payload" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JobCustomerIssueEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "JobCustomerIssueEvent_businessId_idx"
  ON "JobCustomerIssueEvent"("businessId");
CREATE INDEX IF NOT EXISTS "JobCustomerIssueEvent_jobId_idx"
  ON "JobCustomerIssueEvent"("jobId");
CREATE INDEX IF NOT EXISTS "JobCustomerIssueEvent_issueId_createdAt_idx"
  ON "JobCustomerIssueEvent"("issueId", "createdAt");

CREATE TABLE IF NOT EXISTS "JobCustomerIssueAttachment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "storedAssetId" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JobCustomerIssueAttachment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "JobCustomerIssueAttachment_issueId_storedAssetId_key"
  ON "JobCustomerIssueAttachment"("issueId", "storedAssetId");
CREATE INDEX IF NOT EXISTS "JobCustomerIssueAttachment_businessId_idx"
  ON "JobCustomerIssueAttachment"("businessId");
CREATE INDEX IF NOT EXISTS "JobCustomerIssueAttachment_jobId_idx"
  ON "JobCustomerIssueAttachment"("jobId");
CREATE INDEX IF NOT EXISTS "JobCustomerIssueAttachment_storedAssetId_idx"
  ON "JobCustomerIssueAttachment"("storedAssetId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobCustomerIssue_businessId_fkey'
  ) THEN
    ALTER TABLE "JobCustomerIssue"
      ADD CONSTRAINT "JobCustomerIssue_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobCustomerIssue_jobId_fkey'
  ) THEN
    ALTER TABLE "JobCustomerIssue"
      ADD CONSTRAINT "JobCustomerIssue_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "Job"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobCustomerIssue_customerId_fkey'
  ) THEN
    ALTER TABLE "JobCustomerIssue"
      ADD CONSTRAINT "JobCustomerIssue_customerId_fkey"
      FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobCustomerIssue_recordedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "JobCustomerIssue"
      ADD CONSTRAINT "JobCustomerIssue_recordedByMembershipId_fkey"
      FOREIGN KEY ("recordedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobCustomerIssue_reviewedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "JobCustomerIssue"
      ADD CONSTRAINT "JobCustomerIssue_reviewedByMembershipId_fkey"
      FOREIGN KEY ("reviewedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobCustomerIssue_decidedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "JobCustomerIssue"
      ADD CONSTRAINT "JobCustomerIssue_decidedByMembershipId_fkey"
      FOREIGN KEY ("decidedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobCustomerIssueEvent_businessId_fkey'
  ) THEN
    ALTER TABLE "JobCustomerIssueEvent"
      ADD CONSTRAINT "JobCustomerIssueEvent_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobCustomerIssueEvent_jobId_fkey'
  ) THEN
    ALTER TABLE "JobCustomerIssueEvent"
      ADD CONSTRAINT "JobCustomerIssueEvent_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "Job"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobCustomerIssueEvent_issueId_fkey'
  ) THEN
    ALTER TABLE "JobCustomerIssueEvent"
      ADD CONSTRAINT "JobCustomerIssueEvent_issueId_fkey"
      FOREIGN KEY ("issueId") REFERENCES "JobCustomerIssue"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobCustomerIssueEvent_actorMembershipId_fkey'
  ) THEN
    ALTER TABLE "JobCustomerIssueEvent"
      ADD CONSTRAINT "JobCustomerIssueEvent_actorMembershipId_fkey"
      FOREIGN KEY ("actorMembershipId") REFERENCES "Membership"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobCustomerIssueAttachment_businessId_fkey'
  ) THEN
    ALTER TABLE "JobCustomerIssueAttachment"
      ADD CONSTRAINT "JobCustomerIssueAttachment_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobCustomerIssueAttachment_jobId_fkey'
  ) THEN
    ALTER TABLE "JobCustomerIssueAttachment"
      ADD CONSTRAINT "JobCustomerIssueAttachment_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "Job"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobCustomerIssueAttachment_issueId_fkey'
  ) THEN
    ALTER TABLE "JobCustomerIssueAttachment"
      ADD CONSTRAINT "JobCustomerIssueAttachment_issueId_fkey"
      FOREIGN KEY ("issueId") REFERENCES "JobCustomerIssue"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobCustomerIssueAttachment_storedAssetId_fkey'
  ) THEN
    ALTER TABLE "JobCustomerIssueAttachment"
      ADD CONSTRAINT "JobCustomerIssueAttachment_storedAssetId_fkey"
      FOREIGN KEY ("storedAssetId") REFERENCES "StoredAsset"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
