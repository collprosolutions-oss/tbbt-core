-- AlterTable
ALTER TABLE "JobPhoto" ADD COLUMN "marketingPermissionStatus" TEXT NOT NULL DEFAULT 'PRIVATE';
ALTER TABLE "JobPhoto" ADD COLUMN "marketingPermissionGrantedAt" TIMESTAMP(3);
ALTER TABLE "JobPhoto" ADD COLUMN "marketingPermissionGrantedByMembershipId" TEXT;

-- CreateTable
CREATE TABLE "MarketingContent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "jobId" TEXT,
    "contentType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "channelIntent" TEXT NOT NULL DEFAULT 'UNASSIGNED',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "plannedFor" TIMESTAMP(3),
    "createdByMembershipId" TEXT NOT NULL,
    "reviewedByMembershipId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingContent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingContentPhoto" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "jobPhotoId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingContentPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobPhoto_businessId_marketingPermissionStatus_idx" ON "JobPhoto"("businessId", "marketingPermissionStatus");

-- CreateIndex
CREATE INDEX "MarketingContent_businessId_idx" ON "MarketingContent"("businessId");

-- CreateIndex
CREATE INDEX "MarketingContent_businessId_status_idx" ON "MarketingContent"("businessId", "status");

-- CreateIndex
CREATE INDEX "MarketingContent_businessId_plannedFor_idx" ON "MarketingContent"("businessId", "plannedFor");

-- CreateIndex
CREATE INDEX "MarketingContent_jobId_idx" ON "MarketingContent"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingContentPhoto_contentId_jobPhotoId_key" ON "MarketingContentPhoto"("contentId", "jobPhotoId");

-- CreateIndex
CREATE INDEX "MarketingContentPhoto_businessId_idx" ON "MarketingContentPhoto"("businessId");

-- CreateIndex
CREATE INDEX "MarketingContentPhoto_jobPhotoId_idx" ON "MarketingContentPhoto"("jobPhotoId");

-- AddForeignKey
ALTER TABLE "JobPhoto" ADD CONSTRAINT "JobPhoto_marketingPermissionGrantedByMembershipId_fkey" FOREIGN KEY ("marketingPermissionGrantedByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingContent" ADD CONSTRAINT "MarketingContent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingContent" ADD CONSTRAINT "MarketingContent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingContent" ADD CONSTRAINT "MarketingContent_createdByMembershipId_fkey" FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingContent" ADD CONSTRAINT "MarketingContent_reviewedByMembershipId_fkey" FOREIGN KEY ("reviewedByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingContentPhoto" ADD CONSTRAINT "MarketingContentPhoto_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingContentPhoto" ADD CONSTRAINT "MarketingContentPhoto_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "MarketingContent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingContentPhoto" ADD CONSTRAINT "MarketingContentPhoto_jobPhotoId_fkey" FOREIGN KEY ("jobPhotoId") REFERENCES "JobPhoto"("id") ON DELETE CASCADE ON UPDATE CASCADE;
