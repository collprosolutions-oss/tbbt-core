-- Additive owner-intelligence schema. Preview shares Production and
-- skips migrate, so every statement is IF NOT EXISTS.

ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "firstLeadSource" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "firstCampaignId" TEXT;

ALTER TABLE "ServiceRequest" ADD COLUMN IF NOT EXISTS "leadSource" TEXT;
ALTER TABLE "ServiceRequest" ADD COLUMN IF NOT EXISTS "campaignId" TEXT;
ALTER TABLE "ServiceRequest" ADD COLUMN IF NOT EXISTS "serviceAreaQualification" TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE "ServiceRequest" ADD COLUMN IF NOT EXISTS "matchedServiceAreaId" TEXT;

ALTER TABLE "Estimate" ADD COLUMN IF NOT EXISTS "leadSource" TEXT;
ALTER TABLE "Estimate" ADD COLUMN IF NOT EXISTS "campaignId" TEXT;

ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "leadSource" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "campaignId" TEXT;

ALTER TABLE "MarketingContent" ADD COLUMN IF NOT EXISTS "campaignId" TEXT;
ALTER TABLE "MarketingContent" ADD COLUMN IF NOT EXISTS "catalogItemId" TEXT;

ALTER TABLE "ReviewRequest" ADD COLUMN IF NOT EXISTS "reminderCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ReviewRequest" ADD COLUMN IF NOT EXISTS "lastReminderAt" TIMESTAMP(3);
ALTER TABLE "ReviewRequest" ADD COLUMN IF NOT EXISTS "remindersStoppedAt" TIMESTAMP(3);
ALTER TABLE "ReviewRequest" ADD COLUMN IF NOT EXISTS "lastEmailStatus" TEXT;
ALTER TABLE "ReviewRequest" ADD COLUMN IF NOT EXISTS "lastSmsStatus" TEXT;

ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "marketingBrandVoice" TEXT;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "marketingIdentityNotes" TEXT;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "reviewGoogleUrl" TEXT;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "reviewFacebookUrl" TEXT;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "reviewOtherUrl" TEXT;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "reviewReminderMaxCount" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "seoTitleHome" TEXT;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "seoDescriptionHome" TEXT;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "seoTitleServices" TEXT;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "seoDescriptionServices" TEXT;

CREATE TABLE IF NOT EXISTS "BusinessGoal" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "recommendationKey" TEXT,
    "createdByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BusinessGoal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "BusinessActionItem" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "goalId" TEXT,
    "recommendationKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BusinessActionItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "MarketingCampaign" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL DEFAULT 'OTHER',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT NOT NULL DEFAULT '',
    "createdByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MarketingCampaign_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ServiceArea" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "city" TEXT,
    "region" TEXT,
    "postalCode" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "travelAdjustment" DECIMAL(65,30),
    "minimumAdjustment" DECIMAL(65,30),
    "notes" TEXT NOT NULL DEFAULT '',
    "createdByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ServiceArea_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ReferralRequest" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "jobId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "requestText" TEXT NOT NULL DEFAULT '',
    "notes" TEXT,
    "requestedAt" TIMESTAMP(3),
    "remindersStoppedAt" TIMESTAMP(3),
    "createdByMembershipId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReferralRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Referral" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "sourceCustomerId" TEXT NOT NULL,
    "referredCustomerId" TEXT,
    "referralRequestId" TEXT,
    "campaignId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RECORDED',
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CustomerFollowUp" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "jobId" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "notes" TEXT NOT NULL DEFAULT '',
    "cancelledAt" TIMESTAMP(3),
    "createdByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CustomerFollowUp_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BusinessGoal_businessId_idx" ON "BusinessGoal"("businessId");
CREATE INDEX IF NOT EXISTS "BusinessGoal_businessId_status_idx" ON "BusinessGoal"("businessId", "status");
CREATE INDEX IF NOT EXISTS "BusinessActionItem_businessId_idx" ON "BusinessActionItem"("businessId");
CREATE INDEX IF NOT EXISTS "BusinessActionItem_businessId_status_idx" ON "BusinessActionItem"("businessId", "status");
CREATE INDEX IF NOT EXISTS "BusinessActionItem_goalId_idx" ON "BusinessActionItem"("goalId");
CREATE INDEX IF NOT EXISTS "MarketingCampaign_businessId_idx" ON "MarketingCampaign"("businessId");
CREATE INDEX IF NOT EXISTS "MarketingCampaign_businessId_status_idx" ON "MarketingCampaign"("businessId", "status");
CREATE INDEX IF NOT EXISTS "ServiceArea_businessId_idx" ON "ServiceArea"("businessId");
CREATE INDEX IF NOT EXISTS "ServiceArea_businessId_enabled_idx" ON "ServiceArea"("businessId", "enabled");
CREATE INDEX IF NOT EXISTS "ReferralRequest_businessId_idx" ON "ReferralRequest"("businessId");
CREATE INDEX IF NOT EXISTS "ReferralRequest_businessId_status_idx" ON "ReferralRequest"("businessId", "status");
CREATE INDEX IF NOT EXISTS "ReferralRequest_customerId_idx" ON "ReferralRequest"("customerId");
CREATE INDEX IF NOT EXISTS "Referral_businessId_idx" ON "Referral"("businessId");
CREATE INDEX IF NOT EXISTS "Referral_sourceCustomerId_idx" ON "Referral"("sourceCustomerId");
CREATE INDEX IF NOT EXISTS "Referral_referredCustomerId_idx" ON "Referral"("referredCustomerId");
CREATE INDEX IF NOT EXISTS "CustomerFollowUp_businessId_idx" ON "CustomerFollowUp"("businessId");
CREATE INDEX IF NOT EXISTS "CustomerFollowUp_businessId_kind_status_idx" ON "CustomerFollowUp"("businessId", "kind", "status");
CREATE INDEX IF NOT EXISTS "CustomerFollowUp_customerId_idx" ON "CustomerFollowUp"("customerId");
CREATE INDEX IF NOT EXISTS "Customer_firstCampaignId_idx" ON "Customer"("firstCampaignId");
CREATE INDEX IF NOT EXISTS "ServiceRequest_campaignId_idx" ON "ServiceRequest"("campaignId");
CREATE INDEX IF NOT EXISTS "ServiceRequest_matchedServiceAreaId_idx" ON "ServiceRequest"("matchedServiceAreaId");
CREATE INDEX IF NOT EXISTS "Estimate_campaignId_idx" ON "Estimate"("campaignId");
CREATE INDEX IF NOT EXISTS "Job_campaignId_idx" ON "Job"("campaignId");
CREATE INDEX IF NOT EXISTS "MarketingContent_campaignId_idx" ON "MarketingContent"("campaignId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Customer_firstCampaignId_fkey') THEN
    ALTER TABLE "Customer" ADD CONSTRAINT "Customer_firstCampaignId_fkey" FOREIGN KEY ("firstCampaignId") REFERENCES "MarketingCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceRequest_campaignId_fkey') THEN
    ALTER TABLE "ServiceRequest" ADD CONSTRAINT "ServiceRequest_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceRequest_matchedServiceAreaId_fkey') THEN
    ALTER TABLE "ServiceRequest" ADD CONSTRAINT "ServiceRequest_matchedServiceAreaId_fkey" FOREIGN KEY ("matchedServiceAreaId") REFERENCES "ServiceArea"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Estimate_campaignId_fkey') THEN
    ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Job_campaignId_fkey') THEN
    ALTER TABLE "Job" ADD CONSTRAINT "Job_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MarketingContent_campaignId_fkey') THEN
    ALTER TABLE "MarketingContent" ADD CONSTRAINT "MarketingContent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BusinessGoal_businessId_fkey') THEN
    ALTER TABLE "BusinessGoal" ADD CONSTRAINT "BusinessGoal_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BusinessGoal_createdByMembershipId_fkey') THEN
    ALTER TABLE "BusinessGoal" ADD CONSTRAINT "BusinessGoal_createdByMembershipId_fkey" FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BusinessActionItem_businessId_fkey') THEN
    ALTER TABLE "BusinessActionItem" ADD CONSTRAINT "BusinessActionItem_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BusinessActionItem_goalId_fkey') THEN
    ALTER TABLE "BusinessActionItem" ADD CONSTRAINT "BusinessActionItem_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "BusinessGoal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BusinessActionItem_createdByMembershipId_fkey') THEN
    ALTER TABLE "BusinessActionItem" ADD CONSTRAINT "BusinessActionItem_createdByMembershipId_fkey" FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MarketingCampaign_businessId_fkey') THEN
    ALTER TABLE "MarketingCampaign" ADD CONSTRAINT "MarketingCampaign_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MarketingCampaign_createdByMembershipId_fkey') THEN
    ALTER TABLE "MarketingCampaign" ADD CONSTRAINT "MarketingCampaign_createdByMembershipId_fkey" FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceArea_businessId_fkey') THEN
    ALTER TABLE "ServiceArea" ADD CONSTRAINT "ServiceArea_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceArea_createdByMembershipId_fkey') THEN
    ALTER TABLE "ServiceArea" ADD CONSTRAINT "ServiceArea_createdByMembershipId_fkey" FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ReferralRequest_businessId_fkey') THEN
    ALTER TABLE "ReferralRequest" ADD CONSTRAINT "ReferralRequest_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ReferralRequest_customerId_fkey') THEN
    ALTER TABLE "ReferralRequest" ADD CONSTRAINT "ReferralRequest_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ReferralRequest_createdByMembershipId_fkey') THEN
    ALTER TABLE "ReferralRequest" ADD CONSTRAINT "ReferralRequest_createdByMembershipId_fkey" FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Referral_businessId_fkey') THEN
    ALTER TABLE "Referral" ADD CONSTRAINT "Referral_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Referral_sourceCustomerId_fkey') THEN
    ALTER TABLE "Referral" ADD CONSTRAINT "Referral_sourceCustomerId_fkey" FOREIGN KEY ("sourceCustomerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Referral_referredCustomerId_fkey') THEN
    ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referredCustomerId_fkey" FOREIGN KEY ("referredCustomerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Referral_referralRequestId_fkey') THEN
    ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referralRequestId_fkey" FOREIGN KEY ("referralRequestId") REFERENCES "ReferralRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Referral_campaignId_fkey') THEN
    ALTER TABLE "Referral" ADD CONSTRAINT "Referral_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomerFollowUp_businessId_fkey') THEN
    ALTER TABLE "CustomerFollowUp" ADD CONSTRAINT "CustomerFollowUp_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
