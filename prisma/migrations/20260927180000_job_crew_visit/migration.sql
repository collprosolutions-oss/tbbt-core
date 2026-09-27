-- Additive Cleaning recurring-visit + crew-checklist field record.
-- Cadence remains on existing Job recurrence columns.
-- Preview shares Production and may skip migrate, so every statement is IF NOT EXISTS.
-- Additive only. No table or column removals. No new columns on Business, Membership, or Job.
-- Concurrent Network uses 20260927150000 (Business/Membership relations).
-- Concurrent multi-location is expected to add location columns/relations on
-- Business / Job / Membership; rebase that work onto this JobCrewVisit model
-- and its Business/Job/Membership/OperatingProcedure relation sites.

CREATE TABLE IF NOT EXISTS "JobCrewVisit" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "procedureId" TEXT,
    "checklistJson" TEXT NOT NULL DEFAULT '[]',
    "outcomeStatus" TEXT NOT NULL DEFAULT 'NONE',
    "outcomeRecordedAt" TIMESTAMP(3),
    "outcomeRecordedByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "JobCrewVisit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "JobCrewVisit_jobId_key" ON "JobCrewVisit"("jobId");
CREATE INDEX IF NOT EXISTS "JobCrewVisit_businessId_idx" ON "JobCrewVisit"("businessId");
CREATE INDEX IF NOT EXISTS "JobCrewVisit_jobId_idx" ON "JobCrewVisit"("jobId");
CREATE INDEX IF NOT EXISTS "JobCrewVisit_businessId_outcomeStatus_idx" ON "JobCrewVisit"("businessId", "outcomeStatus");
CREATE INDEX IF NOT EXISTS "JobCrewVisit_procedureId_idx" ON "JobCrewVisit"("procedureId");
CREATE INDEX IF NOT EXISTS "JobCrewVisit_outcomeRecordedByMembershipId_idx" ON "JobCrewVisit"("outcomeRecordedByMembershipId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobCrewVisit_businessId_fkey'
  ) THEN
    ALTER TABLE "JobCrewVisit"
      ADD CONSTRAINT "JobCrewVisit_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobCrewVisit_jobId_fkey'
  ) THEN
    ALTER TABLE "JobCrewVisit"
      ADD CONSTRAINT "JobCrewVisit_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "Job"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobCrewVisit_procedureId_fkey'
  ) THEN
    ALTER TABLE "JobCrewVisit"
      ADD CONSTRAINT "JobCrewVisit_procedureId_fkey"
      FOREIGN KEY ("procedureId") REFERENCES "OperatingProcedure"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobCrewVisit_outcomeRecordedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "JobCrewVisit"
      ADD CONSTRAINT "JobCrewVisit_outcomeRecordedByMembershipId_fkey"
      FOREIGN KEY ("outcomeRecordedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
