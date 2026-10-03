-- Persist the provider signature_request_id against the business,
-- agreement, and locked version at OWNER Send. event_hash only covers
-- event_time+event_type, so completion must match this stored id.
-- Additive only. Previews share Production and skip migrate.
-- Reserved timestamp 20261002193000.

ALTER TABLE "BusinessAgreement"
  ADD COLUMN IF NOT EXISTS "esignSignatureRequestId" TEXT;

ALTER TABLE "BusinessAgreement"
  ADD COLUMN IF NOT EXISTS "esignSendingClaimedAt" TIMESTAMP(3);

ALTER TABLE "BusinessAgreementVersion"
  ADD COLUMN IF NOT EXISTS "esignSignatureRequestId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "BusinessAgreement_businessId_esignSignatureRequestId_key"
  ON "BusinessAgreement"("businessId", "esignSignatureRequestId");

CREATE UNIQUE INDEX IF NOT EXISTS "BusinessAgreementVersion_businessId_esignSignatureRequestId_key"
  ON "BusinessAgreementVersion"("businessId", "esignSignatureRequestId");
