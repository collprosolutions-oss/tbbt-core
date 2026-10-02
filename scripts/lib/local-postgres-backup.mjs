/**
 * Local-only Postgres dump / restore helpers.
 *
 * Refuse any non-local DATABASE_URL before pg_dump or pg_restore.
 * Never dump Production. Object-storage bytes are not part of a
 * database dump — restore recreates metadata only.
 */
import { spawnSync } from "node:child_process";
import {
  assertSafeLocalDatabaseEnvironment,
  scrubAlternateDatabaseEnv,
} from "./local-database-guard.mjs";

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

/**
 * Rebuild a libpq URL from an already-local Prisma URL.
 * Drops Prisma-only query params such as schema=public.
 */
export function libpqUrlForLocalBackup(databaseUrl, action) {
  const parsed = assertSafeLocalDatabaseEnvironment(databaseUrl, action);
  parsed.search = "";
  if (parsed.pathname.length > 1) {
    parsed.pathname = `/${parsed.pathname.replace(/^\//, "").split("/")[0]}`;
  }
  return parsed.toString();
}

function backupEnv(databaseUrl, action) {
  const libpqUrl = libpqUrlForLocalBackup(databaseUrl, action);
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
