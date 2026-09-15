-- Task 7: additive Stripe event timestamps for SaaS subscription
-- lifecycle ordering. Does not rewrite Business rows, Stripe Connect
-- accounts, or existing SaaS Customer/Subscription ids.

ALTER TABLE "BusinessSaasSubscription"
  ADD COLUMN IF NOT EXISTS "lastStripeEventCreatedAt" TIMESTAMP(3);

ALTER TABLE "SaasBillingWebhookEvent"
  ADD COLUMN IF NOT EXISTS "stripeEventCreatedAt" TIMESTAMP(3);
