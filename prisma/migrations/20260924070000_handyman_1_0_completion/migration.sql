-- Handyman 1.0 completion: TOTP, session revocation, offboarding marker.
-- Additive only. Never deletes historical financial or job records.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "totpSecret" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "totpPendingSecret" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "totpEnabledAt" TIMESTAMP(3);

ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "userAgent" TEXT;
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "revokedAt" TIMESTAMP(3);

ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "offboardingRequestedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "TotpBackupCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TotpBackupCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TotpBackupCode_codeHash_key" ON "TotpBackupCode"("codeHash");
CREATE INDEX IF NOT EXISTS "TotpBackupCode_userId_idx" ON "TotpBackupCode"("userId");

CREATE TABLE IF NOT EXISTS "AuthChallenge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthChallenge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AuthChallenge_tokenHash_key" ON "AuthChallenge"("tokenHash");
CREATE INDEX IF NOT EXISTS "AuthChallenge_userId_idx" ON "AuthChallenge"("userId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'TotpBackupCode_userId_fkey'
  ) THEN
    ALTER TABLE "TotpBackupCode"
      ADD CONSTRAINT "TotpBackupCode_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AuthChallenge_userId_fkey'
  ) THEN
    ALTER TABLE "AuthChallenge"
      ADD CONSTRAINT "AuthChallenge_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
