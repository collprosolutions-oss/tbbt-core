-- AlterTable
ALTER TABLE "Expense" ADD COLUMN "customerBillable" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Expense" ADD COLUMN "voidedAt" TIMESTAMP(3);
