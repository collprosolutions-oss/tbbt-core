-- AlterTable
ALTER TABLE "Estimate" ADD COLUMN     "approvedVersionId" TEXT;

-- CreateTable
CREATE TABLE "EstimateVersion" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "total" DECIMAL(65,30) NOT NULL,
    "laborMinimumWaived" BOOLEAN NOT NULL,
    "laborMinimumAdjustment" DECIMAL(65,30) NOT NULL,
    "customerName" TEXT,
    "customerEmail" TEXT,
    "customerPhone" TEXT,
    "propertyAddressLine1" TEXT,
    "propertyAddressLine2" TEXT,
    "propertyCity" TEXT,
    "propertyRegion" TEXT,
    "propertyPostalCode" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EstimateVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EstimateVersionLineItem" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "estimateVersionId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "unitPrice" DECIMAL(65,30) NOT NULL,
    "total" DECIMAL(65,30) NOT NULL,
    "type" "LineItemType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EstimateVersionLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EstimateVersion_businessId_idx" ON "EstimateVersion"("businessId");

-- CreateIndex
CREATE INDEX "EstimateVersion_estimateId_idx" ON "EstimateVersion"("estimateId");

-- CreateIndex
CREATE UNIQUE INDEX "EstimateVersion_estimateId_versionNumber_key" ON "EstimateVersion"("estimateId", "versionNumber");

-- CreateIndex
CREATE INDEX "EstimateVersionLineItem_businessId_idx" ON "EstimateVersionLineItem"("businessId");

-- CreateIndex
CREATE INDEX "EstimateVersionLineItem_estimateVersionId_idx" ON "EstimateVersionLineItem"("estimateVersionId");

-- AddForeignKey
ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_approvedVersionId_fkey" FOREIGN KEY ("approvedVersionId") REFERENCES "EstimateVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimateVersion" ADD CONSTRAINT "EstimateVersion_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimateVersion" ADD CONSTRAINT "EstimateVersion_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimateVersionLineItem" ADD CONSTRAINT "EstimateVersionLineItem_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimateVersionLineItem" ADD CONSTRAINT "EstimateVersionLineItem_estimateVersionId_fkey" FOREIGN KEY ("estimateVersionId") REFERENCES "EstimateVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
