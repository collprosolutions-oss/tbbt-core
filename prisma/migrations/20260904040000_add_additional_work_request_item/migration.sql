-- Catalog selections on Additional Work requests (not description-only).
CREATE TABLE "AdditionalWorkRequestItem" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "additionalWorkRequestId" TEXT NOT NULL,
    "serviceCatalogItemId" TEXT,
    "customDescription" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdditionalWorkRequestItem_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AdditionalWorkRequestItem" ADD CONSTRAINT "AdditionalWorkRequestItem_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdditionalWorkRequestItem" ADD CONSTRAINT "AdditionalWorkRequestItem_additionalWorkRequestId_fkey" FOREIGN KEY ("additionalWorkRequestId") REFERENCES "AdditionalWorkRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdditionalWorkRequestItem" ADD CONSTRAINT "AdditionalWorkRequestItem_serviceCatalogItemId_fkey" FOREIGN KEY ("serviceCatalogItemId") REFERENCES "ServiceCatalogItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "AdditionalWorkRequestItem_businessId_idx" ON "AdditionalWorkRequestItem"("businessId");
CREATE INDEX "AdditionalWorkRequestItem_additionalWorkRequestId_idx" ON "AdditionalWorkRequestItem"("additionalWorkRequestId");
