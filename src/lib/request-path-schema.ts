/**
 * Request paths are not a second migration engine.
 * Schema DDL and data backfill belong exclusively to prisma migrate.
 * If required schema is missing, fail closed — including on Preview,
 * which shares production DATABASE_URL and skips migrate deploy.
 */
import { Prisma, type PrismaClient } from "@prisma/client";

type SchemaClient = PrismaClient | Prisma.TransactionClient;

export const REQUEST_PATH_SCHEMA_WRITES_BLOCKED = true;

export class RequestPathSchemaUnavailableError extends Error {
  readonly failClosed = true;
  readonly detail: string;

  constructor(detail: string) {
    super(
      `Required schema is unavailable (${detail}). Request paths fail closed and do not run DDL or backfill. Apply the missing schema through the migration system.`,
    );
    this.name = "RequestPathSchemaUnavailableError";
    this.detail = detail;
  }
}

export function isRequestPathSchemaUnavailableError(
  error: unknown,
): error is RequestPathSchemaUnavailableError {
  return error instanceof RequestPathSchemaUnavailableError;
}

async function tableExists(db: SchemaClient, tableName: string) {
  const rows = await db.$queryRaw<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename = ${tableName}
    ) AS exists
  `;
  return rows[0]?.exists === true;
}

async function existingColumns(db: SchemaClient, tableName: string, columns: string[]) {
  const rows = await db.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ${tableName}
      AND column_name IN (${Prisma.join(columns)})
  `;
  return new Set(rows.map((row) => row.column_name));
}

export async function assertRequiredTablesExist(
  db: SchemaClient,
  tableNames: string[],
) {
  const missing: string[] = [];
  for (const tableName of tableNames) {
    if (!(await tableExists(db, tableName))) missing.push(tableName);
  }
  if (missing.length > 0) {
    throw new RequestPathSchemaUnavailableError(
      `missing table(s): ${missing.join(", ")}`,
    );
  }
}

export async function assertRequiredColumnsExist(
  db: SchemaClient,
  tableName: string,
  columns: string[],
) {
  if (!(await tableExists(db, tableName))) {
    throw new RequestPathSchemaUnavailableError(`missing table: ${tableName}`);
  }
  const present = await existingColumns(db, tableName, columns);
  const missing = columns.filter((column) => !present.has(column));
  if (missing.length > 0) {
    throw new RequestPathSchemaUnavailableError(
      `missing ${tableName} column(s): ${missing.join(", ")}`,
    );
  }
}
