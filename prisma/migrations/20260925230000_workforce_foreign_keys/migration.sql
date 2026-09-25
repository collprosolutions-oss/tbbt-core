-- Additive foreign keys, indexes, and outreach idempotency.
-- Production migrate is the source of truth. Request paths never run this DDL.
-- Existing Workforce rows are preserved. This file is additive only.

ALTER TABLE "WorkforceOutreachTask" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

UPDATE "WorkforceOutreachTask"
SET "idempotencyKey" = 'legacy:' || "id"
WHERE "idempotencyKey" IS NULL OR "idempotencyKey" = '';

DO $$
BEGIN
  ALTER TABLE "WorkforceOutreachTask" ALTER COLUMN "idempotencyKey" SET NOT NULL;
EXCEPTION
  WHEN others THEN
    NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "WorkforceOutreachTask_businessId_idempotencyKey_key"
  ON "WorkforceOutreachTask"("businessId", "idempotencyKey");

CREATE INDEX IF NOT EXISTS "MembershipSkill_membershipId_idx" ON "MembershipSkill"("membershipId");
CREATE INDEX IF NOT EXISTS "MembershipWeeklyAvailability_membershipId_idx"
  ON "MembershipWeeklyAvailability"("membershipId");
CREATE INDEX IF NOT EXISTS "MembershipAvailabilityException_membershipId_idx"
  ON "MembershipAvailabilityException"("membershipId");
CREATE INDEX IF NOT EXISTS "WorkforceOutreachTask_createdByMembershipId_idx"
  ON "WorkforceOutreachTask"("createdByMembershipId");
CREATE INDEX IF NOT EXISTS "WorkforceOutreachTask_approvedByMembershipId_idx"
  ON "WorkforceOutreachTask"("approvedByMembershipId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MembershipSkill_businessId_fkey') THEN
    ALTER TABLE "MembershipSkill"
      ADD CONSTRAINT "MembershipSkill_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MembershipSkill_membershipId_fkey') THEN
    ALTER TABLE "MembershipSkill"
      ADD CONSTRAINT "MembershipSkill_membershipId_fkey"
      FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MembershipWeeklyAvailability_businessId_fkey') THEN
    ALTER TABLE "MembershipWeeklyAvailability"
      ADD CONSTRAINT "MembershipWeeklyAvailability_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MembershipWeeklyAvailability_membershipId_fkey') THEN
    ALTER TABLE "MembershipWeeklyAvailability"
      ADD CONSTRAINT "MembershipWeeklyAvailability_membershipId_fkey"
      FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MembershipAvailabilityException_businessId_fkey') THEN
    ALTER TABLE "MembershipAvailabilityException"
      ADD CONSTRAINT "MembershipAvailabilityException_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MembershipAvailabilityException_membershipId_fkey') THEN
    ALTER TABLE "MembershipAvailabilityException"
      ADD CONSTRAINT "MembershipAvailabilityException_membershipId_fkey"
      FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FillInBenchWorker_businessId_fkey') THEN
    ALTER TABLE "FillInBenchWorker"
      ADD CONSTRAINT "FillInBenchWorker_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FillInBenchWorker_membershipId_fkey') THEN
    ALTER TABLE "FillInBenchWorker"
      ADD CONSTRAINT "FillInBenchWorker_membershipId_fkey"
      FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WorkforceOutreachTask_businessId_fkey') THEN
    ALTER TABLE "WorkforceOutreachTask"
      ADD CONSTRAINT "WorkforceOutreachTask_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WorkforceOutreachTask_jobId_fkey') THEN
    ALTER TABLE "WorkforceOutreachTask"
      ADD CONSTRAINT "WorkforceOutreachTask_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WorkforceOutreachTask_benchWorkerId_fkey') THEN
    ALTER TABLE "WorkforceOutreachTask"
      ADD CONSTRAINT "WorkforceOutreachTask_benchWorkerId_fkey"
      FOREIGN KEY ("benchWorkerId") REFERENCES "FillInBenchWorker"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WorkforceOutreachTask_createdByMembershipId_fkey') THEN
    ALTER TABLE "WorkforceOutreachTask"
      ADD CONSTRAINT "WorkforceOutreachTask_createdByMembershipId_fkey"
      FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WorkforceOutreachTask_approvedByMembershipId_fkey') THEN
    ALTER TABLE "WorkforceOutreachTask"
      ADD CONSTRAINT "WorkforceOutreachTask_approvedByMembershipId_fkey"
      FOREIGN KEY ("approvedByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
