-- Additive BSOS Intelligence + Automation Core.
-- Preview shares Production and skips migrate, so every statement is IF NOT EXISTS.

ALTER TABLE "KnowledgeEntry" ADD COLUMN IF NOT EXISTS "scope" TEXT NOT NULL DEFAULT 'BUSINESS';

CREATE TABLE IF NOT EXISTS "AiConversation" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiConversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AiConversationMessage" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "stance" TEXT NOT NULL DEFAULT 'MIXED',
    "citedFacts" JSONB,
    "interactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiConversationMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AiInteraction" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "membershipId" TEXT,
    "userId" TEXT,
    "conversationId" TEXT,
    "taskType" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "status" TEXT NOT NULL,
    "inputSummary" TEXT NOT NULL,
    "outputSummary" TEXT,
    "failureReason" TEXT,
    "latencyMs" INTEGER,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiInteraction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AiUsagePeriod" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiUsagePeriod_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "KnowledgeConcept" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KnowledgeConcept_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "KnowledgeAssertion" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "stance" TEXT NOT NULL,
    "confidence" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KnowledgeAssertion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "BusinessEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "payload" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BusinessEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AutomationRule" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'COMMUNICATION',
    "purpose" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "channel" TEXT NOT NULL DEFAULT 'NONE',
    "delayMinutes" INTEGER NOT NULL DEFAULT 0,
    "templateKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AutomationRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AutomationRun" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "ruleId" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "resultSummary" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "BsosRecommendationState" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "recommendationKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "actionItemId" TEXT,
    "updatedByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BsosRecommendationState_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AiConversation_businessId_idx" ON "AiConversation"("businessId");
CREATE INDEX IF NOT EXISTS "AiConversation_businessId_area_idx" ON "AiConversation"("businessId", "area");
CREATE INDEX IF NOT EXISTS "AiConversation_membershipId_idx" ON "AiConversation"("membershipId");
CREATE INDEX IF NOT EXISTS "AiConversationMessage_businessId_idx" ON "AiConversationMessage"("businessId");
CREATE INDEX IF NOT EXISTS "AiConversationMessage_conversationId_idx" ON "AiConversationMessage"("conversationId");
CREATE UNIQUE INDEX IF NOT EXISTS "AiInteraction_businessId_idempotencyKey_key" ON "AiInteraction"("businessId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "AiInteraction_businessId_idx" ON "AiInteraction"("businessId");
CREATE INDEX IF NOT EXISTS "AiInteraction_businessId_taskType_idx" ON "AiInteraction"("businessId", "taskType");
CREATE INDEX IF NOT EXISTS "AiInteraction_businessId_createdAt_idx" ON "AiInteraction"("businessId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "AiUsagePeriod_businessId_periodStart_key" ON "AiUsagePeriod"("businessId", "periodStart");
CREATE INDEX IF NOT EXISTS "KnowledgeConcept_businessId_idx" ON "KnowledgeConcept"("businessId");
CREATE INDEX IF NOT EXISTS "KnowledgeConcept_entryId_idx" ON "KnowledgeConcept"("entryId");
CREATE INDEX IF NOT EXISTS "KnowledgeAssertion_businessId_idx" ON "KnowledgeAssertion"("businessId");
CREATE INDEX IF NOT EXISTS "KnowledgeAssertion_entryId_idx" ON "KnowledgeAssertion"("entryId");
CREATE INDEX IF NOT EXISTS "KnowledgeEntry_businessId_scope_idx" ON "KnowledgeEntry"("businessId", "scope");
CREATE UNIQUE INDEX IF NOT EXISTS "BusinessEvent_businessId_idempotencyKey_key" ON "BusinessEvent"("businessId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "BusinessEvent_businessId_idx" ON "BusinessEvent"("businessId");
CREATE INDEX IF NOT EXISTS "BusinessEvent_businessId_type_idx" ON "BusinessEvent"("businessId", "type");
CREATE INDEX IF NOT EXISTS "BusinessEvent_businessId_subjectType_subjectId_idx" ON "BusinessEvent"("businessId", "subjectType", "subjectId");
CREATE UNIQUE INDEX IF NOT EXISTS "AutomationRule_businessId_eventType_purpose_key" ON "AutomationRule"("businessId", "eventType", "purpose");
CREATE INDEX IF NOT EXISTS "AutomationRule_businessId_idx" ON "AutomationRule"("businessId");
CREATE UNIQUE INDEX IF NOT EXISTS "AutomationRun_businessId_idempotencyKey_key" ON "AutomationRun"("businessId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "AutomationRun_businessId_idx" ON "AutomationRun"("businessId");
CREATE INDEX IF NOT EXISTS "AutomationRun_businessId_status_availableAt_idx" ON "AutomationRun"("businessId", "status", "availableAt");
CREATE INDEX IF NOT EXISTS "AutomationRun_eventId_idx" ON "AutomationRun"("eventId");
CREATE UNIQUE INDEX IF NOT EXISTS "BsosRecommendationState_businessId_recommendationKey_key" ON "BsosRecommendationState"("businessId", "recommendationKey");
CREATE INDEX IF NOT EXISTS "BsosRecommendationState_businessId_idx" ON "BsosRecommendationState"("businessId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AiConversation_businessId_fkey'
  ) THEN
    ALTER TABLE "AiConversation" ADD CONSTRAINT "AiConversation_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AiConversation_membershipId_fkey'
  ) THEN
    ALTER TABLE "AiConversation" ADD CONSTRAINT "AiConversation_membershipId_fkey"
      FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AiConversationMessage_businessId_fkey'
  ) THEN
    ALTER TABLE "AiConversationMessage" ADD CONSTRAINT "AiConversationMessage_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AiConversationMessage_conversationId_fkey'
  ) THEN
    ALTER TABLE "AiConversationMessage" ADD CONSTRAINT "AiConversationMessage_conversationId_fkey"
      FOREIGN KEY ("conversationId") REFERENCES "AiConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AiInteraction_businessId_fkey'
  ) THEN
    ALTER TABLE "AiInteraction" ADD CONSTRAINT "AiInteraction_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AiInteraction_membershipId_fkey'
  ) THEN
    ALTER TABLE "AiInteraction" ADD CONSTRAINT "AiInteraction_membershipId_fkey"
      FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AiInteraction_conversationId_fkey'
  ) THEN
    ALTER TABLE "AiInteraction" ADD CONSTRAINT "AiInteraction_conversationId_fkey"
      FOREIGN KEY ("conversationId") REFERENCES "AiConversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AiUsagePeriod_businessId_fkey'
  ) THEN
    ALTER TABLE "AiUsagePeriod" ADD CONSTRAINT "AiUsagePeriod_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgeConcept_businessId_fkey'
  ) THEN
    ALTER TABLE "KnowledgeConcept" ADD CONSTRAINT "KnowledgeConcept_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgeConcept_entryId_fkey'
  ) THEN
    ALTER TABLE "KnowledgeConcept" ADD CONSTRAINT "KnowledgeConcept_entryId_fkey"
      FOREIGN KEY ("entryId") REFERENCES "KnowledgeEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgeAssertion_businessId_fkey'
  ) THEN
    ALTER TABLE "KnowledgeAssertion" ADD CONSTRAINT "KnowledgeAssertion_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgeAssertion_entryId_fkey'
  ) THEN
    ALTER TABLE "KnowledgeAssertion" ADD CONSTRAINT "KnowledgeAssertion_entryId_fkey"
      FOREIGN KEY ("entryId") REFERENCES "KnowledgeEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessEvent_businessId_fkey'
  ) THEN
    ALTER TABLE "BusinessEvent" ADD CONSTRAINT "BusinessEvent_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AutomationRule_businessId_fkey'
  ) THEN
    ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AutomationRun_businessId_fkey'
  ) THEN
    ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AutomationRun_eventId_fkey'
  ) THEN
    ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_eventId_fkey"
      FOREIGN KEY ("eventId") REFERENCES "BusinessEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AutomationRun_ruleId_fkey'
  ) THEN
    ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_ruleId_fkey"
      FOREIGN KEY ("ruleId") REFERENCES "AutomationRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BsosRecommendationState_businessId_fkey'
  ) THEN
    ALTER TABLE "BsosRecommendationState" ADD CONSTRAINT "BsosRecommendationState_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BsosRecommendationState_updatedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "BsosRecommendationState" ADD CONSTRAINT "BsosRecommendationState_updatedByMembershipId_fkey"
      FOREIGN KEY ("updatedByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
