-- Materials, suppliers, price history, purchase lists, and lightweight POs.
-- Additive only. Prisma migrate is the authoritative schema source.
-- Application request paths must not run CREATE/ALTER/INDEX DDL.
-- Never stores supplier passwords or API secrets.

CREATE TABLE IF NOT EXISTS "Supplier" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "website" TEXT,
    "accountReference" TEXT,
    "preferred" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "categories" TEXT,
    "locationDescription" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Supplier_businessId_idx"
  ON "Supplier"("businessId");

CREATE INDEX IF NOT EXISTS "Supplier_businessId_active_idx"
  ON "Supplier"("businessId", "active");

CREATE TABLE IF NOT EXISTS "MaterialCatalogItem" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "sku" TEXT,
    "unit" TEXT NOT NULL,
    "packSize" DECIMAL(65,30),
    "preferredSupplierId" TEXT,
    "lastKnownCost" DECIMAL(65,30),
    "lastKnownCostAt" TIMESTAMP(3),
    "notes" TEXT,
    "category" TEXT,
    "takeoffIdentity" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaterialCatalogItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MaterialCatalogItem_businessId_idx"
  ON "MaterialCatalogItem"("businessId");

CREATE INDEX IF NOT EXISTS "MaterialCatalogItem_businessId_normalizedName_idx"
  ON "MaterialCatalogItem"("businessId", "normalizedName");

CREATE INDEX IF NOT EXISTS "MaterialCatalogItem_preferredSupplierId_idx"
  ON "MaterialCatalogItem"("preferredSupplierId");

CREATE TABLE IF NOT EXISTS "MaterialPriceHistory" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "supplierId" TEXT,
    "unit" TEXT NOT NULL,
    "packSize" DECIMAL(65,30),
    "price" DECIMAL(65,30) NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "purchaseListItemId" TEXT,
    "expenseId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaterialPriceHistory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MaterialPriceHistory_businessId_idx"
  ON "MaterialPriceHistory"("businessId");

CREATE INDEX IF NOT EXISTS "MaterialPriceHistory_materialId_observedAt_idx"
  ON "MaterialPriceHistory"("materialId", "observedAt");

CREATE INDEX IF NOT EXISTS "MaterialPriceHistory_supplierId_idx"
  ON "MaterialPriceHistory"("supplierId");

CREATE INDEX IF NOT EXISTS "MaterialPriceHistory_purchaseListItemId_idx"
  ON "MaterialPriceHistory"("purchaseListItemId");

CREATE INDEX IF NOT EXISTS "MaterialPriceHistory_expenseId_idx"
  ON "MaterialPriceHistory"("expenseId");

CREATE TABLE IF NOT EXISTS "MaterialPurchaseList" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "jobId" TEXT,
    "estimateId" TEXT,
    "estimateVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaterialPurchaseList_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MaterialPurchaseList_businessId_idx"
  ON "MaterialPurchaseList"("businessId");

CREATE INDEX IF NOT EXISTS "MaterialPurchaseList_jobId_idx"
  ON "MaterialPurchaseList"("jobId");

CREATE INDEX IF NOT EXISTS "MaterialPurchaseList_estimateId_idx"
  ON "MaterialPurchaseList"("estimateId");

CREATE INDEX IF NOT EXISTS "MaterialPurchaseList_estimateVersionId_idx"
  ON "MaterialPurchaseList"("estimateVersionId");

CREATE UNIQUE INDEX IF NOT EXISTS "MaterialPurchaseList_businessId_jobId_key"
  ON "MaterialPurchaseList"("businessId", "jobId");

CREATE UNIQUE INDEX IF NOT EXISTS "MaterialPurchaseList_businessId_estimateId_key"
  ON "MaterialPurchaseList"("businessId", "estimateId");

CREATE TABLE IF NOT EXISTS "MaterialPurchaseListItem" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "purchaseListId" TEXT NOT NULL,
    "materialId" TEXT,
    "supplierId" TEXT,
    "lineItemId" TEXT,
    "takeoffItemId" TEXT,
    "sourceKey" TEXT,
    "name" TEXT NOT NULL,
    "quantityNeeded" DECIMAL(65,30) NOT NULL,
    "unit" TEXT NOT NULL,
    "plannedUnitCost" DECIMAL(65,30),
    "plannedCost" DECIMAL(65,30),
    "quantityPurchased" DECIMAL(65,30),
    "actualUnitCost" DECIMAL(65,30),
    "actualCost" DECIMAL(65,30),
    "markupPercent" DECIMAL(65,30),
    "customerUnitPrice" DECIMAL(65,30),
    "estimatedQuantity" DECIMAL(65,30),
    "estimatedCost" DECIMAL(65,30),
    "pickupRequired" BOOLEAN NOT NULL DEFAULT false,
    "pickupLocationDescription" TEXT,
    "pickupDurationMinutes" INTEGER,
    "pickupReady" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'NEEDED',
    "expenseId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaterialPurchaseListItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MaterialPurchaseListItem_expenseId_key"
  ON "MaterialPurchaseListItem"("expenseId");

CREATE INDEX IF NOT EXISTS "MaterialPurchaseListItem_businessId_idx"
  ON "MaterialPurchaseListItem"("businessId");

CREATE INDEX IF NOT EXISTS "MaterialPurchaseListItem_purchaseListId_idx"
  ON "MaterialPurchaseListItem"("purchaseListId");

CREATE INDEX IF NOT EXISTS "MaterialPurchaseListItem_materialId_idx"
  ON "MaterialPurchaseListItem"("materialId");

CREATE INDEX IF NOT EXISTS "MaterialPurchaseListItem_supplierId_idx"
  ON "MaterialPurchaseListItem"("supplierId");

CREATE INDEX IF NOT EXISTS "MaterialPurchaseListItem_lineItemId_idx"
  ON "MaterialPurchaseListItem"("lineItemId");

CREATE UNIQUE INDEX IF NOT EXISTS "MaterialPurchaseListItem_businessId_purchaseListId_sourceKey_key"
  ON "MaterialPurchaseListItem"("businessId", "purchaseListId", "sourceKey");

CREATE TABLE IF NOT EXISTS "MaterialPurchaseOrder" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "purchaseListId" TEXT NOT NULL,
    "supplierId" TEXT,
    "jobId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "orderedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaterialPurchaseOrder_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MaterialPurchaseOrder_businessId_idx"
  ON "MaterialPurchaseOrder"("businessId");

CREATE INDEX IF NOT EXISTS "MaterialPurchaseOrder_purchaseListId_idx"
  ON "MaterialPurchaseOrder"("purchaseListId");

CREATE INDEX IF NOT EXISTS "MaterialPurchaseOrder_supplierId_idx"
  ON "MaterialPurchaseOrder"("supplierId");

CREATE INDEX IF NOT EXISTS "MaterialPurchaseOrder_jobId_idx"
  ON "MaterialPurchaseOrder"("jobId");

CREATE TABLE IF NOT EXISTS "MaterialPurchaseOrderItem" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "purchaseListItemId" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "unitCost" DECIMAL(65,30),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaterialPurchaseOrderItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MaterialPurchaseOrderItem_businessId_idx"
  ON "MaterialPurchaseOrderItem"("businessId");

CREATE INDEX IF NOT EXISTS "MaterialPurchaseOrderItem_purchaseOrderId_idx"
  ON "MaterialPurchaseOrderItem"("purchaseOrderId");

CREATE INDEX IF NOT EXISTS "MaterialPurchaseOrderItem_purchaseListItemId_idx"
  ON "MaterialPurchaseOrderItem"("purchaseListItemId");

CREATE UNIQUE INDEX IF NOT EXISTS "MaterialPurchaseOrderItem_purchaseOrderId_purchaseListItemId_key"
  ON "MaterialPurchaseOrderItem"("purchaseOrderId", "purchaseListItemId");

CREATE TABLE IF NOT EXISTS "MaterialOperationAttempt" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "attemptKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "purchaseListId" TEXT,
    "purchaseOrderId" TEXT,
    "purchaseListItemId" TEXT,
    "expenseId" TEXT,
    "createdCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaterialOperationAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MaterialOperationAttempt_businessId_attemptKey_key"
  ON "MaterialOperationAttempt"("businessId", "attemptKey");

CREATE INDEX IF NOT EXISTS "MaterialOperationAttempt_businessId_idx"
  ON "MaterialOperationAttempt"("businessId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Supplier_businessId_fkey'
  ) THEN
    ALTER TABLE "Supplier"
      ADD CONSTRAINT "Supplier_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MaterialCatalogItem_businessId_fkey'
  ) THEN
    ALTER TABLE "MaterialCatalogItem"
      ADD CONSTRAINT "MaterialCatalogItem_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MaterialCatalogItem_preferredSupplierId_fkey'
  ) THEN
    ALTER TABLE "MaterialCatalogItem"
      ADD CONSTRAINT "MaterialCatalogItem_preferredSupplierId_fkey"
      FOREIGN KEY ("preferredSupplierId") REFERENCES "Supplier"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MaterialPriceHistory_businessId_fkey'
  ) THEN
    ALTER TABLE "MaterialPriceHistory"
      ADD CONSTRAINT "MaterialPriceHistory_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MaterialPriceHistory_materialId_fkey'
  ) THEN
    ALTER TABLE "MaterialPriceHistory"
      ADD CONSTRAINT "MaterialPriceHistory_materialId_fkey"
      FOREIGN KEY ("materialId") REFERENCES "MaterialCatalogItem"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MaterialPriceHistory_supplierId_fkey'
  ) THEN
    ALTER TABLE "MaterialPriceHistory"
      ADD CONSTRAINT "MaterialPriceHistory_supplierId_fkey"
      FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MaterialPurchaseList_businessId_fkey'
  ) THEN
    ALTER TABLE "MaterialPurchaseList"
      ADD CONSTRAINT "MaterialPurchaseList_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MaterialPurchaseList_jobId_fkey'
  ) THEN
    ALTER TABLE "MaterialPurchaseList"
      ADD CONSTRAINT "MaterialPurchaseList_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "Job"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MaterialPurchaseList_estimateId_fkey'
  ) THEN
    ALTER TABLE "MaterialPurchaseList"
      ADD CONSTRAINT "MaterialPurchaseList_estimateId_fkey"
      FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MaterialPurchaseList_estimateVersionId_fkey'
  ) THEN
    ALTER TABLE "MaterialPurchaseList"
      ADD CONSTRAINT "MaterialPurchaseList_estimateVersionId_fkey"
      FOREIGN KEY ("estimateVersionId") REFERENCES "EstimateVersion"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MaterialPurchaseListItem_businessId_fkey'
  ) THEN
    ALTER TABLE "MaterialPurchaseListItem"
      ADD CONSTRAINT "MaterialPurchaseListItem_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MaterialPurchaseListItem_purchaseListId_fkey'
  ) THEN
    ALTER TABLE "MaterialPurchaseListItem"
      ADD CONSTRAINT "MaterialPurchaseListItem_purchaseListId_fkey"
      FOREIGN KEY ("purchaseListId") REFERENCES "MaterialPurchaseList"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MaterialPurchaseListItem_materialId_fkey'
  ) THEN
    ALTER TABLE "MaterialPurchaseListItem"
      ADD CONSTRAINT "MaterialPurchaseListItem_materialId_fkey"
      FOREIGN KEY ("materialId") REFERENCES "MaterialCatalogItem"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MaterialPurchaseListItem_supplierId_fkey'
  ) THEN
    ALTER TABLE "MaterialPurchaseListItem"
      ADD CONSTRAINT "MaterialPurchaseListItem_supplierId_fkey"
      FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MaterialPurchaseListItem_lineItemId_fkey'
  ) THEN
    ALTER TABLE "MaterialPurchaseListItem"
      ADD CONSTRAINT "MaterialPurchaseListItem_lineItemId_fkey"
      FOREIGN KEY ("lineItemId") REFERENCES "LineItem"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MaterialPurchaseListItem_expenseId_fkey'
  ) THEN
    ALTER TABLE "MaterialPurchaseListItem"
      ADD CONSTRAINT "MaterialPurchaseListItem_expenseId_fkey"
      FOREIGN KEY ("expenseId") REFERENCES "Expense"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MaterialPriceHistory_purchaseListItemId_fkey'
  ) THEN
    ALTER TABLE "MaterialPriceHistory"
      ADD CONSTRAINT "MaterialPriceHistory_purchaseListItemId_fkey"
      FOREIGN KEY ("purchaseListItemId") REFERENCES "MaterialPurchaseListItem"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MaterialPurchaseOrder_businessId_fkey'
  ) THEN
    ALTER TABLE "MaterialPurchaseOrder"
      ADD CONSTRAINT "MaterialPurchaseOrder_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MaterialPurchaseOrder_purchaseListId_fkey'
  ) THEN
    ALTER TABLE "MaterialPurchaseOrder"
      ADD CONSTRAINT "MaterialPurchaseOrder_purchaseListId_fkey"
      FOREIGN KEY ("purchaseListId") REFERENCES "MaterialPurchaseList"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MaterialPurchaseOrder_supplierId_fkey'
  ) THEN
    ALTER TABLE "MaterialPurchaseOrder"
      ADD CONSTRAINT "MaterialPurchaseOrder_supplierId_fkey"
      FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MaterialPurchaseOrder_jobId_fkey'
  ) THEN
    ALTER TABLE "MaterialPurchaseOrder"
      ADD CONSTRAINT "MaterialPurchaseOrder_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "Job"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MaterialPurchaseOrderItem_businessId_fkey'
  ) THEN
    ALTER TABLE "MaterialPurchaseOrderItem"
      ADD CONSTRAINT "MaterialPurchaseOrderItem_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MaterialPurchaseOrderItem_purchaseOrderId_fkey'
  ) THEN
    ALTER TABLE "MaterialPurchaseOrderItem"
      ADD CONSTRAINT "MaterialPurchaseOrderItem_purchaseOrderId_fkey"
      FOREIGN KEY ("purchaseOrderId") REFERENCES "MaterialPurchaseOrder"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MaterialPurchaseOrderItem_purchaseListItemId_fkey'
  ) THEN
    ALTER TABLE "MaterialPurchaseOrderItem"
      ADD CONSTRAINT "MaterialPurchaseOrderItem_purchaseListItemId_fkey"
      FOREIGN KEY ("purchaseListItemId") REFERENCES "MaterialPurchaseListItem"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MaterialPriceHistory_expenseId_fkey'
  ) THEN
    ALTER TABLE "MaterialPriceHistory"
      ADD CONSTRAINT "MaterialPriceHistory_expenseId_fkey"
      FOREIGN KEY ("expenseId") REFERENCES "Expense"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MaterialOperationAttempt_businessId_fkey'
  ) THEN
    ALTER TABLE "MaterialOperationAttempt"
      ADD CONSTRAINT "MaterialOperationAttempt_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
