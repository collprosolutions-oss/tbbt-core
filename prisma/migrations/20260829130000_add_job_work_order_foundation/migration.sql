-- Phase 3 / Step 1: Job/Work Order foundation + Customer Project Portal.
--
-- Additive and non-destructive. Every existing Job row remains valid:
--   * approvedEstimateVersionId is nullable and left NULL for every existing
--     row -- application code does NOT retroactively guess/fabricate which
--     EstimateVersion an already-created Job came from. Legacy Jobs fall
--     back to their live linked Estimate for display (see
--     resolveApprovedWorkOrderScope() in src/lib/job-work-order.ts).
--   * projectToken is a NOT NULL unique column (every Job needs a stable
--     Customer Project Portal link), so existing rows are backfilled with a
--     freshly generated random token below before the NOT NULL constraint
--     is applied. This does not fabricate any business data -- a token is
--     only an access credential, not a historical fact.

-- AlterTable: add the nullable approved-version relation first.
ALTER TABLE "Job" ADD COLUMN "approvedEstimateVersionId" TEXT;

-- AlterTable: add projectToken as nullable, backfill, THEN enforce NOT NULL.
ALTER TABLE "Job" ADD COLUMN "projectToken" TEXT;

-- gen_random_uuid() has been a built-in Postgres function since v13 (no
-- pgcrypto extension required), matching the app's own token style
-- (Estimate.publicToken is a randomUUID() generated in application code).
UPDATE "Job" SET "projectToken" = gen_random_uuid()::text WHERE "projectToken" IS NULL;

ALTER TABLE "Job" ALTER COLUMN "projectToken" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Job_projectToken_key" ON "Job"("projectToken");

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_approvedEstimateVersionId_fkey" FOREIGN KEY ("approvedEstimateVersionId") REFERENCES "EstimateVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
