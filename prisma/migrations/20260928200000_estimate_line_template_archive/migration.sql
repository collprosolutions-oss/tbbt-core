-- OWNER edit / rename / archive for named estimate-line templates.
-- Additive only. Preview shares Production and skips migrate, so every
-- statement is IF NOT EXISTS. No backfill. Existing templates stay active.
-- Does not rewrite LineItem rows, catalog prices, SENT/APPROVED estimates,
-- invoices, or jobs. Timestamp is 20260928200000 so it sits after
-- 20260928190000_owner_studio_reminder_sms_destination (#205).

ALTER TABLE "EstimateLineTemplate"
  ADD COLUMN IF NOT EXISTS "archived" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "EstimateLineTemplate_businessId_archived_idx"
  ON "EstimateLineTemplate"("businessId", "archived");
