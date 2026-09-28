-- Explicit OWNER-controlled SMS destination and opt-in for the weekly
-- Marketing Studio reminder. Additive only. Preview shares Production
-- and skips migrate, so every statement is IF NOT EXISTS.
-- Business.publicPhone is never the destination.
-- Timestamp is 20260928180000 so it stays after
-- 20260928170000_service_request_repeat_visit_source (#206) and
-- 20260928150000_marketing_studio_weekly_reminder (#201).

ALTER TABLE "BusinessSettings"
  ADD COLUMN IF NOT EXISTS "studioWeeklyReminderOwnerSmsTo" TEXT;

ALTER TABLE "BusinessSettings"
  ADD COLUMN IF NOT EXISTS "studioWeeklyReminderOwnerSmsOptedIn" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "BusinessSettings"
  ADD COLUMN IF NOT EXISTS "studioWeeklyReminderOwnerSmsStopAt" TIMESTAMP(3);

ALTER TABLE "BusinessSettings"
  ADD COLUMN IF NOT EXISTS "studioWeeklyReminderOwnerSmsBlockedAt" TIMESTAMP(3);

ALTER TABLE "MarketingStudioWeeklyReminder"
  ADD COLUMN IF NOT EXISTS "smsSendClaimedAt" TIMESTAMP(3);

ALTER TABLE "MarketingStudioWeeklyReminder"
  ADD COLUMN IF NOT EXISTS "smsProviderMessageId" TEXT;

ALTER TABLE "MarketingStudioWeeklyReminder"
  ADD COLUMN IF NOT EXISTS "smsProviderError" TEXT;
