-- Explicit first-run starter-services setup completion (install or skip).
-- Additive only. Preview skips migrate, so application code uses the same
-- one-shot: add the columns and backfill rows that already existed at that
-- moment. Do not repeat UPDATE WHERE NULL after the columns exist — that
-- would mark a brand-new incomplete signup as complete.
-- Completion is not inferred from catalog item count.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Business'
      AND column_name = 'starterServicesSetupCompletedAt'
  ) THEN
    ALTER TABLE "Business" ADD COLUMN "starterServicesSetupCompletedAt" TIMESTAMP(3);
    ALTER TABLE "Business" ADD COLUMN "starterServicesSetupChoice" TEXT;
    UPDATE "Business"
    SET "starterServicesSetupCompletedAt" = "createdAt"
    WHERE "starterServicesSetupCompletedAt" IS NULL;
  END IF;
END $$;
