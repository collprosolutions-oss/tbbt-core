/**
 * Native push schema presence for request paths.
 *
 * Preview shares Production and skips migrate. Request paths fail closed
 * when these tables are missing. They must not CREATE/ALTER.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { assertRequiredTablesExist } from "@/lib/request-path-schema";

type SchemaClient = PrismaClient | Prisma.TransactionClient;

export const NATIVE_PUSH_REQUIRED_TABLES = ["NativePushDevice", "NativePushDelivery"] as const;

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
