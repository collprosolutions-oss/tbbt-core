-- AlterTable
ALTER TABLE "ServiceCatalogItem" ADD COLUMN "pricingMode" TEXT NOT NULL DEFAULT 'STARTING_AT';

-- AlterTable
ALTER TABLE "ServiceCatalogItem" ALTER COLUMN "price" DROP NOT NULL;
