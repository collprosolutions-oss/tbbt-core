-- Additive origin on CustomerFollowUp. Existing rows stay COMMUNICATION
-- and remain eligible for CUSTOMER_FOLLOW_UP_DUE scans. RETENTION_TASK
-- is owner-recorded work and is unique per business/customer/job.
ALTER TABLE "CustomerFollowUp" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'COMMUNICATION';

CREATE INDEX "CustomerFollowUp_businessId_origin_status_idx"
ON "CustomerFollowUp"("businessId", "origin", "status");

CREATE UNIQUE INDEX "CustomerFollowUp_retention_task_business_customer_job_key"
ON "CustomerFollowUp"("businessId", "customerId", "jobId")
WHERE "origin" = 'RETENTION_TASK' AND "jobId" IS NOT NULL;
