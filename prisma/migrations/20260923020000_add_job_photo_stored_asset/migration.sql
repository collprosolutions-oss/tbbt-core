-- AlterTable
ALTER TABLE "JobPhoto" ADD COLUMN "storedAssetId" TEXT;

-- CreateIndex
CREATE INDEX "JobPhoto_storedAssetId_idx" ON "JobPhoto"("storedAssetId");

-- AddForeignKey
ALTER TABLE "JobPhoto" ADD CONSTRAINT "JobPhoto_storedAssetId_fkey" FOREIGN KEY ("storedAssetId") REFERENCES "StoredAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
