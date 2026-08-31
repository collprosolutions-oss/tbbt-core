-- CreateTable
CREATE TABLE "BusinessSettings" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "estimateCommunicationEnabled" BOOLEAN NOT NULL DEFAULT true,
    "scheduleNotificationEnabled" BOOLEAN NOT NULL DEFAULT true,
    "invoiceCommunicationEnabled" BOOLEAN NOT NULL DEFAULT true,
    "reviewRequestPreferenceEnabled" BOOLEAN NOT NULL DEFAULT false,
    "marketingCommunicationEnabled" BOOLEAN NOT NULL DEFAULT false,
    "notifyEstimateEvents" BOOLEAN NOT NULL DEFAULT true,
    "notifyScheduleEvents" BOOLEAN NOT NULL DEFAULT true,
    "notifyInvoiceEvents" BOOLEAN NOT NULL DEFAULT true,
    "notifyPayrollEvents" BOOLEAN NOT NULL DEFAULT true,
    "notifyTeamEvents" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettingsAuditLog" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "changedByMembershipId" TEXT NOT NULL,
    "settingArea" TEXT NOT NULL,
    "settingKey" TEXT NOT NULL,
    "previousValue" TEXT,
    "newValue" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettingsAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BusinessSettings_businessId_key" ON "BusinessSettings"("businessId");

-- CreateIndex
CREATE INDEX "SettingsAuditLog_businessId_idx" ON "SettingsAuditLog"("businessId");

-- CreateIndex
CREATE INDEX "SettingsAuditLog_businessId_settingArea_idx" ON "SettingsAuditLog"("businessId", "settingArea");

-- CreateIndex
CREATE INDEX "SettingsAuditLog_businessId_changedAt_idx" ON "SettingsAuditLog"("businessId", "changedAt");

-- AddForeignKey
ALTER TABLE "BusinessSettings" ADD CONSTRAINT "BusinessSettings_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettingsAuditLog" ADD CONSTRAINT "SettingsAuditLog_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettingsAuditLog" ADD CONSTRAINT "SettingsAuditLog_changedByMembershipId_fkey" FOREIGN KEY ("changedByMembershipId") REFERENCES "Membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
