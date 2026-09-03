-- CreateTable
CREATE TABLE "BusinessPaymentAccount" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "stripeAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessPaymentAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BusinessPaymentAccount_businessId_key" ON "BusinessPaymentAccount"("businessId");

-- CreateIndex
CREATE INDEX "BusinessPaymentAccount_stripeAccountId_idx" ON "BusinessPaymentAccount"("stripeAccountId");

-- AddForeignKey
ALTER TABLE "BusinessPaymentAccount" ADD CONSTRAINT "BusinessPaymentAccount_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
