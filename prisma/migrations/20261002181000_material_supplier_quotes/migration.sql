-- OWNER-recorded dated supplier quotes for the same catalog material.
-- Append-only. Additive only. Prisma migrate is the authoritative source.
-- Application request paths must not run CREATE/ALTER/INDEX DDL.
-- Never scraped, never a live retailer order, and never rewritten onto
-- SENT / APPROVED estimate or invoice snapshots.

CREATE TABLE IF NOT EXISTS "MaterialSupplierQuote" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "quotedAt" TIMESTAMP(3) NOT NULL,
    "unit" TEXT NOT NULL,
    "unitPrice" DECIMAL(65,30) NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "deliveryCost" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "availability" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaterialSupplierQuote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MaterialSupplierQuote_businessId_idx"
  ON "MaterialSupplierQuote"("businessId");

CREATE INDEX IF NOT EXISTS "MaterialSupplierQuote_materialId_quotedAt_idx"
  ON "MaterialSupplierQuote"("materialId", "quotedAt");

CREATE INDEX IF NOT EXISTS "MaterialSupplierQuote_supplierId_idx"
  ON "MaterialSupplierQuote"("supplierId");

ALTER TABLE "MaterialPurchaseListItem"
  ADD COLUMN IF NOT EXISTS "selectedQuoteId" TEXT;

CREATE INDEX IF NOT EXISTS "MaterialPurchaseListItem_selectedQuoteId_idx"
  ON "MaterialPurchaseListItem"("selectedQuoteId");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'MaterialSupplierQuote_businessId_fkey'
    ) THEN
        ALTER TABLE "MaterialSupplierQuote"
          ADD CONSTRAINT "MaterialSupplierQuote_businessId_fkey"
          FOREIGN KEY ("businessId") REFERENCES "Business"("id")
          ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'MaterialSupplierQuote_materialId_fkey'
    ) THEN
        ALTER TABLE "MaterialSupplierQuote"
          ADD CONSTRAINT "MaterialSupplierQuote_materialId_fkey"
          FOREIGN KEY ("materialId") REFERENCES "MaterialCatalogItem"("id")
          ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'MaterialSupplierQuote_supplierId_fkey'
    ) THEN
        ALTER TABLE "MaterialSupplierQuote"
          ADD CONSTRAINT "MaterialSupplierQuote_supplierId_fkey"
          FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id")
          ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'MaterialPurchaseListItem_selectedQuoteId_fkey'
    ) THEN
        ALTER TABLE "MaterialPurchaseListItem"
          ADD CONSTRAINT "MaterialPurchaseListItem_selectedQuoteId_fkey"
          FOREIGN KEY ("selectedQuoteId") REFERENCES "MaterialSupplierQuote"("id")
          ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;
