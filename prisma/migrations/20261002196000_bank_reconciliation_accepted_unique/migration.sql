-- Additive only. Preview shares Production and skips migrate, so every
-- statement is IF NOT EXISTS. One ACCEPTED match per recorded candidate
-- across the business, and one ACCEPTED match per bank row.
-- Timestamp is 20261002196000 so it sits after 20261002190000_bank_reconciliation.

CREATE UNIQUE INDEX IF NOT EXISTS "BankReconciliationMatch_accepted_candidate_key"
  ON "BankReconciliationMatch" ("businessId", "candidateKind", "candidateId")
  WHERE status = 'ACCEPTED';

CREATE UNIQUE INDEX IF NOT EXISTS "BankReconciliationMatch_accepted_row_key"
  ON "BankReconciliationMatch" ("rowId")
  WHERE status = 'ACCEPTED';
