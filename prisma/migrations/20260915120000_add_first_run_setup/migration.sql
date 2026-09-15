-- Explicit first-run business setup completion.
-- Additive only. Preview skips migrate, so application code uses the same
-- one-shot: add the column and backfill rows that already existed at that
-- moment. Do not repeat UPDATE WHERE NULL after the column exists — that
-- would mark a brand-new incomplete signup as complete.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Business'
      AND column_name = 'firstRunSetupCompletedAt'
  ) THEN
    ALTER TABLE "Business" ADD COLUMN "firstRunSetupCompletedAt" TIMESTAMP(3);
    UPDATE "Business"
    SET "firstRunSetupCompletedAt" = "createdAt"
    WHERE "firstRunSetupCompletedAt" IS NULL;
  END IF;
END $$;
