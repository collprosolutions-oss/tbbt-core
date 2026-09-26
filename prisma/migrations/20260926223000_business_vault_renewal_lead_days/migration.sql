-- Additive per-document renewal lead time on the canonical Business Vault record.
-- Preview shares Production and skips migrate, so the statement is IF NOT EXISTS.
-- Existing vault rows, files, and expiry dates are preserved. No destructive statements.
-- No request-time DDL.

ALTER TABLE "BusinessVaultRecord"
  ADD COLUMN IF NOT EXISTS "renewalLeadDays" INTEGER;
