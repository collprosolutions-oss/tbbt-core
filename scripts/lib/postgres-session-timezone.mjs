/**
 * P1 gate Postgres session-timezone contract.
 *
 * Production sessions are UTC. Prisma DateTime columns are TIMESTAMP(3)
 * without time zone, and $queryRaw Date parameters are interpreted in
 * the session timezone. A non-UTC session silently shifts stored
 * instants. The gate sets the current role to UTC and refuses to start
 * DB-backed children unless a fresh connection reports SHOW timezone
 * = UTC.
 */
import { createRequire } from "node:module";
import { assertLocalDatabaseUrl } from "./local-database-guard.mjs";

export const REQUIRED_POSTGRES_SESSION_TIMEZONE = "UTC";

export function showTimezoneValue(rows) {
  const row = rows?.[0] ?? {};
  const value = row.TimeZone ?? row.timezone ?? Object.values(row)[0];
  return String(value ?? "").trim();
}

export function postgresSessionTimezoneProblem(shown, required = REQUIRED_POSTGRES_SESSION_TIMEZONE) {
  if (shown === required) return null;
  return (
    `P1 gate requires Postgres session timezone ${required} ` +
    `(production default). SHOW timezone is ${JSON.stringify(shown)}. ` +
    `A non-UTC session shifts TIMESTAMP without time zone values used by ` +
    `time-card weeks and NativeSignInThrottle. Set it with ` +
    `ALTER ROLE <user> SET timezone = '${required}' and reconnect.`
  );
}

export async function assertPostgresSessionTimezoneUtc(
  databaseUrl,
  env = process.env,
) {
  assertLocalDatabaseUrl(databaseUrl, "assert Postgres session timezone UTC", env);
  const require = createRequire(import.meta.url);
  const { PrismaClient } = require("@prisma/client");

  const setter = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    await setter.$executeRawUnsafe(`SET timezone = '${REQUIRED_POSTGRES_SESSION_TIMEZONE}'`);
    const afterSet = showTimezoneValue(await setter.$queryRawUnsafe("SHOW timezone"));
    const setProblem = postgresSessionTimezoneProblem(afterSet);
    if (setProblem) {
      throw new Error(`SET timezone = '${REQUIRED_POSTGRES_SESSION_TIMEZONE}' failed. ${setProblem}`);
    }
    await setter.$executeRawUnsafe(
      `ALTER ROLE CURRENT_USER SET timezone = '${REQUIRED_POSTGRES_SESSION_TIMEZONE}'`,
    );
  } finally {
    await setter.$disconnect();
  }

  const verifier = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const shown = showTimezoneValue(await verifier.$queryRawUnsafe("SHOW timezone"));
    const problem = postgresSessionTimezoneProblem(shown);
    if (problem) {
      throw new Error(problem);
    }
    return shown;
  } finally {
    await verifier.$disconnect();
  }
}
