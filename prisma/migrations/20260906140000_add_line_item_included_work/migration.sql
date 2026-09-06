-- Optional multi-line Scope / Included Work on commercial line snapshots.
-- Descriptive only; existing totals and pricing math are unchanged.
ALTER TABLE "LineItem" ADD COLUMN "includedWork" TEXT;
ALTER TABLE "EstimateVersionLineItem" ADD COLUMN "includedWork" TEXT;
