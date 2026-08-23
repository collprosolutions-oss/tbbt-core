/*
  Warnings:

  - Added the required column `price` to the `ServiceCatalogItem` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ServiceCatalogItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" DECIMAL NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ServiceCatalogItem_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ServiceCatalogItem" ("businessId", "createdAt", "description", "id", "name", "updatedAt") SELECT "businessId", "createdAt", "description", "id", "name", "updatedAt" FROM "ServiceCatalogItem";
DROP TABLE "ServiceCatalogItem";
ALTER TABLE "new_ServiceCatalogItem" RENAME TO "ServiceCatalogItem";
CREATE INDEX "ServiceCatalogItem_businessId_idx" ON "ServiceCatalogItem"("businessId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
