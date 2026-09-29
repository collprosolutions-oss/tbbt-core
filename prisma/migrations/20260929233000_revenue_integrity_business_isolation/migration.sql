-- Forward-only correction for 20260926100000_revenue_integrity_supplemental_invoices.
-- Do not edit that already-applied migration. Its ChangeOrder and Payment
-- backfills joined on jobId / estimateId without businessId equality, so a
-- foreign-business Payment or ChangeOrder could attach to another tenant's
-- invoice (and a Payment could also inherit that jobId).
--
-- This migration:
-- 1. Records already-attached cross-business links. It never reassigns
--    invoiceId / jobId / ownership. Operators must decide any repair.
-- 2. Attaches remaining NULL invoiceId rows only when every joined
--    Invoice, Job, ChangeOrder, and Payment share the same businessId.

CREATE TABLE IF NOT EXISTS "RevenueIntegrityBusinessIsolationFinding" (
  "id" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "recordTable" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "recordBusinessId" TEXT NOT NULL,
  "attachedInvoiceId" TEXT,
  "invoiceBusinessId" TEXT,
  "jobId" TEXT,
  "jobBusinessId" TEXT,
  "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RevenueIntegrityBusinessIsolationFinding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "RevenueIntegrityBusinessIsolationFinding_record_category_key"
  ON "RevenueIntegrityBusinessIsolationFinding"("recordTable", "recordId", "category");

CREATE INDEX IF NOT EXISTS "RevenueIntegrityBusinessIsolationFinding_category_idx"
  ON "RevenueIntegrityBusinessIsolationFinding"("category");

INSERT INTO "RevenueIntegrityBusinessIsolationFinding" (
  "id",
  "category",
  "recordTable",
  "recordId",
  "recordBusinessId",
  "attachedInvoiceId",
  "invoiceBusinessId",
  "jobId",
  "jobBusinessId",
  "detectedAt"
)
SELECT
  concat('rif_', substr(md5(co.id || '|change_order_attached_foreign_invoice'), 1, 24)),
  'change_order_attached_foreign_invoice',
  'ChangeOrder',
  co.id,
  co."businessId",
  inv.id,
  inv."businessId",
  co."jobId",
  j."businessId",
  CURRENT_TIMESTAMP
FROM "ChangeOrder" AS co
INNER JOIN "Invoice" AS inv ON inv.id = co."invoiceId"
LEFT JOIN "Job" AS j ON j.id = co."jobId"
WHERE co."invoiceId" IS NOT NULL
  AND co."businessId" <> inv."businessId"
ON CONFLICT ("recordTable", "recordId", "category") DO NOTHING;

INSERT INTO "RevenueIntegrityBusinessIsolationFinding" (
  "id",
  "category",
  "recordTable",
  "recordId",
  "recordBusinessId",
  "attachedInvoiceId",
  "invoiceBusinessId",
  "jobId",
  "jobBusinessId",
  "detectedAt"
)
SELECT
  concat('rif_', substr(md5(p.id || '|payment_attached_foreign_invoice'), 1, 24)),
  'payment_attached_foreign_invoice',
  'Payment',
  p.id,
  p."businessId",
  inv.id,
  inv."businessId",
  p."jobId",
  j."businessId",
  CURRENT_TIMESTAMP
FROM "Payment" AS p
INNER JOIN "Invoice" AS inv ON inv.id = p."invoiceId"
LEFT JOIN "Job" AS j ON j.id = p."jobId"
WHERE p."invoiceId" IS NOT NULL
  AND p."businessId" <> inv."businessId"
ON CONFLICT ("recordTable", "recordId", "category") DO NOTHING;

INSERT INTO "RevenueIntegrityBusinessIsolationFinding" (
  "id",
  "category",
  "recordTable",
  "recordId",
  "recordBusinessId",
  "attachedInvoiceId",
  "invoiceBusinessId",
  "jobId",
  "jobBusinessId",
  "detectedAt"
)
SELECT
  concat('rif_', substr(md5(p.id || '|payment_job_business_mismatch'), 1, 24)),
  'payment_job_business_mismatch',
  'Payment',
  p.id,
  p."businessId",
  p."invoiceId",
  inv."businessId",
  p."jobId",
  j."businessId",
  CURRENT_TIMESTAMP
FROM "Payment" AS p
INNER JOIN "Job" AS j ON j.id = p."jobId"
LEFT JOIN "Invoice" AS inv ON inv.id = p."invoiceId"
WHERE p."jobId" IS NOT NULL
  AND p."businessId" <> j."businessId"
ON CONFLICT ("recordTable", "recordId", "category") DO NOTHING;

INSERT INTO "RevenueIntegrityBusinessIsolationFinding" (
  "id",
  "category",
  "recordTable",
  "recordId",
  "recordBusinessId",
  "attachedInvoiceId",
  "invoiceBusinessId",
  "jobId",
  "jobBusinessId",
  "detectedAt"
)
SELECT
  concat('rif_', substr(md5(co.id || '|change_order_job_business_mismatch'), 1, 24)),
  'change_order_job_business_mismatch',
  'ChangeOrder',
  co.id,
  co."businessId",
  co."invoiceId",
  inv."businessId",
  co."jobId",
  j."businessId",
  CURRENT_TIMESTAMP
FROM "ChangeOrder" AS co
INNER JOIN "Job" AS j ON j.id = co."jobId"
LEFT JOIN "Invoice" AS inv ON inv.id = co."invoiceId"
WHERE co."businessId" <> j."businessId"
ON CONFLICT ("recordTable", "recordId", "category") DO NOTHING;

-- Remaining NULL invoiceId Change Orders: same-business ORIGINAL invoice only.
UPDATE "ChangeOrder" AS co
SET "invoiceId" = first_invoice.id
FROM (
  SELECT DISTINCT ON (inv."jobId", inv."businessId")
    inv.id,
    inv."jobId",
    inv."businessId",
    inv."createdAt"
  FROM "Invoice" AS inv
  WHERE inv."jobId" IS NOT NULL
    AND inv."kind" = 'ORIGINAL'
  ORDER BY inv."jobId", inv."businessId", inv."createdAt" ASC, inv.id ASC
) AS first_invoice
INNER JOIN "Job" AS j
  ON j.id = first_invoice."jobId"
 AND j."businessId" = first_invoice."businessId"
WHERE co."jobId" = first_invoice."jobId"
  AND co."businessId" = first_invoice."businessId"
  AND co."businessId" = j."businessId"
  AND co.status = 'APPROVED'
  AND co."invoiceId" IS NULL
  AND co."approvedAt" IS NOT NULL
  AND co."approvedAt" <= first_invoice."createdAt";

-- Remaining NULL invoiceId Payments attached by same-business jobId.
UPDATE "Payment" AS p
SET "invoiceId" = original.id
FROM (
  SELECT DISTINCT ON (inv."jobId", inv."businessId")
    inv.id,
    inv."jobId",
    inv."businessId"
  FROM "Invoice" AS inv
  WHERE inv."jobId" IS NOT NULL
    AND inv."kind" = 'ORIGINAL'
  ORDER BY inv."jobId", inv."businessId", inv."createdAt" ASC, inv.id ASC
) AS original
INNER JOIN "Job" AS j
  ON j.id = original."jobId"
 AND j."businessId" = original."businessId"
WHERE p."invoiceId" IS NULL
  AND p."jobId" IS NOT NULL
  AND p."jobId" = original."jobId"
  AND p."businessId" = original."businessId"
  AND p."businessId" = j."businessId";

-- Remaining NULL invoiceId Payments attached by same-business estimateId.
-- Never inherit a foreign jobId. Leave already-pointed foreign jobId alone.
UPDATE "Payment" AS p
SET "invoiceId" = original.id,
    "jobId" = COALESCE(p."jobId", j.id)
FROM "Job" AS j
INNER JOIN "Invoice" AS original
  ON original."jobId" = j.id
 AND original."kind" = 'ORIGINAL'
 AND original."businessId" = j."businessId"
WHERE p."invoiceId" IS NULL
  AND p."estimateId" IS NOT NULL
  AND j."estimateId" IS NOT NULL
  AND p."estimateId" = j."estimateId"
  AND p."businessId" = j."businessId"
  AND p."businessId" = original."businessId"
  AND (p."jobId" IS NULL OR p."jobId" = j.id);
