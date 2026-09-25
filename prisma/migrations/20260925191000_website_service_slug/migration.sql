-- Additive stable public service slugs. Existing rows stay nullable and
-- are lazily initialized on catalog save or the next publish.
-- Preview shares Production and skips migrate, so every statement is
-- IF NOT EXISTS. Re-running is safe.

ALTER TABLE "ServiceCatalogItem" ADD COLUMN IF NOT EXISTS "websiteSlug" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "ServiceCatalogItem_businessId_websiteSlug_key"
  ON "ServiceCatalogItem"("businessId", "websiteSlug");
