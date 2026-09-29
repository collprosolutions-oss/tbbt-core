-- OWNER collections worklist next-step / resolution rows.
-- Additive only. Preview shares Production and skips migrate, so every
-- statement is IF NOT EXISTS. No backfill. Existing invoices, payments,
-- and communications stay unchanged. Recording a next step or resolution
-- never marks an invoice paid and never sends a reminder.
-- Timestamp is 20260929011000 so it sits after
-- 20260928200000_estimate_line_template_archive (#210).

CREATE TABLE IF NOT EXISTS "InvoiceCollectionWorkItem" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "customerId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "nextStep" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "createdByMembershipId" TEXT,
    "updatedByMembershipId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InvoiceCollectionWorkItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "InvoiceCollectionWorkItem_businessId_invoiceId_key"
  ON "InvoiceCollectionWorkItem"("businessId", "invoiceId");
CREATE INDEX IF NOT EXISTS "InvoiceCollectionWorkItem_businessId_status_idx"
  ON "InvoiceCollectionWorkItem"("businessId", "status");
CREATE INDEX IF NOT EXISTS "InvoiceCollectionWorkItem_invoiceId_idx"
  ON "InvoiceCollectionWorkItem"("invoiceId");
CREATE INDEX IF NOT EXISTS "InvoiceCollectionWorkItem_customerId_idx"
  ON "InvoiceCollectionWorkItem"("customerId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'InvoiceCollectionWorkItem_businessId_fkey'
  ) THEN
    ALTER TABLE "InvoiceCollectionWorkItem"
      ADD CONSTRAINT "InvoiceCollectionWorkItem_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'InvoiceCollectionWorkItem_invoiceId_fkey'
  ) THEN
    ALTER TABLE "InvoiceCollectionWorkItem"
      ADD CONSTRAINT "InvoiceCollectionWorkItem_invoiceId_fkey"
      FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'InvoiceCollectionWorkItem_customerId_fkey'
  ) THEN
    ALTER TABLE "InvoiceCollectionWorkItem"
      ADD CONSTRAINT "InvoiceCollectionWorkItem_customerId_fkey"
      FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'InvoiceCollectionWorkItem_createdByMembershipId_fkey'
  ) THEN
    ALTER TABLE "InvoiceCollectionWorkItem"
      ADD CONSTRAINT "InvoiceCollectionWorkItem_createdByMembershipId_fkey"
      FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'InvoiceCollectionWorkItem_updatedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "InvoiceCollectionWorkItem"
      ADD CONSTRAINT "InvoiceCollectionWorkItem_updatedByMembershipId_fkey"
      FOREIGN KEY ("updatedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
