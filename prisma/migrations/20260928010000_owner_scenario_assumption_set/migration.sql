-- Named OWNER assumption overlays for /scenario-planner.
-- Additive only. Preview shares Production and skips migrate, so every
-- statement is IF NOT EXISTS. No backfill. Existing businesses keep zero rows.
-- Stores knobs only — never recorded facts, forecasts, invoices, payments,
-- expenses, jobs, or catalog prices. Does not rewrite Business, Invoice,
-- Payment, Expense, Job, or ServiceCatalogItem rows.

CREATE TABLE IF NOT EXISTS "OwnerScenarioAssumptionSet" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "workloadPercent" DECIMAL(65,30) NOT NULL,
    "materialCostPercent" DECIMAL(65,30) NOT NULL,
    "laborCostPercent" DECIMAL(65,30) NOT NULL,
    "pricePercent" DECIMAL(65,30) NOT NULL,
    "assumeUnpaidInvoicesCollect" BOOLEAN NOT NULL DEFAULT false,
    "createdByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OwnerScenarioAssumptionSet_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OwnerScenarioAssumptionSet_businessId_name_key"
  ON "OwnerScenarioAssumptionSet"("businessId", "name");
CREATE INDEX IF NOT EXISTS "OwnerScenarioAssumptionSet_businessId_updatedAt_idx"
  ON "OwnerScenarioAssumptionSet"("businessId", "updatedAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OwnerScenarioAssumptionSet_businessId_fkey'
  ) THEN
    ALTER TABLE "OwnerScenarioAssumptionSet"
      ADD CONSTRAINT "OwnerScenarioAssumptionSet_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OwnerScenarioAssumptionSet_createdByMembershipId_fkey'
  ) THEN
    ALTER TABLE "OwnerScenarioAssumptionSet"
      ADD CONSTRAINT "OwnerScenarioAssumptionSet_createdByMembershipId_fkey"
      FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
