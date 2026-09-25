-- Additive Multi-Trade Core + Cleaning-ready architecture.
-- Preview shares Production and skips migrate, so every statement is IF NOT EXISTS.
-- Re-running is safe: backfills use WHERE NOT EXISTS / COALESCE no-ops.
-- Statements are additive only.

CREATE TABLE IF NOT EXISTS "BusinessTrade" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "tradeCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "configOverridesJson" TEXT NOT NULL DEFAULT '{}',
    "intakeSchemaVersion" INTEGER NOT NULL DEFAULT 1,
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BusinessTrade_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BusinessTrade_businessId_tradeCode_key"
  ON "BusinessTrade"("businessId", "tradeCode");
CREATE INDEX IF NOT EXISTS "BusinessTrade_businessId_idx" ON "BusinessTrade"("businessId");
CREATE INDEX IF NOT EXISTS "BusinessTrade_tradeCode_idx" ON "BusinessTrade"("tradeCode");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessTrade_businessId_fkey'
  ) THEN
    ALTER TABLE "BusinessTrade"
      ADD CONSTRAINT "BusinessTrade_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Compatibility backfill: every existing Business gets exactly one
-- business_trades row from Business.tradeCode. This is the deterministic
-- tradeCode → business_trades transition. New writers treat BusinessTrade
-- as authority and sync tradeCode as a projection of the primary ACTIVE row.
INSERT INTO "BusinessTrade" (
  "id",
  "businessId",
  "tradeCode",
  "status",
  "configOverridesJson",
  "intakeSchemaVersion",
  "activatedAt",
  "createdAt",
  "updatedAt"
)
SELECT
  'bt_' || b."id",
  b."id",
  COALESCE(NULLIF(b."tradeCode", ''), 'HANDYMAN'),
  'ACTIVE',
  '{}',
  1,
  COALESCE(b."createdAt", CURRENT_TIMESTAMP),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Business" b
WHERE NOT EXISTS (
  SELECT 1
  FROM "BusinessTrade" t
  WHERE t."businessId" = b."id"
    AND t."tradeCode" = COALESCE(NULLIF(b."tradeCode", ''), 'HANDYMAN')
);

ALTER TABLE "ServiceCatalogItem" ADD COLUMN IF NOT EXISTS "tradeCode" TEXT NOT NULL DEFAULT 'HANDYMAN';
ALTER TABLE "ServiceCatalogItem" ADD COLUMN IF NOT EXISTS "recurrenceEligible" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ServiceCatalogItem" ADD COLUMN IF NOT EXISTS "unitLabel" TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS "ServiceCatalogItem_businessId_tradeCode_idx"
  ON "ServiceCatalogItem"("businessId", "tradeCode");

-- Existing catalog rows inherit the business compatibility tradeCode so
-- Handyman services stay Handyman. Cleaning is never inserted here.
UPDATE "ServiceCatalogItem" AS item
SET "tradeCode" = COALESCE(NULLIF(b."tradeCode", ''), 'HANDYMAN')
FROM "Business" AS b
WHERE item."businessId" = b."id"
  AND item."tradeCode" = 'HANDYMAN'
  AND COALESCE(NULLIF(b."tradeCode", ''), 'HANDYMAN') <> 'HANDYMAN';

ALTER TABLE "ServiceRequest" ADD COLUMN IF NOT EXISTS "tradeCode" TEXT NOT NULL DEFAULT 'HANDYMAN';
ALTER TABLE "ServiceRequest" ADD COLUMN IF NOT EXISTS "intakeSchemaKey" TEXT;
ALTER TABLE "ServiceRequest" ADD COLUMN IF NOT EXISTS "intakeSchemaVersion" INTEGER;
ALTER TABLE "ServiceRequest" ADD COLUMN IF NOT EXISTS "intakeSchemaJson" TEXT;
ALTER TABLE "ServiceRequest" ADD COLUMN IF NOT EXISTS "intakeAnswersJson" TEXT;
ALTER TABLE "ServiceRequest" ADD COLUMN IF NOT EXISTS "serviceIntent" TEXT NOT NULL DEFAULT 'ONE_TIME';
ALTER TABLE "ServiceRequest" ADD COLUMN IF NOT EXISTS "recurrenceCadence" TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS "ServiceRequest_businessId_tradeCode_idx"
  ON "ServiceRequest"("businessId", "tradeCode");

-- Historical requests freeze Handyman public intake v1. Later trade-config
-- changes must not reinterpret these rows. JSON snapshot is applied by
-- application code from the archived schema key+version when null.
UPDATE "ServiceRequest" AS req
SET
  "tradeCode" = COALESCE(NULLIF(b."tradeCode", ''), 'HANDYMAN'),
  "intakeSchemaKey" = COALESCE(req."intakeSchemaKey", 'handyman.public'),
  "intakeSchemaVersion" = COALESCE(req."intakeSchemaVersion", 1),
  "serviceIntent" = COALESCE(NULLIF(req."serviceIntent", ''), 'ONE_TIME')
FROM "Business" AS b
WHERE req."businessId" = b."id"
  AND req."intakeSchemaKey" IS NULL;

ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "serviceIntent" TEXT NOT NULL DEFAULT 'ONE_TIME';
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "recurrenceCadence" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "recurrenceSourceJobId" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "nextOccurrenceAt" TIMESTAMP(3);
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "recurrenceStatus" TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS "Job_recurrenceSourceJobId_idx" ON "Job"("recurrenceSourceJobId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Job_recurrenceSourceJobId_fkey'
  ) THEN
    ALTER TABLE "Job"
      ADD CONSTRAINT "Job_recurrenceSourceJobId_fkey"
      FOREIGN KEY ("recurrenceSourceJobId") REFERENCES "Job"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
