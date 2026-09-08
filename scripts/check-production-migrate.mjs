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

const estimatingDefaultsMigration = readFileSync(
  new URL(
    "../prisma/migrations/20260907220000_add_business_estimating_defaults/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
check(
  "Business estimating defaults migration is additive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(estimatingDefaultsMigration) &&
    estimatingDefaultsMigration.includes('CREATE TABLE IF NOT EXISTS "BusinessEstimatingDefault"') &&
    estimatingDefaultsMigration.includes('"workspaceId"') &&
    estimatingDefaultsMigration.includes('"payload"'),
);

const paymentsMigration = readFileSync(
  new URL("../prisma/migrations/20260908010000_add_payments/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Payment migration is additive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(paymentsMigration) &&
    paymentsMigration.includes('CREATE TABLE IF NOT EXISTS "Payment"') &&
    paymentsMigration.includes('"purpose"') &&
    paymentsMigration.includes('"stripeCheckoutSessionId"') &&
    paymentsMigration.includes('"stripePaymentIntentId"'),
);

const availabilityMigration = readFileSync(
  new URL("../prisma/migrations/20260908140000_add_business_availability/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Business availability migration is additive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(availabilityMigration) &&
    availabilityMigration.includes('ADD COLUMN IF NOT EXISTS "workStartMinutes"') &&
    availabilityMigration.includes('ADD COLUMN IF NOT EXISTS "schedulingBufferMinutes"') &&
    availabilityMigration.includes('CREATE TABLE IF NOT EXISTS "BusinessUnavailableDate"'),
);

const materialPriceMigration = readFileSync(
  new URL("../prisma/migrations/20260908190000_add_material_price_engine/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Material price engine migration is additive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(materialPriceMigration) &&
    materialPriceMigration.includes('CREATE TABLE IF NOT EXISTS "BusinessSupplierPreference"') &&
    materialPriceMigration.includes('CREATE TABLE IF NOT EXISTS "BusinessMaterialSupplierMapping"') &&
    materialPriceMigration.includes('CREATE TABLE IF NOT EXISTS "SupplierPriceRecord"'),
);

const materialPriceDb = readFileSync(
  new URL("../src/lib/material-pricing/db.ts", import.meta.url),
  "utf8",
);
check(
  "Preview runtime ensure covers material price engine tables skipped by migrate",
  materialPriceDb.includes("Preview shares Production and skips migrate") &&
    materialPriceDb.includes("CREATE TABLE IF NOT EXISTS") &&
    materialPriceDb.includes("ensureMaterialPriceEngineTables"),
);

const publicContactMigration = readFileSync(
  new URL("../prisma/migrations/20260908210000_add_business_public_contact/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Business public contact migration is additive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(publicContactMigration) &&
    publicContactMigration.includes('ADD COLUMN IF NOT EXISTS "publicPhone"') &&
    publicContactMigration.includes('ADD COLUMN IF NOT EXISTS "publicEmail"') &&
    publicContactMigration.includes('ADD COLUMN IF NOT EXISTS "publicWebsite"'),
);

const businessContact = readFileSync(
  new URL("../src/lib/business-contact.ts", import.meta.url),
  "utf8",
);
check(
  "Preview runtime ensure covers public contact columns skipped by migrate",
  businessContact.includes("Preview shares Production and skips migrate") &&
    businessContact.includes('ADD COLUMN IF NOT EXISTS "publicPhone"') &&
    businessContact.includes("ensureBusinessPublicContactSchema"),
);

const availabilityData = readFileSync(
  new URL("../src/lib/availability-data.ts", import.meta.url),
  "utf8",
);
check(
  "Preview runtime ensure covers availability columns/table skipped by migrate",
  availabilityData.includes("Preview shares Production and skips migrate") &&
    availabilityData.includes("ADD COLUMN IF NOT EXISTS \"workStartMinutes\"") &&
    availabilityData.includes("CREATE TABLE IF NOT EXISTS \"BusinessUnavailableDate\"") &&
    availabilityData.includes("ensureBusinessAvailabilitySchema"),
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
