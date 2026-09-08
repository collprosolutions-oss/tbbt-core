-- Customer-facing business contact for estimates, invoices, and the public site.
-- Additive only. Preview skips migrate, so application code also ADD COLUMN IF NOT EXISTS.

ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "publicPhone" TEXT;
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "publicEmail" TEXT;
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "publicWebsite" TEXT;
