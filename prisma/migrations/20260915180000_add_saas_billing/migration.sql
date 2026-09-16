-- TBBT SaaS software-subscription billing. Additive only.
-- Distinct from BusinessPaymentAccount (Stripe Connect).
-- Do not backfill Stripe Customer or Subscription ids — existing
-- tenants stay usable without a TBBT subscription in this version.

CREATE TABLE IF NOT EXISTS "BusinessSaasSubscription" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "stripePriceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'none',
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessSaasSubscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BusinessSaasSubscription_businessId_key" ON "BusinessSaasSubscription"("businessId");
CREATE UNIQUE INDEX IF NOT EXISTS "BusinessSaasSubscription_stripeSubscriptionId_key" ON "BusinessSaasSubscription"("stripeSubscriptionId");
CREATE INDEX IF NOT EXISTS "BusinessSaasSubscription_stripeCustomerId_idx" ON "BusinessSaasSubscription"("stripeCustomerId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BusinessSaasSubscription_businessId_fkey'
  ) THEN
    ALTER TABLE "BusinessSaasSubscription"
      ADD CONSTRAINT "BusinessSaasSubscription_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "SaasBillingWebhookEvent" (
    "id" TEXT NOT NULL,
    "stripeEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "businessId" TEXT,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaasBillingWebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SaasBillingWebhookEvent_stripeEventId_key" ON "SaasBillingWebhookEvent"("stripeEventId");
CREATE INDEX IF NOT EXISTS "SaasBillingWebhookEvent_businessId_idx" ON "SaasBillingWebhookEvent"("businessId");
