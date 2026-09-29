-- One root conversion Job per Estimate. Recurring occurrences, OWNER
-- next bookings, and corrective cleans copy estimateId and are excluded.
-- Nullable estimateId stays allowed (jobs with no source estimate).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT "estimateId"
      FROM "Job"
      WHERE "estimateId" IS NOT NULL
        AND "recurrenceSourceJobId" IS NULL
        AND "nextBookingSourceJobId" IS NULL
        AND "correctiveCleanSourceJobId" IS NULL
      GROUP BY "estimateId"
      HAVING COUNT(*) > 1
    ) duplicates
  ) THEN
    RAISE EXCEPTION
      'Job_estimateId_conversion_unique cannot be created: duplicate conversion jobs exist for the same estimateId';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "Job_estimateId_conversion_unique"
  ON "Job" ("estimateId")
  WHERE "estimateId" IS NOT NULL
    AND "recurrenceSourceJobId" IS NULL
    AND "nextBookingSourceJobId" IS NULL
    AND "correctiveCleanSourceJobId" IS NULL;
