/**
 * Native push schema presence for request paths.
 *
 * Preview shares Production and skips migrate. Request paths fail closed
 * when these tables are missing. They must not CREATE/ALTER. Historical
 * SQL below is the migrate-system stand-in only.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { assertRequiredTablesExist } from "@/lib/request-path-schema";

type SchemaClient = PrismaClient | Prisma.TransactionClient;

export const NATIVE_PUSH_REQUIRED_TABLES = ["NativePushDevice", "NativePushDelivery"] as const;

/** Historical migration SQL. Never execute from a request path. */
export const NATIVE_PUSH_ENSURE_SQL = [
  `CREATE TABLE IF NOT EXISTS "NativePushDevice" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenLast4" TEXT NOT NULL DEFAULT '',
    "deviceToken" TEXT NOT NULL,
    "optedIn" BOOLEAN NOT NULL DEFAULT false,
    "revokedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "NativePushDevice_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE TABLE IF NOT EXISTS "NativePushDelivery" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "payloadSnapshot" JSONB NOT NULL,
    "provider" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "NativePushDelivery_pkey" PRIMARY KEY ("id")
  )`,
];

let ensurePromise: Promise<void> | null = null;

export function resetNativePushSchemaEnsure() {
  ensurePromise = null;
}

export async function ensureNativePushSchema(db: SchemaClient) {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await assertRequiredTablesExist(db, [...NATIVE_PUSH_REQUIRED_TABLES]);
    })().catch((error) => {
      ensurePromise = null;
      throw error;
    });
  }
  await ensurePromise;
}

export async function nativePushDeviceTablePresent(db: SchemaClient) {
  const rows = await db.$queryRaw<Array<{ present: boolean | string | null }>>`
    SELECT to_regclass('"NativePushDevice"') IS NOT NULL AS present
  `;
  const present = rows[0]?.present;
  return present === true || present === "t";
}
