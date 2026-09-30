/**
 * Vercel Preview and the unused `workspace` project share DATABASE_URL
 * with live collpro-reno Production. Running `prisma migrate deploy` on
 * every build contends for PostgreSQL advisory lock 72707369 (P1002).
 *
 * Preview and local `npm run build` skip migrate. Production migrate
 * runs only on the collpro-reno Vercel project, and only when local
 * migration folders are not already recorded in `_prisma_migrations`.
 * Unavailable or checksum-divergent applied history fails closed
 * before deploy. Prisma locking stays on for real pending migrations.
 */
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  extractPostgresSqlState,
  isPrismaMigrationsTableMissingError,
  listLocalMigrationChecksums,
  listLocalMigrationNames,
  planProductionMigrateDeploy,
  shouldRunProductionMigrate,
} from "./production-migrate-policy.mjs";

const require = createRequire(import.meta.url);
const migrationsDir = fileURLToPath(new URL("../prisma/migrations", import.meta.url));

async function readAppliedMigrationRows() {
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();
  try {
    return await prisma.$queryRaw`
      SELECT "migration_name", "checksum", "finished_at", "rolled_back_at"
      FROM "_prisma_migrations"
    `;
  } finally {
    await prisma.$disconnect();
  }
}

async function countPublicUserTables() {
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS n
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name <> '_prisma_migrations'
    `;
    return rows[0]?.n ?? null;
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const decision = shouldRunProductionMigrate({
    vercelEnv: process.env.VERCEL_ENV,
    projectId: process.env.VERCEL_PROJECT_ID,
    projectName: process.env.VERCEL_PROJECT_NAME,
    productionUrl: process.env.VERCEL_PROJECT_PRODUCTION_URL,
  });

  if (!decision.run) {
    console.log(`Skipping prisma migrate deploy (${decision.reason}).`);
    process.exit(0);
  }

  const localNames = listLocalMigrationNames(migrationsDir);
  const localChecksums = listLocalMigrationChecksums(migrationsDir);
  let appliedRows;
  let appliedQueryError = false;
  let appliedQueryCode = null;
  let migrationsTableMissing = false;
  let userTableCount = null;
  try {
    appliedRows = await readAppliedMigrationRows();
  } catch (error) {
    appliedQueryError = true;
    appliedQueryCode = extractPostgresSqlState(error);
    migrationsTableMissing = isPrismaMigrationsTableMissingError(error);
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`Could not read _prisma_migrations (${detail}).`);
    if (migrationsTableMissing) {
      try {
        userTableCount = await countPublicUserTables();
      } catch {
        userTableCount = null;
      }
    }
  }

  const plan = planProductionMigrateDeploy({
    localNames,
    localChecksums,
    appliedRows,
    appliedQueryError,
    appliedQueryCode,
    migrationsTableMissing,
    userTableCount,
  });
  if (plan.blocked) {
    console.error(`Refusing prisma migrate deploy (${plan.reason}).`);
    process.exit(1);
  }
  if (!plan.run) {
    console.log(`Skipping prisma migrate deploy (${plan.reason}).`);
    process.exit(0);
  }

  console.log(`Running prisma migrate deploy (${plan.reason}).`);
  const result = spawnSync("npx", ["prisma", "migrate", "deploy"], {
    stdio: "inherit",
    env: process.env,
  });
  process.exit(result.status ?? 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
