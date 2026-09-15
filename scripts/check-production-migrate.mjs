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

const workspaceLoader = readFileSync(
  new URL("../src/lib/workspace.ts", import.meta.url),
  "utf8",
);
check(
  "Authenticated workspace load ensures public contact columns before Business SELECT",
  workspaceLoader.includes("loadActiveWorkspaceMemberships") &&
    businessContact.includes("export async function loadActiveWorkspaceMemberships") &&
    businessContact.includes("include: { business: true }") &&
    businessContact.indexOf("await ensureBusinessPublicContactSchema(db)") <
      businessContact.lastIndexOf("include: { business: true }"),
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

const appointmentMigration = readFileSync(
  new URL(
    "../prisma/migrations/20260913200000_add_appointment_confirmation/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
check(
  "Appointment confirmation migration is additive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(appointmentMigration) &&
    appointmentMigration.includes('ADD COLUMN IF NOT EXISTS "appointmentConfirmationStatus"') &&
    appointmentMigration.includes('ADD COLUMN IF NOT EXISTS "propertyAccessMethod"') &&
    appointmentMigration.includes('ADD COLUMN IF NOT EXISTS "appointmentChangeRequestNote"') &&
    appointmentMigration.includes('CREATE TABLE IF NOT EXISTS "JobAppointmentEvent"'),
);

const appointmentData = readFileSync(
  new URL("../src/lib/appointment-data.ts", import.meta.url),
  "utf8",
);
check(
  "Preview runtime ensure covers appointment confirmation columns/table skipped by migrate",
  appointmentData.includes("Preview shares Production and skips migrate") &&
    appointmentData.includes('ADD COLUMN IF NOT EXISTS "appointmentConfirmationStatus"') &&
    appointmentData.includes('ADD COLUMN IF NOT EXISTS "appointmentChangeRequestNote"') &&
    appointmentData.includes('CREATE TABLE IF NOT EXISTS "JobAppointmentEvent"') &&
    appointmentData.includes("ensureAppointmentConfirmationSchema"),
);

check(
  "Authenticated workspace load ensures appointment columns before Job SELECT",
  workspaceLoader.includes("ensureAppointmentConfirmationSchema"),
);

const firstRunMigration = readFileSync(
  new URL("../prisma/migrations/20260915120000_add_first_run_setup/migration.sql", import.meta.url),
  "utf8",
);
check(
  "First-run setup migration is additive and one-shot",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(firstRunMigration) &&
    firstRunMigration.includes('ADD COLUMN "firstRunSetupCompletedAt"') &&
    firstRunMigration.includes('UPDATE "Business"') &&
    firstRunMigration.includes("information_schema.columns") &&
    firstRunMigration.includes("IF NOT EXISTS"),
);

const firstRunSetup = readFileSync(
  new URL("../src/lib/first-run-setup.ts", import.meta.url),
  "utf8",
);
check(
  "Preview runtime ensure covers first-run setup column skipped by migrate",
  firstRunSetup.includes("Preview shares Production and skips migrate") &&
    firstRunSetup.includes("ensureFirstRunSetupSchema") &&
    firstRunSetup.includes("FIRST_RUN_SETUP_ENSURE_SQL") &&
    firstRunSetup.includes('ADD COLUMN "firstRunSetupCompletedAt"'),
);

check(
  "Authenticated workspace load ensures first-run setup column before Business SELECT",
  workspaceLoader.includes("ensureFirstRunSetupSchema"),
);

const starterServicesMigration = readFileSync(
  new URL("../prisma/migrations/20260915140000_add_starter_services_setup/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Starter-services setup migration is additive and one-shot",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(starterServicesMigration) &&
    starterServicesMigration.includes('ADD COLUMN "starterServicesSetupCompletedAt"') &&
    starterServicesMigration.includes('ADD COLUMN "starterServicesSetupChoice"') &&
    starterServicesMigration.includes("information_schema.columns") &&
    starterServicesMigration.includes("IF NOT EXISTS"),
);

const starterServicesSetup = readFileSync(
  new URL("../src/lib/starter-services-setup.ts", import.meta.url),
  "utf8",
);
check(
  "Preview runtime ensure covers starter-services setup columns skipped by migrate",
  starterServicesSetup.includes("Preview shares Production and skips migrate") &&
    starterServicesSetup.includes("ensureStarterServicesSetupSchema") &&
    starterServicesSetup.includes("STARTER_SERVICES_SETUP_ENSURE_SQL") &&
    starterServicesSetup.includes('ADD COLUMN "starterServicesSetupCompletedAt"'),
);

check(
  "Authenticated workspace load ensures starter-services setup columns before Business SELECT",
  workspaceLoader.includes("ensureStarterServicesSetupSchema"),
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
