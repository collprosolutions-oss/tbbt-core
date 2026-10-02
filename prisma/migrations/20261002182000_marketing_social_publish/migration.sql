-- OWNER Facebook Page publish for one connected social destination.
-- Additive only. Preview shares Production and skips migrate, so every
-- statement is IF NOT EXISTS. MarketingContent.status stays
-- DRAFT | READY_FOR_REVIEW | APPROVED — this does not add a PUBLISHED
-- content status. Publish lives on MarketingSocialPublishAttempt.
-- Instagram and Google stay disconnected. Application code must claim
-- an attempt before the provider call and must never label FAILED rows
-- PUBLISHED. Timestamp is 20261002182000 so it sits after
-- 20261002050000_job_project_link.

CREATE TABLE IF NOT EXISTS "MarketingSocialDestination" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MarketingSocialDestination_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MarketingSocialDestination_businessId_destination_key"
  ON "MarketingSocialDestination"("businessId", "destination");
CREATE INDEX IF NOT EXISTS "MarketingSocialDestination_businessId_idx"
  ON "MarketingSocialDestination"("businessId");

CREATE TABLE IF NOT EXISTS "MarketingSocialPublishAttempt" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL,
    "expectedContentUpdatedAt" TIMESTAMP(3) NOT NULL,
    "destinationPageId" TEXT NOT NULL,
    "liveKey" TEXT,
    "providerPostId" TEXT,
    "providerError" TEXT,
    "failureLabel" TEXT NOT NULL DEFAULT '',
    "publishedAt" TIMESTAMP(3),
    "createdByMembershipId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MarketingSocialPublishAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MarketingSocialPublishAttempt_liveKey_key"
  ON "MarketingSocialPublishAttempt"("liveKey");
CREATE INDEX IF NOT EXISTS "MarketingSocialPublishAttempt_businessId_idx"
  ON "MarketingSocialPublishAttempt"("businessId");
CREATE INDEX IF NOT EXISTS "MarketingSocialPublishAttempt_contentId_destination_idx"
  ON "MarketingSocialPublishAttempt"("contentId", "destination");
CREATE INDEX IF NOT EXISTS "MarketingSocialPublishAttempt_businessId_contentId_destination_idx"
  ON "MarketingSocialPublishAttempt"("businessId", "contentId", "destination");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MarketingSocialDestination_businessId_fkey'
  ) THEN
    ALTER TABLE "MarketingSocialDestination"
      ADD CONSTRAINT "MarketingSocialDestination_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MarketingSocialPublishAttempt_businessId_fkey'
  ) THEN
    ALTER TABLE "MarketingSocialPublishAttempt"
      ADD CONSTRAINT "MarketingSocialPublishAttempt_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MarketingSocialPublishAttempt_contentId_fkey'
  ) THEN
    ALTER TABLE "MarketingSocialPublishAttempt"
      ADD CONSTRAINT "MarketingSocialPublishAttempt_contentId_fkey"
      FOREIGN KEY ("contentId") REFERENCES "MarketingContent"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MarketingSocialPublishAttempt_createdByMembershipId_fkey'
  ) THEN
    ALTER TABLE "MarketingSocialPublishAttempt"
      ADD CONSTRAINT "MarketingSocialPublishAttempt_createdByMembershipId_fkey"
      FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
