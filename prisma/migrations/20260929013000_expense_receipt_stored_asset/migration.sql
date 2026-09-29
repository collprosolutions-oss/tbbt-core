-- Private managed expense receipts. Additive only.
-- Preview shares Production and skips migrate, so every statement is IF NOT EXISTS.
-- receiptUrl stays for legacy rows and is never written as a public file URL.

ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "receiptStoredAssetId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Expense_receiptStoredAssetId_key"
  ON "Expense"("receiptStoredAssetId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Expense_receiptStoredAssetId_fkey'
  ) THEN
    ALTER TABLE "Expense"
      ADD CONSTRAINT "Expense_receiptStoredAssetId_fkey"
      FOREIGN KEY ("receiptStoredAssetId") REFERENCES "StoredAsset"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
