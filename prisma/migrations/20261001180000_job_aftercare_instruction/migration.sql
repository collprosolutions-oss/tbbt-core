-- OWNER-authored aftercare instructions for a completed same-business Job.
-- Additive only. Preview shares Production and skips migrate, so every
-- statement is IF NOT EXISTS. No Job column changes — concurrent
-- Job-column chats do not collide. No backfill. Application code must
-- never send a customer message from these rows.
-- Timestamp is 20261001180000 so it sits after
-- 20261001140000_invoice_checkout_session_and_mismatch_resolved.

CREATE TABLE IF NOT EXISTS "JobAftercareInstruction" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "draftInstructions" TEXT NOT NULL DEFAULT '',
    "ownerNotes" TEXT NOT NULL DEFAULT '',
    "publishedInstructions" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdByMembershipId" TEXT NOT NULL,
    "updatedByMembershipId" TEXT,
    "publishedByMembershipId" TEXT,
    "unpublishedByMembershipId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "unpublishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "JobAftercareInstruction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "JobAftercareInstruction_jobId_key"
  ON "JobAftercareInstruction"("jobId");
CREATE INDEX IF NOT EXISTS "JobAftercareInstruction_businessId_idx"
  ON "JobAftercareInstruction"("businessId");
CREATE INDEX IF NOT EXISTS "JobAftercareInstruction_businessId_status_idx"
  ON "JobAftercareInstruction"("businessId", "status");

CREATE TABLE IF NOT EXISTS "JobAftercareEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "aftercareId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "instructionsSnapshot" TEXT,
    "actorMembershipId" TEXT NOT NULL,
    "payload" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JobAftercareEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "JobAftercareEvent_businessId_idx"
  ON "JobAftercareEvent"("businessId");
CREATE INDEX IF NOT EXISTS "JobAftercareEvent_jobId_idx"
  ON "JobAftercareEvent"("jobId");
CREATE INDEX IF NOT EXISTS "JobAftercareEvent_aftercareId_createdAt_idx"
  ON "JobAftercareEvent"("aftercareId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobAftercareInstruction_businessId_fkey'
  ) THEN
    ALTER TABLE "JobAftercareInstruction"
      ADD CONSTRAINT "JobAftercareInstruction_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobAftercareInstruction_jobId_fkey'
  ) THEN
    ALTER TABLE "JobAftercareInstruction"
      ADD CONSTRAINT "JobAftercareInstruction_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "Job"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobAftercareInstruction_createdByMembershipId_fkey'
  ) THEN
    ALTER TABLE "JobAftercareInstruction"
      ADD CONSTRAINT "JobAftercareInstruction_createdByMembershipId_fkey"
      FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobAftercareInstruction_updatedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "JobAftercareInstruction"
      ADD CONSTRAINT "JobAftercareInstruction_updatedByMembershipId_fkey"
      FOREIGN KEY ("updatedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobAftercareInstruction_publishedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "JobAftercareInstruction"
      ADD CONSTRAINT "JobAftercareInstruction_publishedByMembershipId_fkey"
      FOREIGN KEY ("publishedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobAftercareInstruction_unpublishedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "JobAftercareInstruction"
      ADD CONSTRAINT "JobAftercareInstruction_unpublishedByMembershipId_fkey"
      FOREIGN KEY ("unpublishedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobAftercareEvent_businessId_fkey'
  ) THEN
    ALTER TABLE "JobAftercareEvent"
      ADD CONSTRAINT "JobAftercareEvent_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobAftercareEvent_jobId_fkey'
  ) THEN
    ALTER TABLE "JobAftercareEvent"
      ADD CONSTRAINT "JobAftercareEvent_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "Job"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobAftercareEvent_aftercareId_fkey'
  ) THEN
    ALTER TABLE "JobAftercareEvent"
      ADD CONSTRAINT "JobAftercareEvent_aftercareId_fkey"
      FOREIGN KEY ("aftercareId") REFERENCES "JobAftercareInstruction"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobAftercareEvent_actorMembershipId_fkey'
  ) THEN
    ALTER TABLE "JobAftercareEvent"
      ADD CONSTRAINT "JobAftercareEvent_actorMembershipId_fkey"
      FOREIGN KEY ("actorMembershipId") REFERENCES "Membership"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
