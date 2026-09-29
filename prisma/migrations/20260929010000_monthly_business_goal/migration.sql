-- OWNER-set monthly targets for recorded jobs completed, invoices paid,
-- and revenue received. Additive only. Preview shares Production and skips
-- migrate, so every statement is IF NOT EXISTS. No backfill. Existing
-- businesses keep zero rows. Stores targets only — never recorded facts,
-- forecasts, invoices, payments, expenses, jobs, catalog prices, or bank
-- balance. Does not rewrite Business, Invoice, Payment, Expense, Job, or
-- ServiceCatalogItem rows.

CREATE TABLE IF NOT EXISTS "MonthlyBusinessGoal" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "jobsCompletedTarget" INTEGER,
    "invoicesPaidTarget" INTEGER,
    "revenueReceivedTarget" DECIMAL(65,30),
    "createdByMembershipId" TEXT,
    "updatedByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MonthlyBusinessGoal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MonthlyBusinessGoal_businessId_year_month_key"
  ON "MonthlyBusinessGoal"("businessId", "year", "month");
CREATE INDEX IF NOT EXISTS "MonthlyBusinessGoal_businessId_idx"
  ON "MonthlyBusinessGoal"("businessId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MonthlyBusinessGoal_businessId_fkey'
  ) THEN
    ALTER TABLE "MonthlyBusinessGoal"
      ADD CONSTRAINT "MonthlyBusinessGoal_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MonthlyBusinessGoal_createdByMembershipId_fkey'
  ) THEN
    ALTER TABLE "MonthlyBusinessGoal"
      ADD CONSTRAINT "MonthlyBusinessGoal_createdByMembershipId_fkey"
      FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MonthlyBusinessGoal_updatedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "MonthlyBusinessGoal"
      ADD CONSTRAINT "MonthlyBusinessGoal_updatedByMembershipId_fkey"
      FOREIGN KEY ("updatedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
