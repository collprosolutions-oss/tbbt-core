-- Verified Resend bounce/complaint destinations. Additive only.
-- Preview shares Production and skips migrate.
-- Tenant is bound from existing CustomerCommunication send history.
-- Unique provider+event prevents replay duplicates. Unique
-- business+fingerprint keeps one failed destination per address.

CREATE TABLE IF NOT EXISTS "EmailFailedDestination" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "destinationFingerprint" TEXT NOT NULL,
    "destinationLast4" TEXT,
    "reason" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "providerMessageId" TEXT NOT NULL,
    "communicationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EmailFailedDestination_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "EmailFailedDestination_provider_providerEventId_key"
  ON "EmailFailedDestination"("provider", "providerEventId");
CREATE UNIQUE INDEX IF NOT EXISTS "EmailFailedDestination_businessId_destinationFingerprint_key"
  ON "EmailFailedDestination"("businessId", "destinationFingerprint");
CREATE INDEX IF NOT EXISTS "EmailFailedDestination_businessId_idx"
  ON "EmailFailedDestination"("businessId");
CREATE INDEX IF NOT EXISTS "EmailFailedDestination_provider_providerMessageId_idx"
  ON "EmailFailedDestination"("provider", "providerMessageId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'EmailFailedDestination_businessId_fkey'
  ) THEN
    ALTER TABLE "EmailFailedDestination"
      ADD CONSTRAINT "EmailFailedDestination_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'EmailFailedDestination_communicationId_fkey'
  ) THEN
    ALTER TABLE "EmailFailedDestination"
      ADD CONSTRAINT "EmailFailedDestination_communicationId_fkey"
      FOREIGN KEY ("communicationId") REFERENCES "CustomerCommunication"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
