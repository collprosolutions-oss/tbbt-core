-- Customer appointment confirmation, property access, notification outcome,
-- and a small append-only appointment event history.
-- Additive only. Job.status lifecycle is unchanged.
-- Preview skips migrate, so application code also ADD COLUMN / CREATE TABLE IF NOT EXISTS.

ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "appointmentConfirmationStatus" TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "appointmentProposalId" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "appointmentConfirmedAt" TIMESTAMP(3);
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "appointmentConfirmedForProposalId" INTEGER;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "appointmentConfirmationSource" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "appointmentConfirmedByMembershipId" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "propertyAccessMethod" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "propertyAccessInstructions" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "propertyAccessContactName" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "propertyAccessContactInfo" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "propertyAccessPickupLocation" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "propertyAccessNote" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "appointmentNotificationStatus" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "appointmentNotificationError" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "appointmentNotifiedAt" TIMESTAMP(3);
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "appointmentNotifiedForProposalId" INTEGER;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "startWithoutConfirmationAt" TIMESTAMP(3);
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "startWithoutConfirmationReason" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "startWithoutConfirmationByMembershipId" TEXT;

CREATE INDEX IF NOT EXISTS "Job_appointmentConfirmedByMembershipId_idx"
  ON "Job"("appointmentConfirmedByMembershipId");
CREATE INDEX IF NOT EXISTS "Job_startWithoutConfirmationByMembershipId_idx"
  ON "Job"("startWithoutConfirmationByMembershipId");

CREATE TABLE IF NOT EXISTS "JobAppointmentEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "appointmentProposalId" INTEGER,
    "scheduledAt" TIMESTAMP(3),
    "scheduledDurationMinutes" INTEGER,
    "actorKind" TEXT NOT NULL,
    "actorMembershipId" TEXT,
    "payload" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobAppointmentEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "JobAppointmentEvent_businessId_idx"
  ON "JobAppointmentEvent"("businessId");
CREATE INDEX IF NOT EXISTS "JobAppointmentEvent_jobId_idx"
  ON "JobAppointmentEvent"("jobId");
CREATE INDEX IF NOT EXISTS "JobAppointmentEvent_businessId_createdAt_idx"
  ON "JobAppointmentEvent"("businessId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Job_appointmentConfirmedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "Job"
      ADD CONSTRAINT "Job_appointmentConfirmedByMembershipId_fkey"
      FOREIGN KEY ("appointmentConfirmedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Job_startWithoutConfirmationByMembershipId_fkey'
  ) THEN
    ALTER TABLE "Job"
      ADD CONSTRAINT "Job_startWithoutConfirmationByMembershipId_fkey"
      FOREIGN KEY ("startWithoutConfirmationByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobAppointmentEvent_businessId_fkey'
  ) THEN
    ALTER TABLE "JobAppointmentEvent"
      ADD CONSTRAINT "JobAppointmentEvent_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobAppointmentEvent_jobId_fkey'
  ) THEN
    ALTER TABLE "JobAppointmentEvent"
      ADD CONSTRAINT "JobAppointmentEvent_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "Job"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobAppointmentEvent_actorMembershipId_fkey'
  ) THEN
    ALTER TABLE "JobAppointmentEvent"
      ADD CONSTRAINT "JobAppointmentEvent_actorMembershipId_fkey"
      FOREIGN KEY ("actorMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
