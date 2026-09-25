-- Additive idempotency key for support/provider product grants.
-- Preview shares Production and skips migrate, so statements are IF NOT EXISTS.
-- Existing grant rows are preserved. Independent grants without sourceRef remain allowed
-- because PostgreSQL treats NULL as distinct in this unique index.

ALTER TABLE "BusinessProductGrant" ADD COLUMN IF NOT EXISTS "sourceRef" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "BusinessProductGrant_businessId_grantType_code_source_sourceRef_key"
  ON "BusinessProductGrant"("businessId", "grantType", "code", "source", "sourceRef");
