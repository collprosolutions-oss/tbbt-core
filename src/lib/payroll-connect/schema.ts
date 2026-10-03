/**
 * Payroll-provider schema presence for request paths.
 * Missing tables fail closed. Request paths do not CREATE or ALTER.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  assertRequiredTablesExist,
  isRequestPathSchemaUnavailableError,
} from "@/lib/request-path-schema";

type SchemaClient = PrismaClient | Prisma.TransactionClient;

export const PAYROLL_CONNECT_REQUIRED_TABLES = [
  "PayrollConnection",
  "PayrollConnectionOAuthState",
  "PayrollProviderPayrollFact",
  "PayrollProviderPayrollFactLine",
] as const;

let ensurePromise: Promise<void> | null = null;

export function resetPayrollConnectSchemaEnsure() {
  ensurePromise = null;
}

export async function ensurePayrollConnectSchema(db: SchemaClient) {
  if (!ensurePromise) {
    ensurePromise = assertRequiredTablesExist(db, [...PAYROLL_CONNECT_REQUIRED_TABLES]).catch((error) => {
      ensurePromise = null;
      throw error;
    });
  }
  await ensurePromise;
}

export { isRequestPathSchemaUnavailableError };
