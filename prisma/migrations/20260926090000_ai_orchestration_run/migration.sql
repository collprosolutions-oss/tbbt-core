-- Additive Chief-of-Staff orchestration audit table.
-- Preview shares Production and skips migrate, so every statement is IF NOT EXISTS.
-- Orchestration status is NOT AI-provider status. No secrets. No chain-of-thought.
-- Existing AI conversation and interaction rows are preserved. No destructive statements.

CREATE TABLE IF NOT EXISTS "AiOrchestrationRun" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "interactionId" TEXT NOT NULL,
    "conversationId" TEXT,
    "status" TEXT NOT NULL,
    "questionSummary" TEXT NOT NULL,
    "specialistIds" JSONB NOT NULL,
    "factKeys" JSONB NOT NULL,
    "recommendationKeys" JSONB NOT NULL,
    "conflictMetadata" JSONB,
    "skippedFailure" JSONB,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiOrchestrationRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AiOrchestrationRun_interactionId_key"
  ON "AiOrchestrationRun"("interactionId");
CREATE UNIQUE INDEX IF NOT EXISTS "AiOrchestrationRun_businessId_idempotencyKey_key"
  ON "AiOrchestrationRun"("businessId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "AiOrchestrationRun_businessId_idx"
  ON "AiOrchestrationRun"("businessId");
CREATE INDEX IF NOT EXISTS "AiOrchestrationRun_membershipId_idx"
  ON "AiOrchestrationRun"("membershipId");
CREATE INDEX IF NOT EXISTS "AiOrchestrationRun_conversationId_idx"
  ON "AiOrchestrationRun"("conversationId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AiOrchestrationRun_businessId_fkey'
  ) THEN
    ALTER TABLE "AiOrchestrationRun"
      ADD CONSTRAINT "AiOrchestrationRun_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AiOrchestrationRun_membershipId_fkey'
  ) THEN
    ALTER TABLE "AiOrchestrationRun"
      ADD CONSTRAINT "AiOrchestrationRun_membershipId_fkey"
      FOREIGN KEY ("membershipId") REFERENCES "Membership"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AiOrchestrationRun_interactionId_fkey'
  ) THEN
    ALTER TABLE "AiOrchestrationRun"
      ADD CONSTRAINT "AiOrchestrationRun_interactionId_fkey"
      FOREIGN KEY ("interactionId") REFERENCES "AiInteraction"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AiOrchestrationRun_conversationId_fkey'
  ) THEN
    ALTER TABLE "AiOrchestrationRun"
      ADD CONSTRAINT "AiOrchestrationRun_conversationId_fkey"
      FOREIGN KEY ("conversationId") REFERENCES "AiConversation"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
