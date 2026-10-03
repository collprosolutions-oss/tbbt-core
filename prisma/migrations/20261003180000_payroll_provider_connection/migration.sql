-- OWNER Gusto payroll-fact connection. Additive only. Preview shares
-- Production and skips migrate, so every statement is IF NOT EXISTS.
-- Timestamp 20261003180000 sits after 20261002193000_esign_signature_request_id
-- and after the reserved stamps used by open PRs (20261003120000, 20261003150000).
--
-- TBBT is not a payroll processor. These tables store provider-reported
-- facts and encrypted tokens. They do not alter PayrollRun, Payment,
-- Expense, Invoice, or bank reconciliation tables.
--
-- An active Gusto company (CONNECTED or NEEDS_RECONNECT) can belong to
-- only one business because refresh tokens are single-use. DISCONNECTED
-- rows keep imported facts and release the company id. There is no
-- documented Gusto revoke endpoint.

CREATE TABLE IF NOT EXISTS "PayrollConnection" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalCompanyId" TEXT,
    "accessTokenCiphertext" TEXT,
    "refreshTokenCiphertext" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT,
    "status" TEXT NOT NULL,
    "lastSyncedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "connectedByMembershipId" TEXT,
    "disconnectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PayrollConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PayrollConnection_businessId_provider_key"
  ON "PayrollConnection"("businessId", "provider");
CREATE INDEX IF NOT EXISTS "PayrollConnection_businessId_idx"
  ON "PayrollConnection"("businessId");
CREATE INDEX IF NOT EXISTS "PayrollConnection_provider_externalCompanyId_idx"
  ON "PayrollConnection"("provider", "externalCompanyId");
CREATE UNIQUE INDEX IF NOT EXISTS "PayrollConnection_provider_externalCompanyId_active_key"
  ON "PayrollConnection"("provider", "externalCompanyId")
  WHERE "status" <> 'DISCONNECTED' AND "externalCompanyId" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "PayrollConnectionOAuthState" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PayrollConnectionOAuthState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PayrollConnectionOAuthState_stateHash_key"
  ON "PayrollConnectionOAuthState"("stateHash");
CREATE INDEX IF NOT EXISTS "PayrollConnectionOAuthState_businessId_membershipId_provider_idx"
  ON "PayrollConnectionOAuthState"("businessId", "membershipId", "provider");
CREATE INDEX IF NOT EXISTS "PayrollConnectionOAuthState_expiresAt_idx"
  ON "PayrollConnectionOAuthState"("expiresAt");

CREATE TABLE IF NOT EXISTS "PayrollProviderPayrollFact" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerPayrollId" TEXT NOT NULL,
    "payPeriodStart" TIMESTAMP(3),
    "payPeriodEnd" TIMESTAMP(3),
    "checkDate" TIMESTAMP(3),
    "processed" BOOLEAN NOT NULL,
    "grossTotalCents" INTEGER,
    "employerTaxesCents" INTEGER,
    "employerBenefitsCents" INTEGER,
    "reviewStatus" TEXT NOT NULL DEFAULT 'UNREVIEWED',
    "rawPayloadHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PayrollProviderPayrollFact_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PayrollProviderPayrollFact_businessId_provider_providerPayrollId_key"
  ON "PayrollProviderPayrollFact"("businessId", "provider", "providerPayrollId");
CREATE INDEX IF NOT EXISTS "PayrollProviderPayrollFact_businessId_idx"
  ON "PayrollProviderPayrollFact"("businessId");
CREATE INDEX IF NOT EXISTS "PayrollProviderPayrollFact_businessId_reviewStatus_idx"
  ON "PayrollProviderPayrollFact"("businessId", "reviewStatus");

CREATE TABLE IF NOT EXISTS "PayrollProviderPayrollFactLine" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "factId" TEXT NOT NULL,
    "providerEmployeeId" TEXT,
    "employeeName" TEXT,
    "grossCents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PayrollProviderPayrollFactLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PayrollProviderPayrollFactLine_businessId_idx"
  ON "PayrollProviderPayrollFactLine"("businessId");
CREATE INDEX IF NOT EXISTS "PayrollProviderPayrollFactLine_factId_idx"
  ON "PayrollProviderPayrollFactLine"("factId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PayrollConnection_businessId_fkey'
  ) THEN
    ALTER TABLE "PayrollConnection"
      ADD CONSTRAINT "PayrollConnection_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PayrollConnection_connectedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "PayrollConnection"
      ADD CONSTRAINT "PayrollConnection_connectedByMembershipId_fkey"
      FOREIGN KEY ("connectedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PayrollConnectionOAuthState_businessId_fkey'
  ) THEN
    ALTER TABLE "PayrollConnectionOAuthState"
      ADD CONSTRAINT "PayrollConnectionOAuthState_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PayrollConnectionOAuthState_membershipId_fkey'
  ) THEN
    ALTER TABLE "PayrollConnectionOAuthState"
      ADD CONSTRAINT "PayrollConnectionOAuthState_membershipId_fkey"
      FOREIGN KEY ("membershipId") REFERENCES "Membership"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PayrollProviderPayrollFact_businessId_fkey'
  ) THEN
    ALTER TABLE "PayrollProviderPayrollFact"
      ADD CONSTRAINT "PayrollProviderPayrollFact_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PayrollProviderPayrollFactLine_businessId_fkey'
  ) THEN
    ALTER TABLE "PayrollProviderPayrollFactLine"
      ADD CONSTRAINT "PayrollProviderPayrollFactLine_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PayrollProviderPayrollFactLine_factId_fkey'
  ) THEN
    ALTER TABLE "PayrollProviderPayrollFactLine"
      ADD CONSTRAINT "PayrollProviderPayrollFactLine_factId_fkey"
      FOREIGN KEY ("factId") REFERENCES "PayrollProviderPayrollFact"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
