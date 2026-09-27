-- Marketing Studio creator-package fields. Internal workflow only.
-- Does not publish, generate video, or connect ads/social.

ALTER TABLE "MarketingContent" ADD COLUMN "storyboardJson" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "MarketingContent" ADD COLUMN "shotListJson" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "MarketingContent" ADD COLUMN "hashtags" TEXT NOT NULL DEFAULT '';
ALTER TABLE "MarketingContent" ADD COLUMN "exportedAt" TIMESTAMP(3);
ALTER TABLE "MarketingContent" ADD COLUMN "exportedByMembershipId" TEXT;

ALTER TABLE "MarketingContent" ADD CONSTRAINT "MarketingContent_exportedByMembershipId_fkey" FOREIGN KEY ("exportedByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
