-- OWNER-recorded Job milestones and append-only status history.
-- Additive only. Preview shares Production and skips migrate, so every
-- statement is IF NOT EXISTS. No backfill. Existing Jobs keep zero rows.
-- Does NOT alter the Job table — no Job-column collision with other PRs.
-- Completion is explicit; this migration never infers status from Job,
-- Invoice, or crew checklist. Timestamp is 20260929010000 so it is after
-- 20260928190000_owner_studio_reminder_sms_destination (#205).

CREATE TABLE IF NOT EXISTS "JobMilestone" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "titleKey" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "customerVisible" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "completedAt" TIMESTAMP(3),
    "completedByMembershipId" TEXT,
    "createdByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "JobMilestone_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "JobMilestoneEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "milestoneId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "actorMembershipId" TEXT,
    "payload" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JobMilestoneEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "JobMilestone_jobId_sortOrder_key"
  ON "JobMilestone"("jobId", "sortOrder");
CREATE UNIQUE INDEX IF NOT EXISTS "JobMilestone_jobId_titleKey_key"
  ON "JobMilestone"("jobId", "titleKey");
CREATE INDEX IF NOT EXISTS "JobMilestone_businessId_idx"
  ON "JobMilestone"("businessId");
CREATE INDEX IF NOT EXISTS "JobMilestone_jobId_sortOrder_idx"
  ON "JobMilestone"("jobId", "sortOrder");
CREATE INDEX IF NOT EXISTS "JobMilestone_businessId_jobId_idx"
  ON "JobMilestone"("businessId", "jobId");
CREATE INDEX IF NOT EXISTS "JobMilestoneEvent_businessId_idx"
  ON "JobMilestoneEvent"("businessId");
CREATE INDEX IF NOT EXISTS "JobMilestoneEvent_jobId_idx"
  ON "JobMilestoneEvent"("jobId");
CREATE INDEX IF NOT EXISTS "JobMilestoneEvent_milestoneId_createdAt_idx"
  ON "JobMilestoneEvent"("milestoneId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobMilestone_businessId_fkey'
  ) THEN
    ALTER TABLE "JobMilestone"
      ADD CONSTRAINT "JobMilestone_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobMilestone_jobId_fkey'
  ) THEN
    ALTER TABLE "JobMilestone"
      ADD CONSTRAINT "JobMilestone_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "Job"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobMilestone_createdByMembershipId_fkey'
  ) THEN
    ALTER TABLE "JobMilestone"
      ADD CONSTRAINT "JobMilestone_createdByMembershipId_fkey"
      FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobMilestone_completedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "JobMilestone"
      ADD CONSTRAINT "JobMilestone_completedByMembershipId_fkey"
      FOREIGN KEY ("completedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobMilestoneEvent_businessId_fkey'
  ) THEN
    ALTER TABLE "JobMilestoneEvent"
      ADD CONSTRAINT "JobMilestoneEvent_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobMilestoneEvent_jobId_fkey'
  ) THEN
    ALTER TABLE "JobMilestoneEvent"
      ADD CONSTRAINT "JobMilestoneEvent_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "Job"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobMilestoneEvent_milestoneId_fkey'
  ) THEN
    ALTER TABLE "JobMilestoneEvent"
      ADD CONSTRAINT "JobMilestoneEvent_milestoneId_fkey"
      FOREIGN KEY ("milestoneId") REFERENCES "JobMilestone"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobMilestoneEvent_actorMembershipId_fkey'
  ) THEN
    ALTER TABLE "JobMilestoneEvent"
      ADD CONSTRAINT "JobMilestoneEvent_actorMembershipId_fkey"
      FOREIGN KEY ("actorMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
