-- AlterTable
ALTER TABLE "Membership" ADD COLUMN "hourlyWage" DECIMAL(65,30);

-- CreateTable
CREATE TABLE "TimeEntry" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "jobId" TEXT,
    "activityType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "note" TEXT,
    "source" TEXT NOT NULL DEFAULT 'CLOCK',
    "approvedHours" DECIMAL(65,30),
    "approvedHourlyWage" DECIMAL(65,30),
    "approvedLaborCost" DECIMAL(65,30),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeEntryAdjustment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "timeEntryId" TEXT NOT NULL,
    "actorMembershipId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "previousJson" JSONB,
    "nextJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimeEntryAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimesheetWeek" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "weekStartedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "approvedAt" TIMESTAMP(3),
    "approvedByMembershipId" TEXT,
    "approvedHours" DECIMAL(65,30),
    "approvedHourlyWage" DECIMAL(65,30),
    "approvedLaborCost" DECIMAL(65,30),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimesheetWeek_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TimeEntry_businessId_idx" ON "TimeEntry"("businessId");

-- CreateIndex
CREATE INDEX "TimeEntry_membershipId_idx" ON "TimeEntry"("membershipId");

-- CreateIndex
CREATE INDEX "TimeEntry_jobId_idx" ON "TimeEntry"("jobId");

-- CreateIndex
CREATE INDEX "TimeEntry_businessId_membershipId_status_idx" ON "TimeEntry"("businessId", "membershipId", "status");

-- CreateIndex
CREATE INDEX "TimeEntry_businessId_startedAt_idx" ON "TimeEntry"("businessId", "startedAt");

-- CreateIndex
CREATE INDEX "TimeEntryAdjustment_businessId_idx" ON "TimeEntryAdjustment"("businessId");

-- CreateIndex
CREATE INDEX "TimeEntryAdjustment_timeEntryId_idx" ON "TimeEntryAdjustment"("timeEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "TimesheetWeek_businessId_membershipId_weekStartedAt_key" ON "TimesheetWeek"("businessId", "membershipId", "weekStartedAt");

-- CreateIndex
CREATE INDEX "TimesheetWeek_businessId_idx" ON "TimesheetWeek"("businessId");

-- CreateIndex
CREATE INDEX "TimesheetWeek_membershipId_idx" ON "TimesheetWeek"("membershipId");

-- CreateIndex
CREATE INDEX "TimesheetWeek_businessId_status_idx" ON "TimesheetWeek"("businessId", "status");

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntryAdjustment" ADD CONSTRAINT "TimeEntryAdjustment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntryAdjustment" ADD CONSTRAINT "TimeEntryAdjustment_timeEntryId_fkey" FOREIGN KEY ("timeEntryId") REFERENCES "TimeEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntryAdjustment" ADD CONSTRAINT "TimeEntryAdjustment_actorMembershipId_fkey" FOREIGN KEY ("actorMembershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetWeek" ADD CONSTRAINT "TimesheetWeek_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetWeek" ADD CONSTRAINT "TimesheetWeek_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetWeek" ADD CONSTRAINT "TimesheetWeek_approvedByMembershipId_fkey" FOREIGN KEY ("approvedByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
