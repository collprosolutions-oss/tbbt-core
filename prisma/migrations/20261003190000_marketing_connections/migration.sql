-- OWNER marketing destination connections for Facebook, Instagram,
-- and Google Business Profile. Additive only. Preview shares Production
-- and skips migrate, so every statement is IF NOT EXISTS or a guarded
-- foreign key. Request paths must not run this SQL.
-- Timestamp 20261003190000 sits after 20261002193000_esign_signature_request_id
-- and after the in-flight 20261003120000 / 20261003150000 / 20261003180000
-- sibling migrations.

ALTER TABLE "MarketingSocialDestination" ADD COLUMN IF NOT EXISTS "accessTokenCiphertext" TEXT;
ALTER TABLE "MarketingSocialDestination" ADD COLUMN IF NOT EXISTS "refreshTokenCiphertext" TEXT;
ALTER TABLE "MarketingSocialDestination" ADD COLUMN IF NOT EXISTS "tokenExpiresAt" TIMESTAMP(3);
ALTER TABLE "MarketingSocialDestination" ADD COLUMN IF NOT EXISTS "scopesGranted" TEXT NOT NULL DEFAULT '';
ALTER TABLE "MarketingSocialDestination" ADD COLUMN IF NOT EXISTS "connectionStatus" TEXT NOT NULL DEFAULT '';
ALTER TABLE "MarketingSocialDestination" ADD COLUMN IF NOT EXISTS "lastCheckedAt" TIMESTAMP(3);
ALTER TABLE "MarketingSocialDestination" ADD COLUMN IF NOT EXISTS "lastError" TEXT NOT NULL DEFAULT '';
ALTER TABLE "MarketingSocialDestination" ADD COLUMN IF NOT EXISTS "displayName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "MarketingSocialDestination" ADD COLUMN IF NOT EXISTS "externalAccountId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "MarketingSocialDestination" ADD COLUMN IF NOT EXISTS "disconnectedAt" TIMESTAMP(3);
ALTER TABLE "MarketingSocialDestination" ADD COLUMN IF NOT EXISTS "remoteRevokeNote" TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS "MarketingConnectionOAuthState" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "payloadCiphertext" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MarketingConnectionOAuthState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MarketingConnectionOAuthState_tokenHash_key"
  ON "MarketingConnectionOAuthState"("tokenHash");
CREATE INDEX IF NOT EXISTS "MarketingConnectionOAuthState_businessId_destination_idx"
  ON "MarketingConnectionOAuthState"("businessId", "destination");
CREATE INDEX IF NOT EXISTS "MarketingConnectionOAuthState_membershipId_idx"
  ON "MarketingConnectionOAuthState"("membershipId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MarketingConnectionOAuthState_businessId_fkey'
  ) THEN
    ALTER TABLE "MarketingConnectionOAuthState"
      ADD CONSTRAINT "MarketingConnectionOAuthState_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MarketingConnectionOAuthState_membershipId_fkey'
  ) THEN
    ALTER TABLE "MarketingConnectionOAuthState"
      ADD CONSTRAINT "MarketingConnectionOAuthState_membershipId_fkey"
      FOREIGN KEY ("membershipId") REFERENCES "Membership"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
