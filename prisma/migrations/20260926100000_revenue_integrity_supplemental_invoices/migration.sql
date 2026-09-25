-- Revenue integrity: supplemental / balance invoices for approved Change
-- Orders billed after the original invoice already exists.
-- Additive only. Preview shares Production and skips migrate, so every
-- schema statement is IF NOT EXISTS. Existing invoice totals, line items,
-- Payment relationships, and paidAt / payment metadata are preserved.
-- Invoices are never merged or deleted.

ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'ORIGINAL';

CREATE INDEX IF NOT EXISTS "Invoice_jobId_kind_idx"
  ON "Invoice"("jobId", "kind");

-- Legacy rows: the old schema allowed multiple Invoice rows per job and
-- the new column defaults them all to ORIGINAL. Rank deterministically
-- and keep the oldest as ORIGINAL before the partial unique index exists.
UPDATE "Invoice" AS inv
SET "kind" = CASE
  WHEN ranked.rn = 1 THEN 'ORIGINAL'
  ELSE 'SUPPLEMENTAL'
END
FROM (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "jobId"
      ORDER BY "createdAt" ASC, id ASC
    ) AS rn
  FROM "Invoice"
  WHERE "jobId" IS NOT NULL
) AS ranked
WHERE inv.id = ranked.id;

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

-- Legacy: attach an approved Change Order to the original invoice only when
-- recorded approval truth proves it was approved at or before that invoice.
-- createdAt is not approval time. Unproven approval stays unbilled.
UPDATE "ChangeOrder" AS co
SET "invoiceId" = first_invoice.id
FROM (
  SELECT DISTINCT ON ("jobId") id, "jobId", "createdAt"
  FROM "Invoice"
  WHERE "jobId" IS NOT NULL AND "kind" = 'ORIGINAL'
  ORDER BY "jobId", "createdAt" ASC, id ASC
) AS first_invoice
WHERE co."jobId" = first_invoice."jobId"
  AND co.status = 'APPROVED'
  AND co."invoiceId" IS NULL
  AND co."approvedAt" IS NOT NULL
  AND co."approvedAt" <= first_invoice."createdAt";

-- Legacy unallocated payments attach only to the ORIGINAL invoice.
UPDATE "Payment" AS p
SET "invoiceId" = original.id
FROM (
  SELECT DISTINCT ON ("jobId") id, "jobId"
  FROM "Invoice"
  WHERE "jobId" IS NOT NULL AND "kind" = 'ORIGINAL'
  ORDER BY "jobId", "createdAt" ASC, id ASC
) AS original
WHERE p."invoiceId" IS NULL
  AND p."jobId" IS NOT NULL
  AND p."jobId" = original."jobId";

UPDATE "Payment" AS p
SET "invoiceId" = original.id,
    "jobId" = COALESCE(p."jobId", j.id)
FROM "Job" AS j
INNER JOIN "Invoice" AS original
  ON original."jobId" = j.id
 AND original."kind" = 'ORIGINAL'
WHERE p."invoiceId" IS NULL
  AND p."estimateId" IS NOT NULL
  AND j."estimateId" IS NOT NULL
  AND p."estimateId" = j."estimateId";
