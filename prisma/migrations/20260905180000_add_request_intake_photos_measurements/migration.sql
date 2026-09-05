-- Customer-reported measurements and private request-photo asset links.
ALTER TABLE "ServiceCatalogItem" ADD COLUMN "intakeMeasurementMode" TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE "ServiceCatalogItem" ADD COLUMN "intakeMeasurementAxes" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ServiceCatalogItem" ADD COLUMN "intakeMeasurementUnit" TEXT NOT NULL DEFAULT 'IN';

ALTER TABLE "ServiceRequestPhoto" ADD COLUMN "storedAssetId" TEXT;

CREATE TABLE "ServiceRequestMeasurement" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "serviceRequestId" TEXT NOT NULL,
    "serviceRequestItemId" TEXT,
    "source" TEXT NOT NULL,
    "width" DECIMAL(10,2),
    "height" DECIMAL(10,2),
    "length" DECIMAL(10,2),
    "quantity" INTEGER,
    "unit" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),
    "verifiedByMembershipId" TEXT,

    CONSTRAINT "ServiceRequestMeasurement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ServiceRequestPhoto_storedAssetId_idx" ON "ServiceRequestPhoto"("storedAssetId");

CREATE INDEX "ServiceRequestMeasurement_businessId_idx" ON "ServiceRequestMeasurement"("businessId");
CREATE INDEX "ServiceRequestMeasurement_serviceRequestId_idx" ON "ServiceRequestMeasurement"("serviceRequestId");
CREATE INDEX "ServiceRequestMeasurement_serviceRequestItemId_idx" ON "ServiceRequestMeasurement"("serviceRequestItemId");

ALTER TABLE "ServiceRequestPhoto" ADD CONSTRAINT "ServiceRequestPhoto_storedAssetId_fkey" FOREIGN KEY ("storedAssetId") REFERENCES "StoredAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ServiceRequestMeasurement" ADD CONSTRAINT "ServiceRequestMeasurement_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceRequestMeasurement" ADD CONSTRAINT "ServiceRequestMeasurement_serviceRequestId_fkey" FOREIGN KEY ("serviceRequestId") REFERENCES "ServiceRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceRequestMeasurement" ADD CONSTRAINT "ServiceRequestMeasurement_serviceRequestItemId_fkey" FOREIGN KEY ("serviceRequestItemId") REFERENCES "ServiceRequestItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ServiceRequestMeasurement" ADD CONSTRAINT "ServiceRequestMeasurement_verifiedByMembershipId_fkey" FOREIGN KEY ("verifiedByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Existing starter-catalog blinds ask for approximate width/height.
UPDATE "ServiceCatalogItem"
SET
  "intakeMeasurementMode" = 'RECOMMENDED',
  "intakeMeasurementAxes" = 'width,height',
  "intakeMeasurementUnit" = 'IN'
WHERE name = 'Blind / Shade Installation';
