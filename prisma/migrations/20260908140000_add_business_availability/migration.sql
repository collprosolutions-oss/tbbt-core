-- Business working hours, working days, scheduling buffer, and unavailable dates.
-- Additive only. Existing Job.scheduledAt / scheduledDurationMinutes are unchanged.

ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "workStartMinutes" INTEGER NOT NULL DEFAULT 480;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "workEndMinutes" INTEGER NOT NULL DEFAULT 1020;
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "workingWeekdays" TEXT NOT NULL DEFAULT '1,2,3,4,5';
ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "schedulingBufferMinutes" INTEGER NOT NULL DEFAULT 30;

CREATE TABLE IF NOT EXISTS "BusinessUnavailableDate" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessUnavailableDate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BusinessUnavailableDate_businessId_date_key"
  ON "BusinessUnavailableDate"("businessId", "date");

CREATE INDEX IF NOT EXISTS "BusinessUnavailableDate_businessId_idx"
  ON "BusinessUnavailableDate"("businessId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'BusinessUnavailableDate_businessId_fkey'
  ) THEN
    ALTER TABLE "BusinessUnavailableDate"
      ADD CONSTRAINT "BusinessUnavailableDate_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
