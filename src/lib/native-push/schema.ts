/**
 * Native push schema presence for request paths.
 *
 * Preview shares Production and skips migrate. Request paths fail closed
 * when these tables are missing. They must not CREATE/ALTER.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  assertRequiredColumnsExist,
  assertRequiredTablesExist,
  isRequestPathSchemaUnavailableError,
} from "@/lib/request-path-schema";

type SchemaClient = PrismaClient | Prisma.TransactionClient;

export const NATIVE_PUSH_REQUIRED_TABLES = ["NativePushDevice", "NativePushDelivery"] as const;
export const NATIVE_PUSH_REQUIRED_DEVICE_COLUMNS = ["sessionId"] as const;

let ensurePromise: Promise<void> | null = null;

export function resetNativePushSchemaEnsure() {
  ensurePromise = null;
}

export async function ensureNativePushSchema(db: SchemaClient) {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await assertRequiredTablesExist(db, [...NATIVE_PUSH_REQUIRED_TABLES]);
      await assertRequiredColumnsExist(db, "NativePushDevice", [
        ...NATIVE_PUSH_REQUIRED_DEVICE_COLUMNS,
      ]);
    })().catch((error) => {
      ensurePromise = null;
      throw error;
    });
  }
  await ensurePromise;
}

export async function nativePushDeviceTablePresent(db: SchemaClient) {
  try {
    await assertRequiredTablesExist(db, ["NativePushDevice"]);
    await assertRequiredColumnsExist(db, "NativePushDevice", [
      ...NATIVE_PUSH_REQUIRED_DEVICE_COLUMNS,
    ]);
    return true;
  } catch (error) {
    if (isRequestPathSchemaUnavailableError(error)) {
      return false;
    }
    throw error;
  }
}
