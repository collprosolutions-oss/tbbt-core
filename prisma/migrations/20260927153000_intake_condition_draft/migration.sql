-- Additive OWNER intake-condition drafts.
-- Preview shares Production and skips migrate, so every statement is IF NOT EXISTS.
-- Draft-only: these rows are never applied to public hire forms.
-- Historical ServiceRequest snapshots are never rewritten from this table.

CREATE TABLE IF NOT EXISTS "IntakeConditionDraft" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "tradeCode" TEXT NOT NULL,
    "baseSchemaKey" TEXT NOT NULL,
    "baseSchemaVersion" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "documentJson" TEXT NOT NULL,
    "updatedByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IntakeConditionDraft_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "IntakeConditionDraft_businessId_tradeCode_key"
  ON "IntakeConditionDraft"("businessId", "tradeCode");
CREATE INDEX IF NOT EXISTS "IntakeConditionDraft_businessId_idx"
  ON "IntakeConditionDraft"("businessId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'IntakeConditionDraft_businessId_fkey'
  ) THEN
    ALTER TABLE "IntakeConditionDraft"
      ADD CONSTRAINT "IntakeConditionDraft_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
