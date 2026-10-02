-- Optional revocable calendar subscription. Additive only.
-- Preview shares Production and skips migrate, so every statement is
-- IF NOT EXISTS. No Job column changes — Chat 4 (worker job
-- reassignment) can add its own assignment migration without colliding.
-- Stores only sha256(token). No backfill. Application code must never
-- log the raw token or put names, addresses, notes, or secrets in the
-- feed. Timestamp 20261001194722 sits after
-- 20261001180000_job_aftercare_instruction.

CREATE TABLE IF NOT EXISTS "ScheduleCalendarSubscription" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    CONSTRAINT "ScheduleCalendarSubscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ScheduleCalendarSubscription_tokenHash_key"
  ON "ScheduleCalendarSubscription"("tokenHash");
CREATE UNIQUE INDEX IF NOT EXISTS "ScheduleCalendarSubscription_membershipId_scope_key"
  ON "ScheduleCalendarSubscription"("membershipId", "scope");
CREATE INDEX IF NOT EXISTS "ScheduleCalendarSubscription_businessId_idx"
  ON "ScheduleCalendarSubscription"("businessId");
CREATE INDEX IF NOT EXISTS "ScheduleCalendarSubscription_membershipId_idx"
  ON "ScheduleCalendarSubscription"("membershipId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ScheduleCalendarSubscription_businessId_fkey'
  ) THEN
    ALTER TABLE "ScheduleCalendarSubscription"
      ADD CONSTRAINT "ScheduleCalendarSubscription_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ScheduleCalendarSubscription_membershipId_fkey'
  ) THEN
    ALTER TABLE "ScheduleCalendarSubscription"
      ADD CONSTRAINT "ScheduleCalendarSubscription_membershipId_fkey"
      FOREIGN KEY ("membershipId") REFERENCES "Membership"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
