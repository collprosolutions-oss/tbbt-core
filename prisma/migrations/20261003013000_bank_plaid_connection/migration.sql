-- Reserved timestamp 20261003013000
-- OWNER read-only Plaid connection for reconciliation review.
-- Additive only. Preview shares Production and skips migrate.
-- Tokens are application-encrypted; this table never stores a verified
-- cash balance and never enables money movement.

ALTER TABLE "BankReconciliationRow"
  ADD COLUMN IF NOT EXISTS "externalTransactionId" TEXT;

CREATE INDEX IF NOT EXISTS "BankReconciliationRow_importId_externalTransactionId_idx"
  ON "BankReconciliationRow"("importId", "externalTransactionId");

CREATE TABLE IF NOT EXISTS "BankPlaidItem" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "institutionId" TEXT,
    "institutionName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "accessTokenCipher" TEXT NOT NULL DEFAULT '',
    "syncCursor" TEXT NOT NULL DEFAULT '',
    "lastSyncedAt" TIMESTAMP(3),
    "lastWebhookAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3) NOT NULL,
    "disconnectedAt" TIMESTAMP(3),
    "createdByMembershipId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BankPlaidItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BankPlaidItem_businessId_key"
  ON "BankPlaidItem"("businessId");
CREATE UNIQUE INDEX IF NOT EXISTS "BankPlaidItem_itemId_key"
  ON "BankPlaidItem"("itemId");
CREATE INDEX IF NOT EXISTS "BankPlaidItem_createdByMembershipId_idx"
  ON "BankPlaidItem"("createdByMembershipId");

CREATE TABLE IF NOT EXISTS "BankPlaidAccount" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "itemRowId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "officialName" TEXT,
    "mask" TEXT,
    "type" TEXT NOT NULL,
    "subtype" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BankPlaidAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BankPlaidAccount_itemRowId_accountId_key"
  ON "BankPlaidAccount"("itemRowId", "accountId");
CREATE INDEX IF NOT EXISTS "BankPlaidAccount_businessId_idx"
  ON "BankPlaidAccount"("businessId");

CREATE TABLE IF NOT EXISTS "BankPlaidTransaction" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "itemRowId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "postedOn" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "pending" BOOLEAN NOT NULL DEFAULT false,
    "removed" BOOLEAN NOT NULL DEFAULT false,
    "importId" TEXT,
    "rowId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BankPlaidTransaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BankPlaidTransaction_businessId_transactionId_key"
  ON "BankPlaidTransaction"("businessId", "transactionId");
CREATE INDEX IF NOT EXISTS "BankPlaidTransaction_itemRowId_idx"
  ON "BankPlaidTransaction"("itemRowId");
CREATE INDEX IF NOT EXISTS "BankPlaidTransaction_importId_idx"
  ON "BankPlaidTransaction"("importId");
CREATE INDEX IF NOT EXISTS "BankPlaidTransaction_rowId_idx"
  ON "BankPlaidTransaction"("rowId");

CREATE TABLE IF NOT EXISTS "BankPlaidWebhookEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT,
    "itemRowId" TEXT,
    "itemId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "webhookType" TEXT NOT NULL,
    "webhookCode" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    CONSTRAINT "BankPlaidWebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BankPlaidWebhookEvent_eventKey_key"
  ON "BankPlaidWebhookEvent"("eventKey");
CREATE INDEX IF NOT EXISTS "BankPlaidWebhookEvent_itemId_idx"
  ON "BankPlaidWebhookEvent"("itemId");
CREATE INDEX IF NOT EXISTS "BankPlaidWebhookEvent_businessId_idx"
  ON "BankPlaidWebhookEvent"("businessId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BankPlaidItem_businessId_fkey'
  ) THEN
    ALTER TABLE "BankPlaidItem"
      ADD CONSTRAINT "BankPlaidItem_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BankPlaidItem_createdByMembershipId_fkey'
  ) THEN
    ALTER TABLE "BankPlaidItem"
      ADD CONSTRAINT "BankPlaidItem_createdByMembershipId_fkey"
      FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BankPlaidAccount_businessId_fkey'
  ) THEN
    ALTER TABLE "BankPlaidAccount"
      ADD CONSTRAINT "BankPlaidAccount_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BankPlaidAccount_itemRowId_fkey'
  ) THEN
    ALTER TABLE "BankPlaidAccount"
      ADD CONSTRAINT "BankPlaidAccount_itemRowId_fkey"
      FOREIGN KEY ("itemRowId") REFERENCES "BankPlaidItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BankPlaidTransaction_businessId_fkey'
  ) THEN
    ALTER TABLE "BankPlaidTransaction"
      ADD CONSTRAINT "BankPlaidTransaction_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BankPlaidTransaction_itemRowId_fkey'
  ) THEN
    ALTER TABLE "BankPlaidTransaction"
      ADD CONSTRAINT "BankPlaidTransaction_itemRowId_fkey"
      FOREIGN KEY ("itemRowId") REFERENCES "BankPlaidItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BankPlaidWebhookEvent_businessId_fkey'
  ) THEN
    ALTER TABLE "BankPlaidWebhookEvent"
      ADD CONSTRAINT "BankPlaidWebhookEvent_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BankPlaidWebhookEvent_itemRowId_fkey'
  ) THEN
    ALTER TABLE "BankPlaidWebhookEvent"
      ADD CONSTRAINT "BankPlaidWebhookEvent_itemRowId_fkey"
      FOREIGN KEY ("itemRowId") REFERENCES "BankPlaidItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
