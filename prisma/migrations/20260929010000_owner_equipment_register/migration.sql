-- Trade-neutral OWNER equipment register for tools and vehicles.
-- Additive only. Preview shares Production and skips migrate, so every
-- statement is IF NOT EXISTS. No backfill. Existing businesses keep zero rows.
-- Inspected MaterialCatalogItem / Expense first: this is not inventory stock,
-- not a material purchase list, not telemetry, depreciation, tax treatment,
-- or automated reminders. Optional purchaseExpenseId may reference one
-- same-business Expense. Timestamp is 20260929010000 so it sits after
-- 20260928200000_estimate_line_template_archive (#210).

CREATE TABLE IF NOT EXISTS "EquipmentItem" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "purchaseExpenseId" TEXT,
    "serviceOn" TIMESTAMP(3),
    "createdByMembershipId" TEXT,
    "attemptKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EquipmentItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "EquipmentMaintenanceEntry" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "occurredOn" TIMESTAMP(3) NOT NULL,
    "notes" TEXT NOT NULL,
    "createdByMembershipId" TEXT,
    "attemptKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EquipmentMaintenanceEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "EquipmentItem_purchaseExpenseId_key"
  ON "EquipmentItem"("purchaseExpenseId");
CREATE UNIQUE INDEX IF NOT EXISTS "EquipmentItem_businessId_attemptKey_key"
  ON "EquipmentItem"("businessId", "attemptKey");
CREATE INDEX IF NOT EXISTS "EquipmentItem_businessId_idx"
  ON "EquipmentItem"("businessId");
CREATE INDEX IF NOT EXISTS "EquipmentItem_businessId_serviceOn_idx"
  ON "EquipmentItem"("businessId", "serviceOn");
CREATE INDEX IF NOT EXISTS "EquipmentItem_businessId_kind_idx"
  ON "EquipmentItem"("businessId", "kind");
CREATE INDEX IF NOT EXISTS "EquipmentItem_createdByMembershipId_idx"
  ON "EquipmentItem"("createdByMembershipId");

CREATE UNIQUE INDEX IF NOT EXISTS "EquipmentMaintenanceEntry_businessId_attemptKey_key"
  ON "EquipmentMaintenanceEntry"("businessId", "attemptKey");
CREATE INDEX IF NOT EXISTS "EquipmentMaintenanceEntry_businessId_idx"
  ON "EquipmentMaintenanceEntry"("businessId");
CREATE INDEX IF NOT EXISTS "EquipmentMaintenanceEntry_equipmentId_occurredOn_idx"
  ON "EquipmentMaintenanceEntry"("equipmentId", "occurredOn");
CREATE INDEX IF NOT EXISTS "EquipmentMaintenanceEntry_createdByMembershipId_idx"
  ON "EquipmentMaintenanceEntry"("createdByMembershipId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'EquipmentItem_businessId_fkey'
  ) THEN
    ALTER TABLE "EquipmentItem"
      ADD CONSTRAINT "EquipmentItem_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'EquipmentItem_purchaseExpenseId_fkey'
  ) THEN
    ALTER TABLE "EquipmentItem"
      ADD CONSTRAINT "EquipmentItem_purchaseExpenseId_fkey"
      FOREIGN KEY ("purchaseExpenseId") REFERENCES "Expense"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'EquipmentItem_createdByMembershipId_fkey'
  ) THEN
    ALTER TABLE "EquipmentItem"
      ADD CONSTRAINT "EquipmentItem_createdByMembershipId_fkey"
      FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'EquipmentMaintenanceEntry_businessId_fkey'
  ) THEN
    ALTER TABLE "EquipmentMaintenanceEntry"
      ADD CONSTRAINT "EquipmentMaintenanceEntry_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'EquipmentMaintenanceEntry_equipmentId_fkey'
  ) THEN
    ALTER TABLE "EquipmentMaintenanceEntry"
      ADD CONSTRAINT "EquipmentMaintenanceEntry_equipmentId_fkey"
      FOREIGN KEY ("equipmentId") REFERENCES "EquipmentItem"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'EquipmentMaintenanceEntry_createdByMembershipId_fkey'
  ) THEN
    ALTER TABLE "EquipmentMaintenanceEntry"
      ADD CONSTRAINT "EquipmentMaintenanceEntry_createdByMembershipId_fkey"
      FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
