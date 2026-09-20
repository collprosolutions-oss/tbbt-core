-- Customer messaging foundation (Task 79).
-- Additive only: SMS consent columns on Customer plus a durable
-- CustomerCommunication audit table. Existing customers default to
-- UNKNOWN consent — a phone number is never treated as consent.
-- Preview skips migrate, so application ensure SQL also uses
-- ADD COLUMN / CREATE TABLE IF NOT EXISTS.

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "smsConsentStatus" TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "smsConsentUpdatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CustomerCommunication" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'SMS',
    "purpose" TEXT NOT NULL,
    "relatedType" TEXT,
    "relatedId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "destinationLast4" TEXT,
    "destinationFingerprint" TEXT,
    "bodySnapshot" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "providerMetadata" JSONB,
    "failureReason" TEXT,
    "initiatedByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attemptedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerCommunication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CustomerCommunication_businessId_idempotencyKey_key" ON "CustomerCommunication"("businessId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "CustomerCommunication_businessId_idx" ON "CustomerCommunication"("businessId");
CREATE INDEX IF NOT EXISTS "CustomerCommunication_customerId_idx" ON "CustomerCommunication"("customerId");
CREATE INDEX IF NOT EXISTS "CustomerCommunication_provider_providerMessageId_idx" ON "CustomerCommunication"("provider", "providerMessageId");
CREATE INDEX IF NOT EXISTS "CustomerCommunication_businessId_relatedType_relatedId_idx" ON "CustomerCommunication"("businessId", "relatedType", "relatedId");

-- Foreign keys (idempotent for Preview ensure / migrate-already-applied).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CustomerCommunication_businessId_fkey'
  ) THEN
    ALTER TABLE "CustomerCommunication"
      ADD CONSTRAINT "CustomerCommunication_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CustomerCommunication_customerId_fkey'
  ) THEN
    ALTER TABLE "CustomerCommunication"
      ADD CONSTRAINT "CustomerCommunication_customerId_fkey"
      FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CustomerCommunication_initiatedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "CustomerCommunication"
      ADD CONSTRAINT "CustomerCommunication_initiatedByMembershipId_fkey"
      FOREIGN KEY ("initiatedByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
