-- Twilio SMS connection (Task 80).
-- Additive only: inbound tenant routing number on Business plus webhook
-- idempotency table. Does not rewrite customers or grant consent.
-- Preview skips migrate, so application ensure SQL also uses IF NOT EXISTS.

ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "operationalSmsNumber" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Business_operationalSmsNumber_key"
  ON "Business"("operationalSmsNumber");

CREATE TABLE IF NOT EXISTS "CustomerMessagingWebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "eventKind" TEXT NOT NULL,
    "businessId" TEXT,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerMessagingWebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CustomerMessagingWebhookEvent_provider_providerEventId_eventKind_key"
  ON "CustomerMessagingWebhookEvent"("provider", "providerEventId", "eventKind");
CREATE INDEX IF NOT EXISTS "CustomerMessagingWebhookEvent_businessId_idx"
  ON "CustomerMessagingWebhookEvent"("businessId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CustomerMessagingWebhookEvent_businessId_fkey'
  ) THEN
    ALTER TABLE "CustomerMessagingWebhookEvent"
      ADD CONSTRAINT "CustomerMessagingWebhookEvent_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
