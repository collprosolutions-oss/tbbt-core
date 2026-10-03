/**
 * Marketing connection reads and writes fail closed when the migration
 * is missing. This module never runs DDL.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  assertRequiredColumnsExist,
  assertRequiredTablesExist,
  isRequestPathSchemaUnavailableError,
} from "@/lib/request-path-schema";

type Db = PrismaClient | Prisma.TransactionClient;

export const MARKETING_CONNECTION_SCHEMA_UNAVAILABLE_MESSAGE =
  "Marketing connections are unavailable until this workspace's schema is migrated. TBBT will not connect or post.";

export const MARKETING_CONNECTION_TABLES = [
  "MarketingSocialDestination",
  "MarketingConnectionOAuthState",
] as const;

export const MARKETING_DESTINATION_CONNECTION_COLUMNS = [
  "accessTokenCiphertext",
  "refreshTokenCiphertext",
  "tokenExpiresAt",
  "scopesGranted",
  "connectionStatus",
  "lastCheckedAt",
  "lastError",
  "displayName",
  "externalAccountId",
  "disconnectedAt",
  "remoteRevokeNote",
] as const;

const SCHEMA_NAME =
  /MarketingSocialDestination|marketingSocialDestination|MarketingConnectionOAuthState|marketingConnectionOAuthState/;

export function isMarketingConnectionSchemaError(error: unknown) {
  if (isRequestPathSchemaUnavailableError(error)) return true;
  const code =
    error && typeof error === "object" && "code" in error ? String((error as { code?: string }).code) : "";
  if (code === "P2002" || code === "P2003" || code === "P2025") return false;
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (!SCHEMA_NAME.test(message)) return false;
  if (code === "P2021" || code === "P2022") return true;
  return (code === "" || code === "P2010") && /does not exist/i.test(message);
}

export async function assertMarketingConnectionSchema(db: Db) {
  await assertRequiredTablesExist(db, [...MARKETING_CONNECTION_TABLES]);
  await assertRequiredColumnsExist(db, "MarketingSocialDestination", [
    ...MARKETING_DESTINATION_CONNECTION_COLUMNS,
  ]);
  await assertRequiredColumnsExist(db, "MarketingConnectionOAuthState", [
    "tokenHash",
    "purpose",
    "payloadCiphertext",
    "usedAt",
    "expiresAt",
    "businessId",
    "membershipId",
    "destination",
  ]);
}
