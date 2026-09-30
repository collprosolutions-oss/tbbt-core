/**
 * TBBT Founder production preflight.
 *
 * Read-only. Does not deploy, migrate, or write. The production database
 * probe runs only when both of these are set:
 *   TBBT_FOUNDER_PRODUCTION_READONLY_DATABASE_URL
 *   TBBT_FOUNDER_PRODUCTION_READONLY_CONFIRM=confirm-readonly
 * DATABASE_URL is reported as present or absent and is never opened.
 *
 *   node --experimental-strip-types scripts/founder-production-preflight.mjs
 *
 * Exit 0 when launch clearance is CLEAR, 2 when any check is BLOCKED,
 * and 1 when required items are still missing or manual.
 */
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  CERTIFICATION_SCRIPT_NAMES,
  CONVERSION_MIGRATION_NAME,
  conversionMigrationGuardsDuplicates,
  evaluateFounderProductionPreflight,
  formatPreflightReport,
  preflightExitCode,
  productionDatabaseProbeDecision,
  sensitiveValuesFromEnv,
  snapshotPreflightEnv,
} = await import("@/lib/founder-production-preflight");
const {
  listLocalMigrationChecksums,
  listLocalMigrationNames,
  planProductionMigrateDeploy,
  shouldRunProductionMigrate,
} = await import("./production-migrate-policy.mjs");
const { runProductionReadonlyProbe } = await import("./founder-production-preflight-db.mjs");

const env = snapshotPreflightEnv(process.env);
const decision = productionDatabaseProbeDecision(env);
let probe = null;
let migrationPlan = null;

if (decision.action === "connect") {
  const result = await runProductionReadonlyProbe(decision.databaseUrl);
  probe = result.probe;
  if (probe.connectivity === "ok") {
    const migrationsDir = fileURLToPath(new URL("../prisma/migrations", import.meta.url));
    migrationPlan = planProductionMigrateDeploy({
      localNames: listLocalMigrationNames(migrationsDir),
      localChecksums: listLocalMigrationChecksums(migrationsDir),
      appliedRows: result.migration.rows ?? undefined,
      appliedQueryError: result.migration.queryError,
      appliedQueryCode: result.migration.queryCode,
      migrationsTableMissing: result.migration.tableMissing,
      userTableCount: result.migration.userTableCount,
    });
  }
}

const migrationPath = fileURLToPath(
  new URL(`../prisma/migrations/${CONVERSION_MIGRATION_NAME}/migration.sql`, import.meta.url),
);
let conversionMigration = { present: false, guardsDuplicates: false };
try {
  const sql = readFileSync(migrationPath, "utf8");
  conversionMigration = {
    present: true,
    guardsDuplicates: conversionMigrationGuardsDuplicates(sql),
  };
} catch {
  conversionMigration = { present: false, guardsDuplicates: false };
}

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
);
const certificationScriptsPresent = Object.fromEntries(
  CERTIFICATION_SCRIPT_NAMES.map((name) => [name, typeof packageJson.scripts?.[name] === "string"]),
);

const migrateOwner = shouldRunProductionMigrate({
  vercelEnv: env.VERCEL_ENV,
  projectId: env.VERCEL_PROJECT_ID,
  projectName: env.VERCEL_PROJECT_NAME,
  productionUrl: env.VERCEL_PROJECT_PRODUCTION_URL,
});

const report = evaluateFounderProductionPreflight({
  env,
  conversionMigration,
  certificationScriptsPresent,
  migrateOwner,
  migrationPlan,
  probe,
});
const text = formatPreflightReport(report, {
  sensitiveValues: sensitiveValuesFromEnv(process.env),
});
console.log(text);
process.exit(preflightExitCode(report));
