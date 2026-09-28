-- Dedicated unique source link for OWNER-scheduled corrective Cleaning jobs
-- after a RE_CLEAN_REQUESTED visit. Distinct from nextBookingSourceJobId.
-- Job.recurrenceSourceJobId stays nonunique so later occurrences can share a source.

ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "correctiveCleanSourceJobId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Job_correctiveCleanSourceJobId_key"
ON "Job"("correctiveCleanSourceJobId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Job_correctiveCleanSourceJobId_fkey'
  ) THEN
    ALTER TABLE "Job"
      ADD CONSTRAINT "Job_correctiveCleanSourceJobId_fkey"
      FOREIGN KEY ("correctiveCleanSourceJobId") REFERENCES "Job"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
