-- Additive read-only regulatory intelligence notes.
-- Preview shares Production and skips migrate, so every statement is IF NOT EXISTS.
-- Tenant-scoped official-source records only. No backfill. No estimate/job gates.

CREATE TABLE IF NOT EXISTS "RegulatoryIntelligenceNote" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "jurisdictionCode" TEXT NOT NULL,
    "jurisdictionLabel" TEXT NOT NULL,
    "tradeCode" TEXT NOT NULL,
    "officialSourceUrl" TEXT NOT NULL,
    "officialSourceTitle" TEXT NOT NULL,
    "citation" TEXT NOT NULL,
    "retrievedAt" TIMESTAMP(3) NOT NULL,
    "effectiveOn" TIMESTAMP(3),
    "expiresOn" TIMESTAMP(3),
    "recordedState" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RegulatoryIntelligenceNote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "RegulatoryIntelligenceNote_businessId_idx"
  ON "RegulatoryIntelligenceNote"("businessId");
CREATE INDEX IF NOT EXISTS "RegulatoryIntelligenceNote_businessId_jurisdictionCode_tradeCode_idx"
  ON "RegulatoryIntelligenceNote"("businessId", "jurisdictionCode", "tradeCode");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'RegulatoryIntelligenceNote_businessId_fkey'
  ) THEN
    ALTER TABLE "RegulatoryIntelligenceNote"
      ADD CONSTRAINT "RegulatoryIntelligenceNote_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
