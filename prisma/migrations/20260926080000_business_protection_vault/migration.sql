-- Additive Business Protection / Business Vault / Agreement Coach tables.
-- Preview shares Production and skips migrate, so every statement is IF NOT EXISTS.
-- Existing tenant, storage, and entitlement rows are preserved. No destructive statements.

CREATE TABLE IF NOT EXISTS "BusinessVaultRecord" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "issuer" TEXT,
    "counterparty" TEXT,
    "effectiveOn" TEXT,
    "expiresOn" TEXT,
    "recordStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
    "persistedExpiryState" TEXT,
    "notes" TEXT,
    "storedAssetId" TEXT,
    "createdByMembershipId" TEXT NOT NULL,
    "updatedByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BusinessVaultRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BusinessVaultRecord_businessId_category_recordStatus_idx"
  ON "BusinessVaultRecord"("businessId", "category", "recordStatus");
CREATE INDEX IF NOT EXISTS "BusinessVaultRecord_businessId_expiresOn_idx"
  ON "BusinessVaultRecord"("businessId", "expiresOn");
CREATE INDEX IF NOT EXISTS "BusinessVaultRecord_storedAssetId_idx"
  ON "BusinessVaultRecord"("storedAssetId");

CREATE TABLE IF NOT EXISTS "BusinessAgreement" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "agreementType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "counterparty" TEXT,
    "lifecycleStatus" TEXT NOT NULL DEFAULT 'QUESTIONS',
    "currentDraftVersionId" TEXT,
    "signedVersionId" TEXT,
    "vaultRecordId" TEXT,
    "effectiveOn" TEXT,
    "expiresOn" TEXT,
    "signingMode" TEXT NOT NULL DEFAULT 'NOT_CONNECTED',
    "completedByMembershipId" TEXT,
    "completedAt" TIMESTAMP(3),
    "completionNotes" TEXT,
    "legalReviewAcknowledgedAt" TIMESTAMP(3),
    "legalReviewAcknowledgedByMembershipId" TEXT,
    "ownerReviewedAt" TIMESTAMP(3),
    "ownerReviewedByMembershipId" TEXT,
    "createdByMembershipId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BusinessAgreement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BusinessAgreement_currentDraftVersionId_key"
  ON "BusinessAgreement"("currentDraftVersionId");
CREATE UNIQUE INDEX IF NOT EXISTS "BusinessAgreement_signedVersionId_key"
  ON "BusinessAgreement"("signedVersionId");
CREATE INDEX IF NOT EXISTS "BusinessAgreement_businessId_lifecycleStatus_idx"
  ON "BusinessAgreement"("businessId", "lifecycleStatus");
CREATE INDEX IF NOT EXISTS "BusinessAgreement_businessId_agreementType_idx"
  ON "BusinessAgreement"("businessId", "agreementType");
CREATE INDEX IF NOT EXISTS "BusinessAgreement_vaultRecordId_idx"
  ON "BusinessAgreement"("vaultRecordId");

CREATE TABLE IF NOT EXISTS "BusinessAgreementVersion" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "agreementId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "representationStatus" TEXT NOT NULL DEFAULT 'DRAFT',
    "answersJson" TEXT NOT NULL DEFAULT '{}',
    "draftContent" TEXT NOT NULL DEFAULT '',
    "riskReviewJson" TEXT,
    "createdByMembershipId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    CONSTRAINT "BusinessAgreementVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BusinessAgreementVersion_agreementId_versionNumber_key"
  ON "BusinessAgreementVersion"("agreementId", "versionNumber");
CREATE INDEX IF NOT EXISTS "BusinessAgreementVersion_businessId_agreementId_idx"
  ON "BusinessAgreementVersion"("businessId", "agreementId");

CREATE TABLE IF NOT EXISTS "BusinessProtectionAuditLog" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "vaultRecordId" TEXT,
    "agreementId" TEXT,
    "changedByMembershipId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "previousValue" TEXT,
    "newValue" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BusinessProtectionAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BusinessProtectionAuditLog_businessId_changedAt_idx"
  ON "BusinessProtectionAuditLog"("businessId", "changedAt");
CREATE INDEX IF NOT EXISTS "BusinessProtectionAuditLog_businessId_action_idx"
  ON "BusinessProtectionAuditLog"("businessId", "action");
CREATE INDEX IF NOT EXISTS "BusinessProtectionAuditLog_vaultRecordId_idx"
  ON "BusinessProtectionAuditLog"("vaultRecordId");
CREATE INDEX IF NOT EXISTS "BusinessProtectionAuditLog_agreementId_idx"
  ON "BusinessProtectionAuditLog"("agreementId");

CREATE TABLE IF NOT EXISTS "BusinessProtectionAcknowledgment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BusinessProtectionAcknowledgment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BusinessProtectionAcknowledgment_businessId_kind_idx"
  ON "BusinessProtectionAcknowledgment"("businessId", "kind");

CREATE TABLE IF NOT EXISTS "BusinessEsignBoundary" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "providerStatus" TEXT NOT NULL DEFAULT 'NOT_CONNECTED',
    "providerName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BusinessEsignBoundary_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BusinessEsignBoundary_businessId_key"
  ON "BusinessEsignBoundary"("businessId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessVaultRecord_businessId_fkey'
  ) THEN
    ALTER TABLE "BusinessVaultRecord"
      ADD CONSTRAINT "BusinessVaultRecord_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessVaultRecord_storedAssetId_fkey'
  ) THEN
    ALTER TABLE "BusinessVaultRecord"
      ADD CONSTRAINT "BusinessVaultRecord_storedAssetId_fkey"
      FOREIGN KEY ("storedAssetId") REFERENCES "StoredAsset"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessVaultRecord_createdByMembershipId_fkey'
  ) THEN
    ALTER TABLE "BusinessVaultRecord"
      ADD CONSTRAINT "BusinessVaultRecord_createdByMembershipId_fkey"
      FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessVaultRecord_updatedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "BusinessVaultRecord"
      ADD CONSTRAINT "BusinessVaultRecord_updatedByMembershipId_fkey"
      FOREIGN KEY ("updatedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessAgreement_businessId_fkey'
  ) THEN
    ALTER TABLE "BusinessAgreement"
      ADD CONSTRAINT "BusinessAgreement_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessAgreement_vaultRecordId_fkey'
  ) THEN
    ALTER TABLE "BusinessAgreement"
      ADD CONSTRAINT "BusinessAgreement_vaultRecordId_fkey"
      FOREIGN KEY ("vaultRecordId") REFERENCES "BusinessVaultRecord"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessAgreement_createdByMembershipId_fkey'
  ) THEN
    ALTER TABLE "BusinessAgreement"
      ADD CONSTRAINT "BusinessAgreement_createdByMembershipId_fkey"
      FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessAgreement_completedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "BusinessAgreement"
      ADD CONSTRAINT "BusinessAgreement_completedByMembershipId_fkey"
      FOREIGN KEY ("completedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessAgreement_legalReviewAcknowledgedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "BusinessAgreement"
      ADD CONSTRAINT "BusinessAgreement_legalReviewAcknowledgedByMembershipId_fkey"
      FOREIGN KEY ("legalReviewAcknowledgedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessAgreement_ownerReviewedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "BusinessAgreement"
      ADD CONSTRAINT "BusinessAgreement_ownerReviewedByMembershipId_fkey"
      FOREIGN KEY ("ownerReviewedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessAgreementVersion_businessId_fkey'
  ) THEN
    ALTER TABLE "BusinessAgreementVersion"
      ADD CONSTRAINT "BusinessAgreementVersion_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessAgreementVersion_agreementId_fkey'
  ) THEN
    ALTER TABLE "BusinessAgreementVersion"
      ADD CONSTRAINT "BusinessAgreementVersion_agreementId_fkey"
      FOREIGN KEY ("agreementId") REFERENCES "BusinessAgreement"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessAgreementVersion_createdByMembershipId_fkey'
  ) THEN
    ALTER TABLE "BusinessAgreementVersion"
      ADD CONSTRAINT "BusinessAgreementVersion_createdByMembershipId_fkey"
      FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessAgreement_currentDraftVersionId_fkey'
  ) THEN
    ALTER TABLE "BusinessAgreement"
      ADD CONSTRAINT "BusinessAgreement_currentDraftVersionId_fkey"
      FOREIGN KEY ("currentDraftVersionId") REFERENCES "BusinessAgreementVersion"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessAgreement_signedVersionId_fkey'
  ) THEN
    ALTER TABLE "BusinessAgreement"
      ADD CONSTRAINT "BusinessAgreement_signedVersionId_fkey"
      FOREIGN KEY ("signedVersionId") REFERENCES "BusinessAgreementVersion"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessProtectionAuditLog_businessId_fkey'
  ) THEN
    ALTER TABLE "BusinessProtectionAuditLog"
      ADD CONSTRAINT "BusinessProtectionAuditLog_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessProtectionAuditLog_vaultRecordId_fkey'
  ) THEN
    ALTER TABLE "BusinessProtectionAuditLog"
      ADD CONSTRAINT "BusinessProtectionAuditLog_vaultRecordId_fkey"
      FOREIGN KEY ("vaultRecordId") REFERENCES "BusinessVaultRecord"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessProtectionAuditLog_agreementId_fkey'
  ) THEN
    ALTER TABLE "BusinessProtectionAuditLog"
      ADD CONSTRAINT "BusinessProtectionAuditLog_agreementId_fkey"
      FOREIGN KEY ("agreementId") REFERENCES "BusinessAgreement"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessProtectionAuditLog_changedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "BusinessProtectionAuditLog"
      ADD CONSTRAINT "BusinessProtectionAuditLog_changedByMembershipId_fkey"
      FOREIGN KEY ("changedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessProtectionAcknowledgment_businessId_fkey'
  ) THEN
    ALTER TABLE "BusinessProtectionAcknowledgment"
      ADD CONSTRAINT "BusinessProtectionAcknowledgment_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessProtectionAcknowledgment_membershipId_fkey'
  ) THEN
    ALTER TABLE "BusinessProtectionAcknowledgment"
      ADD CONSTRAINT "BusinessProtectionAcknowledgment_membershipId_fkey"
      FOREIGN KEY ("membershipId") REFERENCES "Membership"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessEsignBoundary_businessId_fkey'
  ) THEN
    ALTER TABLE "BusinessEsignBoundary"
      ADD CONSTRAINT "BusinessEsignBoundary_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
