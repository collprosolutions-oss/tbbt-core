/**
 * Production migrate-owner policy. No database access.
 *
 * Run with:
 *   node scripts/check-production-migrate.mjs
 */
import { readFileSync } from "node:fs";
import {
  COLLPRO_RENO_VERCEL_PROJECT_ID,
  WORKSPACE_VERCEL_PROJECT_ID,
  shouldRunProductionMigrate,
} from "./production-migrate-policy.mjs";

let passed = 0;
let failed = 0;
function check(label, ok) {
  if (ok) {
    passed += 1;
    console.log(`  ok  - ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL - ${label}`);
  }
}

const runner = readFileSync(new URL("./run-production-migrate.mjs", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../prisma/migrations/20260905180000_add_request_intake_photos_measurements/migration.sql", import.meta.url),
  "utf8",
);

console.log("\nSTATIC — Production migrate lock policy");
check("Preview still skips migrate", runner.includes("shouldRunProductionMigrate"));
check("Prisma advisory locking is not disabled", !runner.includes("PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK"));
check(
  "Intake measurement migration is still additive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migration) &&
    migration.includes('ADD COLUMN "intakeMeasurementMode"') &&
    migration.includes('CREATE TABLE "ServiceRequestMeasurement"') &&
    migration.includes("WHERE name = 'Blind / Shade Installation'"),
);

check(
  "Local builds skip migrate",
  shouldRunProductionMigrate({ vercelEnv: undefined }).run === false,
);
check(
  "Preview builds skip migrate",
  shouldRunProductionMigrate({
    vercelEnv: "preview",
    projectId: COLLPRO_RENO_VERCEL_PROJECT_ID,
    productionUrl: "www.collproreno.com",
  }).run === false,
);
check(
  "collpro-reno Production runs migrate",
  shouldRunProductionMigrate({
    vercelEnv: "production",
    projectId: COLLPRO_RENO_VERCEL_PROJECT_ID,
    projectName: "collpro-reno",
    productionUrl: "www.collproreno.com",
  }).run === true,
);
check(
  "collpro-reno Production runs migrate by project name",
  shouldRunProductionMigrate({
    vercelEnv: "production",
    projectName: "collpro-reno",
  }).run === true,
);
check(
  "workspace Production skips migrate",
  shouldRunProductionMigrate({
    vercelEnv: "production",
    projectId: WORKSPACE_VERCEL_PROJECT_ID,
    projectName: "workspace",
    productionUrl: "workspace.vercel.app",
  }).run === false,
);
check(
  "Unknown production project skips migrate rather than racing",
  shouldRunProductionMigrate({
    vercelEnv: "production",
    projectId: "prj_other",
    productionUrl: "other.vercel.app",
  }).run === false,
);

console.log(
  failed === 0
    ? `\nAll production-migrate checks passed (${passed}).`
    : `\n${failed} production-migrate check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
