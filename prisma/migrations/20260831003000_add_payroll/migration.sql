-- CreateTable
CREATE TABLE "PayrollRun" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "payPeriodStart" TIMESTAMP(3) NOT NULL,
    "payPeriodEnd" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "reviewedAt" TIMESTAMP(3),
    "reviewedByMembershipId" TEXT,
    "authorizedAt" TIMESTAMP(3),
    "authorizedByMembershipId" TEXT,
    "processedAt" TIMESTAMP(3),
    "processedByMembershipId" TEXT,
    "processedSource" TEXT,
    "providerReference" TEXT,
    "notes" TEXT,
    "authorizedWorkerCount" INTEGER,
    "authorizedApprovedHours" DECIMAL(65,30),
    "authorizedGrossLaborAmount" DECIMAL(65,30),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRunItem" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "payrollRunId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "timesheetWeekId" TEXT NOT NULL,
    "weekStartedAt" TIMESTAMP(3) NOT NULL,
    "regularHours" DECIMAL(65,30) NOT NULL,
    "overtimeHours" DECIMAL(65,30) NOT NULL,
    "approvedHours" DECIMAL(65,30) NOT NULL,
    "approvedHourlyWage" DECIMAL(65,30),
    "grossLaborAmount" DECIMAL(65,30),
    "readiness" TEXT NOT NULL DEFAULT 'NEEDS_ATTENTION',
    "exceptions" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollRunItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRunEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "payrollRunId" TEXT NOT NULL,
    "actorMembershipId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "previousJson" JSONB,
    "nextJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollRunEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayrollRun_businessId_idx" ON "PayrollRun"("businessId");

-- CreateIndex
CREATE INDEX "PayrollRun_businessId_status_idx" ON "PayrollRun"("businessId", "status");

-- CreateIndex
CREATE INDEX "PayrollRun_businessId_payPeriodStart_idx" ON "PayrollRun"("businessId", "payPeriodStart");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRunItem_payrollRunId_timesheetWeekId_key" ON "PayrollRunItem"("payrollRunId", "timesheetWeekId");

-- CreateIndex
CREATE INDEX "PayrollRunItem_businessId_idx" ON "PayrollRunItem"("businessId");

-- CreateIndex
CREATE INDEX "PayrollRunItem_payrollRunId_idx" ON "PayrollRunItem"("payrollRunId");

-- CreateIndex
CREATE INDEX "PayrollRunItem_membershipId_idx" ON "PayrollRunItem"("membershipId");

-- CreateIndex
CREATE INDEX "PayrollRunItem_timesheetWeekId_idx" ON "PayrollRunItem"("timesheetWeekId");

-- CreateIndex
CREATE INDEX "PayrollRunEvent_businessId_idx" ON "PayrollRunEvent"("businessId");

-- CreateIndex
CREATE INDEX "PayrollRunEvent_payrollRunId_idx" ON "PayrollRunEvent"("payrollRunId");

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_reviewedByMembershipId_fkey" FOREIGN KEY ("reviewedByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_authorizedByMembershipId_fkey" FOREIGN KEY ("authorizedByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_processedByMembershipId_fkey" FOREIGN KEY ("processedByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRunItem" ADD CONSTRAINT "PayrollRunItem_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRunItem" ADD CONSTRAINT "PayrollRunItem_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRunItem" ADD CONSTRAINT "PayrollRunItem_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRunItem" ADD CONSTRAINT "PayrollRunItem_timesheetWeekId_fkey" FOREIGN KEY ("timesheetWeekId") REFERENCES "TimesheetWeek"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRunEvent" ADD CONSTRAINT "PayrollRunEvent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRunEvent" ADD CONSTRAINT "PayrollRunEvent_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRunEvent" ADD CONSTRAINT "PayrollRunEvent_actorMembershipId_fkey" FOREIGN KEY ("actorMembershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;
