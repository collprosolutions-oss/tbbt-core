-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN "paidAt" TIMESTAMP(3),
ADD COLUMN "paymentMethod" TEXT,
ADD COLUMN "paymentReference" TEXT;
