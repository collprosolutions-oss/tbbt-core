-- CreateEnum
CREATE TYPE "LineItemType" AS ENUM ('LABOR', 'MATERIAL', 'OTHER');

-- AlterTable
ALTER TABLE "Business" ADD COLUMN "laborMinimumEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Business" ADD COLUMN "laborMinimumAmount" DECIMAL(65,30);

-- AlterTable
ALTER TABLE "Estimate" ADD COLUMN "laborMinimumWaived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Estimate" ADD COLUMN "laborMinimumAdjustment" DECIMAL(65,30) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "LineItem" ADD COLUMN "type" "LineItemType" NOT NULL DEFAULT 'LABOR';
