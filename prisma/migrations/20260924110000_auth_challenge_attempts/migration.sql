-- Durable TOTP sign-in attempt counter. Additive only.

ALTER TABLE "AuthChallenge" ADD COLUMN IF NOT EXISTS "failedAttemptCount" INTEGER NOT NULL DEFAULT 0;
