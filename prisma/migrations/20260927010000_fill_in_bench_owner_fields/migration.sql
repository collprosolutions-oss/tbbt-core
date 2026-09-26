-- Additive Fill-In Bench owner fields for worker type and service-area notes.
-- Preview shares Production and skips migrate, so statements are IF NOT EXISTS.
-- Existing bench rows stay intact. No destructive statements.
-- No request-time DDL. Does not create User or Membership rows.

ALTER TABLE "FillInBenchWorker"
  ADD COLUMN IF NOT EXISTS "workerType" TEXT NOT NULL DEFAULT 'BACKUP';

ALTER TABLE "FillInBenchWorker"
  ADD COLUMN IF NOT EXISTS "locationNotes" TEXT NOT NULL DEFAULT '';
