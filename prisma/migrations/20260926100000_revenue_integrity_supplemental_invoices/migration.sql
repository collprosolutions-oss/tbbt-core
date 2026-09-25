-- Revenue integrity: supplemental / balance invoices for approved Change
-- Orders billed after the original invoice already exists.
-- Additive only. Preview shares Production and skips migrate, so every
-- statement is IF NOT EXISTS. Existing invoice totals are preserved.

ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'ORIGINAL';

CREATE INDEX IF NOT EXISTS "Invoice_jobId_kind_idx"
  ON "Invoice"("jobId", "kind");

-- One ORIGINAL invoice per job. Multiple SUPPLEMENTAL invoices are allowed.
CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_jobId_original_unique"
  ON "Invoice"("jobId")
  WHERE "jobId" IS NOT NULL AND "kind" = 'ORIGINAL';

ALTER TABLE "ChangeOrder" ADD COLUMN IF NOT EXISTS "invoiceId" TEXT;

CREATE INDEX IF NOT EXISTS "ChangeOrder_invoiceId_idx"
  ON "ChangeOrder"("invoiceId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ChangeOrder_invoiceId_fkey'
  ) THEN
    ALTER TABLE "ChangeOrder"
      ADD CONSTRAINT "ChangeOrder_invoiceId_fkey"
      FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Legacy: attach approved Change Orders that already existed when the
-- job's first invoice was created. Later-approved COs stay unbilled.
UPDATE "ChangeOrder" AS co
SET "invoiceId" = first_invoice.id
FROM (
  SELECT DISTINCT ON ("jobId") id, "jobId", "createdAt"
  FROM "Invoice"
  WHERE "jobId" IS NOT NULL
  ORDER BY "jobId", "createdAt" ASC, id ASC
) AS first_invoice
WHERE co."jobId" = first_invoice."jobId"
  AND co.status = 'APPROVED'
  AND co."invoiceId" IS NULL
  AND co."createdAt" <= first_invoice."createdAt";
