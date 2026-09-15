/**
 * Preview shares Production and skips migrate, so SaaS billing reads
 * and writes first ensure these additive tables exist. Do not backfill
 * Stripe Customer or Subscription ids for existing tenants. Founder
 * trial columns are additive; existing businesses are marked
 * legacyExempt once and are not given a trial.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

type BillingClient = PrismaClient | Prisma.TransactionClient;

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

/**
 * One-shot compatibility rows for tenants that already finished onboarding
 * (or CollPro) before Founder trials existed. Does not insert Stripe
 * Customer/Subscription ids. Businesses still in Tasks 1–3 are left
 * without a row so completing website setup can start a real trial.
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

const SAAS_BILLING_CONSTRAINTS_SQL = `
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
`.trim();

let ensureTablesPromise: Promise<void> | null = null;
let ensureBackfillPromise: Promise<void> | null = null;

export function resetSaasBillingSchemaEnsure() {
  ensureTablesPromise = null;
  ensureBackfillPromise = null;
}

export async function ensureSaasBillingTablesAndColumns(db: BillingClient) {
  if (!ensureTablesPromise) {
    ensureTablesPromise = (async () => {
      for (const statement of SAAS_BILLING_ENSURE_SQL) {
        await db.$executeRawUnsafe(statement);
      }
      await db.$executeRawUnsafe(SAAS_BILLING_CONSTRAINTS_SQL);
      for (const statement of SAAS_FOUNDER_TRIAL_ENSURE_SQL.split(";")
        .map((part) => part.trim())
        .filter(Boolean)) {
        await db.$executeRawUnsafe(statement);
      }
      await db.$executeRawUnsafe(SAAS_FOUNDER_TRIAL_SENTINEL_SQL);
    })().catch((error) => {
      ensureTablesPromise = null;
      throw error;
    });
  }
  await ensureTablesPromise;
}

export async function ensureSaasFounderTrialBackfill(db: BillingClient) {
  if (!ensureBackfillPromise) {
    ensureBackfillPromise = (async () => {
      await ensureSaasBillingTablesAndColumns(db);
      await db.$executeRawUnsafe(SAAS_FOUNDER_TRIAL_BACKFILL_SQL);
    })().catch((error) => {
      ensureBackfillPromise = null;
      throw error;
    });
  }
  await ensureBackfillPromise;
}

export async function ensureSaasBillingSchema(db: BillingClient) {
  await ensureSaasFounderTrialBackfill(db);
}
