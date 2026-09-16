-- Founder Plan trial + legacy/exempt compatibility. Additive only.
-- Does not create Stripe Customers or Subscriptions.
-- Existing finished businesses are marked legacyExempt once — not given a trial.
-- Does not UPDATE "Business". Does not delete or hide tenant records.

ALTER TABLE "BusinessSaasSubscription" ADD COLUMN IF NOT EXISTS "trialStartedAt" TIMESTAMP(3);
ALTER TABLE "BusinessSaasSubscription" ADD COLUMN IF NOT EXISTS "trialEndsAt" TIMESTAMP(3);
ALTER TABLE "BusinessSaasSubscription" ADD COLUMN IF NOT EXISTS "founderEligible" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BusinessSaasSubscription" ADD COLUMN IF NOT EXISTS "founderConvertedAt" TIMESTAMP(3);
ALTER TABLE "BusinessSaasSubscription" ADD COLUMN IF NOT EXISTS "founderEligibilityEndedAt" TIMESTAMP(3);
ALTER TABLE "BusinessSaasSubscription" ADD COLUMN IF NOT EXISTS "legacyExempt" BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'BusinessSaasSubscription'
      AND column_name = 'saasFounderTrialBackfilledAt'
  ) THEN
    ALTER TABLE "BusinessSaasSubscription" ADD COLUMN "saasFounderTrialBackfilledAt" TIMESTAMP(3);

    INSERT INTO "BusinessSaasSubscription" (
      "id",
      "businessId",
      "status",
      "cancelAtPeriodEnd",
      "founderEligible",
      "legacyExempt",
      "saasFounderTrialBackfilledAt",
      "createdAt",
      "updatedAt"
    )
    SELECT
      concat('c', substr(md5(b."id" || clock_timestamp()::text), 1, 24)),
      b."id",
      'none',
      false,
      false,
      true,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    FROM "Business" b
    WHERE NOT EXISTS (
      SELECT 1
      FROM "BusinessSaasSubscription" s
      WHERE s."businessId" = b."id"
    )
    AND (
      b."websiteSetupCompletedAt" IS NOT NULL
      OR b."slug" IN ('collpro-reno', 'collpro-reno-handyman-services')
    );

    UPDATE "BusinessSaasSubscription" s
    SET
      "legacyExempt" = true,
      "saasFounderTrialBackfilledAt" = CURRENT_TIMESTAMP
    FROM "Business" b
    WHERE s."businessId" = b."id"
      AND s."trialStartedAt" IS NULL
      AND s."stripeCustomerId" IS NULL
      AND s."stripeSubscriptionId" IS NULL
      AND s."saasFounderTrialBackfilledAt" IS NULL
      AND (
        b."websiteSetupCompletedAt" IS NOT NULL
        OR b."slug" IN ('collpro-reno', 'collpro-reno-handyman-services')
      );
  END IF;
END $$;
