-- Additive Intelligence + Automation hardening.
-- Preview shares Production and skips migrate, so every statement is IF NOT EXISTS
-- or guarded. No request-time DDL.

ALTER TABLE "BsosRecommendationState" ADD COLUMN IF NOT EXISTS "evidenceKey" TEXT NOT NULL DEFAULT '';
ALTER TABLE "BsosRecommendationState" ADD COLUMN IF NOT EXISTS "history" JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AiConversationMessage_interactionId_fkey'
  ) THEN
    ALTER TABLE "AiConversationMessage"
      ADD CONSTRAINT "AiConversationMessage_interactionId_fkey"
      FOREIGN KEY ("interactionId") REFERENCES "AiInteraction"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AiInteraction_userId_fkey'
  ) THEN
    ALTER TABLE "AiInteraction"
      ADD CONSTRAINT "AiInteraction_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BsosRecommendationState_actionItemId_fkey'
  ) THEN
    ALTER TABLE "BsosRecommendationState"
      ADD CONSTRAINT "BsosRecommendationState_actionItemId_fkey"
      FOREIGN KEY ("actionItemId") REFERENCES "BusinessActionItem"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
