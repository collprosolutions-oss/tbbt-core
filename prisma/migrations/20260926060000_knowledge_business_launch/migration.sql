-- Additive Knowledge Hub expansion + Business Launch Experience.
-- Preview shares Production and skips migrate, so every statement is IF NOT EXISTS.

ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "businessStage" TEXT;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "pricingApproach" TEXT;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "teamStructureNotes" TEXT;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "paymentPreferenceNotes" TEXT;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "schedulingPreferenceNotes" TEXT;

ALTER TABLE "KnowledgeEntry" ADD COLUMN IF NOT EXISTS "knowledgeKind" TEXT;
ALTER TABLE "KnowledgeEntry" ADD COLUMN IF NOT EXISTS "approvalState" TEXT NOT NULL DEFAULT 'UNREVIEWED';
ALTER TABLE "KnowledgeEntry" ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMP(3);
ALTER TABLE "KnowledgeEntry" ADD COLUMN IF NOT EXISTS "approvedByMembershipId" TEXT;

CREATE TABLE IF NOT EXISTS "BusinessLaunchProgress" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "lastStepKey" TEXT,
    "resumeLaterAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BusinessLaunchProgress_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "BusinessLaunchStep" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "progressId" TEXT NOT NULL,
    "stepKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "completedAt" TIMESTAMP(3),
    "skippedAt" TIMESTAMP(3),
    "deferredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BusinessLaunchStep_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CompanySetupProposal" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "createdByMembershipId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "inputText" TEXT NOT NULL,
    "proposalSummary" TEXT NOT NULL DEFAULT '',
    "interactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CompanySetupProposal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CompanySetupProposalItem" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "appliedAt" TIMESTAMP(3),
    "appliedRecordKind" TEXT,
    "appliedRecordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CompanySetupProposalItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "OperatingProcedure" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "tradeCode" TEXT,
    "serviceCatalogItemId" TEXT,
    "jobType" TEXT,
    "knowledgeEntryId" TEXT,
    "approvalState" TEXT NOT NULL DEFAULT 'UNREVIEWED',
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdByMembershipId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OperatingProcedure_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "OperatingProcedureStep" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "procedureId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "required" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OperatingProcedureStep_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ExperienceLearningCandidate" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "evidenceJson" TEXT NOT NULL DEFAULT '{}',
    "evidenceKey" TEXT NOT NULL,
    "sourceKind" TEXT,
    "sourceReferenceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CANDIDATE',
    "confidence" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "reviewedAt" TIMESTAMP(3),
    "reviewedByMembershipId" TEXT,
    "knowledgeEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExperienceLearningCandidate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BusinessLaunchProgress_businessId_key" ON "BusinessLaunchProgress"("businessId");
CREATE INDEX IF NOT EXISTS "BusinessLaunchStep_businessId_idx" ON "BusinessLaunchStep"("businessId");
CREATE INDEX IF NOT EXISTS "BusinessLaunchStep_progressId_idx" ON "BusinessLaunchStep"("progressId");
CREATE UNIQUE INDEX IF NOT EXISTS "BusinessLaunchStep_businessId_stepKey_key" ON "BusinessLaunchStep"("businessId", "stepKey");

CREATE INDEX IF NOT EXISTS "CompanySetupProposal_businessId_idx" ON "CompanySetupProposal"("businessId");
CREATE INDEX IF NOT EXISTS "CompanySetupProposal_businessId_status_idx" ON "CompanySetupProposal"("businessId", "status");
CREATE INDEX IF NOT EXISTS "CompanySetupProposalItem_businessId_idx" ON "CompanySetupProposalItem"("businessId");
CREATE INDEX IF NOT EXISTS "CompanySetupProposalItem_proposalId_idx" ON "CompanySetupProposalItem"("proposalId");

CREATE INDEX IF NOT EXISTS "OperatingProcedure_businessId_idx" ON "OperatingProcedure"("businessId");
CREATE INDEX IF NOT EXISTS "OperatingProcedure_businessId_archived_idx" ON "OperatingProcedure"("businessId", "archived");
CREATE INDEX IF NOT EXISTS "OperatingProcedure_serviceCatalogItemId_idx" ON "OperatingProcedure"("serviceCatalogItemId");
CREATE INDEX IF NOT EXISTS "OperatingProcedure_knowledgeEntryId_idx" ON "OperatingProcedure"("knowledgeEntryId");
CREATE INDEX IF NOT EXISTS "OperatingProcedureStep_businessId_idx" ON "OperatingProcedureStep"("businessId");
CREATE INDEX IF NOT EXISTS "OperatingProcedureStep_procedureId_sortOrder_idx" ON "OperatingProcedureStep"("procedureId", "sortOrder");

CREATE UNIQUE INDEX IF NOT EXISTS "ExperienceLearningCandidate_businessId_kind_evidenceKey_key" ON "ExperienceLearningCandidate"("businessId", "kind", "evidenceKey");
CREATE INDEX IF NOT EXISTS "ExperienceLearningCandidate_businessId_idx" ON "ExperienceLearningCandidate"("businessId");
CREATE INDEX IF NOT EXISTS "ExperienceLearningCandidate_businessId_status_idx" ON "ExperienceLearningCandidate"("businessId", "status");

CREATE INDEX IF NOT EXISTS "KnowledgeEntry_businessId_approvalState_idx" ON "KnowledgeEntry"("businessId", "approvalState");
CREATE INDEX IF NOT EXISTS "KnowledgeEntry_businessId_knowledgeKind_idx" ON "KnowledgeEntry"("businessId", "knowledgeKind");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgeEntry_approvedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "KnowledgeEntry"
      ADD CONSTRAINT "KnowledgeEntry_approvedByMembershipId_fkey"
      FOREIGN KEY ("approvedByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessLaunchProgress_businessId_fkey'
  ) THEN
    ALTER TABLE "BusinessLaunchProgress"
      ADD CONSTRAINT "BusinessLaunchProgress_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessLaunchProgress_createdByMembershipId_fkey'
  ) THEN
    ALTER TABLE "BusinessLaunchProgress"
      ADD CONSTRAINT "BusinessLaunchProgress_createdByMembershipId_fkey"
      FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessLaunchStep_businessId_fkey'
  ) THEN
    ALTER TABLE "BusinessLaunchStep"
      ADD CONSTRAINT "BusinessLaunchStep_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessLaunchStep_progressId_fkey'
  ) THEN
    ALTER TABLE "BusinessLaunchStep"
      ADD CONSTRAINT "BusinessLaunchStep_progressId_fkey"
      FOREIGN KEY ("progressId") REFERENCES "BusinessLaunchProgress"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CompanySetupProposal_businessId_fkey'
  ) THEN
    ALTER TABLE "CompanySetupProposal"
      ADD CONSTRAINT "CompanySetupProposal_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CompanySetupProposal_createdByMembershipId_fkey'
  ) THEN
    ALTER TABLE "CompanySetupProposal"
      ADD CONSTRAINT "CompanySetupProposal_createdByMembershipId_fkey"
      FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CompanySetupProposalItem_businessId_fkey'
  ) THEN
    ALTER TABLE "CompanySetupProposalItem"
      ADD CONSTRAINT "CompanySetupProposalItem_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CompanySetupProposalItem_proposalId_fkey'
  ) THEN
    ALTER TABLE "CompanySetupProposalItem"
      ADD CONSTRAINT "CompanySetupProposalItem_proposalId_fkey"
      FOREIGN KEY ("proposalId") REFERENCES "CompanySetupProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OperatingProcedure_businessId_fkey'
  ) THEN
    ALTER TABLE "OperatingProcedure"
      ADD CONSTRAINT "OperatingProcedure_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OperatingProcedure_createdByMembershipId_fkey'
  ) THEN
    ALTER TABLE "OperatingProcedure"
      ADD CONSTRAINT "OperatingProcedure_createdByMembershipId_fkey"
      FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OperatingProcedure_serviceCatalogItemId_fkey'
  ) THEN
    ALTER TABLE "OperatingProcedure"
      ADD CONSTRAINT "OperatingProcedure_serviceCatalogItemId_fkey"
      FOREIGN KEY ("serviceCatalogItemId") REFERENCES "ServiceCatalogItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OperatingProcedure_knowledgeEntryId_fkey'
  ) THEN
    ALTER TABLE "OperatingProcedure"
      ADD CONSTRAINT "OperatingProcedure_knowledgeEntryId_fkey"
      FOREIGN KEY ("knowledgeEntryId") REFERENCES "KnowledgeEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OperatingProcedureStep_businessId_fkey'
  ) THEN
    ALTER TABLE "OperatingProcedureStep"
      ADD CONSTRAINT "OperatingProcedureStep_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OperatingProcedureStep_procedureId_fkey'
  ) THEN
    ALTER TABLE "OperatingProcedureStep"
      ADD CONSTRAINT "OperatingProcedureStep_procedureId_fkey"
      FOREIGN KEY ("procedureId") REFERENCES "OperatingProcedure"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ExperienceLearningCandidate_businessId_fkey'
  ) THEN
    ALTER TABLE "ExperienceLearningCandidate"
      ADD CONSTRAINT "ExperienceLearningCandidate_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ExperienceLearningCandidate_reviewedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "ExperienceLearningCandidate"
      ADD CONSTRAINT "ExperienceLearningCandidate_reviewedByMembershipId_fkey"
      FOREIGN KEY ("reviewedByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ExperienceLearningCandidate_knowledgeEntryId_fkey'
  ) THEN
    ALTER TABLE "ExperienceLearningCandidate"
      ADD CONSTRAINT "ExperienceLearningCandidate_knowledgeEntryId_fkey"
      FOREIGN KEY ("knowledgeEntryId") REFERENCES "KnowledgeEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
