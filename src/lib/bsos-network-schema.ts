/**
 * Preview shares Production and skips migrate, so Network reads/writes
 * first ensure the additive table exists. Workspace load must not run
 * this DDL — only Network loaders and mutations call it.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

type SchemaClient = PrismaClient | Prisma.TransactionClient;

export const BSOS_NETWORK_ENSURE_SQL = [
  `CREATE TABLE IF NOT EXISTS "BsosNetworkParticipation" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "optedIn" BOOLEAN NOT NULL DEFAULT false,
    "optedInAt" TIMESTAMP(3),
    "optedOutAt" TIMESTAMP(3),
    "publicName" TEXT NOT NULL DEFAULT '',
    "tradeCode" TEXT NOT NULL DEFAULT 'HANDYMAN',
    "serviceAreaLabel" TEXT NOT NULL DEFAULT '',
    "publicContactMethod" TEXT NOT NULL DEFAULT 'EMAIL',
    "publicContactValue" TEXT NOT NULL DEFAULT '',
    "updatedByMembershipId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BsosNetworkParticipation_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "BsosNetworkParticipation_businessId_key"
    ON "BsosNetworkParticipation"("businessId")`,
  `CREATE INDEX IF NOT EXISTS "BsosNetworkParticipation_optedIn_idx"
    ON "BsosNetworkParticipation"("optedIn")`,
  `CREATE INDEX IF NOT EXISTS "BsosNetworkParticipation_optedIn_tradeCode_idx"
    ON "BsosNetworkParticipation"("optedIn", "tradeCode")`,
];

let ensureSchemaPromise: Promise<void> | null = null;

export function resetBsosNetworkSchemaEnsure() {
  ensureSchemaPromise = null;
}

export async function ensureBsosNetworkSchema(db: SchemaClient) {
  if (!ensureSchemaPromise) {
    ensureSchemaPromise = (async () => {
      for (const statement of BSOS_NETWORK_ENSURE_SQL) {
        await db.$executeRawUnsafe(statement);
      }
    })().catch((error) => {
      ensureSchemaPromise = null;
      throw error;
    });
  }
  await ensureSchemaPromise;
}
