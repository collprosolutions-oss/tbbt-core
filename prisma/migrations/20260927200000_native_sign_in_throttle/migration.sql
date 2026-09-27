-- Durable native password-attempt counter. Additive only.
-- Preview shares Production and skips migrate, so CREATE is IF NOT EXISTS.
-- No request-time DDL. Stores only a hashed subject, never a raw email.

CREATE TABLE IF NOT EXISTS "NativeSignInThrottle" (
  "id" TEXT NOT NULL,
  "subjectHash" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "failedAttemptCount" INTEGER NOT NULL DEFAULT 0,
  "windowStartedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NativeSignInThrottle_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "NativeSignInThrottle_subjectHash_purpose_key"
  ON "NativeSignInThrottle"("subjectHash", "purpose");

CREATE INDEX IF NOT EXISTS "NativeSignInThrottle_expiresAt_idx"
  ON "NativeSignInThrottle"("expiresAt");
