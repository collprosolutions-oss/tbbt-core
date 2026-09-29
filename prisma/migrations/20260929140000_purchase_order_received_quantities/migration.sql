-- OWNER-recorded received quantities on existing purchase-order items.
-- Additive only. Prisma migrate is the authoritative schema source.
-- Recording a receipt never creates a payment, expense, invoice, or
-- supplier order. Distinct from worker pickup columns on
-- MaterialPurchaseListItem (#216 native pickup-item record).
-- Timestamp is 20260929140000 so it stays after
-- 20260928200000_estimate_line_template_archive (#210) and after
-- 20260929010000_material_pickup_recorded_quantities if that PR lands.
-- OWNER reversal of a recorded delivery is a follow-up.

ALTER TABLE "MaterialPurchaseOrderItem"
  ADD COLUMN IF NOT EXISTS "quantityReceived" DECIMAL(65,30) NOT NULL DEFAULT 0;

ALTER TABLE "MaterialPurchaseOrderItem"
  ADD COLUMN IF NOT EXISTS "lastReceivedAt" TIMESTAMP(3);

ALTER TABLE "MaterialOperationAttempt"
  ADD COLUMN IF NOT EXISTS "payloadFingerprint" TEXT;

CREATE TABLE IF NOT EXISTS "MaterialPurchaseOrderReceipt" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "attemptKey" TEXT NOT NULL,
    "recordedByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaterialPurchaseOrderReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MaterialPurchaseOrderReceipt_businessId_attemptKey_key"
  ON "MaterialPurchaseOrderReceipt"("businessId", "attemptKey");

CREATE INDEX IF NOT EXISTS "MaterialPurchaseOrderReceipt_businessId_idx"
  ON "MaterialPurchaseOrderReceipt"("businessId");

CREATE INDEX IF NOT EXISTS "MaterialPurchaseOrderReceipt_purchaseOrderId_idx"
  ON "MaterialPurchaseOrderReceipt"("purchaseOrderId");

CREATE INDEX IF NOT EXISTS "MaterialPurchaseOrderReceipt_recordedByMembershipId_idx"
  ON "MaterialPurchaseOrderReceipt"("recordedByMembershipId");

CREATE TABLE IF NOT EXISTS "MaterialPurchaseOrderReceiptItem" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "purchaseOrderItemId" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,

    CONSTRAINT "MaterialPurchaseOrderReceiptItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MaterialPurchaseOrderReceiptItem_businessId_idx"
  ON "MaterialPurchaseOrderReceiptItem"("businessId");

CREATE INDEX IF NOT EXISTS "MaterialPurchaseOrderReceiptItem_receiptId_idx"
  ON "MaterialPurchaseOrderReceiptItem"("receiptId");

CREATE INDEX IF NOT EXISTS "MaterialPurchaseOrderReceiptItem_purchaseOrderItemId_idx"
  ON "MaterialPurchaseOrderReceiptItem"("purchaseOrderItemId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MaterialPurchaseOrderReceipt_businessId_fkey'
  ) THEN
    ALTER TABLE "MaterialPurchaseOrderReceipt"
      ADD CONSTRAINT "MaterialPurchaseOrderReceipt_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MaterialPurchaseOrderReceipt_purchaseOrderId_fkey'
  ) THEN
    ALTER TABLE "MaterialPurchaseOrderReceipt"
      ADD CONSTRAINT "MaterialPurchaseOrderReceipt_purchaseOrderId_fkey"
      FOREIGN KEY ("purchaseOrderId") REFERENCES "MaterialPurchaseOrder"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'MaterialPurchaseOrderReceipt_recordedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "MaterialPurchaseOrderReceipt"
      ADD CONSTRAINT "MaterialPurchaseOrderReceipt_recordedByMembershipId_fkey"
      FOREIGN KEY ("recordedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MaterialPurchaseOrderReceiptItem_businessId_fkey'
  ) THEN
    ALTER TABLE "MaterialPurchaseOrderReceiptItem"
      ADD CONSTRAINT "MaterialPurchaseOrderReceiptItem_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MaterialPurchaseOrderReceiptItem_receiptId_fkey'
  ) THEN
    ALTER TABLE "MaterialPurchaseOrderReceiptItem"
      ADD CONSTRAINT "MaterialPurchaseOrderReceiptItem_receiptId_fkey"
      FOREIGN KEY ("receiptId") REFERENCES "MaterialPurchaseOrderReceipt"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'MaterialPurchaseOrderReceiptItem_purchaseOrderItemId_fkey'
  ) THEN
    ALTER TABLE "MaterialPurchaseOrderReceiptItem"
      ADD CONSTRAINT "MaterialPurchaseOrderReceiptItem_purchaseOrderItemId_fkey"
      FOREIGN KEY ("purchaseOrderItemId") REFERENCES "MaterialPurchaseOrderItem"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
