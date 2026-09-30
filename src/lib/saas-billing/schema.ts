/**
 * SaaS billing schema presence for request paths.
 *
 * Schema DDL and founder-trial backfill belong exclusively to
 * prisma migrate. Preview shares Production and skips migrate deploy,
 * so request paths must fail closed when required tables/columns are
 * missing — they must not CREATE/ALTER or INSERT/UPDATE compatibility
 * rows. Historical SQL below is the migration-system stand-in only.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  assertRequiredColumnsExist,
  assertRequiredTablesExist,
} from "@/lib/request-path-schema";

type BillingClient = PrismaClient | Prisma.TransactionClient;

export const SAAS_BILLING_REQUIRED_TABLES = [
  "BusinessSaasSubscription",
  "SaasBillingWebhookEvent",
] as const;

export const SAAS_BILLING_REQUIRED_COLUMNS = {
  BusinessSaasSubscription: [
    "trialStartedAt",
    "trialEndsAt",
    "founderEligible",
    "founderConvertedAt",
    "founderEligibilityEndedAt",
    "legacyExempt",
    "saasFounderTrialBackfilledAt",
    "lastStripeEventCreatedAt",
  ],
  SaasBillingWebhookEvent: ["stripeEventCreatedAt"],
} as const;

/**
 * Historical migration SQL. Never execute from a request path.
 * Tests may apply it as the migrate-system stand-in on a disposable DB.
 */
export const SAAS_BILLING_ENSURE_SQL = [
  `CREATE TABLE IF NOT EXISTS "BusinessSaasSubscription" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "stripePriceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'none',
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "trialStartedAt" TIMESTAMP(3),
    "trialEndsAt" TIMESTAMP(3),
    "founderEligible" BOOLEAN NOT NULL DEFAULT false,
    "founderConvertedAt" TIMESTAMP(3),
    "founderEligibilityEndedAt" TIMESTAMP(3),
    "legacyExempt" BOOLEAN NOT NULL DEFAULT false,
    "saasFounderTrialBackfilledAt" TIMESTAMP(3),
    "lastStripeEventCreatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BusinessSaasSubscription_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "BusinessSaasSubscription_businessId_key" ON "BusinessSaasSubscription"("businessId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "BusinessSaasSubscription_stripeSubscriptionId_key" ON "BusinessSaasSubscription"("stripeSubscriptionId")`,
  `CREATE INDEX IF NOT EXISTS "BusinessSaasSubscription_stripeCustomerId_idx" ON "BusinessSaasSubscription"("stripeCustomerId")`,
  `CREATE TABLE IF NOT EXISTS "SaasBillingWebhookEvent" (
    "id" TEXT NOT NULL,
    "stripeEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "businessId" TEXT,
    "stripeEventCreatedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SaasBillingWebhookEvent_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "SaasBillingWebhookEvent_stripeEventId_key" ON "SaasBillingWebhookEvent"("stripeEventId")`,
  `CREATE INDEX IF NOT EXISTS "SaasBillingWebhookEvent_businessId_idx" ON "SaasBillingWebhookEvent"("businessId")`,
];

export const SAAS_FOUNDER_TRIAL_ENSURE_SQL = `
ALTER TABLE "BusinessSaasSubscription" ADD COLUMN IF NOT EXISTS "trialStartedAt" TIMESTAMP(3);
ALTER TABLE "BusinessSaasSubscription" ADD COLUMN IF NOT EXISTS "trialEndsAt" TIMESTAMP(3);
ALTER TABLE "BusinessSaasSubscription" ADD COLUMN IF NOT EXISTS "founderEligible" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BusinessSaasSubscription" ADD COLUMN IF NOT EXISTS "founderConvertedAt" TIMESTAMP(3);
ALTER TABLE "BusinessSaasSubscription" ADD COLUMN IF NOT EXISTS "founderEligibilityEndedAt" TIMESTAMP(3);
ALTER TABLE "BusinessSaasSubscription" ADD COLUMN IF NOT EXISTS "legacyExempt" BOOLEAN NOT NULL DEFAULT false;
`.trim();

export const SAAS_FOUNDER_TRIAL_SENTINEL_SQL = `
ALTER TABLE "BusinessSaasSubscription" ADD COLUMN IF NOT EXISTS "saasFounderTrialBackfilledAt" TIMESTAMP(3);
`.trim();

export const SAAS_SUBSCRIPTION_LIFECYCLE_ENSURE_SQL = `
ALTER TABLE "BusinessSaasSubscription" ADD COLUMN IF NOT EXISTS "lastStripeEventCreatedAt" TIMESTAMP(3);
ALTER TABLE "SaasBillingWebhookEvent" ADD COLUMN IF NOT EXISTS "stripeEventCreatedAt" TIMESTAMP(3);
`.trim();

/**
 * One-shot compatibility rows for tenants that already finished onboarding
 * (or CollPro) before Founder trials existed. Does not insert Stripe
 * Customer/Subscription ids. Businesses still in Tasks 1–3 are left
 * without a row so completing website setup can start a real trial.
 *
 * Execute only from the migration system (or a test simulating migrate).
 */
export const SAAS_FOUNDER_TRIAL_BACKFILL_SQL = `
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'BusinessSaasSubscription'
      AND column_name = 'saasFounderTrialBackfilledAt'
  ) AND NOT EXISTS (
    SELECT 1
    FROM "BusinessSaasSubscription"
    WHERE "saasFounderTrialBackfilledAt" IS NOT NULL
    LIMIT 1
  ) THEN
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
`.trim();

let ensureTablesPromise: Promise<void> | null = null;
let ensureBackfillPromise: Promise<void> | null = null;

export function resetSaasBillingSchemaEnsure() {
  ensureTablesPromise = null;
  ensureBackfillPromise = null;
}

export async function assertSaasBillingSchemaPresent(db: BillingClient) {
  await assertRequiredTablesExist(db, [...SAAS_BILLING_REQUIRED_TABLES]);
  await assertRequiredColumnsExist(
    db,
    "BusinessSaasSubscription",
    [...SAAS_BILLING_REQUIRED_COLUMNS.BusinessSaasSubscription],
  );
  await assertRequiredColumnsExist(
    db,
    "SaasBillingWebhookEvent",
    [...SAAS_BILLING_REQUIRED_COLUMNS.SaasBillingWebhookEvent],
  );
}

export async function ensureSaasBillingTablesAndColumns(db: BillingClient) {
  if (!ensureTablesPromise) {
    ensureTablesPromise = assertSaasBillingSchemaPresent(db).catch((error) => {
      ensureTablesPromise = null;
      throw error;
    });
  }
  await ensureTablesPromise;
}

export async function ensureSaasFounderTrialBackfill(db: BillingClient) {
  if (!ensureBackfillPromise) {
    ensureBackfillPromise = ensureSaasBillingTablesAndColumns(db).catch((error) => {
      ensureBackfillPromise = null;
      throw error;
    });
  }
  await ensureBackfillPromise;
}

export async function ensureSaasBillingSchema(db: BillingClient) {
  await ensureSaasFounderTrialBackfill(db);
}
