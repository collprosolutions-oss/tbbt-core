-- IANA timezone for business calendar days. Null means America/New_York.
-- Additive only. Preview skips migrate, so application code also ADD COLUMN IF NOT EXISTS.

ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "timezone" TEXT;
