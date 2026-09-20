/**
 * Preview shares Production and skips migrate, so customer messaging
 * reads/writes first ensure the additive Customer consent columns and
 * CustomerCommunication table exist.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

type MessagingClient = PrismaClient | Prisma.TransactionClient;

export const CUSTOMER_MESSAGING_ENSURE_SQL = [
  `ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "smsConsentStatus" TEXT NOT NULL DEFAULT 'UNKNOWN'`,
  `ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "smsConsentUpdatedAt" TIMESTAMP(3)`,
  `CREATE TABLE IF NOT EXISTS "CustomerCommunication" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'SMS',
    "purpose" TEXT NOT NULL,
    "relatedType" TEXT,
    "relatedId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "destinationLast4" TEXT,
    "destinationFingerprint" TEXT,
    "bodySnapshot" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "providerMetadata" JSONB,
    "failureReason" TEXT,
    "initiatedByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attemptedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CustomerCommunication_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "CustomerCommunication_businessId_idempotencyKey_key" ON "CustomerCommunication"("businessId", "idempotencyKey")`,
  `CREATE INDEX IF NOT EXISTS "CustomerCommunication_businessId_idx" ON "CustomerCommunication"("businessId")`,
  `CREATE INDEX IF NOT EXISTS "CustomerCommunication_customerId_idx" ON "CustomerCommunication"("customerId")`,
  `CREATE INDEX IF NOT EXISTS "CustomerCommunication_provider_providerMessageId_idx" ON "CustomerCommunication"("provider", "providerMessageId")`,
  `CREATE INDEX IF NOT EXISTS "CustomerCommunication_businessId_relatedType_relatedId_idx" ON "CustomerCommunication"("businessId", "relatedType", "relatedId")`,
  `ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "operationalSmsNumber" TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Business_operationalSmsNumber_key" ON "Business"("operationalSmsNumber")`,
  `CREATE TABLE IF NOT EXISTS "CustomerMessagingWebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "eventKind" TEXT NOT NULL,
    "businessId" TEXT,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CustomerMessagingWebhookEvent_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "CustomerMessagingWebhookEvent_provider_providerEventId_eventKind_key" ON "CustomerMessagingWebhookEvent"("provider", "providerEventId", "eventKind")`,
  `CREATE INDEX IF NOT EXISTS "CustomerMessagingWebhookEvent_businessId_idx" ON "CustomerMessagingWebhookEvent"("businessId")`,
];

const CUSTOMER_MESSAGING_CONSTRAINTS_SQL = `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CustomerCommunication_businessId_fkey'
  ) THEN
    ALTER TABLE "CustomerCommunication"
      ADD CONSTRAINT "CustomerCommunication_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CustomerCommunication_customerId_fkey'
  ) THEN
    ALTER TABLE "CustomerCommunication"
      ADD CONSTRAINT "CustomerCommunication_customerId_fkey"
      FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CustomerCommunication_initiatedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "CustomerCommunication"
      ADD CONSTRAINT "CustomerCommunication_initiatedByMembershipId_fkey"
      FOREIGN KEY ("initiatedByMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CustomerMessagingWebhookEvent_businessId_fkey'
  ) THEN
    ALTER TABLE "CustomerMessagingWebhookEvent"
      ADD CONSTRAINT "CustomerMessagingWebhookEvent_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
`.trim();

let ensurePromise: Promise<void> | null = null;

export function resetCustomerMessagingSchemaEnsure() {
  ensurePromise = null;
}

export async function ensureCustomerMessagingSchema(db: MessagingClient) {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      for (const statement of CUSTOMER_MESSAGING_ENSURE_SQL) {
        await db.$executeRawUnsafe(statement);
      }
      await db.$executeRawUnsafe(CUSTOMER_MESSAGING_CONSTRAINTS_SQL);
    })().catch((error) => {
      ensurePromise = null;
      throw error;
    });
  }
  await ensurePromise;
}
