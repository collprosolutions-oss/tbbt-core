-- Worker time-correction requests with frozen original/proposed times
-- and an append-only OWNER decision. Additive only. Preview shares
-- Production and skips migrate, so every statement is IF NOT EXISTS.
-- Does not rewrite TimeEntry, TimesheetWeek, or PayrollRun rows.
-- Timestamp is 20260929010100 so it stays after
-- 20260928200000_estimate_line_template_archive (#210) and avoids the
-- 20260929010000 collision used by other open PRs.

CREATE TABLE IF NOT EXISTS "TimeCorrectionRequest" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "timeEntryId" TEXT NOT NULL,
    "requestedByMembershipId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL,
    "originalStartedAt" TIMESTAMP(3) NOT NULL,
    "originalEndedAt" TIMESTAMP(3) NOT NULL,
    "proposedStartedAt" TIMESTAMP(3) NOT NULL,
    "proposedEndedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimeCorrectionRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TimeCorrectionDecision" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "actorMembershipId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimeCorrectionDecision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TimeCorrectionRequest_businessId_idx"
  ON "TimeCorrectionRequest"("businessId");

CREATE INDEX IF NOT EXISTS "TimeCorrectionRequest_timeEntryId_idx"
  ON "TimeCorrectionRequest"("timeEntryId");

CREATE INDEX IF NOT EXISTS "TimeCorrectionRequest_businessId_status_idx"
  ON "TimeCorrectionRequest"("businessId", "status");

CREATE INDEX IF NOT EXISTS "TimeCorrectionRequest_requestedByMembershipId_idx"
  ON "TimeCorrectionRequest"("requestedByMembershipId");

CREATE UNIQUE INDEX IF NOT EXISTS "TimeCorrectionRequest_timeEntryId_pending_key"
  ON "TimeCorrectionRequest" ("timeEntryId")
  WHERE status = 'PENDING';

CREATE UNIQUE INDEX IF NOT EXISTS "TimeCorrectionDecision_requestId_key"
  ON "TimeCorrectionDecision"("requestId");

CREATE INDEX IF NOT EXISTS "TimeCorrectionDecision_businessId_idx"
  ON "TimeCorrectionDecision"("businessId");

CREATE INDEX IF NOT EXISTS "TimeCorrectionDecision_actorMembershipId_idx"
  ON "TimeCorrectionDecision"("actorMembershipId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'TimeCorrectionRequest_businessId_fkey'
  ) THEN
    ALTER TABLE "TimeCorrectionRequest"
      ADD CONSTRAINT "TimeCorrectionRequest_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'TimeCorrectionRequest_timeEntryId_fkey'
  ) THEN
    ALTER TABLE "TimeCorrectionRequest"
      ADD CONSTRAINT "TimeCorrectionRequest_timeEntryId_fkey"
      FOREIGN KEY ("timeEntryId") REFERENCES "TimeEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'TimeCorrectionRequest_requestedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "TimeCorrectionRequest"
      ADD CONSTRAINT "TimeCorrectionRequest_requestedByMembershipId_fkey"
      FOREIGN KEY ("requestedByMembershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'TimeCorrectionDecision_businessId_fkey'
  ) THEN
    ALTER TABLE "TimeCorrectionDecision"
      ADD CONSTRAINT "TimeCorrectionDecision_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'TimeCorrectionDecision_requestId_fkey'
  ) THEN
    ALTER TABLE "TimeCorrectionDecision"
      ADD CONSTRAINT "TimeCorrectionDecision_requestId_fkey"
      FOREIGN KEY ("requestId") REFERENCES "TimeCorrectionRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'TimeCorrectionDecision_actorMembershipId_fkey'
  ) THEN
    ALTER TABLE "TimeCorrectionDecision"
      ADD CONSTRAINT "TimeCorrectionDecision_actorMembershipId_fkey"
      FOREIGN KEY ("actorMembershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
