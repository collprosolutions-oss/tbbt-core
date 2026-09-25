-- Additive scheduling capacity, workforce profile, and internal Fill-In Bench.
-- Preview shares Production and skips migrate, so every statement is IF NOT EXISTS.
-- Existing Membership, Job, and BusinessSettings rows are preserved.

ALTER TABLE "Membership" ADD COLUMN IF NOT EXISTS "schedulingActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Membership" ADD COLUMN IF NOT EXISTS "progression" TEXT NOT NULL DEFAULT 'CAPABLE';
ALTER TABLE "Membership" ADD COLUMN IF NOT EXISTS "maxDailyJobMinutes" INTEGER;
ALTER TABLE "Membership" ADD COLUMN IF NOT EXISTS "preferredJobTypes" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Membership" ADD COLUMN IF NOT EXISTS "allowedJobTypes" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Membership" ADD COLUMN IF NOT EXISTS "workforceNotes" TEXT NOT NULL DEFAULT '';

ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "pickupDurationMinutes" INTEGER;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "arrivalWindowMinutes" INTEGER;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "requiredSkills" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "requiredProgression" TEXT NOT NULL DEFAULT '';

ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "firstAppointmentMode" TEXT NOT NULL DEFAULT 'EXACT';
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "laterAppointmentMode" TEXT NOT NULL DEFAULT 'WINDOW';
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "defaultArrivalWindowMinutes" INTEGER NOT NULL DEFAULT 120;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "dayBeforeChangeCutoffHours" INTEGER NOT NULL DEFAULT 24;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "defaultPickupMinutes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "travelPlaceholderMinutes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "helperRecommendationThresholdMinutes" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "overloadThresholdPercent" INTEGER NOT NULL DEFAULT 90;

CREATE TABLE IF NOT EXISTS "MembershipSkill" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "skillKey" TEXT NOT NULL,
    "proficiency" TEXT NOT NULL DEFAULT 'CAPABLE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MembershipSkill_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MembershipSkill_membershipId_skillKey_key"
  ON "MembershipSkill"("membershipId", "skillKey");
CREATE INDEX IF NOT EXISTS "MembershipSkill_businessId_idx" ON "MembershipSkill"("businessId");

CREATE TABLE IF NOT EXISTS "MembershipWeeklyAvailability" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startMinutes" INTEGER NOT NULL,
    "endMinutes" INTEGER NOT NULL,
    CONSTRAINT "MembershipWeeklyAvailability_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MembershipWeeklyAvailability_membershipId_weekday_key"
  ON "MembershipWeeklyAvailability"("membershipId", "weekday");
CREATE INDEX IF NOT EXISTS "MembershipWeeklyAvailability_businessId_idx"
  ON "MembershipWeeklyAvailability"("businessId");

CREATE TABLE IF NOT EXISTS "MembershipAvailabilityException" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "startMinutes" INTEGER,
    "endMinutes" INTEGER,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MembershipAvailabilityException_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MembershipAvailabilityException_membershipId_date_key"
  ON "MembershipAvailabilityException"("membershipId", "date");
CREATE INDEX IF NOT EXISTS "MembershipAvailabilityException_businessId_idx"
  ON "MembershipAvailabilityException"("businessId");

CREATE TABLE IF NOT EXISTS "FillInBenchWorker" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "contactPreference" TEXT NOT NULL DEFAULT 'PHONE',
    "contactValue" TEXT NOT NULL DEFAULT '',
    "skills" TEXT NOT NULL DEFAULT '',
    "availabilityNotes" TEXT NOT NULL DEFAULT '',
    "approved" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "notes" TEXT NOT NULL DEFAULT '',
    "membershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FillInBenchWorker_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "FillInBenchWorker_businessId_idx" ON "FillInBenchWorker"("businessId");
CREATE INDEX IF NOT EXISTS "FillInBenchWorker_membershipId_idx" ON "FillInBenchWorker"("membershipId");

CREATE TABLE IF NOT EXISTS "WorkforceOutreachTask" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "kind" TEXT NOT NULL,
    "jobId" TEXT,
    "benchWorkerId" TEXT,
    "missingSkills" TEXT NOT NULL DEFAULT '',
    "missingMinutes" INTEGER,
    "explanation" TEXT NOT NULL,
    "createdByMembershipId" TEXT,
    "approvedByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WorkforceOutreachTask_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "WorkforceOutreachTask_businessId_idx" ON "WorkforceOutreachTask"("businessId");
CREATE INDEX IF NOT EXISTS "WorkforceOutreachTask_jobId_idx" ON "WorkforceOutreachTask"("jobId");
CREATE INDEX IF NOT EXISTS "WorkforceOutreachTask_benchWorkerId_idx" ON "WorkforceOutreachTask"("benchWorkerId");
