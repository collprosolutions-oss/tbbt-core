-- Additive Website Engine: immutable published snapshots, current pointer,
-- gallery/review/local draft selection, and a future host-binding boundary.
-- Preview shares Production and skips migrate, so every statement is IF NOT EXISTS.
-- Re-running is safe. Statements are additive only.

CREATE TABLE IF NOT EXISTS "WebsitePublish" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PUBLISHED',
    "schemaVersion" INTEGER NOT NULL,
    "snapshotJson" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedByMembershipId" TEXT,
    "sourcePublishId" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WebsitePublish_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WebsitePublish_businessId_versionNumber_key"
  ON "WebsitePublish"("businessId", "versionNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "WebsitePublish_businessId_idempotencyKey_key"
  ON "WebsitePublish"("businessId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "WebsitePublish_businessId_publishedAt_idx"
  ON "WebsitePublish"("businessId", "publishedAt");
CREATE INDEX IF NOT EXISTS "WebsitePublish_publishedByMembershipId_idx"
  ON "WebsitePublish"("publishedByMembershipId");
CREATE INDEX IF NOT EXISTS "WebsitePublish_sourcePublishId_idx"
  ON "WebsitePublish"("sourcePublishId");

CREATE TABLE IF NOT EXISTS "WebsiteGalleryItem" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "storedAssetId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "caption" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "catalogItemId" TEXT,
    "createdByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WebsiteGalleryItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "WebsiteGalleryItem_businessId_sortOrder_idx"
  ON "WebsiteGalleryItem"("businessId", "sortOrder");
CREATE INDEX IF NOT EXISTS "WebsiteGalleryItem_storedAssetId_idx"
  ON "WebsiteGalleryItem"("storedAssetId");
CREATE INDEX IF NOT EXISTS "WebsiteGalleryItem_catalogItemId_idx"
  ON "WebsiteGalleryItem"("catalogItemId");

CREATE TABLE IF NOT EXISTS "WebsiteHostBinding" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WebsiteHostBinding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WebsiteHostBinding_hostname_key"
  ON "WebsiteHostBinding"("hostname");
CREATE INDEX IF NOT EXISTS "WebsiteHostBinding_businessId_idx"
  ON "WebsiteHostBinding"("businessId");

CREATE TABLE IF NOT EXISTS "WebsiteLocalPageDraft" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "serviceAreaId" TEXT NOT NULL,
    "catalogItemId" TEXT NOT NULL,
    "draftCopy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WebsiteLocalPageDraft_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WebsiteLocalPageDraft_businessId_serviceAreaId_catalogItemId_key"
  ON "WebsiteLocalPageDraft"("businessId", "serviceAreaId", "catalogItemId");
CREATE INDEX IF NOT EXISTS "WebsiteLocalPageDraft_businessId_idx"
  ON "WebsiteLocalPageDraft"("businessId");

ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "publishedWebsiteId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Business_publishedWebsiteId_key"
  ON "Business"("publishedWebsiteId");

ALTER TABLE "Review" ADD COLUMN IF NOT EXISTS "websiteSelected" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "seoTitleAbout" TEXT;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "seoDescriptionAbout" TEXT;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "seoTitleRequest" TEXT;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "seoDescriptionRequest" TEXT;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "websiteHeroHeadline" TEXT;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "websiteHeroSupporting" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WebsitePublish_businessId_fkey'
  ) THEN
    ALTER TABLE "WebsitePublish"
      ADD CONSTRAINT "WebsitePublish_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WebsitePublish_publishedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "WebsitePublish"
      ADD CONSTRAINT "WebsitePublish_publishedByMembershipId_fkey"
      FOREIGN KEY ("publishedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WebsitePublish_sourcePublishId_fkey'
  ) THEN
    ALTER TABLE "WebsitePublish"
      ADD CONSTRAINT "WebsitePublish_sourcePublishId_fkey"
      FOREIGN KEY ("sourcePublishId") REFERENCES "WebsitePublish"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Business_publishedWebsiteId_fkey'
  ) THEN
    ALTER TABLE "Business"
      ADD CONSTRAINT "Business_publishedWebsiteId_fkey"
      FOREIGN KEY ("publishedWebsiteId") REFERENCES "WebsitePublish"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WebsiteGalleryItem_businessId_fkey'
  ) THEN
    ALTER TABLE "WebsiteGalleryItem"
      ADD CONSTRAINT "WebsiteGalleryItem_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WebsiteGalleryItem_storedAssetId_fkey'
  ) THEN
    ALTER TABLE "WebsiteGalleryItem"
      ADD CONSTRAINT "WebsiteGalleryItem_storedAssetId_fkey"
      FOREIGN KEY ("storedAssetId") REFERENCES "StoredAsset"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WebsiteGalleryItem_catalogItemId_fkey'
  ) THEN
    ALTER TABLE "WebsiteGalleryItem"
      ADD CONSTRAINT "WebsiteGalleryItem_catalogItemId_fkey"
      FOREIGN KEY ("catalogItemId") REFERENCES "ServiceCatalogItem"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WebsiteGalleryItem_createdByMembershipId_fkey'
  ) THEN
    ALTER TABLE "WebsiteGalleryItem"
      ADD CONSTRAINT "WebsiteGalleryItem_createdByMembershipId_fkey"
      FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WebsiteHostBinding_businessId_fkey'
  ) THEN
    ALTER TABLE "WebsiteHostBinding"
      ADD CONSTRAINT "WebsiteHostBinding_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WebsiteLocalPageDraft_businessId_fkey'
  ) THEN
    ALTER TABLE "WebsiteLocalPageDraft"
      ADD CONSTRAINT "WebsiteLocalPageDraft_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WebsiteLocalPageDraft_serviceAreaId_fkey'
  ) THEN
    ALTER TABLE "WebsiteLocalPageDraft"
      ADD CONSTRAINT "WebsiteLocalPageDraft_serviceAreaId_fkey"
      FOREIGN KEY ("serviceAreaId") REFERENCES "ServiceArea"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'WebsiteLocalPageDraft_catalogItemId_fkey'
  ) THEN
    ALTER TABLE "WebsiteLocalPageDraft"
      ADD CONSTRAINT "WebsiteLocalPageDraft_catalogItemId_fkey"
      FOREIGN KEY ("catalogItemId") REFERENCES "ServiceCatalogItem"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
