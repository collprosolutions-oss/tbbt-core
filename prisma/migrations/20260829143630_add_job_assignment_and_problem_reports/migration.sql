-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "assignedMembershipId" TEXT;

-- CreateTable
CREATE TABLE "JobProblemReport" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobProblemReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobProblemReport_businessId_idx" ON "JobProblemReport"("businessId");

-- CreateIndex
CREATE INDEX "JobProblemReport_jobId_idx" ON "JobProblemReport"("jobId");

-- CreateIndex
CREATE INDEX "JobProblemReport_membershipId_idx" ON "JobProblemReport"("membershipId");

-- CreateIndex
CREATE INDEX "Job_assignedMembershipId_idx" ON "Job"("assignedMembershipId");

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_assignedMembershipId_fkey" FOREIGN KEY ("assignedMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobProblemReport" ADD CONSTRAINT "JobProblemReport_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobProblemReport" ADD CONSTRAINT "JobProblemReport_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobProblemReport" ADD CONSTRAINT "JobProblemReport_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;
