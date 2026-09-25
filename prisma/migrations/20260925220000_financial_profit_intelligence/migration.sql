-- Financial + profit intelligence (additive).
-- Optional labor burden, owner-reviewed recurring patterns, and
-- provider-neutral finance connection rows. Historical invoices,
-- payments, expenses, time cards, and payroll snapshots stay intact.

CREATE TABLE "BusinessLaborBurdenSetting" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "burdenRate" DECIMAL(65,30),
    "targetGrossMarginRate" DECIMAL(65,30),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessLaborBurdenSetting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BusinessLaborBurdenSetting_businessId_key" ON "BusinessLaborBurdenSetting"("businessId");

ALTER TABLE "BusinessLaborBurdenSetting"
    ADD CONSTRAINT "BusinessLaborBurdenSetting_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RecurringExpensePattern" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "patternKey" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "vendor" TEXT,
    "category" TEXT NOT NULL,
    "suggestedAmount" DECIMAL(65,30) NOT NULL,
    "occurrenceCount" INTEGER NOT NULL,
    "firstOccurredOn" TIMESTAMP(3) NOT NULL,
    "lastOccurredOn" TIMESTAMP(3) NOT NULL,
    "ownerStatus" TEXT NOT NULL DEFAULT 'SUGGESTED',
    "confirmedAt" TIMESTAMP(3),
    "confirmedByMembershipId" TEXT,
    "dismissedAt" TIMESTAMP(3),
    "dismissedByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringExpensePattern_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RecurringExpensePattern_businessId_patternKey_key"
    ON "RecurringExpensePattern"("businessId", "patternKey");

CREATE INDEX "RecurringExpensePattern_businessId_idx"
    ON "RecurringExpensePattern"("businessId");

CREATE INDEX "RecurringExpensePattern_businessId_ownerStatus_idx"
    ON "RecurringExpensePattern"("businessId", "ownerStatus");

ALTER TABLE "RecurringExpensePattern"
    ADD CONSTRAINT "RecurringExpensePattern_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "BusinessFinanceConnection" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL DEFAULT 'none',
    "status" TEXT NOT NULL DEFAULT 'DISCONNECTED',
    "connectedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessFinanceConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BusinessFinanceConnection_businessId_kind_key"
    ON "BusinessFinanceConnection"("businessId", "kind");

CREATE INDEX "BusinessFinanceConnection_businessId_idx"
    ON "BusinessFinanceConnection"("businessId");

ALTER TABLE "BusinessFinanceConnection"
    ADD CONSTRAINT "BusinessFinanceConnection_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
