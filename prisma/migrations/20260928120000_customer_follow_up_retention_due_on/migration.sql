-- Optional owner-set calendar day on CustomerFollowUp. COMMUNICATION
-- rows stay null. RETENTION_TASK due dates are display/work dates only
-- and never emit CUSTOMER_FOLLOW_UP_DUE.
ALTER TABLE "CustomerFollowUp" ADD COLUMN IF NOT EXISTS "dueOn" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "CustomerFollowUp_businessId_origin_status_dueOn_idx"
ON "CustomerFollowUp"("businessId", "origin", "status", "dueOn");
