-- Dedicated unique occurrence key for OWNER-managed Cleaning recurring bookings.
-- Distinct from nextBookingSourceJobId and correctiveCleanSourceJobId.
-- Job.recurrenceSourceJobId stays nonunique so later occurrences can share a source.

ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "recurrenceOccurrenceKey" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Job_recurrenceOccurrenceKey_key"
ON "Job"("recurrenceOccurrenceKey");
