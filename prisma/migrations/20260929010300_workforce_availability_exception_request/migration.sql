-- Worker-requested dated availability exception / time off.
-- Additive only. Preview shares Production and skips migrate, so every
-- statement is IF NOT EXISTS. Pending requests do not write recorded
-- availability. Acceptance creates MembershipAvailabilityException
-- unless the owner confirms replace.
-- These rows never cancel, reassign, or message Jobs.

CREATE TABLE IF NOT EXISTS "MembershipAvailabilityExceptionRequest" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "startMinutes" INTEGER,
    "endMinutes" INTEGER,
    "note" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedByMembershipId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MembershipAvailabilityExceptionRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MembershipAvailabilityExceptionRequest_businessId_status_idx"
  ON "MembershipAvailabilityExceptionRequest"("businessId", "status");
CREATE INDEX IF NOT EXISTS "MembershipAvailabilityExceptionRequest_membershipId_date_idx"
  ON "MembershipAvailabilityExceptionRequest"("membershipId", "date");
CREATE INDEX IF NOT EXISTS "MembershipAvailabilityExceptionRequest_decidedByMembershipId_idx"
  ON "MembershipAvailabilityExceptionRequest"("decidedByMembershipId");

CREATE UNIQUE INDEX IF NOT EXISTS "MembershipAvailabilityExceptionRequest_pending_membership_date_key"
  ON "MembershipAvailabilityExceptionRequest"("membershipId", "date")
  WHERE "status" = 'PENDING';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'MembershipAvailabilityExceptionRequest_businessId_fkey'
  ) THEN
    ALTER TABLE "MembershipAvailabilityExceptionRequest"
      ADD CONSTRAINT "MembershipAvailabilityExceptionRequest_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'MembershipAvailabilityExceptionRequest_membershipId_fkey'
  ) THEN
    ALTER TABLE "MembershipAvailabilityExceptionRequest"
      ADD CONSTRAINT "MembershipAvailabilityExceptionRequest_membershipId_fkey"
      FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'MembershipAvailabilityExceptionRequest_decidedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "MembershipAvailabilityExceptionRequest"
      ADD CONSTRAINT "MembershipAvailabilityExceptionRequest_decidedByMembershipId_fkey"
      FOREIGN KEY ("decidedByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
