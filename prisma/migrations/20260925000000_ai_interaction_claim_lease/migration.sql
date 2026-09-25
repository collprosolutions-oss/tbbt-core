-- Additive claim lease for abandoned PENDING AI interactions.
-- Preview shares Production and skips migrate, so every statement is
-- IF NOT EXISTS. No request-time DDL.

ALTER TABLE "AiInteraction" ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3);
