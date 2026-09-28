-- Dedicated unique source link for OWNER-created Cleaning next bookings.
-- Job.recurrenceSourceJobId stays nonunique so later occurrences can share a source.

ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "nextBookingSourceJobId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Job_nextBookingSourceJobId_key"
ON "Job"("nextBookingSourceJobId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Job_nextBookingSourceJobId_fkey'
  ) THEN
    ALTER TABLE "Job"
      ADD CONSTRAINT "Job_nextBookingSourceJobId_fkey"
      FOREIGN KEY ("nextBookingSourceJobId") REFERENCES "Job"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
