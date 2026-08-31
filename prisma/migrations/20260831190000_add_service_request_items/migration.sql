-- Multi-service public intake: requested tasks and optional photos.
-- Existing ServiceRequest rows stay readable without any items/photos.

CREATE TABLE "ServiceRequestItem" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "serviceRequestId" TEXT NOT NULL,
    "serviceCatalogItemId" TEXT,
    "customDescription" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceRequestItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ServiceRequestPhoto" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "serviceRequestId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceRequestPhoto_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ServiceRequestItem_businessId_idx" ON "ServiceRequestItem"("businessId");
CREATE INDEX "ServiceRequestItem_serviceRequestId_idx" ON "ServiceRequestItem"("serviceRequestId");
CREATE INDEX "ServiceRequestPhoto_businessId_idx" ON "ServiceRequestPhoto"("businessId");
CREATE INDEX "ServiceRequestPhoto_serviceRequestId_idx" ON "ServiceRequestPhoto"("serviceRequestId");

ALTER TABLE "ServiceRequestItem" ADD CONSTRAINT "ServiceRequestItem_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceRequestItem" ADD CONSTRAINT "ServiceRequestItem_serviceRequestId_fkey" FOREIGN KEY ("serviceRequestId") REFERENCES "ServiceRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceRequestItem" ADD CONSTRAINT "ServiceRequestItem_serviceCatalogItemId_fkey" FOREIGN KEY ("serviceCatalogItemId") REFERENCES "ServiceCatalogItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ServiceRequestPhoto" ADD CONSTRAINT "ServiceRequestPhoto_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceRequestPhoto" ADD CONSTRAINT "ServiceRequestPhoto_serviceRequestId_fkey" FOREIGN KEY ("serviceRequestId") REFERENCES "ServiceRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
