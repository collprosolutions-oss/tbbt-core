-- Bind a native push device to the Session that registered it so
-- sign-out / session-revoke can clear the token server-side.
-- Additive only. Preview shares Production and skips migrate.
-- Timestamp 20261002193000 is after 20261002192000_native_push_alerts.

ALTER TABLE "NativePushDevice"
  ADD COLUMN IF NOT EXISTS "sessionId" TEXT;

CREATE INDEX IF NOT EXISTS "NativePushDevice_sessionId_idx"
  ON "NativePushDevice"("sessionId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'NativePushDevice_sessionId_fkey'
  ) THEN
    ALTER TABLE "NativePushDevice"
      ADD CONSTRAINT "NativePushDevice_sessionId_fkey"
      FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
