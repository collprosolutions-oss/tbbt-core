-- Persist authenticated Connect invoice Checkout events so OWNER can
-- see HTTP 200 / applied:false rows and retry the frozen verified event.
-- Additive only. Preview shares Production and skips migrate, so every
-- statement is IF NOT EXISTS. No backfill. Existing payments stay unchanged.
-- Distinct from SaasBillingWebhookEvent.

CREATE TABLE IF NOT EXISTS "ConnectInvoiceWebhookEvent" (
    "id" TEXT NOT NULL,
    "stripeEventId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "checkoutSessionId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "paymentStatus" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "verifiedPaymentJson" JSONB NOT NULL,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT NOT NULL,
    "lastAttemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ConnectInvoiceWebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ConnectInvoiceWebhookEvent_stripeEventId_key"
  ON "ConnectInvoiceWebhookEvent"("stripeEventId");
CREATE INDEX IF NOT EXISTS "ConnectInvoiceWebhookEvent_businessId_applied_idx"
  ON "ConnectInvoiceWebhookEvent"("businessId", "applied");
CREATE INDEX IF NOT EXISTS "ConnectInvoiceWebhookEvent_businessId_invoiceId_idx"
  ON "ConnectInvoiceWebhookEvent"("businessId", "invoiceId");
CREATE INDEX IF NOT EXISTS "ConnectInvoiceWebhookEvent_checkoutSessionId_idx"
  ON "ConnectInvoiceWebhookEvent"("checkoutSessionId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ConnectInvoiceWebhookEvent_businessId_fkey'
  ) THEN
    ALTER TABLE "ConnectInvoiceWebhookEvent"
      ADD CONSTRAINT "ConnectInvoiceWebhookEvent_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
