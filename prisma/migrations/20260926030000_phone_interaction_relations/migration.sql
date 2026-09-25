-- Additive PhoneInteraction FKs. requestId / jobId / followUpActionItemId
-- are concrete relations, not polymorphic strings. Server still validates
-- tenant + customer consistency before write.

CREATE INDEX IF NOT EXISTS "PhoneInteraction_requestId_idx" ON "PhoneInteraction"("requestId");
CREATE INDEX IF NOT EXISTS "PhoneInteraction_jobId_idx" ON "PhoneInteraction"("jobId");
CREATE INDEX IF NOT EXISTS "PhoneInteraction_followUpActionItemId_idx" ON "PhoneInteraction"("followUpActionItemId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PhoneInteraction_requestId_fkey'
  ) THEN
    ALTER TABLE "PhoneInteraction"
      ADD CONSTRAINT "PhoneInteraction_requestId_fkey"
      FOREIGN KEY ("requestId") REFERENCES "ServiceRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PhoneInteraction_jobId_fkey'
  ) THEN
    ALTER TABLE "PhoneInteraction"
      ADD CONSTRAINT "PhoneInteraction_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PhoneInteraction_followUpActionItemId_fkey'
  ) THEN
    ALTER TABLE "PhoneInteraction"
      ADD CONSTRAINT "PhoneInteraction_followUpActionItemId_fkey"
      FOREIGN KEY ("followUpActionItemId") REFERENCES "BusinessActionItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
