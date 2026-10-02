-- Opt-in native field push device tokens and worker-alert deliveries.
-- Additive only. Preview shares Production and skips migrate, so every
-- statement is IF NOT EXISTS. These tables do not alter Job columns
-- and never store a customer address or access code.
-- Reserved unique timestamp 20261002192000. Do not reuse another
-- parallel-chat migration name.

CREATE TABLE IF NOT EXISTS "NativePushDevice" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenLast4" TEXT NOT NULL DEFAULT '',
    "deviceToken" TEXT NOT NULL,
    "optedIn" BOOLEAN NOT NULL DEFAULT false,
    "revokedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "NativePushDevice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "NativePushDevice_membershipId_tokenHash_key"
  ON "NativePushDevice"("membershipId", "tokenHash");
CREATE INDEX IF NOT EXISTS "NativePushDevice_businessId_membershipId_idx"
  ON "NativePushDevice"("businessId", "membershipId");
CREATE INDEX IF NOT EXISTS "NativePushDevice_membershipId_revokedAt_idx"
  ON "NativePushDevice"("membershipId", "revokedAt");

CREATE TABLE IF NOT EXISTS "NativePushDelivery" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "payloadSnapshot" JSONB NOT NULL,
    "provider" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "NativePushDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "NativePushDelivery_businessId_idempotencyKey_key"
  ON "NativePushDelivery"("businessId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "NativePushDelivery_businessId_membershipId_idx"
  ON "NativePushDelivery"("businessId", "membershipId");
CREATE INDEX IF NOT EXISTS "NativePushDelivery_jobId_idx"
  ON "NativePushDelivery"("jobId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'NativePushDevice_businessId_fkey'
  ) THEN
    ALTER TABLE "NativePushDevice"
      ADD CONSTRAINT "NativePushDevice_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'NativePushDevice_membershipId_fkey'
  ) THEN
    ALTER TABLE "NativePushDevice"
      ADD CONSTRAINT "NativePushDevice_membershipId_fkey"
      FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'NativePushDevice_userId_fkey'
  ) THEN
    ALTER TABLE "NativePushDevice"
      ADD CONSTRAINT "NativePushDevice_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'NativePushDelivery_businessId_fkey'
  ) THEN
    ALTER TABLE "NativePushDelivery"
      ADD CONSTRAINT "NativePushDelivery_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'NativePushDelivery_membershipId_fkey'
  ) THEN
    ALTER TABLE "NativePushDelivery"
      ADD CONSTRAINT "NativePushDelivery_membershipId_fkey"
      FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'NativePushDelivery_jobId_fkey'
  ) THEN
    ALTER TABLE "NativePushDelivery"
      ADD CONSTRAINT "NativePushDelivery_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
