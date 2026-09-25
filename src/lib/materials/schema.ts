/**
 * Preview shares Production and skips migrate, so reads/writes first
 * ensure tables exist with CREATE TABLE IF NOT EXISTS.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

const CREATE_SUPPLIER_SQL = `
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
`;

const CREATE_CATALOG_SQL = `
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
`;

const CREATE_HISTORY_SQL = `
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
`;

const CREATE_LIST_SQL = `
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
`;

const CREATE_LIST_ITEM_SQL = `
CREATE TABLE IF NOT EXISTS "MaterialPurchaseListItem" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "purchaseListId" TEXT NOT NULL,
    "materialId" TEXT,
    "supplierId" TEXT,
    "lineItemId" TEXT,
    "takeoffItemId" TEXT,
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
`;

const CREATE_PO_SQL = `
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
`;

const CREATE_PO_ITEM_SQL = `
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
`;

const ensured = new WeakSet<object>();

export async function ensureMaterialsSuppliersTables(
  db: PrismaClient | Prisma.TransactionClient,
) {
  if (ensured.has(db)) return;
  await db.$executeRawUnsafe(CREATE_SUPPLIER_SQL);
  await db.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "Supplier_businessId_idx" ON "Supplier"("businessId")`,
  );
  await db.$executeRawUnsafe(CREATE_CATALOG_SQL);
  await db.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "MaterialCatalogItem_businessId_idx" ON "MaterialCatalogItem"("businessId")`,
  );
  await db.$executeRawUnsafe(CREATE_HISTORY_SQL);
  await db.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "MaterialPriceHistory_businessId_idx" ON "MaterialPriceHistory"("businessId")`,
  );
  await db.$executeRawUnsafe(CREATE_LIST_SQL);
  await db.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "MaterialPurchaseList_businessId_idx" ON "MaterialPurchaseList"("businessId")`,
  );
  await db.$executeRawUnsafe(CREATE_LIST_ITEM_SQL);
  await db.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "MaterialPurchaseListItem_expenseId_key" ON "MaterialPurchaseListItem"("expenseId")`,
  );
  await db.$executeRawUnsafe(CREATE_PO_SQL);
  await db.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "MaterialPurchaseOrder_businessId_idx" ON "MaterialPurchaseOrder"("businessId")`,
  );
  await db.$executeRawUnsafe(CREATE_PO_ITEM_SQL);
  ensured.add(db);
}
