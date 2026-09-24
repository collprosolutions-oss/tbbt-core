/**
 * Production migrate-owner policy. No database access.
 *
 * Run with:
 *   node scripts/check-production-migrate.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  COLLPRO_RENO_VERCEL_PROJECT_ID,
  WORKSPACE_VERCEL_PROJECT_ID,
  listLocalMigrationNames,
  planProductionMigrateDeploy,
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
  "Production runner does not use db push or disable migrate safety",
  !runner.includes("db push") &&
    !runner.includes("prisma migrate reset") &&
    runner.includes('spawnSync("npx", ["prisma", "migrate", "deploy"]'),
);
check(
  "Code-only production builds skip migrate deploy without taking the advisory lock",
  runner.includes("planProductionMigrateDeploy") &&
    runner.includes("readAppliedMigrationRows") &&
    runner.includes("_prisma_migrations") &&
    runner.includes("Skipping prisma migrate deploy (${plan.reason})") &&
    !runner.includes("prisma migrate status"),
);
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

const websiteSetupMigration = readFileSync(
  new URL("../prisma/migrations/20260915160000_add_website_setup/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Website setup migration is additive and one-shot",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(websiteSetupMigration) &&
    websiteSetupMigration.includes('ADD COLUMN "websiteSetupCompletedAt"') &&
    websiteSetupMigration.includes('ADD COLUMN "websiteSetupChoice"') &&
    websiteSetupMigration.includes("publicServiceAreaLabel") &&
    websiteSetupMigration.includes("information_schema.columns") &&
    websiteSetupMigration.includes("IF NOT EXISTS"),
);

const websiteSetup = readFileSync(
  new URL("../src/lib/website-setup.ts", import.meta.url),
  "utf8",
);
check(
  "Preview runtime ensure covers website setup columns skipped by migrate",
  websiteSetup.includes("Preview shares Production and skips migrate") &&
    websiteSetup.includes("ensureWebsiteSetupSchema") &&
    websiteSetup.includes("WEBSITE_SETUP_ENSURE_SQL") &&
    websiteSetup.includes('ADD COLUMN "websiteSetupCompletedAt"'),
);

check(
  "Authenticated workspace load ensures website setup columns before Business SELECT",
  workspaceLoader.includes("ensureWebsiteSetupSchema"),
);

const saasBillingMigration = readFileSync(
  new URL("../prisma/migrations/20260915180000_add_saas_billing/migration.sql", import.meta.url),
  "utf8",
);
check(
  "SaaS billing migration is additive and distinct from Connect",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(saasBillingMigration) &&
    saasBillingMigration.includes('CREATE TABLE IF NOT EXISTS "BusinessSaasSubscription"') &&
    saasBillingMigration.includes('CREATE TABLE IF NOT EXISTS "SaasBillingWebhookEvent"') &&
    saasBillingMigration.includes("Do not backfill Stripe Customer") &&
    saasBillingMigration.includes("BusinessPaymentAccount") &&
    !saasBillingMigration.includes("UPDATE \"Business\""),
);

const saasBillingSchema = readFileSync(
  new URL("../src/lib/saas-billing/schema.ts", import.meta.url),
  "utf8",
);
check(
  "Preview runtime ensure covers SaaS billing tables skipped by migrate",
  saasBillingSchema.includes("Preview shares Production and skips migrate") &&
    saasBillingSchema.includes("ensureSaasBillingSchema") &&
    saasBillingSchema.includes("SAAS_BILLING_ENSURE_SQL") &&
    saasBillingSchema.includes('CREATE TABLE IF NOT EXISTS "BusinessSaasSubscription"'),
);

check(
  "Authenticated workspace load ensures SaaS billing tables before Business SELECT",
  workspaceLoader.includes("ensureSaasBillingSchema"),
);

const founderTrialMigration = readFileSync(
  new URL("../prisma/migrations/20260915200000_add_saas_founder_trial/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Founder trial migration is additive and does not rewrite Business rows",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(founderTrialMigration) &&
    founderTrialMigration.includes('ADD COLUMN IF NOT EXISTS "trialStartedAt"') &&
    founderTrialMigration.includes('ADD COLUMN IF NOT EXISTS "founderEligible"') &&
    founderTrialMigration.includes('ADD COLUMN IF NOT EXISTS "legacyExempt"') &&
    founderTrialMigration.includes("legacyExempt") &&
    !/UPDATE "Business"\s/.test(founderTrialMigration) &&
    founderTrialMigration.includes("Does not create Stripe Customers"),
);
check(
  "Preview runtime ensure covers Founder trial columns skipped by migrate",
  saasBillingSchema.includes("SAAS_FOUNDER_TRIAL_ENSURE_SQL") &&
    saasBillingSchema.includes("SAAS_FOUNDER_TRIAL_BACKFILL_SQL") &&
    saasBillingSchema.includes("legacyExempt") &&
    saasBillingSchema.includes("trialStartedAt"),
);

const saasLifecycleMigration = readFileSync(
  new URL("../prisma/migrations/20260915220000_add_saas_subscription_lifecycle/migration.sql", import.meta.url),
  "utf8",
);
check(
  "SaaS subscription lifecycle migration is additive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(saasLifecycleMigration) &&
    saasLifecycleMigration.includes('ADD COLUMN IF NOT EXISTS "lastStripeEventCreatedAt"') &&
    saasLifecycleMigration.includes('ADD COLUMN IF NOT EXISTS "stripeEventCreatedAt"') &&
    saasLifecycleMigration.includes("Does not rewrite Business") &&
    !/UPDATE "Business"/i.test(saasLifecycleMigration),
);
check(
  "Preview runtime ensure covers SaaS lifecycle timestamps skipped by migrate",
  saasBillingSchema.includes("SAAS_SUBSCRIPTION_LIFECYCLE_ENSURE_SQL") &&
    saasBillingSchema.includes("lastStripeEventCreatedAt") &&
    saasBillingSchema.includes("stripeEventCreatedAt"),
);

const businessTimezoneMigration = readFileSync(
  new URL("../prisma/migrations/20260919200000_add_business_timezone/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Business timezone migration is additive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(businessTimezoneMigration) &&
    businessTimezoneMigration.includes('ADD COLUMN IF NOT EXISTS "timezone"') &&
    !/UPDATE "Business"/i.test(businessTimezoneMigration),
);

const businessTimezone = readFileSync(
  new URL("../src/lib/business-timezone.ts", import.meta.url),
  "utf8",
);
check(
  "Preview runtime ensure covers business timezone column skipped by migrate",
  businessTimezone.includes("Preview shares Production and skips migrate") &&
    businessTimezone.includes("ensureBusinessTimezoneSchema") &&
    businessTimezone.includes("BUSINESS_TIMEZONE_ENSURE_SQL") &&
    businessTimezone.includes('ADD COLUMN IF NOT EXISTS "timezone"'),
);
check(
  "Authenticated workspace load ensures business timezone column before Business SELECT",
  workspaceLoader.includes("ensureBusinessTimezoneSchema"),
);

const customerMessagingMigration = readFileSync(
  new URL("../prisma/migrations/20260920180000_add_customer_messaging/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Customer messaging migration is additive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(customerMessagingMigration) &&
    customerMessagingMigration.includes('ADD COLUMN IF NOT EXISTS "smsConsentStatus"') &&
    customerMessagingMigration.includes('CREATE TABLE IF NOT EXISTS "CustomerCommunication"') &&
    !/UPDATE "Business"/i.test(customerMessagingMigration) &&
    !/UPDATE "Customer"/i.test(customerMessagingMigration),
);

const customerMessagingSchema = readFileSync(
  new URL("../src/lib/customer-messaging/schema.ts", import.meta.url),
  "utf8",
);
check(
  "Preview runtime ensure covers customer messaging schema skipped by migrate",
  customerMessagingSchema.includes("Preview shares Production and skips migrate") &&
    customerMessagingSchema.includes("ensureCustomerMessagingSchema") &&
    customerMessagingSchema.includes("CUSTOMER_MESSAGING_ENSURE_SQL") &&
    customerMessagingSchema.includes('ADD COLUMN IF NOT EXISTS "smsConsentStatus"') &&
    customerMessagingSchema.includes("CustomerCommunication") &&
    customerMessagingSchema.includes('ADD COLUMN IF NOT EXISTS "operationalSmsNumber"') &&
    customerMessagingSchema.includes("CustomerMessagingWebhookEvent"),
);

const twilioSmsMigration = readFileSync(
  new URL("../prisma/migrations/20260920190000_add_twilio_sms_routing/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Twilio SMS routing migration is additive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(twilioSmsMigration) &&
    twilioSmsMigration.includes('ADD COLUMN IF NOT EXISTS "operationalSmsNumber"') &&
    twilioSmsMigration.includes('CREATE TABLE IF NOT EXISTS "CustomerMessagingWebhookEvent"') &&
    !/UPDATE "Business"/i.test(twilioSmsMigration) &&
    !/UPDATE "Customer"/i.test(twilioSmsMigration),
);
check(
  "Authenticated workspace load ensures customer messaging schema before Business SELECT",
  workspaceLoader.includes("ensureCustomerMessagingSchema"),
);

const ownerIntelligenceMigration = readFileSync(
  new URL("../prisma/migrations/20260924040000_add_owner_intelligence/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Owner-intelligence migration is additive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(ownerIntelligenceMigration) &&
    ownerIntelligenceMigration.includes('ADD COLUMN IF NOT EXISTS "firstLeadSource"') &&
    ownerIntelligenceMigration.includes('CREATE TABLE IF NOT EXISTS "BusinessGoal"') &&
    ownerIntelligenceMigration.includes('CREATE TABLE IF NOT EXISTS "ServiceArea"') &&
    ownerIntelligenceMigration.includes('CREATE TABLE IF NOT EXISTS "ReferralRequest"') &&
    !/UPDATE "Business"/i.test(ownerIntelligenceMigration) &&
    !/UPDATE "Customer"/i.test(ownerIntelligenceMigration),
);

const ownerIntelligenceSchema = readFileSync(
  new URL("../src/lib/owner-intelligence-schema.ts", import.meta.url),
  "utf8",
);
check(
  "Owner-intelligence schema is migrate-only and does not run request-time DDL",
  ownerIntelligenceSchema.includes("prisma-migrate") &&
    !ownerIntelligenceSchema.includes("$executeRawUnsafe") &&
    !ownerIntelligenceSchema.includes("OWNER_INTELLIGENCE_ENSURE_SQL") &&
    !ownerIntelligenceSchema.includes("ensureOwnerIntelligenceSchema"),
);
check(
  "Authenticated workspace load does not run owner-intelligence DDL",
  !workspaceLoader.includes("ensureOwnerIntelligenceSchema") &&
    !workspaceLoader.includes("owner-intelligence-schema"),
);

const ownerIntelligenceFkMigration = readFileSync(
  new URL("../prisma/migrations/20260924053000_owner_intelligence_fks/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Owner-intelligence FK migration is additive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(ownerIntelligenceFkMigration) &&
    ownerIntelligenceFkMigration.includes('ReferralRequest_jobId_fkey') &&
    ownerIntelligenceFkMigration.includes('CustomerFollowUp_customerId_fkey') &&
    ownerIntelligenceFkMigration.includes('CustomerFollowUp_jobId_fkey') &&
    ownerIntelligenceFkMigration.includes('CustomerFollowUp_createdByMembershipId_fkey'),
);

const handyman10Migration = readFileSync(
  new URL("../prisma/migrations/20260924070000_handyman_1_0_completion/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Handyman 1.0 completion migration is additive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(handyman10Migration) &&
    handyman10Migration.includes('ADD COLUMN IF NOT EXISTS "totpSecret"') &&
    handyman10Migration.includes('CREATE TABLE IF NOT EXISTS "TotpBackupCode"') &&
    handyman10Migration.includes('CREATE TABLE IF NOT EXISTS "AuthChallenge"') &&
    handyman10Migration.includes('ADD COLUMN IF NOT EXISTS "offboardingRequestedAt"'),
);

const authChallengeAttemptsMigration = readFileSync(
  new URL("../prisma/migrations/20260924110000_auth_challenge_attempts/migration.sql", import.meta.url),
  "utf8",
);
check(
  "AuthChallenge failed-attempt migration is additive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(authChallengeAttemptsMigration) &&
    authChallengeAttemptsMigration.includes('ADD COLUMN IF NOT EXISTS "failedAttemptCount"'),
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

const localNames = listLocalMigrationNames(
  fileURLToPath(new URL("../prisma/migrations", import.meta.url)),
);
const appliedCurrent = localNames.map((migration_name) => ({
  migration_name,
  finished_at: "2026-09-01T00:00:00.000Z",
  rolled_back_at: null,
}));
check(
  "Local migration names are folder names with SQL, not the lockfile",
  localNames.includes("20260823000000_init") &&
    localNames.includes("20260919200000_add_business_timezone") &&
    !localNames.includes("migration_lock.toml"),
);
check(
  "Code-only production skips migrate deploy when _prisma_migrations is current",
  planProductionMigrateDeploy({ localNames, appliedRows: appliedCurrent }).run === false &&
    planProductionMigrateDeploy({ localNames, appliedRows: appliedCurrent }).reason ===
      "no pending migrations",
);
check(
  "A real pending migration still runs prisma migrate deploy",
  planProductionMigrateDeploy({
    localNames: [...localNames, "20990101000000_future_schema"],
    appliedRows: appliedCurrent,
  }).run === true &&
    planProductionMigrateDeploy({
      localNames: [...localNames, "20990101000000_future_schema"],
      appliedRows: appliedCurrent,
    }).reason.includes("20990101000000_future_schema"),
);
check(
  "Unfinished _prisma_migrations rows still run migrate deploy",
  planProductionMigrateDeploy({
    localNames,
    appliedRows: [
      ...appliedCurrent.slice(0, -1),
      {
        migration_name: localNames.at(-1),
        finished_at: null,
        rolled_back_at: null,
      },
    ],
  }).run === true,
);
check(
  "Unreadable _prisma_migrations falls through to migrate deploy instead of skipping",
  planProductionMigrateDeploy({
    localNames,
    appliedRows: undefined,
    appliedQueryError: true,
  }).run === true &&
    planProductionMigrateDeploy({ localNames }).run === true,
);

console.log(
  failed === 0
    ? `\nAll production-migrate checks passed (${passed}).`
    : `\n${failed} production-migrate check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
