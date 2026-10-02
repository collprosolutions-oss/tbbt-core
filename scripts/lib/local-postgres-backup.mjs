/**
 * Local-only Postgres dump / restore helpers.
 *
 * Refuse any non-local DATABASE_URL before pg_dump or pg_restore.
 * Refuse URL fragments (libpq can reinterpret text before '@').
 * Refuse any database name that is not a disposable
 * tbbt_handy_restore_* name — never dump or restore the shared
 * localhost `tbbt` database or any other pre-existing name.
 * Never dump Production. Object-storage bytes are not part of a
 * database dump — restore recreates metadata only.
 */
import { spawnSync } from "node:child_process";
import {
  RemoteDatabaseRefusedError,
  assertSafeLocalDatabaseEnvironment,
  scrubAlternateDatabaseEnv,
} from "./local-database-guard.mjs";

export const HANDYMAN_RESTORE_DATABASE_PREFIX = "tbbt_handy_restore_";

export class RestoreDatabaseNameRefusedError extends Error {
  constructor(message, { databaseName, action } = {}) {
    super(message);
    this.name = "RestoreDatabaseNameRefusedError";
    this.databaseName = databaseName ?? "";
    this.action = action ?? "";
  }
}

const CANDIDATE_BIN_DIRS = [
  "",
  "/usr/bin/",
  "/usr/lib/postgresql/16/bin/",
  "/usr/lib/postgresql/15/bin/",
  "/usr/lib/postgresql/14/bin/",
];

function findPostgresTool(name) {
  for (const dir of CANDIDATE_BIN_DIRS) {
    const candidate = `${dir}${name}`;
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  throw new Error(
    `${name} is required for the local restore drill. Install PostgreSQL client tools on localhost.`,
  );
}

function databaseNameFromParsed(parsed) {
  return decodeURIComponent(parsed.pathname.replace(/^\//, "").split("/")[0] || "");
}

export function assertHandymanRestoreDatabaseName(databaseUrl, action) {
  const parsed = new URL(libpqUrlForLocalBackup(databaseUrl, action));
  const databaseName = databaseNameFromParsed(parsed);
  if (
    !databaseName ||
    !/^[a-z0-9_]+$/.test(databaseName) ||
    !databaseName.startsWith(HANDYMAN_RESTORE_DATABASE_PREFIX)
  ) {
    throw new RestoreDatabaseNameRefusedError(
      `Refusing to ${action}: database name must start with "${HANDYMAN_RESTORE_DATABASE_PREFIX}" (got ${JSON.stringify(databaseName || "")}).`,
      { databaseName, action },
    );
  }
  return databaseName;
}

/**
 * Rebuild a libpq URL from an already-local Prisma URL.
 * Drops Prisma-only query params such as schema=public and any
 * fragment. A fragment is refused: libpq treats text up to the first
 * '@' as userinfo, so
 * postgresql://127.0.0.1:54321#@evil.invalid:5999/x would otherwise
 * target evil.invalid:5999 after WHATWG parsing reports host 127.0.0.1.
 */
export function libpqUrlForLocalBackup(databaseUrl, action) {
  const raw = String(databaseUrl ?? "");
  const parsed = assertSafeLocalDatabaseEnvironment(raw, action);
  if (raw.includes("#") || parsed.hash) {
    throw new RemoteDatabaseRefusedError(
      `Refusing to ${action}: DATABASE_URL must not include a URL fragment. libpq may treat text before '@' as userinfo and connect off-localhost.`,
      { host: parsed.hostname, action },
    );
  }
  parsed.search = "";
  parsed.hash = "";
  if (parsed.pathname.length > 1) {
    parsed.pathname = `/${parsed.pathname.replace(/^\//, "").split("/")[0]}`;
  }
  return parsed.toString();
}

function backupEnv(databaseUrl, action) {
  const libpqUrl = libpqUrlForLocalBackup(databaseUrl, action);
  assertHandymanRestoreDatabaseName(databaseUrl, action);
  return {
    env: { ...scrubAlternateDatabaseEnv(process.env), PGCONNECT_TIMEOUT: "8" },
    libpqUrl,
  };
}

export function dumpLocalDatabase({ databaseUrl, outputPath }) {
  const { env, libpqUrl } = backupEnv(databaseUrl, "pg_dump");
  const pgDump = findPostgresTool("pg_dump");
  const result = spawnSync(
    pgDump,
    [
      "--dbname",
      libpqUrl,
      "--format=custom",
      "--compress=0",
      "--no-owner",
      "--no-acl",
      "--file",
      outputPath,
    ],
    { env, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`pg_dump failed: ${result.stderr || result.stdout || "unknown error"}`);
  }
  return { tool: pgDump, libpqUrl };
}

export function restoreLocalDatabase({ databaseUrl, inputPath }) {
  const { env, libpqUrl } = backupEnv(databaseUrl, "pg_restore");
  const pgRestore = findPostgresTool("pg_restore");
  const result = spawnSync(
    pgRestore,
    [
      "--dbname",
      libpqUrl,
      "--no-owner",
      "--no-acl",
      "--exit-on-error",
      inputPath,
    ],
    { env, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`pg_restore failed: ${result.stderr || result.stdout || "unknown error"}`);
  }
  return { tool: pgRestore, libpqUrl };
}

/**
 * Convert a custom-format dump to plain SQL without connecting to a
 * database. Used to scan for leaked text (file-byte sentinels).
 */
export function readCustomDumpPlainSql(inputPath) {
  const pgRestore = findPostgresTool("pg_restore");
  const result = spawnSync(pgRestore, ["-f", "-", inputPath], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `pg_restore -f - failed: ${result.stderr || result.stdout || "unknown error"}`,
    );
  }
  return result.stdout || "";
}

export function dumpPlainSqlContains(inputPath, needle) {
  return readCustomDumpPlainSql(inputPath).includes(needle);
}
