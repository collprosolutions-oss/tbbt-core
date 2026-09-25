-- Additive Growth Department hardening: owner-approval actor, logical
-- idempotency, and no request-time DDL. Preview shares Production and
-- skips migrate, so every statement is IF NOT EXISTS.

ALTER TABLE "GrowthActionRequest" ADD COLUMN IF NOT EXISTS "approvedByMembershipId" TEXT;
ALTER TABLE "GrowthActionRequest" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "GrowthActionRequest_businessId_idempotencyKey_key"
  ON "GrowthActionRequest"("businessId", "idempotencyKey");

CREATE INDEX IF NOT EXISTS "GrowthActionRequest_approvedByMembershipId_idx"
  ON "GrowthActionRequest"("approvedByMembershipId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'GrowthActionRequest_approvedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "GrowthActionRequest"
      ADD CONSTRAINT "GrowthActionRequest_approvedByMembershipId_fkey"
      FOREIGN KEY ("approvedByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
