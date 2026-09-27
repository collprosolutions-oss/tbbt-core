-- Additive Controlled AI durable provenance ledger.
-- Preview shares Production and skips migrate, so every statement is IF NOT EXISTS.
-- Written only for explicitly confirmed Controlled AI attempts going forward.
-- No backfill. No prompts, secrets, customer message bodies, or provider payloads.
-- Existing BusinessActionItem / BsosRecommendationState rows stay origin-unknown.

CREATE TABLE IF NOT EXISTS "ControlledAiActionAttempt" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "actionKey" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "recommendationKey" TEXT NOT NULL,
    "targetEntityType" TEXT NOT NULL,
    "targetRecordType" TEXT,
    "targetRecordId" TEXT,
    "confirmedByMembershipId" TEXT NOT NULL,
    "confirmedByUserId" TEXT,
    "resultCode" TEXT NOT NULL,
    "resultMessage" TEXT NOT NULL,
    "executionAttemptId" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ControlledAiActionAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ControlledAiActionAttempt_businessId_executionAttemptId_actionKey_recommendationKey_key"
  ON "ControlledAiActionAttempt"("businessId", "executionAttemptId", "actionKey", "recommendationKey");
CREATE INDEX IF NOT EXISTS "ControlledAiActionAttempt_businessId_confirmedAt_idx"
  ON "ControlledAiActionAttempt"("businessId", "confirmedAt");
CREATE INDEX IF NOT EXISTS "ControlledAiActionAttempt_businessId_actionKey_idx"
  ON "ControlledAiActionAttempt"("businessId", "actionKey");
CREATE INDEX IF NOT EXISTS "ControlledAiActionAttempt_confirmedByMembershipId_idx"
  ON "ControlledAiActionAttempt"("confirmedByMembershipId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ControlledAiActionAttempt_businessId_fkey'
  ) THEN
    ALTER TABLE "ControlledAiActionAttempt"
      ADD CONSTRAINT "ControlledAiActionAttempt_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ControlledAiActionAttempt_confirmedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "ControlledAiActionAttempt"
      ADD CONSTRAINT "ControlledAiActionAttempt_confirmedByMembershipId_fkey"
      FOREIGN KEY ("confirmedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
