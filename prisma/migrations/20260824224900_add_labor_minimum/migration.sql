-- AlterTable
ALTER TABLE "Business" ADD COLUMN "laborMinimumEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Business" ADD COLUMN "laborMinimumAmount" DECIMAL(65,30);

-- AlterTable
ALTER TABLE "Estimate" ADD COLUMN "laborMinimumWaived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Estimate" ADD COLUMN "laborMinimumAdjustment" DECIMAL(65,30) NOT NULL DEFAULT 0;
