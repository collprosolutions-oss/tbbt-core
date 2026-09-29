-- OWNER-recorded customer-reported callback against a completed Job.
-- Additive only. Preview shares Production and skips migrate, so every
-- statement is IF NOT EXISTS. No backfill. Existing businesses keep zero rows.
-- Does not invoice, schedule a Job, or message a customer.
-- Timestamp is 20260929010900 so it does not collide with
-- 20260928200000_estimate_line_template_archive (#210).

CREATE TABLE IF NOT EXISTS "JobCallback" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "customerId" TEXT,
    "description" TEXT NOT NULL,
    "reportedVia" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECORDED',
    "outcome" TEXT,
    "outcomeNotes" TEXT,
    "recordedByMembershipId" TEXT NOT NULL,
    "reviewedByMembershipId" TEXT,
    "outcomeByMembershipId" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "outcomeAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "JobCallback_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "JobCallbackEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "callbackId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "actorMembershipId" TEXT NOT NULL,
    "payload" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JobCallbackEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "JobCallback_businessId_idx"
  ON "JobCallback"("businessId");
CREATE INDEX IF NOT EXISTS "JobCallback_jobId_idx"
  ON "JobCallback"("jobId");
CREATE INDEX IF NOT EXISTS "JobCallback_businessId_status_idx"
  ON "JobCallback"("businessId", "status");
CREATE INDEX IF NOT EXISTS "JobCallback_customerId_idx"
  ON "JobCallback"("customerId");
CREATE UNIQUE INDEX IF NOT EXISTS "JobCallback_open_job_key"
  ON "JobCallback"("businessId", "jobId")
  WHERE "status" IN ('RECORDED', 'UNDER_REVIEW');

CREATE INDEX IF NOT EXISTS "JobCallbackEvent_businessId_idx"
  ON "JobCallbackEvent"("businessId");
CREATE INDEX IF NOT EXISTS "JobCallbackEvent_callbackId_createdAt_idx"
  ON "JobCallbackEvent"("callbackId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobCallback_businessId_fkey'
  ) THEN
    ALTER TABLE "JobCallback"
      ADD CONSTRAINT "JobCallback_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobCallback_jobId_fkey'
  ) THEN
    ALTER TABLE "JobCallback"
      ADD CONSTRAINT "JobCallback_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "Job"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobCallback_customerId_fkey'
  ) THEN
    ALTER TABLE "JobCallback"
      ADD CONSTRAINT "JobCallback_customerId_fkey"
      FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobCallback_recordedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "JobCallback"
      ADD CONSTRAINT "JobCallback_recordedByMembershipId_fkey"
      FOREIGN KEY ("recordedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobCallback_reviewedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "JobCallback"
      ADD CONSTRAINT "JobCallback_reviewedByMembershipId_fkey"
      FOREIGN KEY ("reviewedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobCallback_outcomeByMembershipId_fkey'
  ) THEN
    ALTER TABLE "JobCallback"
      ADD CONSTRAINT "JobCallback_outcomeByMembershipId_fkey"
      FOREIGN KEY ("outcomeByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobCallbackEvent_businessId_fkey'
  ) THEN
    ALTER TABLE "JobCallbackEvent"
      ADD CONSTRAINT "JobCallbackEvent_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobCallbackEvent_callbackId_fkey'
  ) THEN
    ALTER TABLE "JobCallbackEvent"
      ADD CONSTRAINT "JobCallbackEvent_callbackId_fkey"
      FOREIGN KEY ("callbackId") REFERENCES "JobCallback"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobCallbackEvent_actorMembershipId_fkey'
  ) THEN
    ALTER TABLE "JobCallbackEvent"
      ADD CONSTRAINT "JobCallbackEvent_actorMembershipId_fkey"
      FOREIGN KEY ("actorMembershipId") REFERENCES "Membership"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
