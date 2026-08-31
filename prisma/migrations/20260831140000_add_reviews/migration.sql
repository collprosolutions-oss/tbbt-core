-- AlterTable
ALTER TABLE "MarketingContent" ADD COLUMN "reviewId" TEXT;

-- CreateTable
CREATE TABLE "ReviewRequest" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "jobId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "intendedPlatform" TEXT NOT NULL DEFAULT 'UNASSIGNED',
    "requestText" TEXT NOT NULL DEFAULT '',
    "notes" TEXT,
    "requestedAt" TIMESTAMP(3),
    "reminderAt" TIMESTAMP(3),
    "createdByMembershipId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "jobId" TEXT,
    "reviewRequestId" TEXT,
    "platform" TEXT NOT NULL,
    "rating" INTEGER,
    "reviewText" TEXT NOT NULL DEFAULT '',
    "externalReviewDate" TIMESTAMP(3),
    "externalUrl" TEXT,
    "responseStatus" TEXT NOT NULL DEFAULT 'NONE',
    "needsAttention" BOOLEAN NOT NULL DEFAULT false,
    "recoveryNotes" TEXT,
    "notes" TEXT,
    "marketingEligible" BOOLEAN NOT NULL DEFAULT false,
    "recordedByMembershipId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewResponse" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdByMembershipId" TEXT NOT NULL,
    "reviewedByMembershipId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewResponse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReviewRequest_businessId_idx" ON "ReviewRequest"("businessId");

-- CreateIndex
CREATE INDEX "ReviewRequest_businessId_status_idx" ON "ReviewRequest"("businessId", "status");

-- CreateIndex
CREATE INDEX "ReviewRequest_customerId_idx" ON "ReviewRequest"("customerId");

-- CreateIndex
CREATE INDEX "ReviewRequest_jobId_idx" ON "ReviewRequest"("jobId");

-- CreateIndex
CREATE INDEX "Review_businessId_idx" ON "Review"("businessId");

-- CreateIndex
CREATE INDEX "Review_businessId_needsAttention_idx" ON "Review"("businessId", "needsAttention");

-- CreateIndex
CREATE INDEX "Review_customerId_idx" ON "Review"("customerId");

-- CreateIndex
CREATE INDEX "Review_jobId_idx" ON "Review"("jobId");

-- CreateIndex
CREATE INDEX "Review_reviewRequestId_idx" ON "Review"("reviewRequestId");

-- CreateIndex
CREATE INDEX "ReviewResponse_businessId_idx" ON "ReviewResponse"("businessId");

-- CreateIndex
CREATE INDEX "ReviewResponse_reviewId_idx" ON "ReviewResponse"("reviewId");

-- CreateIndex
CREATE INDEX "MarketingContent_reviewId_idx" ON "MarketingContent"("reviewId");

-- AddForeignKey
ALTER TABLE "MarketingContent" ADD CONSTRAINT "MarketingContent_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRequest" ADD CONSTRAINT "ReviewRequest_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRequest" ADD CONSTRAINT "ReviewRequest_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRequest" ADD CONSTRAINT "ReviewRequest_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRequest" ADD CONSTRAINT "ReviewRequest_createdByMembershipId_fkey" FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_reviewRequestId_fkey" FOREIGN KEY ("reviewRequestId") REFERENCES "ReviewRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_recordedByMembershipId_fkey" FOREIGN KEY ("recordedByMembershipId") REFERENCES "Membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewResponse" ADD CONSTRAINT "ReviewResponse_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewResponse" ADD CONSTRAINT "ReviewResponse_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewResponse" ADD CONSTRAINT "ReviewResponse_createdByMembershipId_fkey" FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewResponse" ADD CONSTRAINT "ReviewResponse_reviewedByMembershipId_fkey" FOREIGN KEY ("reviewedByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
