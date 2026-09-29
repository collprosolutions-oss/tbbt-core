-- OWNER-recorded received quantities on existing purchase-order items.
-- Additive only. Prisma migrate is the authoritative schema source.
-- Recording a receipt never creates a payment, expense, invoice, or
-- supplier order. Distinct from worker pickup columns on
-- MaterialPurchaseListItem (#216 native pickup-item record).
-- Timestamp is 20260929140000 so it stays after
-- 20260928200000_estimate_line_template_archive (#210) and after
-- 20260929010000_material_pickup_recorded_quantities if that PR lands.

ALTER TABLE "MaterialPurchaseOrderItem"
  ADD COLUMN IF NOT EXISTS "quantityReceived" DECIMAL(65,30) NOT NULL DEFAULT 0;

ALTER TABLE "MaterialPurchaseOrderItem"
  ADD COLUMN IF NOT EXISTS "lastReceivedAt" TIMESTAMP(3);
