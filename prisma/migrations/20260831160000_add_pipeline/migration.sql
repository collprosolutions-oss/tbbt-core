-- CreateTable
CREATE TABLE "PipelineOpportunity" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "serviceRequestId" TEXT,
    "standaloneEstimateId" TEXT,
    "ownerStage" TEXT,
    "followUpOn" TIMESTAMP(3),
    "lossReason" TEXT,
    "lossReasonNote" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PipelineOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PipelineOpportunity_serviceRequestId_key" ON "PipelineOpportunity"("serviceRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "PipelineOpportunity_standaloneEstimateId_key" ON "PipelineOpportunity"("standaloneEstimateId");

-- CreateIndex
CREATE INDEX "PipelineOpportunity_businessId_idx" ON "PipelineOpportunity"("businessId");

-- CreateIndex
CREATE INDEX "PipelineOpportunity_businessId_ownerStage_idx" ON "PipelineOpportunity"("businessId", "ownerStage");

-- CreateIndex
CREATE INDEX "PipelineOpportunity_businessId_followUpOn_idx" ON "PipelineOpportunity"("businessId", "followUpOn");

-- AddForeignKey
ALTER TABLE "PipelineOpportunity" ADD CONSTRAINT "PipelineOpportunity_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineOpportunity" ADD CONSTRAINT "PipelineOpportunity_serviceRequestId_fkey" FOREIGN KEY ("serviceRequestId") REFERENCES "ServiceRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineOpportunity" ADD CONSTRAINT "PipelineOpportunity_standaloneEstimateId_fkey" FOREIGN KEY ("standaloneEstimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
