/**
 * Preview shares Production and skips migrate, so communications
 * department reads/writes first ensure additive tables/columns exist.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  CUSTOMER_MESSAGING_ENSURE_SQL,
  ensureCustomerMessagingSchema,
} from "@/lib/customer-messaging/schema";

type CommunicationsClient = PrismaClient | Prisma.TransactionClient;

export const COMMUNICATIONS_DEPARTMENT_ENSURE_SQL = [
  ...CUSTOMER_MESSAGING_ENSURE_SQL,
  `ALTER TABLE "CustomerCommunication" ADD COLUMN IF NOT EXISTS "threadId" TEXT`,
  `ALTER TABLE "CustomerCommunication" ADD COLUMN IF NOT EXISTS "direction" TEXT NOT NULL DEFAULT 'OUTBOUND'`,
  `ALTER TABLE "CustomerCommunication" ADD COLUMN IF NOT EXISTS "subject" TEXT`,
  `ALTER TABLE "CustomerCommunication" ADD COLUMN IF NOT EXISTS "consentContext" TEXT`,
  `CREATE TABLE IF NOT EXISTS "CommunicationThread" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL DEFAULT 'CUSTOMER',
    "subjectId" TEXT NOT NULL,
    "title" TEXT,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CommunicationThread_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "CommunicationThread_businessId_customerId_subjectType_subjectId_key" ON "CommunicationThread"("businessId", "customerId", "subjectType", "subjectId")`,
  `CREATE INDEX IF NOT EXISTS "CommunicationThread_businessId_customerId_lastActivityAt_idx" ON "CommunicationThread"("businessId", "customerId", "lastActivityAt")`,
  `CREATE INDEX IF NOT EXISTS "CommunicationThread_businessId_idx" ON "CommunicationThread"("businessId")`,
  `CREATE TABLE IF NOT EXISTS "PhoneInteraction" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT,
    "threadId" TEXT,
    "communicationId" TEXT,
    "requestId" TEXT,
    "jobId" TEXT,
    "followUpActionItemId" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'LOGGED',
    "direction" TEXT NOT NULL DEFAULT 'INBOUND',
    "callerLast4" TEXT,
    "callerFingerprint" TEXT,
    "summary" TEXT NOT NULL DEFAULT '',
    "callbackNeeded" BOOLEAN NOT NULL DEFAULT false,
    "idempotencyKey" TEXT NOT NULL,
    "initiatedByMembershipId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PhoneInteraction_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "PhoneInteraction_businessId_idempotencyKey_key" ON "PhoneInteraction"("businessId", "idempotencyKey")`,
  `CREATE INDEX IF NOT EXISTS "PhoneInteraction_businessId_idx" ON "PhoneInteraction"("businessId")`,
  `CREATE INDEX IF NOT EXISTS "PhoneInteraction_customerId_idx" ON "PhoneInteraction"("customerId")`,
  `CREATE INDEX IF NOT EXISTS "PhoneInteraction_threadId_idx" ON "PhoneInteraction"("threadId")`,
  `CREATE TABLE IF NOT EXISTS "ReceptionistEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT,
    "phoneInteractionId" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'none',
    "providerConnected" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB,
    "idempotencyKey" TEXT NOT NULL,
    "initiatedByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReceptionistEvent_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ReceptionistEvent_businessId_idempotencyKey_key" ON "ReceptionistEvent"("businessId", "idempotencyKey")`,
  `CREATE INDEX IF NOT EXISTS "ReceptionistEvent_businessId_idx" ON "ReceptionistEvent"("businessId")`,
  `CREATE INDEX IF NOT EXISTS "ReceptionistEvent_customerId_idx" ON "ReceptionistEvent"("customerId")`,
  `CREATE INDEX IF NOT EXISTS "CustomerCommunication_threadId_idx" ON "CustomerCommunication"("threadId")`,
  `CREATE INDEX IF NOT EXISTS "CustomerCommunication_businessId_customerId_createdAt_idx" ON "CustomerCommunication"("businessId", "customerId", "createdAt")`,
];

const COMMUNICATIONS_CONSTRAINTS_SQL = `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CommunicationThread_businessId_fkey'
  ) THEN
    ALTER TABLE "CommunicationThread"
      ADD CONSTRAINT "CommunicationThread_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CommunicationThread_customerId_fkey'
  ) THEN
    ALTER TABLE "CommunicationThread"
      ADD CONSTRAINT "CommunicationThread_customerId_fkey"
      FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CustomerCommunication_threadId_fkey'
  ) THEN
    ALTER TABLE "CustomerCommunication"
      ADD CONSTRAINT "CustomerCommunication_threadId_fkey"
      FOREIGN KEY ("threadId") REFERENCES "CommunicationThread"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
`.trim();

let ensurePromise: Promise<void> | null = null;

export function resetCommunicationsSchemaEnsure() {
  ensurePromise = null;
}

export async function ensureCommunicationsSchema(db: CommunicationsClient) {
  await ensureCustomerMessagingSchema(db);
  if (!ensurePromise) {
    ensurePromise = (async () => {
      for (const statement of COMMUNICATIONS_DEPARTMENT_ENSURE_SQL) {
        await db.$executeRawUnsafe(statement);
      }
      await db.$executeRawUnsafe(COMMUNICATIONS_CONSTRAINTS_SQL);
    })().catch((error) => {
      ensurePromise = null;
      throw error;
    });
  }
  await ensurePromise;
}
