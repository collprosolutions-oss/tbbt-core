/**
 * Preview shares Production and skips migrate, so location reads/writes
 * first ensure the additive table and nullable Job column exist.
 * Workspace load must not run this DDL — only location loaders and
 * mutations call it.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

type SchemaClient = PrismaClient | Prisma.TransactionClient;

export const BUSINESS_LOCATION_ENSURE_SQL = [
  `CREATE TABLE IF NOT EXISTS "BusinessLocation" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "addressLine1" TEXT NOT NULL DEFAULT '',
    "addressLine2" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "region" TEXT NOT NULL DEFAULT '',
    "postalCode" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BusinessLocation_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE INDEX IF NOT EXISTS "BusinessLocation_businessId_idx"
    ON "BusinessLocation"("businessId")`,
  `CREATE INDEX IF NOT EXISTS "BusinessLocation_businessId_status_idx"
    ON "BusinessLocation"("businessId", "status")`,
  `ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "businessLocationId" TEXT`,
  `CREATE INDEX IF NOT EXISTS "Job_businessLocationId_idx"
    ON "Job"("businessLocationId")`,
];

let ensureSchemaPromise: Promise<void> | null = null;

export function resetBusinessLocationSchemaEnsure() {
  ensureSchemaPromise = null;
}

export async function ensureBusinessLocationSchema(db: SchemaClient) {
  if (!ensureSchemaPromise) {
    ensureSchemaPromise = (async () => {
      for (const statement of BUSINESS_LOCATION_ENSURE_SQL) {
        await db.$executeRawUnsafe(statement);
      }
    })().catch((error) => {
      ensureSchemaPromise = null;
      throw error;
    });
  }
  await ensureSchemaPromise;
}
