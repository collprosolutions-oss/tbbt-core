-- Additive lifecycle / completion idempotency hardening.
-- Preview shares Production and skips migrate, so every statement is IF NOT EXISTS.
-- Existing vault, agreement, and entitlement rows are preserved. No destructive statements.

ALTER TABLE "BusinessAgreement"
  ADD COLUMN IF NOT EXISTS "completionAttemptKey" TEXT;

CREATE INDEX IF NOT EXISTS "BusinessAgreement_businessId_completionAttemptKey_idx"
  ON "BusinessAgreement"("businessId", "completionAttemptKey");

CREATE TABLE IF NOT EXISTS "BusinessAgreementCompletionClaim" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "agreementId" TEXT NOT NULL,
    "attemptKey" TEXT NOT NULL,
    "signedVersionId" TEXT NOT NULL,
    "vaultRecordId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BusinessAgreementCompletionClaim_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BusinessAgreementCompletionClaim_agreementId_key"
  ON "BusinessAgreementCompletionClaim"("agreementId");
CREATE UNIQUE INDEX IF NOT EXISTS "BusinessAgreementCompletionClaim_signedVersionId_key"
  ON "BusinessAgreementCompletionClaim"("signedVersionId");
CREATE UNIQUE INDEX IF NOT EXISTS "BusinessAgreementCompletionClaim_vaultRecordId_key"
  ON "BusinessAgreementCompletionClaim"("vaultRecordId");
CREATE UNIQUE INDEX IF NOT EXISTS "BusinessAgreementCompletionClaim_businessId_attemptKey_key"
  ON "BusinessAgreementCompletionClaim"("businessId", "attemptKey");
CREATE INDEX IF NOT EXISTS "BusinessAgreementCompletionClaim_businessId_agreementId_idx"
  ON "BusinessAgreementCompletionClaim"("businessId", "agreementId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessAgreementCompletionClaim_businessId_fkey'
  ) THEN
    ALTER TABLE "BusinessAgreementCompletionClaim"
      ADD CONSTRAINT "BusinessAgreementCompletionClaim_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessAgreementCompletionClaim_agreementId_fkey'
  ) THEN
    ALTER TABLE "BusinessAgreementCompletionClaim"
      ADD CONSTRAINT "BusinessAgreementCompletionClaim_agreementId_fkey"
      FOREIGN KEY ("agreementId") REFERENCES "BusinessAgreement"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessAgreementCompletionClaim_signedVersionId_fkey'
  ) THEN
    ALTER TABLE "BusinessAgreementCompletionClaim"
      ADD CONSTRAINT "BusinessAgreementCompletionClaim_signedVersionId_fkey"
      FOREIGN KEY ("signedVersionId") REFERENCES "BusinessAgreementVersion"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessAgreementCompletionClaim_vaultRecordId_fkey'
  ) THEN
    ALTER TABLE "BusinessAgreementCompletionClaim"
      ADD CONSTRAINT "BusinessAgreementCompletionClaim_vaultRecordId_fkey"
      FOREIGN KEY ("vaultRecordId") REFERENCES "BusinessVaultRecord"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
