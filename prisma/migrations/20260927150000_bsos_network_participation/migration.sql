-- Additive BSOS Network participation table.
-- Default-off: optedIn defaults to false. No Business columns are added.
-- Preview shares Production and skips migrate, so every statement is IF NOT EXISTS.
-- Existing tenant, customer, job, and finance rows are preserved. No destructive statements.

CREATE TABLE IF NOT EXISTS "BsosNetworkParticipation" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "optedIn" BOOLEAN NOT NULL DEFAULT false,
    "optedInAt" TIMESTAMP(3),
    "optedOutAt" TIMESTAMP(3),
    "publicName" TEXT NOT NULL DEFAULT '',
    "tradeCode" TEXT NOT NULL DEFAULT 'HANDYMAN',
    "serviceAreaLabel" TEXT NOT NULL DEFAULT '',
    "publicContactMethod" TEXT NOT NULL DEFAULT 'EMAIL',
    "publicContactValue" TEXT NOT NULL DEFAULT '',
    "updatedByMembershipId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BsosNetworkParticipation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BsosNetworkParticipation_businessId_key"
  ON "BsosNetworkParticipation"("businessId");
CREATE INDEX IF NOT EXISTS "BsosNetworkParticipation_optedIn_idx"
  ON "BsosNetworkParticipation"("optedIn");
CREATE INDEX IF NOT EXISTS "BsosNetworkParticipation_optedIn_tradeCode_idx"
  ON "BsosNetworkParticipation"("optedIn", "tradeCode");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BsosNetworkParticipation_businessId_fkey'
  ) THEN
    ALTER TABLE "BsosNetworkParticipation"
      ADD CONSTRAINT "BsosNetworkParticipation_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BsosNetworkParticipation_updatedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "BsosNetworkParticipation"
      ADD CONSTRAINT "BsosNetworkParticipation_updatedByMembershipId_fkey"
      FOREIGN KEY ("updatedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
