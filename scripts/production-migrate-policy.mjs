/**
 * Preview and the unused `workspace` Vercel project share DATABASE_URL
 * with live collpro-reno Production. Prisma migrate deploy takes
 * PostgreSQL advisory lock 72707369 (P1002 if contended).
 *
 * Preview already skips migrate. Production still raced because both
 * Vercel projects build with VERCEL_ENV=production on the same commit.
 * Only the collpro-reno Production project may run migrate.
 *
 * collpro-reno Production still must not call `prisma migrate deploy` on
 * every code-only build: that no-op still waits on the advisory lock and
 * can P1002 while `_prisma_migrations` is already current. Pending or
 * unfinished migrations still run migrate deploy with Prisma locking on.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const COLLPRO_RENO_VERCEL_PROJECT_ID = "prj_7xmTwilZyg0plUHRzHgvboCusHLp";
export const WORKSPACE_VERCEL_PROJECT_ID = "prj_93RU249o7PH0npog4XAuKAFZN0hd";

function hostnameOf(value) {
  const raw = (value ?? "").trim();
  if (!raw) return "";
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return raw.split("/")[0].toLowerCase();
  }
}

export function isCollProRenoMigrateOwner({
  projectId,
  projectName,
  productionUrl,
} = {}) {
  const id = (projectId ?? "").trim();
  const name = (projectName ?? "").trim().toLowerCase();
  if (id === COLLPRO_RENO_VERCEL_PROJECT_ID) return true;
  if (id === WORKSPACE_VERCEL_PROJECT_ID) return false;
  if (name === "collpro-reno") return true;
  if (name === "workspace") return false;
  const host = hostnameOf(productionUrl);
  return (
    host === "collproreno.com" ||
    host === "www.collproreno.com" ||
    host === "collpro-reno.vercel.app"
  );
}

export function shouldRunProductionMigrate({
  vercelEnv,
  projectId,
  projectName,
  productionUrl,
} = {}) {
  const env = (vercelEnv || "local").trim() || "local";
  if (env !== "production") {
    return { run: false, reason: `${env} build` };
  }
  if (isCollProRenoMigrateOwner({ projectId, projectName, productionUrl })) {
    return { run: true, reason: "collpro-reno production" };
  }
  return { run: false, reason: "not the migrate-owner Vercel project" };
}

export function listLocalMigrationNames(migrationsDir) {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(path.join(migrationsDir, entry.name, "migration.sql")))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Prisma stores sha256(migration.sql file bytes) as a 64-char hex checksum.
 * Hash the on-disk file; do not rename or edit an already-applied directory.
 */
export function prismaMigrationChecksum(sqlBytes) {
  return createHash("sha256").update(sqlBytes).digest("hex");
}

export function listLocalMigrationChecksums(migrationsDir) {
  const checksums = {};
  for (const name of listLocalMigrationNames(migrationsDir)) {
    checksums[name] = prismaMigrationChecksum(
      readFileSync(path.join(migrationsDir, name, "migration.sql")),
    );
  }
  return checksums;
}

function appliedMigrationNames(appliedRows = []) {
  const names = new Set();
  for (const row of appliedRows) {
    const finishedAt = row.finished_at ?? row.finishedAt ?? null;
    const rolledBackAt = row.rolled_back_at ?? row.rolledBackAt ?? null;
    const name = row.migration_name ?? row.migrationName;
    if (name && finishedAt && !rolledBackAt) names.add(name);
  }
  return names;
}

function hasUnfinishedAppliedMigration(appliedRows = []) {
  return appliedRows.some((row) => {
    const finishedAt = row.finished_at ?? row.finishedAt ?? null;
    const rolledBackAt = row.rolled_back_at ?? row.rolledBackAt ?? null;
    return !finishedAt && !rolledBackAt;
  });
}

function appliedMigrationRecords(appliedRows = []) {
  const records = [];
  for (const row of appliedRows) {
    const finishedAt = row.finished_at ?? row.finishedAt ?? null;
    const rolledBackAt = row.rolled_back_at ?? row.rolledBackAt ?? null;
    const name = row.migration_name ?? row.migrationName;
    const checksum = row.checksum ?? null;
    if (name && finishedAt && !rolledBackAt) {
      records.push({ name, checksum });
    }
  }
  return records;
}

function collectErrorCodes(error, depth = 0, codes = new Set()) {
  if (!error || typeof error !== "object" || depth > 6) return codes;
  if (typeof error.code === "string") codes.add(error.code);
  if (typeof error.sqlState === "string") codes.add(error.sqlState);
  if (error.meta && typeof error.meta.code === "string") codes.add(error.meta.code);
  collectErrorCodes(error.cause, depth + 1, codes);
  collectErrorCodes(error.originalError, depth + 1, codes);
  collectErrorCodes(error.meta, depth + 1, codes);
  return codes;
}

export function extractPostgresSqlState(error) {
  const codes = collectErrorCodes(error);
  if (codes.has("42P01")) return "42P01";
  return [...codes][0] || "";
}

export function isPrismaMigrationsTableMissingError(error) {
  return extractPostgresSqlState(error) === "42P01";
}

/**
 * Lock-free plan for whether `prisma migrate deploy` is actually needed.
 * Compare local migration folders to `_prisma_migrations` rows from a
 * normal SELECT. Do not use `prisma migrate status` here; that takes the
 * same advisory lock as migrate deploy.
 *
 * Fail closed before deploy when applied history is unavailable, an
 * applied name is missing locally, or a Prisma checksum diverges.
 * Postgres 42P01 (_prisma_migrations absent) is the one exception:
 * a brand-new empty database may bootstrap; existing user tables block.
 */
export function planProductionMigrateDeploy({
  localNames = [],
  localChecksums = null,
  appliedRows,
  appliedQueryError = false,
  appliedQueryCode = null,
  migrationsTableMissing = false,
  userTableCount = null,
} = {}) {
  if (appliedQueryError || appliedRows == null) {
    const missingTable =
      migrationsTableMissing === true || appliedQueryCode === "42P01";
    if (missingTable && userTableCount === 0) {
      return { run: true, reason: "fresh empty database" };
    }
    if (missingTable && Number.isFinite(userTableCount) && userTableCount > 0) {
      return {
        run: false,
        blocked: true,
        reason: "_prisma_migrations missing with existing user tables",
      };
    }
    return {
      run: false,
      blocked: true,
      reason: "applied migration history unavailable",
    };
  }

  const localNameSet = new Set(localNames);
  const appliedRecords = appliedMigrationRecords(appliedRows);
  const missingLocally = appliedRecords
    .map((row) => row.name)
    .filter((name) => !localNameSet.has(name));
  if (missingLocally.length > 0) {
    return {
      run: false,
      blocked: true,
      reason: `applied migrations missing locally: ${missingLocally.join(", ")}`,
    };
  }

  if (localChecksums) {
    const mismatches = appliedRecords
      .filter((row) => {
        const localChecksum = localChecksums[row.name];
        return row.checksum && localChecksum && row.checksum !== localChecksum;
      })
      .map((row) => row.name);
    if (mismatches.length > 0) {
      return {
        run: false,
        blocked: true,
        reason: `checksum mismatch: ${mismatches.join(", ")}`,
      };
    }
  }

  if (hasUnfinishedAppliedMigration(appliedRows)) {
    return { run: true, reason: "unfinished migration recorded" };
  }
  const applied = appliedMigrationNames(appliedRows);
  const pending = localNames.filter((name) => !applied.has(name));
  if (pending.length === 0) {
    return { run: false, reason: "no pending migrations" };
  }
  return { run: true, reason: `pending migrations: ${pending.join(", ")}` };
}

/**
 * Preview shares Production DATABASE_URL and skips migrate deploy.
 * Request paths must never become a second migration engine: no schema
 * DDL and no backfill DML. Missing required schema fails closed.
 */
export const REQUEST_PATH_SCHEMA_WRITES_BLOCKED = true;

export function isPreviewSharedProductionRuntime({ vercelEnv } = {}) {
  return String(vercelEnv ?? "").trim().toLowerCase() === "preview";
}

export function classifyRequestPathSql(sql) {
  const text = String(sql ?? "");
  const schemaDdl =
    /\b(CREATE|ALTER|DROP|TRUNCATE)\s+(TABLE|INDEX|UNIQUE|SCHEMA|DATABASE|COLUMN|CONSTRAINT|TYPE)\b/i.test(
      text,
    ) ||
    /\bADD\s+COLUMN\b/i.test(text) ||
    /\bCREATE\s+(UNIQUE\s+)?INDEX\b/i.test(text) ||
    /\bCREATE\s+TABLE\b/i.test(text);
  const backfillDml = /\b(INSERT|UPDATE|DELETE)\s+(INTO\s+|FROM\s+)?/i.test(text);
  return { schemaDdl, backfillDml };
}

export function requestPathSchemaWritesBlocked() {
  return REQUEST_PATH_SCHEMA_WRITES_BLOCKED === true;
}

export function planRequestPathSchemaEnsure({ statements = [] } = {}) {
  const classified = statements.map((sql) => ({
    sql,
    ...classifyRequestPathSql(sql),
  }));
  const ddl = classified.filter((row) => row.schemaDdl);
  const dml = classified.filter((row) => row.backfillDml);
  if (ddl.length > 0 || dml.length > 0) {
    return {
      allowed: false,
      blocked: true,
      failClosed: true,
      reason: "request-path schema writes are forbidden; use the migration system",
    };
  }
  return {
    allowed: true,
    blocked: false,
    failClosed: true,
    reason: "request path is not a migration engine",
  };
}

export function failClosedRequiredSchema({ present, name } = {}) {
  if (!present) {
    return {
      ok: false,
      blocked: true,
      failClosed: true,
      reason: `required schema unavailable: ${name || "unknown"}`,
    };
  }
  return { ok: true, blocked: false, failClosed: true };
}
