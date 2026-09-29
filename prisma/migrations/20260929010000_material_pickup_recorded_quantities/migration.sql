-- Worker-recorded pickup quantities and exceptions on existing
-- MaterialPurchaseListItem rows. Additive only. Prisma migrate is the
-- authoritative schema source. Recording pickup never purchases,
-- prices, expenses, or starts MATERIAL_PICKUP time.
-- Timestamp is 20260929010000 so it stays after
-- 20260928200000_estimate_line_template_archive (#210).

ALTER TABLE "MaterialPurchaseListItem"
  ADD COLUMN IF NOT EXISTS "quantityPickedUp" DECIMAL(65,30);

ALTER TABLE "MaterialPurchaseListItem"
  ADD COLUMN IF NOT EXISTS "pickupException" TEXT;

ALTER TABLE "MaterialPurchaseListItem"
  ADD COLUMN IF NOT EXISTS "pickupExceptionNote" TEXT;

ALTER TABLE "MaterialPurchaseListItem"
  ADD COLUMN IF NOT EXISTS "pickupRecordedAt" TIMESTAMP(3);

ALTER TABLE "MaterialPurchaseListItem"
  ADD COLUMN IF NOT EXISTS "pickupRecordedByMembershipId" TEXT;

CREATE INDEX IF NOT EXISTS "MaterialPurchaseListItem_pickupRecordedByMembershipId_idx"
  ON "MaterialPurchaseListItem"("pickupRecordedByMembershipId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'MaterialPurchaseListItem_pickupRecordedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "MaterialPurchaseListItem"
      ADD CONSTRAINT "MaterialPurchaseListItem_pickupRecordedByMembershipId_fkey"
      FOREIGN KEY ("pickupRecordedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
