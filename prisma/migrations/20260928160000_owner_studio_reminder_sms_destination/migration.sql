-- Explicit OWNER-controlled SMS destination and opt-in for the weekly
-- Marketing Studio reminder. Additive only. Preview shares Production
-- and skips migrate, so every statement is IF NOT EXISTS.
-- Business.publicPhone is never the destination.
-- Timestamp is 20260928160000 so it stays after
-- 20260928150000_marketing_studio_weekly_reminder (#201).

ALTER TABLE "BusinessSettings"
  ADD COLUMN IF NOT EXISTS "studioWeeklyReminderOwnerSmsTo" TEXT;

ALTER TABLE "BusinessSettings"
  ADD COLUMN IF NOT EXISTS "studioWeeklyReminderOwnerSmsOptedIn" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "MarketingStudioWeeklyReminder"
  ADD COLUMN IF NOT EXISTS "smsSendClaimedAt" TIMESTAMP(3);
