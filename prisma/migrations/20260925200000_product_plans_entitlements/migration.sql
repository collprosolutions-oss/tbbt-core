-- Additive product-plan identity and entitlement sources.
-- Preview shares Production and skips migrate, so every statement is IF NOT EXISTS.
-- Existing BusinessSaasSubscription rows are preserved. No DROP/TRUNCATE.

ALTER TABLE "BusinessSaasSubscription" ADD COLUMN IF NOT EXISTS "planCode" TEXT;

CREATE INDEX IF NOT EXISTS "BusinessSaasSubscription_planCode_idx"
  ON "BusinessSaasSubscription"("planCode");

-- Historical SaaS rows are Founder-era. Compatibility also resolves null
-- at read time; this backfill makes the stored identity durable.
UPDATE "BusinessSaasSubscription"
SET "planCode" = 'FOUNDER'
WHERE "planCode" IS NULL;

CREATE TABLE IF NOT EXISTS "BusinessProductAddon" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "addonCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'INACTIVE',
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT NOT NULL DEFAULT 'SUPPORT',
    "providerRef" TEXT,
    "grantedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BusinessProductAddon_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BusinessProductAddon_businessId_addonCode_key"
  ON "BusinessProductAddon"("businessId", "addonCode");
CREATE INDEX IF NOT EXISTS "BusinessProductAddon_businessId_status_idx"
  ON "BusinessProductAddon"("businessId", "status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessProductAddon_businessId_fkey'
  ) THEN
    ALTER TABLE "BusinessProductAddon"
      ADD CONSTRAINT "BusinessProductAddon_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "BusinessProductGrant" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "grantType" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "quantity" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "source" TEXT NOT NULL DEFAULT 'SUPPORT',
    "note" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BusinessProductGrant_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BusinessProductGrant_businessId_status_idx"
  ON "BusinessProductGrant"("businessId", "status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessProductGrant_businessId_fkey'
  ) THEN
    ALTER TABLE "BusinessProductGrant"
      ADD CONSTRAINT "BusinessProductGrant_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
