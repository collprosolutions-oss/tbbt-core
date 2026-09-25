-- Additive Growth Department: original-source preservation, landing-page
-- attribution, campaign cost, correction audit, and durable action requests.
-- Preview shares Production and skips migrate, so every statement is IF NOT EXISTS.
-- Re-running is safe. Statements are additive only.

ALTER TABLE "ServiceRequest" ADD COLUMN IF NOT EXISTS "originalLeadSource" TEXT;
ALTER TABLE "ServiceRequest" ADD COLUMN IF NOT EXISTS "originalCampaignId" TEXT;
ALTER TABLE "ServiceRequest" ADD COLUMN IF NOT EXISTS "landingPagePath" TEXT;
ALTER TABLE "ServiceRequest" ADD COLUMN IF NOT EXISTS "localPageSlug" TEXT;

UPDATE "ServiceRequest"
SET "originalLeadSource" = "leadSource"
WHERE "originalLeadSource" IS NULL AND "leadSource" IS NOT NULL;

UPDATE "ServiceRequest"
SET "originalCampaignId" = "campaignId"
WHERE "originalCampaignId" IS NULL AND "campaignId" IS NOT NULL;

ALTER TABLE "MarketingCampaign" ADD COLUMN IF NOT EXISTS "recordedCost" DECIMAL(65,30);

CREATE TABLE IF NOT EXISTS "LeadAttributionCorrection" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "previousLeadSource" TEXT,
    "previousCampaignId" TEXT,
    "previousLandingPagePath" TEXT,
    "newLeadSource" TEXT,
    "newCampaignId" TEXT,
    "newLandingPagePath" TEXT,
    "reason" TEXT NOT NULL DEFAULT '',
    "actorMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LeadAttributionCorrection_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "LeadAttributionCorrection_businessId_idx"
  ON "LeadAttributionCorrection"("businessId");
CREATE INDEX IF NOT EXISTS "LeadAttributionCorrection_businessId_recordType_recordId_idx"
  ON "LeadAttributionCorrection"("businessId", "recordType", "recordId");
CREATE INDEX IF NOT EXISTS "LeadAttributionCorrection_actorMembershipId_idx"
  ON "LeadAttributionCorrection"("actorMembershipId");

CREATE TABLE IF NOT EXISTS "GrowthActionRequest" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "queue" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "customerId" TEXT,
    "serviceRequestId" TEXT,
    "estimateId" TEXT,
    "jobId" TEXT,
    "campaignId" TEXT,
    "consentEligible" BOOLEAN NOT NULL DEFAULT false,
    "evidenceJson" TEXT NOT NULL DEFAULT '{}',
    "notes" TEXT NOT NULL DEFAULT '',
    "createdByMembershipId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GrowthActionRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "GrowthActionRequest_businessId_idx"
  ON "GrowthActionRequest"("businessId");
CREATE INDEX IF NOT EXISTS "GrowthActionRequest_businessId_status_idx"
  ON "GrowthActionRequest"("businessId", "status");
CREATE INDEX IF NOT EXISTS "GrowthActionRequest_businessId_queue_idx"
  ON "GrowthActionRequest"("businessId", "queue");
CREATE INDEX IF NOT EXISTS "GrowthActionRequest_customerId_idx"
  ON "GrowthActionRequest"("customerId");
CREATE INDEX IF NOT EXISTS "GrowthActionRequest_serviceRequestId_idx"
  ON "GrowthActionRequest"("serviceRequestId");
CREATE INDEX IF NOT EXISTS "GrowthActionRequest_estimateId_idx"
  ON "GrowthActionRequest"("estimateId");
CREATE INDEX IF NOT EXISTS "GrowthActionRequest_jobId_idx"
  ON "GrowthActionRequest"("jobId");
CREATE INDEX IF NOT EXISTS "GrowthActionRequest_campaignId_idx"
  ON "GrowthActionRequest"("campaignId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'LeadAttributionCorrection_businessId_fkey'
  ) THEN
    ALTER TABLE "LeadAttributionCorrection"
      ADD CONSTRAINT "LeadAttributionCorrection_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'LeadAttributionCorrection_actorMembershipId_fkey'
  ) THEN
    ALTER TABLE "LeadAttributionCorrection"
      ADD CONSTRAINT "LeadAttributionCorrection_actorMembershipId_fkey"
      FOREIGN KEY ("actorMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'GrowthActionRequest_businessId_fkey'
  ) THEN
    ALTER TABLE "GrowthActionRequest"
      ADD CONSTRAINT "GrowthActionRequest_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'GrowthActionRequest_customerId_fkey'
  ) THEN
    ALTER TABLE "GrowthActionRequest"
      ADD CONSTRAINT "GrowthActionRequest_customerId_fkey"
      FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'GrowthActionRequest_serviceRequestId_fkey'
  ) THEN
    ALTER TABLE "GrowthActionRequest"
      ADD CONSTRAINT "GrowthActionRequest_serviceRequestId_fkey"
      FOREIGN KEY ("serviceRequestId") REFERENCES "ServiceRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'GrowthActionRequest_estimateId_fkey'
  ) THEN
    ALTER TABLE "GrowthActionRequest"
      ADD CONSTRAINT "GrowthActionRequest_estimateId_fkey"
      FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'GrowthActionRequest_jobId_fkey'
  ) THEN
    ALTER TABLE "GrowthActionRequest"
      ADD CONSTRAINT "GrowthActionRequest_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'GrowthActionRequest_campaignId_fkey'
  ) THEN
    ALTER TABLE "GrowthActionRequest"
      ADD CONSTRAINT "GrowthActionRequest_campaignId_fkey"
      FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'GrowthActionRequest_createdByMembershipId_fkey'
  ) THEN
    ALTER TABLE "GrowthActionRequest"
      ADD CONSTRAINT "GrowthActionRequest_createdByMembershipId_fkey"
      FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
