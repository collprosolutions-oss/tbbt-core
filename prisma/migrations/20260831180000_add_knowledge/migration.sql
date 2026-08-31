-- CreateTable
CREATE TABLE "KnowledgeEntry" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceKind" TEXT,
    "sourceReferenceId" TEXT,
    "sourceLabel" TEXT,
    "trustState" TEXT NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdByMembershipId" TEXT NOT NULL,
    "lastReviewedAt" TIMESTAMP(3),
    "lastReviewedByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KnowledgeEntry_businessId_idx" ON "KnowledgeEntry"("businessId");

-- CreateIndex
CREATE INDEX "KnowledgeEntry_businessId_category_idx" ON "KnowledgeEntry"("businessId", "category");

-- CreateIndex
CREATE INDEX "KnowledgeEntry_businessId_trustState_idx" ON "KnowledgeEntry"("businessId", "trustState");

-- CreateIndex
CREATE INDEX "KnowledgeEntry_businessId_archived_idx" ON "KnowledgeEntry"("businessId", "archived");

-- AddForeignKey
ALTER TABLE "KnowledgeEntry" ADD CONSTRAINT "KnowledgeEntry_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeEntry" ADD CONSTRAINT "KnowledgeEntry_createdByMembershipId_fkey" FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeEntry" ADD CONSTRAINT "KnowledgeEntry_lastReviewedByMembershipId_fkey" FOREIGN KEY ("lastReviewedByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
