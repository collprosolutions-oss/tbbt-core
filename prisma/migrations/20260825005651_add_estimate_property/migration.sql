-- AlterTable
ALTER TABLE "Estimate" ADD COLUMN "propertyId" TEXT;

-- CreateIndex
CREATE INDEX "Estimate_propertyId_idx" ON "Estimate"("propertyId");

-- AddForeignKey
ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;
