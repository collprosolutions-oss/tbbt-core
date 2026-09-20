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

import { existsSync, readdirSync } from "node:fs";
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

/**
 * Lock-free plan for whether `prisma migrate deploy` is actually needed.
 * Compare local migration folders to `_prisma_migrations` rows from a
 * normal SELECT. Do not use `prisma migrate status` here; that takes the
 * same advisory lock as migrate deploy.
 */
export function planProductionMigrateDeploy({
  localNames = [],
  appliedRows,
  appliedQueryError = false,
} = {}) {
  if (appliedQueryError || appliedRows == null) {
    return { run: true, reason: "could not verify applied migrations" };
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
