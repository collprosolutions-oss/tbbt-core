-- OWNER-recorded internal credit / correction against an issued invoice.
-- Additive only. Preview shares Production and skips migrate, so every
-- statement is IF NOT EXISTS. No backfill. Existing invoices, line items,
-- and payments stay unchanged. Recording a credit never issues a Stripe
-- refund and never sends a customer message.
-- Timestamp is 20261001120000 so it sits after
-- 20260929233000_revenue_integrity_business_isolation.

CREATE TABLE IF NOT EXISTS "InvoiceCredit" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "customerId" TEXT,
    "amount" DECIMAL(65,30) NOT NULL,
    "reason" TEXT NOT NULL,
    "recordedByMembershipId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InvoiceCredit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "InvoiceCredit_businessId_invoiceId_idempotencyKey_key"
  ON "InvoiceCredit"("businessId", "invoiceId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "InvoiceCredit_businessId_idx"
  ON "InvoiceCredit"("businessId");
CREATE INDEX IF NOT EXISTS "InvoiceCredit_invoiceId_idx"
  ON "InvoiceCredit"("invoiceId");
CREATE INDEX IF NOT EXISTS "InvoiceCredit_customerId_idx"
  ON "InvoiceCredit"("customerId");
CREATE INDEX IF NOT EXISTS "InvoiceCredit_recordedByMembershipId_idx"
  ON "InvoiceCredit"("recordedByMembershipId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'InvoiceCredit_businessId_fkey'
  ) THEN
    ALTER TABLE "InvoiceCredit"
      ADD CONSTRAINT "InvoiceCredit_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'InvoiceCredit_invoiceId_fkey'
  ) THEN
    ALTER TABLE "InvoiceCredit"
      ADD CONSTRAINT "InvoiceCredit_invoiceId_fkey"
      FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'InvoiceCredit_customerId_fkey'
  ) THEN
    ALTER TABLE "InvoiceCredit"
      ADD CONSTRAINT "InvoiceCredit_customerId_fkey"
      FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'InvoiceCredit_recordedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "InvoiceCredit"
      ADD CONSTRAINT "InvoiceCredit_recordedByMembershipId_fkey"
      FOREIGN KEY ("recordedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
