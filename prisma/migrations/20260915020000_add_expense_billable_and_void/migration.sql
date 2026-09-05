-- Handyman expense flags. Additive only. Later job/invoice/appointment
-- migrations do not touch Expense, so this remains valid after those.
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "customerBillable" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "voidedAt" TIMESTAMP(3);
