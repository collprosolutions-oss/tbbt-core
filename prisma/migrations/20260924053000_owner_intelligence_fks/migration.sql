-- Additive FKs and delivery-status columns. Production migrate is the
-- source of truth. Preview does not run this as request-time DDL.

ALTER TABLE "ReferralRequest" ADD COLUMN IF NOT EXISTS "lastEmailStatus" TEXT;
ALTER TABLE "ReferralRequest" ADD COLUMN IF NOT EXISTS "lastSmsStatus" TEXT;

ALTER TABLE "CustomerFollowUp" ADD COLUMN IF NOT EXISTS "sentAt" TIMESTAMP(3);
ALTER TABLE "CustomerFollowUp" ADD COLUMN IF NOT EXISTS "lastEmailStatus" TEXT;
ALTER TABLE "CustomerFollowUp" ADD COLUMN IF NOT EXISTS "lastSmsStatus" TEXT;

CREATE INDEX IF NOT EXISTS "ReferralRequest_jobId_idx" ON "ReferralRequest"("jobId");
CREATE INDEX IF NOT EXISTS "CustomerFollowUp_jobId_idx" ON "CustomerFollowUp"("jobId");
CREATE INDEX IF NOT EXISTS "CustomerFollowUp_createdByMembershipId_idx" ON "CustomerFollowUp"("createdByMembershipId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ReferralRequest_jobId_fkey') THEN
    ALTER TABLE "ReferralRequest" ADD CONSTRAINT "ReferralRequest_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomerFollowUp_customerId_fkey') THEN
    ALTER TABLE "CustomerFollowUp" ADD CONSTRAINT "CustomerFollowUp_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomerFollowUp_jobId_fkey') THEN
    ALTER TABLE "CustomerFollowUp" ADD CONSTRAINT "CustomerFollowUp_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomerFollowUp_createdByMembershipId_fkey') THEN
    ALTER TABLE "CustomerFollowUp" ADD CONSTRAINT "CustomerFollowUp_createdByMembershipId_fkey" FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
