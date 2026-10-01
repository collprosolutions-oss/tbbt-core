-- Store the expected Stripe Checkout amount at session creation, and let
-- OWNER acknowledge a STRIPE_CREDIT_MISMATCH_REVIEW flag. Additive only.
-- Preview shares Production and skips migrate, so every statement is
-- IF NOT EXISTS. No backfill. Existing payments and invoices stay unchanged.
-- Timestamp is 20261001140000 so it sits after 20261001120000_invoice_credit.

CREATE TABLE IF NOT EXISTS "InvoiceCheckoutSession" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "stripeSessionId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InvoiceCheckoutSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "InvoiceCheckoutSession_stripeSessionId_key"
  ON "InvoiceCheckoutSession"("stripeSessionId");
CREATE INDEX IF NOT EXISTS "InvoiceCheckoutSession_businessId_idx"
  ON "InvoiceCheckoutSession"("businessId");
CREATE INDEX IF NOT EXISTS "InvoiceCheckoutSession_invoiceId_idx"
  ON "InvoiceCheckoutSession"("invoiceId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'InvoiceCheckoutSession_businessId_fkey'
  ) THEN
    ALTER TABLE "InvoiceCheckoutSession"
      ADD CONSTRAINT "InvoiceCheckoutSession_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'InvoiceCheckoutSession_invoiceId_fkey'
  ) THEN
    ALTER TABLE "InvoiceCheckoutSession"
      ADD CONSTRAINT "InvoiceCheckoutSession_invoiceId_fkey"
      FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "Payment"
  ADD COLUMN IF NOT EXISTS "stripeCreditMismatchResolvedAt" TIMESTAMP(3);
