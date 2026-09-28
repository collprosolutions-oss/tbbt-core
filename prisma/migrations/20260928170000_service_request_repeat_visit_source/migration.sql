-- Existing Cleaning customers can submit one "another visit" ServiceRequest
-- from a public project-token page. Distinct from OWNER next-booking Jobs
-- (nextBookingSourceJobId) and OWNER corrective-clean Jobs.

ALTER TABLE "ServiceRequest" ADD COLUMN IF NOT EXISTS "repeatVisitSourceJobId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "ServiceRequest_repeatVisitSourceJobId_key"
ON "ServiceRequest"("repeatVisitSourceJobId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ServiceRequest_repeatVisitSourceJobId_fkey'
  ) THEN
    ALTER TABLE "ServiceRequest"
      ADD CONSTRAINT "ServiceRequest_repeatVisitSourceJobId_fkey"
      FOREIGN KEY ("repeatVisitSourceJobId") REFERENCES "Job"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
