-- One OWNER-created next booking per completed source Job.
-- Additive unique index on the existing nullable recurrenceSourceJobId.
-- Multiple NULL values remain allowed (one-time jobs without a source).

CREATE UNIQUE INDEX IF NOT EXISTS "Job_recurrenceSourceJobId_key"
ON "Job"("recurrenceSourceJobId");
