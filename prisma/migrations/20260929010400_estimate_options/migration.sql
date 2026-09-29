-- OWNER-authored priced alternatives on DRAFT estimates.
-- Additive only. Preview shares Production and skips migrate, so every
-- statement is IF NOT EXISTS. No backfill. Existing estimates keep zero
-- option rows and null option FKs — single-option send/approve/job
-- behavior is unchanged.
-- Timestamp is 20260929010400 so it does not collide with
-- 20260928200000_estimate_line_template_archive (#210) or the
-- 20260929010000–20260929010300 slots used by #213–#216.

CREATE TABLE IF NOT EXISTS "EstimateOption" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EstimateOption_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "EstimateVersionOption" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "estimateVersionId" TEXT NOT NULL,
    "sourceOptionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "total" DECIMAL(65,30) NOT NULL,
    "laborMinimumAdjustment" DECIMAL(65,30) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EstimateVersionOption_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "EstimateOption_estimateId_sortOrder_key"
  ON "EstimateOption"("estimateId", "sortOrder");
CREATE INDEX IF NOT EXISTS "EstimateOption_businessId_idx"
  ON "EstimateOption"("businessId");
CREATE INDEX IF NOT EXISTS "EstimateOption_estimateId_idx"
  ON "EstimateOption"("estimateId");

CREATE UNIQUE INDEX IF NOT EXISTS "EstimateVersionOption_estimateVersionId_sortOrder_key"
  ON "EstimateVersionOption"("estimateVersionId", "sortOrder");
CREATE INDEX IF NOT EXISTS "EstimateVersionOption_businessId_idx"
  ON "EstimateVersionOption"("businessId");
CREATE INDEX IF NOT EXISTS "EstimateVersionOption_estimateVersionId_idx"
  ON "EstimateVersionOption"("estimateVersionId");

ALTER TABLE "Estimate" ADD COLUMN IF NOT EXISTS "approvedOptionId" TEXT;
ALTER TABLE "LineItem" ADD COLUMN IF NOT EXISTS "optionId" TEXT;
ALTER TABLE "EstimateVersionLineItem" ADD COLUMN IF NOT EXISTS "optionId" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "approvedEstimateOptionId" TEXT;

CREATE INDEX IF NOT EXISTS "LineItem_optionId_idx" ON "LineItem"("optionId");
CREATE INDEX IF NOT EXISTS "EstimateVersionLineItem_optionId_idx"
  ON "EstimateVersionLineItem"("optionId");
CREATE INDEX IF NOT EXISTS "Estimate_approvedOptionId_idx"
  ON "Estimate"("approvedOptionId");
CREATE INDEX IF NOT EXISTS "Job_approvedEstimateOptionId_idx"
  ON "Job"("approvedEstimateOptionId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'EstimateOption_businessId_fkey'
  ) THEN
    ALTER TABLE "EstimateOption"
      ADD CONSTRAINT "EstimateOption_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'EstimateOption_estimateId_fkey'
  ) THEN
    ALTER TABLE "EstimateOption"
      ADD CONSTRAINT "EstimateOption_estimateId_fkey"
      FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'EstimateVersionOption_businessId_fkey'
  ) THEN
    ALTER TABLE "EstimateVersionOption"
      ADD CONSTRAINT "EstimateVersionOption_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'EstimateVersionOption_estimateVersionId_fkey'
  ) THEN
    ALTER TABLE "EstimateVersionOption"
      ADD CONSTRAINT "EstimateVersionOption_estimateVersionId_fkey"
      FOREIGN KEY ("estimateVersionId") REFERENCES "EstimateVersion"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Estimate_approvedOptionId_fkey'
  ) THEN
    ALTER TABLE "Estimate"
      ADD CONSTRAINT "Estimate_approvedOptionId_fkey"
      FOREIGN KEY ("approvedOptionId") REFERENCES "EstimateVersionOption"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'LineItem_optionId_fkey'
  ) THEN
    ALTER TABLE "LineItem"
      ADD CONSTRAINT "LineItem_optionId_fkey"
      FOREIGN KEY ("optionId") REFERENCES "EstimateOption"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'EstimateVersionLineItem_optionId_fkey'
  ) THEN
    ALTER TABLE "EstimateVersionLineItem"
      ADD CONSTRAINT "EstimateVersionLineItem_optionId_fkey"
      FOREIGN KEY ("optionId") REFERENCES "EstimateVersionOption"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Job_approvedEstimateOptionId_fkey'
  ) THEN
    ALTER TABLE "Job"
      ADD CONSTRAINT "Job_approvedEstimateOptionId_fkey"
      FOREIGN KEY ("approvedEstimateOptionId") REFERENCES "EstimateVersionOption"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
