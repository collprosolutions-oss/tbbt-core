-- Worker-requested reassignment of one currently assigned upcoming job.
-- Additive only. Preview shares Production and skips migrate, so every
-- statement is IF NOT EXISTS. Pending requests do not change Job
-- assignment or schedule. Only OWNER accept unassigns through the
-- canonical assignment write. Decline leaves the job unchanged.
-- These rows never send customer messages.
-- Timestamp is 20261001194700 so it stays unique and after
-- 20261001180000_job_aftercare_instruction. Do not reuse
-- 20261001180000, 20261001190000, or other wave PR timestamps.

CREATE TABLE IF NOT EXISTS "JobReassignmentRequest" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedByMembershipId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "JobReassignmentRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "JobReassignmentRequest_businessId_status_idx"
  ON "JobReassignmentRequest"("businessId", "status");
CREATE INDEX IF NOT EXISTS "JobReassignmentRequest_jobId_idx"
  ON "JobReassignmentRequest"("jobId");
CREATE INDEX IF NOT EXISTS "JobReassignmentRequest_membershipId_idx"
  ON "JobReassignmentRequest"("membershipId");
CREATE INDEX IF NOT EXISTS "JobReassignmentRequest_decidedByMembershipId_idx"
  ON "JobReassignmentRequest"("decidedByMembershipId");

CREATE UNIQUE INDEX IF NOT EXISTS "JobReassignmentRequest_pending_jobId_key"
  ON "JobReassignmentRequest"("jobId")
  WHERE "status" = 'PENDING';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'JobReassignmentRequest_businessId_fkey'
  ) THEN
    ALTER TABLE "JobReassignmentRequest"
      ADD CONSTRAINT "JobReassignmentRequest_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'JobReassignmentRequest_jobId_fkey'
  ) THEN
    ALTER TABLE "JobReassignmentRequest"
      ADD CONSTRAINT "JobReassignmentRequest_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'JobReassignmentRequest_membershipId_fkey'
  ) THEN
    ALTER TABLE "JobReassignmentRequest"
      ADD CONSTRAINT "JobReassignmentRequest_membershipId_fkey"
      FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'JobReassignmentRequest_decidedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "JobReassignmentRequest"
      ADD CONSTRAINT "JobReassignmentRequest_decidedByMembershipId_fkey"
      FOREIGN KEY ("decidedByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
