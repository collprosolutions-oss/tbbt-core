-- Explicit first-run public website setup completion (save or skip), plus
-- the smallest tenant-scoped service-area label for /hire/[slug].
-- Additive only. Preview skips migrate, so application code uses the same
-- one-shot: add the completion columns and backfill rows that already
-- existed at that moment. Do not repeat UPDATE WHERE NULL after the
-- columns exist — that would mark a brand-new incomplete signup as complete.
-- Completion is not inferred from About copy or service-area text.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Business'
      AND column_name = 'websiteSetupCompletedAt'
  ) THEN
    ALTER TABLE "Business" ADD COLUMN "websiteSetupCompletedAt" TIMESTAMP(3);
    ALTER TABLE "Business" ADD COLUMN "websiteSetupChoice" TEXT;
    UPDATE "Business"
    SET "websiteSetupCompletedAt" = "createdAt"
    WHERE "websiteSetupCompletedAt" IS NULL;
  END IF;
END $$;

ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "publicServiceAreaLabel" TEXT;
