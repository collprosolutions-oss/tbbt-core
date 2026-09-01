-- CreateTable
CREATE TABLE "PublicSiteImage" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "page" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "imageUrl" TEXT,
    "objectPosition" TEXT NOT NULL DEFAULT '50% 50%',
    "updatedByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublicSiteImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PublicSiteImage_businessId_page_slot_key" ON "PublicSiteImage"("businessId", "page", "slot");

-- CreateIndex
CREATE INDEX "PublicSiteImage_businessId_page_idx" ON "PublicSiteImage"("businessId", "page");

-- AddForeignKey
ALTER TABLE "PublicSiteImage" ADD CONSTRAINT "PublicSiteImage_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicSiteImage" ADD CONSTRAINT "PublicSiteImage_updatedByMembershipId_fkey" FOREIGN KEY ("updatedByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
