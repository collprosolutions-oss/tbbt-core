-- Optional owner-set due instant on CustomerFollowUp. RETENTION_TASK
-- rows may use it for the retention due/overdue view. COMMUNICATION
-- rows stay null and CUSTOMER_FOLLOW_UP_DUE scans ignore this column.
ALTER TABLE "CustomerFollowUp" ADD COLUMN IF NOT EXISTS "dueAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "CustomerFollowUp_businessId_origin_status_dueAt_idx"
ON "CustomerFollowUp"("businessId", "origin", "status", "dueAt");
