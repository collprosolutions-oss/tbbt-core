-- Additive claim lease for abandoned PROCESSING automation runs.
-- Preview shares Production and skips migrate, so every statement is
-- IF NOT EXISTS. No request-time DDL.

ALTER TABLE "AutomationRun" ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3);
