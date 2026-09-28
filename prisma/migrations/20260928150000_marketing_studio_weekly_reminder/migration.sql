-- OWNER opt-in weekly Marketing Studio review reminder.
-- Additive only. Preview shares Production and skips migrate, so every
-- statement is IF NOT EXISTS. Default remains off. Never messages
-- customers, auto-approves, publishes, or posts.
-- Timestamp is 20260928150000 so it does not collide with
-- 20260928120000_customer_follow_up_retention_due_on (#194).

ALTER TABLE "BusinessSettings"
  ADD COLUMN IF NOT EXISTS "studioWeeklyReviewReminderOptedIn" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "MarketingStudioWeeklyReminder" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "weekKey" TEXT NOT NULL,
    "awaitingCount" INTEGER NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'IN_APP',
    "smsStatus" TEXT NOT NULL,
    "smsLabel" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MarketingStudioWeeklyReminder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MarketingStudioWeeklyReminder_businessId_weekKey_key"
  ON "MarketingStudioWeeklyReminder"("businessId", "weekKey");
CREATE INDEX IF NOT EXISTS "MarketingStudioWeeklyReminder_businessId_idx"
  ON "MarketingStudioWeeklyReminder"("businessId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MarketingStudioWeeklyReminder_businessId_fkey'
  ) THEN
    ALTER TABLE "MarketingStudioWeeklyReminder"
      ADD CONSTRAINT "MarketingStudioWeeklyReminder_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
