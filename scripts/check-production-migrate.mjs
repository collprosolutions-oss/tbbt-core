/**
 * Production migrate-owner policy. No database access.
 *
 * Run with:
 *   node scripts/check-production-migrate.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bashSyntaxResults,
  hostedRecoveryVerifyNameSafety,
  neonInvokingBlocks,
  REQUIRED_CHECKS,
  runGatingMatrix,
  runSection42Flow,
} from "./lib/hosted-recovery-runbook-check.mjs";
import {
  evaluateNeonCliVersion,
  evaluateNeonCliVersionProcess,
  MIN_NEON_CLI_VERSION,
} from "./lib/neon-cli-version.mjs";
import {
  COLLPRO_RENO_VERCEL_PROJECT_ID,
  WORKSPACE_VERCEL_PROJECT_ID,
  classifyRequestPathSql,
  failClosedRequiredSchema,
  isPreviewSharedProductionRuntime,
  listLocalMigrationChecksums,
  listLocalMigrationNames,
  planProductionMigrateDeploy,
  planRequestPathSchemaEnsure,
  prismaMigrationChecksum,
  requestPathSchemaWritesBlocked,
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
  "Unavailable or divergent applied history fails closed before deploy",
  runner.includes("listLocalMigrationChecksums") &&
    runner.includes('"checksum"') &&
    runner.includes("Refusing prisma migrate deploy (${plan.reason})") &&
    runner.includes("plan.blocked") &&
    !runner.includes("Falling through to prisma migrate deploy"),
);
check(
  "Fresh empty databases can still bootstrap after 42P01",
  runner.includes("isPrismaMigrationsTableMissingError") &&
    runner.includes("countPublicUserTables") &&
    runner.includes("appliedQueryCode") &&
    runner.includes("userTableCount") &&
    runner.includes("information_schema.tables"),
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
const estimatingDefaultsDb = readFileSync(
  new URL("../src/lib/estimating-defaults-db.ts", import.meta.url),
  "utf8",
);
check(
  "Estimating defaults request path fail-closes instead of CREATE TABLE",
  estimatingDefaultsDb.includes("fail closed") &&
    estimatingDefaultsDb.includes("ensureBusinessEstimatingDefaultTable") &&
    estimatingDefaultsDb.includes("assertRequiredTablesExist") &&
    estimatingDefaultsDb.includes("Never execute from a request path") &&
    !estimatingDefaultsDb.includes("$executeRawUnsafe"),
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
const projectPayments = readFileSync(
  new URL("../src/lib/project-payments.ts", import.meta.url),
  "utf8",
);
check(
  "Project payments request path fail-closes instead of CREATE TABLE",
  projectPayments.includes("fail closed") &&
    projectPayments.includes("ensurePaymentTable") &&
    projectPayments.includes("assertRequiredTablesExist") &&
    !projectPayments.includes("$executeRawUnsafe"),
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
  "Material price request path fail-closes instead of CREATE TABLE",
  materialPriceDb.includes("fail closed") &&
    materialPriceDb.includes("ensureMaterialPriceEngineTables") &&
    materialPriceDb.includes("Never execute from a request path") &&
    !materialPriceDb.includes("$executeRawUnsafe"),
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
  "Public contact request path fail-closes instead of ADD COLUMN",
  businessContact.includes("fail closed") &&
    businessContact.includes("ensureBusinessPublicContactSchema") &&
    !businessContact.includes("ADD COLUMN IF NOT EXISTS") &&
    !businessContact.includes("$executeRawUnsafe"),
);

const workspaceLoader = readFileSync(
  new URL("../src/lib/workspace.ts", import.meta.url),
  "utf8",
);
const workspaceRequestLoader = readFileSync(
  new URL("../src/lib/workspace-request.ts", import.meta.url),
  "utf8",
);
check(
  "Authenticated workspace load probes public contact columns before Business SELECT",
  workspaceLoader.includes("requireWorkspaceFromRequest") &&
    workspaceRequestLoader.includes("loadActiveWorkspaceMemberships") &&
    businessContact.includes("export async function loadActiveWorkspaceMemberships") &&
    businessContact.includes("include: { business: true }") &&
    businessContact.indexOf("await ensureBusinessPublicContactSchema(db)") <
      businessContact.lastIndexOf("include: { business: true }"),
);
check(
  "Authenticated workspace load is not a second migration engine",
  !workspaceLoader.includes("ensureAppointmentConfirmationSchema") &&
    !workspaceLoader.includes("ensureFirstRunSetupSchema") &&
    !workspaceLoader.includes("ensureStarterServicesSetupSchema") &&
    !workspaceLoader.includes("ensureWebsiteSetupSchema") &&
    !workspaceLoader.includes("ensureSaasBillingSchema") &&
    !workspaceLoader.includes("ensureBusinessTimezoneSchema") &&
    !workspaceLoader.includes("ensureCustomerMessagingSchema") &&
    !workspaceLoader.includes("$executeRaw") &&
    !workspaceRequestLoader.includes("ensureSaasBillingSchema") &&
    !workspaceRequestLoader.includes("$executeRaw"),
);

const availabilityData = readFileSync(
  new URL("../src/lib/availability-data.ts", import.meta.url),
  "utf8",
);
check(
  "Availability request path fail-closes instead of ADD COLUMN / CREATE TABLE",
  availabilityData.includes("fail closed") &&
    availabilityData.includes("ensureBusinessAvailabilitySchema") &&
    availabilityData.includes("assertRequiredTablesExist") &&
    availabilityData.includes("Never execute from a request path") &&
    !availabilityData.includes("$executeRawUnsafe"),
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
  "Appointment confirmation request path fail-closes instead of CREATE/ALTER/repair",
  appointmentData.includes("fail closed") &&
    appointmentData.includes("ensureAppointmentConfirmationSchema") &&
    appointmentData.includes("assertRequiredTablesExist") &&
    appointmentData.includes("Never execute from a request path") &&
    !appointmentData.includes("$executeRawUnsafe") &&
    !appointmentData.includes("repairMisfiledChangeRequestAccessFields"),
);

check(
  "Authenticated workspace load does not run appointment confirmation DDL",
  !workspaceLoader.includes("ensureAppointmentConfirmationSchema"),
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
  "First-run request path fail-closes instead of ADD COLUMN / backfill",
  firstRunSetup.includes("fail closed") &&
    firstRunSetup.includes("ensureFirstRunSetupSchema") &&
    firstRunSetup.includes("assertRequiredColumnsExist") &&
    firstRunSetup.includes("Never execute from a request path") &&
    firstRunSetup.includes("FIRST_RUN_SETUP_ENSURE_SQL") &&
    !firstRunSetup.includes("$executeRawUnsafe"),
);

check(
  "Authenticated workspace load does not run first-run setup DDL",
  !workspaceLoader.includes("ensureFirstRunSetupSchema"),
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
  "Starter-services request path fail-closes instead of ADD COLUMN / backfill",
  starterServicesSetup.includes("fail closed") &&
    starterServicesSetup.includes("ensureStarterServicesSetupSchema") &&
    starterServicesSetup.includes("assertRequiredColumnsExist") &&
    starterServicesSetup.includes("Never execute from a request path") &&
    !starterServicesSetup.includes("$executeRawUnsafe"),
);

check(
  "Authenticated workspace load does not run starter-services setup DDL",
  !workspaceLoader.includes("ensureStarterServicesSetupSchema"),
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
  "Website setup request path fail-closes instead of ADD COLUMN / backfill",
  websiteSetup.includes("fail closed") &&
    websiteSetup.includes("ensureWebsiteSetupSchema") &&
    websiteSetup.includes("assertRequiredColumnsExist") &&
    websiteSetup.includes("Never execute from a request path") &&
    !websiteSetup.includes("$executeRawUnsafe"),
);

check(
  "Authenticated workspace load does not run website setup DDL",
  !workspaceLoader.includes("ensureWebsiteSetupSchema"),
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
  "SaaS billing request path fail-closes instead of CREATE/ALTER/backfill",
  saasBillingSchema.includes("fail closed") &&
    saasBillingSchema.includes("ensureSaasBillingSchema") &&
    saasBillingSchema.includes("assertSaasBillingSchemaPresent") &&
    !saasBillingSchema.includes("$executeRawUnsafe") &&
    saasBillingSchema.includes("Never execute from a request path"),
);

check(
  "Authenticated workspace load does not run SaaS billing DDL or backfill",
  !workspaceLoader.includes("ensureSaasBillingSchema"),
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
  "Business timezone request path fail-closes instead of ADD COLUMN",
  businessTimezone.includes("fail closed") &&
    businessTimezone.includes("ensureBusinessTimezoneSchema") &&
    businessTimezone.includes("assertRequiredColumnsExist") &&
    businessTimezone.includes("Never execute from a request path") &&
    !businessTimezone.includes("$executeRawUnsafe"),
);
check(
  "Authenticated workspace load does not run business timezone DDL",
  !workspaceLoader.includes("ensureBusinessTimezoneSchema"),
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
  "Customer messaging request path fail-closes instead of CREATE/ALTER",
  customerMessagingSchema.includes("fail closed") &&
    customerMessagingSchema.includes("ensureCustomerMessagingSchema") &&
    customerMessagingSchema.includes("assertRequiredTablesExist") &&
    customerMessagingSchema.includes("Never execute from a request path") &&
    !customerMessagingSchema.includes("$executeRawUnsafe"),
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
  "Authenticated workspace load does not run customer messaging DDL",
  !workspaceLoader.includes("ensureCustomerMessagingSchema"),
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

const intelligenceMigration = readFileSync(
  new URL("../prisma/migrations/20260924120000_bsos_intelligence_automation/migration.sql", import.meta.url),
  "utf8",
);
const intelligenceSchema = readFileSync(
  new URL("../src/lib/intelligence-schema.ts", import.meta.url),
  "utf8",
);
check(
  "Intelligence + automation migration is additive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(intelligenceMigration) &&
    intelligenceMigration.includes('CREATE TABLE IF NOT EXISTS "AiInteraction"') &&
    intelligenceMigration.includes('CREATE TABLE IF NOT EXISTS "BusinessEvent"') &&
    intelligenceMigration.includes('CREATE TABLE IF NOT EXISTS "AutomationRule"') &&
    intelligenceMigration.includes('CREATE TABLE IF NOT EXISTS "BsosRecommendationState"') &&
    intelligenceMigration.includes('ADD COLUMN IF NOT EXISTS "scope"'),
);
check(
  "Intelligence schema is migrate-only and does not run request-time DDL",
  intelligenceSchema.includes("prisma-migrate") &&
    !intelligenceSchema.includes("$executeRawUnsafe") &&
    !intelligenceSchema.includes("ensureIntelligenceSchema"),
);
check(
  "Authenticated workspace load does not run intelligence DDL",
  !workspaceLoader.includes("ensureIntelligenceSchema") &&
    !workspaceLoader.includes("intelligence-schema"),
);

const intelligenceHardeningMigration = readFileSync(
  new URL("../prisma/migrations/20260924220000_intelligence_hardening/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Intelligence hardening migration is additive and adds recommendation evidence plus FKs",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(intelligenceHardeningMigration) &&
    intelligenceHardeningMigration.includes('ADD COLUMN IF NOT EXISTS "evidenceKey"') &&
    intelligenceHardeningMigration.includes('ADD COLUMN IF NOT EXISTS "history"') &&
    intelligenceHardeningMigration.includes("AiConversationMessage_interactionId_fkey") &&
    intelligenceHardeningMigration.includes("AiInteraction_userId_fkey") &&
    intelligenceHardeningMigration.includes("BsosRecommendationState_actionItemId_fkey") &&
    intelligenceHardeningMigration.includes("IF NOT EXISTS"),
);

const automationClaimLeaseMigration = readFileSync(
  new URL("../prisma/migrations/20260924230000_automation_run_claim_lease/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Automation claim-lease migration is additive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(automationClaimLeaseMigration) &&
    automationClaimLeaseMigration.includes('ADD COLUMN IF NOT EXISTS "claimedAt"') &&
    automationClaimLeaseMigration.includes("IF NOT EXISTS"),
);

const aiClaimLeaseMigration = readFileSync(
  new URL("../prisma/migrations/20260925000000_ai_interaction_claim_lease/migration.sql", import.meta.url),
  "utf8",
);
check(
  "AI interaction claim-lease migration is additive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(aiClaimLeaseMigration) &&
    aiClaimLeaseMigration.includes('ADD COLUMN IF NOT EXISTS "claimedAt"') &&
    aiClaimLeaseMigration.includes("IF NOT EXISTS"),
);

const multiTradeMigration = readFileSync(
  new URL("../prisma/migrations/20260925120000_multi_trade_core/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Multi-trade core migration is additive and backfills business_trades from tradeCode",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(multiTradeMigration) &&
    multiTradeMigration.includes('CREATE TABLE IF NOT EXISTS "BusinessTrade"') &&
    multiTradeMigration.includes("WHERE NOT EXISTS") &&
    multiTradeMigration.includes("ADD COLUMN IF NOT EXISTS") &&
    multiTradeMigration.includes("IF NOT EXISTS"),
);
check(
  "Authenticated workspace load does not run multi-trade DDL",
  !workspaceLoader.includes("BusinessTrade") &&
    !workspaceLoader.includes("multi_trade_core"),
);

const websiteEngineMigration = readFileSync(
  new URL("../prisma/migrations/20260925180000_website_engine/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Website engine migration is additive and idempotent",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(websiteEngineMigration) &&
    websiteEngineMigration.includes('CREATE TABLE IF NOT EXISTS "WebsitePublish"') &&
    websiteEngineMigration.includes('ADD COLUMN IF NOT EXISTS "publishedWebsiteId"') &&
    websiteEngineMigration.includes('ADD COLUMN IF NOT EXISTS "websiteSelected"') &&
    websiteEngineMigration.includes("IF NOT EXISTS"),
);
check(
  "Authenticated workspace load does not run website-engine DDL",
  !workspaceLoader.includes("WebsitePublish") &&
    !workspaceLoader.includes("website_engine"),
);

const websiteSlugMigration = readFileSync(
  new URL("../prisma/migrations/20260925191000_website_service_slug/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Website service slug migration is additive and lazily backfills",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(websiteSlugMigration) &&
    websiteSlugMigration.includes('ADD COLUMN IF NOT EXISTS "websiteSlug"') &&
    websiteSlugMigration.includes("IF NOT EXISTS"),
);

const productPlanMigration = readFileSync(
  new URL("../prisma/migrations/20260925200000_product_plans_entitlements/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Product plan entitlement migration is additive and preserves SaaS rows",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(productPlanMigration) &&
    productPlanMigration.includes('ADD COLUMN IF NOT EXISTS "planCode"') &&
    productPlanMigration.includes('CREATE TABLE IF NOT EXISTS "BusinessProductAddon"') &&
    productPlanMigration.includes('CREATE TABLE IF NOT EXISTS "BusinessProductGrant"') &&
    productPlanMigration.includes("IF NOT EXISTS"),
);
check(
  "Authenticated workspace load does not run product-plan DDL",
  !workspaceLoader.includes("BusinessProductAddon") &&
    !workspaceLoader.includes("product_plans_entitlements") &&
    !workspaceLoader.includes("product_grant_source_ref"),
);

const productGrantSourceRefMigration = readFileSync(
  new URL("../prisma/migrations/20260925210000_product_grant_source_ref/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Product grant sourceRef migration is additive and preserves grant rows",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(productGrantSourceRefMigration) &&
    productGrantSourceRefMigration.includes('ADD COLUMN IF NOT EXISTS "sourceRef"') &&
    productGrantSourceRefMigration.includes("IF NOT EXISTS") &&
    productGrantSourceRefMigration.includes("BusinessProductGrant_businessId_grantType_code_source_sourceRef_key"),
);

const workforceMigration = readFileSync(
  new URL("../prisma/migrations/20260925220000_scheduling_workforce_intelligence/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Workforce capacity migration is additive and preserves membership and job rows",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(workforceMigration) &&
    workforceMigration.includes('ADD COLUMN IF NOT EXISTS "schedulingActive"') &&
    workforceMigration.includes('ADD COLUMN IF NOT EXISTS "pickupDurationMinutes"') &&
    workforceMigration.includes('CREATE TABLE IF NOT EXISTS "FillInBenchWorker"') &&
    workforceMigration.includes('CREATE TABLE IF NOT EXISTS "MembershipSkill"') &&
    workforceMigration.includes("IF NOT EXISTS"),
);
check(
  "Authenticated workspace load does not run workforce DDL",
  !workspaceLoader.includes("FillInBenchWorker") &&
    !workspaceLoader.includes("ensureWorkforceSchema") &&
    !workspaceLoader.includes("scheduling_workforce_intelligence"),
);

const workforceFkMigration = readFileSync(
  new URL("../prisma/migrations/20260925230000_workforce_foreign_keys/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Workforce FK migration is additive and matches Prisma cascade/set-null",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(workforceFkMigration) &&
    workforceFkMigration.includes('MembershipSkill_membershipId_fkey') &&
    workforceFkMigration.includes('MembershipWeeklyAvailability_membershipId_fkey') &&
    workforceFkMigration.includes('MembershipAvailabilityException_membershipId_fkey') &&
    workforceFkMigration.includes('FillInBenchWorker_businessId_fkey') &&
    workforceFkMigration.includes('FillInBenchWorker_membershipId_fkey') &&
    workforceFkMigration.includes('WorkforceOutreachTask_jobId_fkey') &&
    workforceFkMigration.includes('WorkforceOutreachTask_createdByMembershipId_fkey') &&
    workforceFkMigration.includes('WorkforceOutreachTask_approvedByMembershipId_fkey') &&
    workforceFkMigration.includes("ON DELETE CASCADE") &&
    workforceFkMigration.includes("ON DELETE SET NULL") &&
    workforceFkMigration.includes("idempotencyKey"),
);

const communicationsDepartmentMigration = readFileSync(
  new URL("../prisma/migrations/20260926020000_communications_department/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Communications department migration is additive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(communicationsDepartmentMigration) &&
    communicationsDepartmentMigration.includes('ADD COLUMN IF NOT EXISTS "threadId"') &&
    communicationsDepartmentMigration.includes('CREATE TABLE IF NOT EXISTS "CommunicationThread"') &&
    communicationsDepartmentMigration.includes('CREATE TABLE IF NOT EXISTS "PhoneInteraction"') &&
    communicationsDepartmentMigration.includes('CREATE TABLE IF NOT EXISTS "ReceptionistEvent"'),
);

const communicationsSchema = readFileSync(
  new URL("../src/lib/communications/schema.ts", import.meta.url),
  "utf8",
);
check(
  "Communications department schema is migrate-only and does not run request-time DDL",
  communicationsSchema.includes("prisma-migrate") &&
    !communicationsSchema.includes("$executeRawUnsafe") &&
    !communicationsSchema.includes("ensureCommunicationsSchema") &&
    !communicationsSchema.includes("COMMUNICATIONS_DEPARTMENT_ENSURE_SQL") &&
    !communicationsSchema.includes("CREATE TABLE IF NOT EXISTS"),
);
check(
  "Authenticated workspace load does not run communications-department DDL",
  !workspaceLoader.includes("ensureCommunicationsSchema") &&
    !workspaceLoader.includes("COMMUNICATIONS_DEPARTMENT_ENSURE_SQL"),
);

const phoneInteractionRelationsMigration = readFileSync(
  new URL("../prisma/migrations/20260926030000_phone_interaction_relations/migration.sql", import.meta.url),
  "utf8",
);
check(
  "PhoneInteraction relation migration is additive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(phoneInteractionRelationsMigration) &&
    phoneInteractionRelationsMigration.includes("PhoneInteraction_requestId_fkey") &&
    phoneInteractionRelationsMigration.includes("PhoneInteraction_jobId_fkey") &&
    phoneInteractionRelationsMigration.includes("PhoneInteraction_followUpActionItemId_fkey") &&
    phoneInteractionRelationsMigration.includes("IF NOT EXISTS"),
);

const growthDepartmentMigration = readFileSync(
  new URL("../prisma/migrations/20260926040000_growth_department/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Growth department migration is additive and idempotent",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(growthDepartmentMigration) &&
    growthDepartmentMigration.includes('ADD COLUMN IF NOT EXISTS "originalLeadSource"') &&
    growthDepartmentMigration.includes('ADD COLUMN IF NOT EXISTS "recordedCost"') &&
    growthDepartmentMigration.includes('CREATE TABLE IF NOT EXISTS "LeadAttributionCorrection"') &&
    growthDepartmentMigration.includes('CREATE TABLE IF NOT EXISTS "GrowthActionRequest"') &&
    growthDepartmentMigration.includes("IF NOT EXISTS"),
);
check(
  "Authenticated workspace load does not run growth-department DDL",
  !workspaceLoader.includes("GrowthActionRequest") &&
    !workspaceLoader.includes("LeadAttributionCorrection") &&
    !workspaceLoader.includes("growth_department"),
);

const growthHardeningMigration = readFileSync(
  new URL("../prisma/migrations/20260926050000_growth_department_hardening/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Growth department hardening migration is additive and idempotent",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(growthHardeningMigration) &&
    growthHardeningMigration.includes('ADD COLUMN IF NOT EXISTS "idempotencyKey"') &&
    growthHardeningMigration.includes('ADD COLUMN IF NOT EXISTS "approvedByMembershipId"') &&
    growthHardeningMigration.includes("IF NOT EXISTS"),
);

const knowledgeLaunchMigration = readFileSync(
  new URL("../prisma/migrations/20260926060000_knowledge_business_launch/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Knowledge business launch migration is additive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(knowledgeLaunchMigration) &&
    knowledgeLaunchMigration.includes('CREATE TABLE IF NOT EXISTS "BusinessLaunchProgress"') &&
    knowledgeLaunchMigration.includes('CREATE TABLE IF NOT EXISTS "ExperienceLearningCandidate"') &&
    knowledgeLaunchMigration.includes('ADD COLUMN IF NOT EXISTS "approvalState"') &&
    knowledgeLaunchMigration.includes("IF NOT EXISTS"),
);
check(
  "Authenticated workspace load does not run knowledge-launch DDL",
  !workspaceLoader.includes("BusinessLaunchProgress") &&
    !workspaceLoader.includes("knowledge_business_launch") &&
    !workspaceLoader.includes("ExperienceLearningCandidate"),
);

const knowledgeLaunchHardeningMigration = readFileSync(
  new URL("../prisma/migrations/20260926070000_knowledge_launch_hardening/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Knowledge launch hardening migration is additive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(knowledgeLaunchHardeningMigration) &&
    knowledgeLaunchHardeningMigration.includes(
      'CREATE UNIQUE INDEX IF NOT EXISTS "CompanySetupProposal_businessId_interactionId_key"',
    ) &&
    knowledgeLaunchHardeningMigration.includes("IF NOT EXISTS"),
);

const businessProtectionMigration = readFileSync(
  new URL("../prisma/migrations/20260926080000_business_protection_vault/migration.sql", import.meta.url),
  "utf8",
);
const businessProtectionHardeningMigration = readFileSync(
  new URL("../prisma/migrations/20260926081000_business_protection_lifecycle_hardening/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Business protection vault migration is additive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(businessProtectionMigration) &&
    businessProtectionMigration.includes('CREATE TABLE IF NOT EXISTS "BusinessVaultRecord"') &&
    businessProtectionMigration.includes('CREATE TABLE IF NOT EXISTS "BusinessAgreement"') &&
    businessProtectionMigration.includes('CREATE TABLE IF NOT EXISTS "BusinessAgreementVersion"') &&
    businessProtectionMigration.includes('CREATE TABLE IF NOT EXISTS "BusinessProtectionAuditLog"') &&
    businessProtectionMigration.includes("IF NOT EXISTS"),
);
check(
  "Business protection lifecycle hardening migration is additive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(businessProtectionHardeningMigration) &&
    businessProtectionHardeningMigration.includes("completionAttemptKey") &&
    businessProtectionHardeningMigration.includes('CREATE TABLE IF NOT EXISTS "BusinessAgreementCompletionClaim"') &&
    businessProtectionHardeningMigration.includes("IF NOT EXISTS"),
);
check(
  "Authenticated workspace load does not run business-protection DDL",
  !workspaceLoader.includes("BusinessVaultRecord") &&
    !workspaceLoader.includes("business_protection_vault"),
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

const migrationsDir = fileURLToPath(new URL("../prisma/migrations", import.meta.url));
const localNames = listLocalMigrationNames(migrationsDir);
const localChecksums = listLocalMigrationChecksums(migrationsDir);
const appliedCurrent = localNames.map((migration_name) => ({
  migration_name,
  checksum: localChecksums[migration_name],
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
  "Local checksums are Prisma sha256 hex of migration.sql bytes",
  localChecksums[localNames[0]] ===
    prismaMigrationChecksum(
      readFileSync(new URL(`../prisma/migrations/${localNames[0]}/migration.sql`, import.meta.url)),
    ) && /^[0-9a-f]{64}$/.test(localChecksums[localNames[0]]),
);
check(
  "Code-only production skips migrate deploy when _prisma_migrations is current",
  planProductionMigrateDeploy({
    localNames,
    localChecksums,
    appliedRows: appliedCurrent,
  }).run === false &&
    planProductionMigrateDeploy({
      localNames,
      localChecksums,
      appliedRows: appliedCurrent,
    }).reason === "no pending migrations" &&
    planProductionMigrateDeploy({
      localNames,
      localChecksums,
      appliedRows: appliedCurrent,
    }).blocked !== true,
);
check(
  "A real pending migration still runs prisma migrate deploy",
  planProductionMigrateDeploy({
    localNames: [...localNames, "20990101000000_future_schema"],
    localChecksums,
    appliedRows: appliedCurrent,
  }).run === true &&
    planProductionMigrateDeploy({
      localNames: [...localNames, "20990101000000_future_schema"],
      localChecksums,
      appliedRows: appliedCurrent,
    }).reason.includes("20990101000000_future_schema") &&
    planProductionMigrateDeploy({
      localNames: [...localNames, "20990101000000_future_schema"],
      localChecksums,
      appliedRows: appliedCurrent,
    }).blocked !== true,
);
check(
  "Unfinished _prisma_migrations rows still run migrate deploy",
  planProductionMigrateDeploy({
    localNames,
    localChecksums,
    appliedRows: [
      ...appliedCurrent.slice(0, -1),
      {
        migration_name: localNames.at(-1),
        checksum: localChecksums[localNames.at(-1)],
        finished_at: null,
        rolled_back_at: null,
      },
    ],
  }).run === true,
);
check(
  "Unreadable _prisma_migrations fails closed before migrate deploy",
  planProductionMigrateDeploy({
    localNames,
    localChecksums,
    appliedRows: undefined,
    appliedQueryError: true,
  }).run === false &&
    planProductionMigrateDeploy({
      localNames,
      localChecksums,
      appliedRows: undefined,
      appliedQueryError: true,
    }).blocked === true &&
    planProductionMigrateDeploy({ localNames, localChecksums }).blocked === true &&
    planProductionMigrateDeploy({ localNames, localChecksums }).run === false,
);
check(
  "Fresh empty database with missing _prisma_migrations still runs migrate deploy",
  planProductionMigrateDeploy({
    localNames,
    localChecksums,
    appliedRows: undefined,
    appliedQueryError: true,
    appliedQueryCode: "42P01",
    migrationsTableMissing: true,
    userTableCount: 0,
  }).run === true &&
    planProductionMigrateDeploy({
      localNames,
      localChecksums,
      appliedRows: undefined,
      appliedQueryError: true,
      appliedQueryCode: "42P01",
      migrationsTableMissing: true,
      userTableCount: 0,
    }).reason === "fresh empty database" &&
    planProductionMigrateDeploy({
      localNames,
      localChecksums,
      appliedRows: undefined,
      appliedQueryError: true,
      appliedQueryCode: "42P01",
      migrationsTableMissing: true,
      userTableCount: 0,
    }).blocked !== true,
);
check(
  "Missing _prisma_migrations with existing user tables fails closed",
  planProductionMigrateDeploy({
    localNames,
    localChecksums,
    appliedRows: undefined,
    appliedQueryError: true,
    appliedQueryCode: "42P01",
    migrationsTableMissing: true,
    userTableCount: 4,
  }).run === false &&
    planProductionMigrateDeploy({
      localNames,
      localChecksums,
      appliedRows: undefined,
      appliedQueryError: true,
      appliedQueryCode: "42P01",
      migrationsTableMissing: true,
      userTableCount: 4,
    }).blocked === true &&
    planProductionMigrateDeploy({
      localNames,
      localChecksums,
      appliedRows: undefined,
      appliedQueryError: true,
      appliedQueryCode: "42P01",
      migrationsTableMissing: true,
      userTableCount: 4,
    }).reason.includes("existing user tables"),
);
check(
  "42P01 without a verified user-table count stays fail-closed",
  planProductionMigrateDeploy({
    localNames,
    localChecksums,
    appliedRows: undefined,
    appliedQueryError: true,
    appliedQueryCode: "42P01",
    migrationsTableMissing: true,
  }).blocked === true &&
    planProductionMigrateDeploy({
      localNames,
      localChecksums,
      appliedRows: undefined,
      appliedQueryError: true,
      appliedQueryCode: "42P01",
      migrationsTableMissing: true,
    }).run === false,
);
check(
  "Applied migration missing locally fails closed before deploy",
  planProductionMigrateDeploy({
    localNames,
    localChecksums,
    appliedRows: [
      ...appliedCurrent,
      {
        migration_name: "20250101000000_applied_only_in_database",
        checksum: "a".repeat(64),
        finished_at: "2026-09-01T00:00:00.000Z",
        rolled_back_at: null,
      },
    ],
  }).run === false &&
    planProductionMigrateDeploy({
      localNames,
      localChecksums,
      appliedRows: [
        ...appliedCurrent,
        {
          migration_name: "20250101000000_applied_only_in_database",
          checksum: "a".repeat(64),
          finished_at: "2026-09-01T00:00:00.000Z",
          rolled_back_at: null,
        },
      ],
    }).blocked === true &&
    planProductionMigrateDeploy({
      localNames,
      localChecksums,
      appliedRows: [
        ...appliedCurrent,
        {
          migration_name: "20250101000000_applied_only_in_database",
          checksum: "a".repeat(64),
          finished_at: "2026-09-01T00:00:00.000Z",
          rolled_back_at: null,
        },
      ],
    }).reason.includes("20250101000000_applied_only_in_database"),
);
check(
  "Same migration name with a divergent checksum fails closed before deploy",
  planProductionMigrateDeploy({
    localNames,
    localChecksums,
    appliedRows: [
      {
        ...appliedCurrent[0],
        checksum: "0".repeat(64),
      },
      ...appliedCurrent.slice(1),
    ],
  }).run === false &&
    planProductionMigrateDeploy({
      localNames,
      localChecksums,
      appliedRows: [
        {
          ...appliedCurrent[0],
          checksum: "0".repeat(64),
        },
        ...appliedCurrent.slice(1),
      ],
    }).blocked === true &&
    planProductionMigrateDeploy({
      localNames,
      localChecksums,
      appliedRows: [
        {
          ...appliedCurrent[0],
          checksum: "0".repeat(64),
        },
        ...appliedCurrent.slice(1),
      ],
    }).reason.includes(localNames[0]),
);

const financialIntelligenceMigration = readFileSync(
  new URL("../prisma/migrations/20260925220000_financial_profit_intelligence/migration.sql", import.meta.url),
  "utf8",
);
const financialTruthMigration = readFileSync(
  new URL("../prisma/migrations/20260925230000_financial_truth_corrections/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Financial intelligence migrations stay additive and before Materials",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(financialIntelligenceMigration) &&
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(financialTruthMigration) &&
    financialIntelligenceMigration.includes('CREATE TABLE "BusinessLaborBurdenSetting"') &&
    localNames.includes("20260925220000_financial_profit_intelligence") &&
    localNames.includes("20260925230000_financial_truth_corrections") &&
    localNames.includes("20260926011500_add_materials_suppliers_operations") &&
    localNames.indexOf("20260925220000_financial_profit_intelligence") <
      localNames.indexOf("20260926011500_add_materials_suppliers_operations") &&
    localNames.indexOf("20260925230000_financial_truth_corrections") <
      localNames.indexOf("20260926011500_add_materials_suppliers_operations"),
);
check(
  "Communications migrations stay after Financial, Workforce, and Materials",
  localNames.includes("20260926020000_communications_department") &&
    localNames.includes("20260926030000_phone_interaction_relations") &&
    localNames.indexOf("20260925220000_financial_profit_intelligence") <
      localNames.indexOf("20260926020000_communications_department") &&
    localNames.indexOf("20260925220000_scheduling_workforce_intelligence") <
      localNames.indexOf("20260926020000_communications_department") &&
    localNames.indexOf("20260925230000_workforce_foreign_keys") <
      localNames.indexOf("20260926020000_communications_department") &&
    localNames.indexOf("20260926011500_add_materials_suppliers_operations") <
      localNames.indexOf("20260926020000_communications_department") &&
    localNames.indexOf("20260926020000_communications_department") <
      localNames.indexOf("20260926030000_phone_interaction_relations"),
);
check(
  "Growth department migrations stay after Communications",
  localNames.includes("20260926040000_growth_department") &&
    localNames.includes("20260926050000_growth_department_hardening") &&
    localNames.indexOf("20260926030000_phone_interaction_relations") <
      localNames.indexOf("20260926040000_growth_department") &&
    localNames.indexOf("20260926040000_growth_department") <
      localNames.indexOf("20260926050000_growth_department_hardening"),
);
check(
  "Knowledge/Business Launch migrations stay after Growth",
  localNames.includes("20260926060000_knowledge_business_launch") &&
    localNames.includes("20260926070000_knowledge_launch_hardening") &&
    localNames.indexOf("20260926050000_growth_department_hardening") <
      localNames.indexOf("20260926060000_knowledge_business_launch") &&
    localNames.indexOf("20260926060000_knowledge_business_launch") <
      localNames.indexOf("20260926070000_knowledge_launch_hardening"),
);
check(
  "Business Protection/Vault migrations stay after Knowledge/Launch",
  localNames.includes("20260926080000_business_protection_vault") &&
    localNames.includes("20260926081000_business_protection_lifecycle_hardening") &&
    localNames.indexOf("20260926070000_knowledge_launch_hardening") <
      localNames.indexOf("20260926080000_business_protection_vault") &&
    localNames.indexOf("20260926080000_business_protection_vault") <
      localNames.indexOf("20260926081000_business_protection_lifecycle_hardening"),
);
const orchestrationMigration = readFileSync(
  new URL("../prisma/migrations/20260926090000_ai_orchestration_run/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Chief-of-Staff orchestration migration is additive and after Business Protection",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(orchestrationMigration) &&
    orchestrationMigration.includes('CREATE TABLE IF NOT EXISTS "AiOrchestrationRun"') &&
    orchestrationMigration.includes("IF NOT EXISTS") &&
    localNames.includes("20260926090000_ai_orchestration_run") &&
    localNames.indexOf("20260926081000_business_protection_lifecycle_hardening") <
      localNames.indexOf("20260926090000_ai_orchestration_run"),
);

const materialsMigration = readFileSync(
  new URL("../prisma/migrations/20260926011500_add_materials_suppliers_operations/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Materials/suppliers operations migration is additive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(materialsMigration) &&
    materialsMigration.includes('CREATE TABLE IF NOT EXISTS "Supplier"') &&
    materialsMigration.includes('CREATE TABLE IF NOT EXISTS "MaterialCatalogItem"') &&
    materialsMigration.includes('CREATE TABLE IF NOT EXISTS "MaterialPriceHistory"') &&
    materialsMigration.includes('CREATE TABLE IF NOT EXISTS "MaterialPurchaseList"') &&
    materialsMigration.includes('CREATE TABLE IF NOT EXISTS "MaterialPurchaseOrder"') &&
    materialsMigration.includes('CREATE TABLE IF NOT EXISTS "MaterialOperationAttempt"') &&
    !/"password"/i.test(materialsMigration) &&
    !/"apiSecret"/i.test(materialsMigration),
);

const revenueIntegrityMigration = readFileSync(
  new URL(
    "../prisma/migrations/20260926100000_revenue_integrity_supplemental_invoices/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
check(
  "Revenue-integrity supplemental invoice migration is additive and after orchestration",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(revenueIntegrityMigration) &&
    revenueIntegrityMigration.includes('ADD COLUMN IF NOT EXISTS "kind"') &&
    revenueIntegrityMigration.includes('ADD COLUMN IF NOT EXISTS "invoiceId"') &&
    revenueIntegrityMigration.includes("Invoice_jobId_original_unique") &&
    revenueIntegrityMigration.includes("WHERE \"jobId\" IS NOT NULL AND \"kind\" = 'ORIGINAL'") &&
    localNames.includes("20260926100000_revenue_integrity_supplemental_invoices") &&
    localNames.indexOf("20260926090000_ai_orchestration_run") <
      localNames.indexOf("20260926100000_revenue_integrity_supplemental_invoices"),
);
check(
  "Revenue-integrity migration ranks legacy duplicate invoices before the unique index",
  revenueIntegrityMigration.indexOf('ROW_NUMBER() OVER') <
    revenueIntegrityMigration.indexOf("Invoice_jobId_original_unique") &&
    revenueIntegrityMigration.includes('THEN \'ORIGINAL\'') &&
    revenueIntegrityMigration.includes("ELSE 'SUPPLEMENTAL'") &&
    !/DELETE FROM "Invoice"/i.test(revenueIntegrityMigration),
);
check(
  "Revenue-integrity legacy Change Order backfill uses approvedAt, not createdAt",
  revenueIntegrityMigration.includes('AND co."approvedAt" IS NOT NULL') &&
    revenueIntegrityMigration.includes('AND co."approvedAt" <= first_invoice."createdAt"') &&
    !revenueIntegrityMigration.includes('AND co."createdAt" <='),
);
check(
  "Revenue-integrity migration attaches unallocated payments only to the ORIGINAL invoice",
  revenueIntegrityMigration.includes('UPDATE "Payment" AS p') &&
    revenueIntegrityMigration.includes('AND original."kind" = \'ORIGINAL\'') &&
    revenueIntegrityMigration.includes('p."invoiceId" IS NULL'),
);

const crewVisitMigration = readFileSync(
  new URL("../prisma/migrations/20260927180000_job_crew_visit/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Cleaning visit workflow migration is additive and after Network's 20260927150000 slot",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(crewVisitMigration) &&
    crewVisitMigration.includes('CREATE TABLE IF NOT EXISTS "JobCrewVisit"') &&
    !/ALTER TABLE "(Job|Business|Membership)"/.test(crewVisitMigration) &&
    localNames.includes("20260927180000_job_crew_visit") &&
    localNames.indexOf("20260927120000_controlled_ai_action_attempt") <
      localNames.indexOf("20260927180000_job_crew_visit"),
);

const fillInBenchMigration = readFileSync(
  new URL("../prisma/migrations/20260927010000_fill_in_bench_owner_fields/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Fill-In Bench owner-fields migration is additive and after Workforce FKs",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(fillInBenchMigration) &&
    fillInBenchMigration.includes('ADD COLUMN IF NOT EXISTS "workerType"') &&
    fillInBenchMigration.includes('ADD COLUMN IF NOT EXISTS "locationNotes"') &&
    fillInBenchMigration.includes("IF NOT EXISTS") &&
    !fillInBenchMigration.includes("CREATE TABLE") &&
    localNames.includes("20260927010000_fill_in_bench_owner_fields") &&
    localNames.indexOf("20260925230000_workforce_foreign_keys") <
      localNames.indexOf("20260927010000_fill_in_bench_owner_fields"),
);

const retentionOriginMigration = readFileSync(
  new URL(
    "../prisma/migrations/20260927210000_customer_follow_up_retention_origin/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
check(
  "Retention follow-up origin migration is additive and after native throttle",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(retentionOriginMigration) &&
    retentionOriginMigration.includes('ADD COLUMN "origin"') &&
    retentionOriginMigration.includes("RETENTION_TASK") &&
    retentionOriginMigration.includes("CustomerFollowUp_retention_task_business_customer_job_key") &&
    localNames.includes("20260927210000_customer_follow_up_retention_origin") &&
    localNames.indexOf("20260927200000_native_sign_in_throttle") <
      localNames.indexOf("20260927210000_customer_follow_up_retention_origin"),
);

const tenantIntakeSnapshotMigration = readFileSync(
  new URL("../prisma/migrations/20260927230000_tenant_intake_snapshot/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Tenant intake snapshot migration is additive and after the draft table",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(tenantIntakeSnapshotMigration) &&
    tenantIntakeSnapshotMigration.includes('CREATE TABLE IF NOT EXISTS "TenantIntakeSnapshot"') &&
    tenantIntakeSnapshotMigration.includes('ADD COLUMN IF NOT EXISTS "publishedIntakeSnapshotId"') &&
    tenantIntakeSnapshotMigration.includes('ADD COLUMN IF NOT EXISTS "tenantIntakeSnapshotId"') &&
    localNames.includes("20260927230000_tenant_intake_snapshot") &&
    localNames.indexOf("20260927153000_intake_condition_draft") <
      localNames.indexOf("20260927230000_tenant_intake_snapshot") &&
    localNames.indexOf("20260927210000_customer_follow_up_retention_origin") <
      localNames.indexOf("20260927230000_tenant_intake_snapshot"),
);

const ownerScenarioAssumptionSetMigration = readFileSync(
  new URL(
    "../prisma/migrations/20260928010000_owner_scenario_assumption_set/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
check(
  "Owner scenario assumption-set migration is additive, valid Sept 28, and after intake snapshot",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(ownerScenarioAssumptionSetMigration) &&
    ownerScenarioAssumptionSetMigration.includes('CREATE TABLE IF NOT EXISTS "OwnerScenarioAssumptionSet"') &&
    ownerScenarioAssumptionSetMigration.includes('OwnerScenarioAssumptionSet_businessId_fkey') &&
    ownerScenarioAssumptionSetMigration.includes('OwnerScenarioAssumptionSet_createdByMembershipId_fkey') &&
    !/ALTER TABLE "(Business|Invoice|Payment|Expense|Job|ServiceCatalogItem)"/.test(
      ownerScenarioAssumptionSetMigration,
    ) &&
    localNames.includes("20260928010000_owner_scenario_assumption_set") &&
    !localNames.includes("20260927240000_owner_scenario_assumption_set") &&
    localNames.indexOf("20260927230000_tenant_intake_snapshot") <
      localNames.indexOf("20260928010000_owner_scenario_assumption_set"),
);

const nextBookingSourceUniqueMigration = readFileSync(
  new URL(
    "../prisma/migrations/20260928020000_job_next_booking_source_unique/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
check(
  "Cleaning next-booking source unique migration is additive and after assumption sets",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(nextBookingSourceUniqueMigration) &&
    nextBookingSourceUniqueMigration.includes('ADD COLUMN IF NOT EXISTS "nextBookingSourceJobId"') &&
    nextBookingSourceUniqueMigration.includes("CREATE UNIQUE INDEX IF NOT EXISTS") &&
    nextBookingSourceUniqueMigration.includes("Job_nextBookingSourceJobId_key") &&
    !nextBookingSourceUniqueMigration.includes("Job_recurrenceSourceJobId_key") &&
    nextBookingSourceUniqueMigration.includes("recurrenceSourceJobId stays nonunique") &&
    localNames.includes("20260928020000_job_next_booking_source_unique") &&
    localNames.indexOf("20260928010000_owner_scenario_assumption_set") <
      localNames.indexOf("20260928020000_job_next_booking_source_unique"),
);

const estimateLineTemplateMigration = readFileSync(
  new URL(
    "../prisma/migrations/20260928030000_estimate_line_template/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
check(
  "Estimate line template migration is after next-booking unique and does not reuse 20260928020000",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(estimateLineTemplateMigration) &&
    estimateLineTemplateMigration.includes('CREATE TABLE IF NOT EXISTS "EstimateLineTemplate"') &&
    estimateLineTemplateMigration.includes('"nameKey" TEXT NOT NULL') &&
    estimateLineTemplateMigration.includes("EstimateLineTemplate_businessId_nameKey_key") &&
    !estimateLineTemplateMigration.includes("EstimateLineTemplate_businessId_name_key") &&
    localNames.includes("20260928030000_estimate_line_template") &&
    !localNames.includes("20260928020000_estimate_line_template") &&
    localNames.includes("20260928020000_job_next_booking_source_unique") &&
    localNames.includes("20260928120000_customer_follow_up_retention_due_on") &&
    localNames.indexOf("20260928020000_job_next_booking_source_unique") <
      localNames.indexOf("20260928030000_estimate_line_template") &&
    localNames.indexOf("20260928030000_estimate_line_template") <
      localNames.indexOf("20260928120000_customer_follow_up_retention_due_on"),
);

const retentionDueOnMigration = readFileSync(
  new URL("../prisma/migrations/20260928120000_customer_follow_up_retention_due_on/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Retention follow-up dueOn migration is additive and after origin",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(retentionDueOnMigration) &&
    retentionDueOnMigration.includes('ADD COLUMN IF NOT EXISTS "dueOn"') &&
    retentionDueOnMigration.includes("CustomerFollowUp_businessId_origin_status_dueOn_idx") &&
    !retentionDueOnMigration.includes("CREATE TABLE") &&
    localNames.includes("20260928120000_customer_follow_up_retention_due_on") &&
    localNames.indexOf("20260927210000_customer_follow_up_retention_origin") <
      localNames.indexOf("20260928120000_customer_follow_up_retention_due_on") &&
    localNames.indexOf("20260928010000_owner_scenario_assumption_set") <
      localNames.indexOf("20260928120000_customer_follow_up_retention_due_on") &&
    localNames.indexOf("20260928020000_job_next_booking_source_unique") <
      localNames.indexOf("20260928120000_customer_follow_up_retention_due_on") &&
    localNames.indexOf("20260928030000_estimate_line_template") <
      localNames.indexOf("20260928120000_customer_follow_up_retention_due_on"),
);

const correctiveCleanSourceUniqueMigration = readFileSync(
  new URL(
    "../prisma/migrations/20260928145000_job_corrective_clean_source_unique/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
check(
  "Cleaning corrective-clean source unique migration is additive and after retention due",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(correctiveCleanSourceUniqueMigration) &&
    correctiveCleanSourceUniqueMigration.includes(
      'ADD COLUMN IF NOT EXISTS "correctiveCleanSourceJobId"',
    ) &&
    correctiveCleanSourceUniqueMigration.includes("CREATE UNIQUE INDEX IF NOT EXISTS") &&
    correctiveCleanSourceUniqueMigration.includes("Job_correctiveCleanSourceJobId_key") &&
    !correctiveCleanSourceUniqueMigration.includes("Job_nextBookingSourceJobId_key") &&
    !correctiveCleanSourceUniqueMigration.includes("Job_recurrenceSourceJobId_key") &&
    correctiveCleanSourceUniqueMigration.includes("Distinct from nextBookingSourceJobId") &&
    localNames.includes("20260928145000_job_corrective_clean_source_unique") &&
    !localNames.includes("20260928120000_job_corrective_clean_source_unique") &&
    localNames.indexOf("20260928020000_job_next_booking_source_unique") <
      localNames.indexOf("20260928145000_job_corrective_clean_source_unique") &&
    localNames.indexOf("20260928120000_customer_follow_up_retention_due_on") <
      localNames.indexOf("20260928145000_job_corrective_clean_source_unique"),
);

const studioWeeklyReminderMigration = readFileSync(
  new URL("../prisma/migrations/20260928150000_marketing_studio_weekly_reminder/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Marketing Studio weekly reminder migration is additive and after retention dueOn",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(studioWeeklyReminderMigration) &&
    studioWeeklyReminderMigration.includes('ADD COLUMN IF NOT EXISTS "studioWeeklyReviewReminderOptedIn"') &&
    studioWeeklyReminderMigration.includes('CREATE TABLE IF NOT EXISTS "MarketingStudioWeeklyReminder"') &&
    studioWeeklyReminderMigration.includes("MarketingStudioWeeklyReminder_businessId_weekKey_key") &&
    studioWeeklyReminderMigration.includes("20260928120000_customer_follow_up_retention_due_on") &&
    localNames.includes("20260928150000_marketing_studio_weekly_reminder") &&
    !localNames.includes("20260928120000_marketing_studio_weekly_reminder") &&
    localNames.indexOf("20260928120000_customer_follow_up_retention_due_on") <
      localNames.indexOf("20260928150000_marketing_studio_weekly_reminder") &&
    localNames.indexOf("20260928145000_job_corrective_clean_source_unique") <
      localNames.indexOf("20260928150000_marketing_studio_weekly_reminder"),
);

const recurringOccurrenceKeyMigration = readFileSync(
  new URL(
    "../prisma/migrations/20260928180000_job_recurrence_occurrence_key/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
check(
  "Cleaning recurring occurrence-key migration is additive and after weekly reminder",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(recurringOccurrenceKeyMigration) &&
    recurringOccurrenceKeyMigration.includes(
      'ADD COLUMN IF NOT EXISTS "recurrenceOccurrenceKey"',
    ) &&
    recurringOccurrenceKeyMigration.includes("CREATE UNIQUE INDEX IF NOT EXISTS") &&
    recurringOccurrenceKeyMigration.includes("Job_recurrenceOccurrenceKey_key") &&
    !recurringOccurrenceKeyMigration.includes("Job_nextBookingSourceJobId_key") &&
    !recurringOccurrenceKeyMigration.includes("Job_correctiveCleanSourceJobId_key") &&
    !recurringOccurrenceKeyMigration.includes("Job_recurrenceSourceJobId_key") &&
    recurringOccurrenceKeyMigration.includes("recurrenceSourceJobId stays nonunique") &&
    localNames.includes("20260928180000_job_recurrence_occurrence_key") &&
    !localNames.includes("20260928150000_job_recurrence_occurrence_key") &&
    localNames.includes("20260928170000_service_request_repeat_visit_source") &&
    localNames.indexOf("20260928150000_marketing_studio_weekly_reminder") <
      localNames.indexOf("20260928170000_service_request_repeat_visit_source") &&
    localNames.indexOf("20260928170000_service_request_repeat_visit_source") <
      localNames.indexOf("20260928180000_job_recurrence_occurrence_key") &&
    localNames.indexOf("20260928145000_job_corrective_clean_source_unique") <
      localNames.indexOf("20260928180000_job_recurrence_occurrence_key"),
);

const studioWeeklyReminderOps = readFileSync(
  new URL("../src/lib/marketing-studio-reminder.ts", import.meta.url),
  "utf8",
);
check(
  "Marketing Studio weekly reminder fails closed without request-time DDL",
  studioWeeklyReminderOps.includes("missingStudioWeeklyReminderSchema") &&
    studioWeeklyReminderOps.includes("pg_advisory_xact_lock") &&
    !studioWeeklyReminderOps.includes("$executeRawUnsafe") &&
    !studioWeeklyReminderOps.includes("ALTER TABLE") &&
    !studioWeeklyReminderOps.includes("CREATE TABLE") &&
    !studioWeeklyReminderOps.includes("ADD COLUMN"),
);

const ownerStudioSmsDestinationMigration = readFileSync(
  new URL(
    "../prisma/migrations/20260928190000_owner_studio_reminder_sms_destination/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const estimateLineTemplateArchiveMigration = readFileSync(
  new URL(
    "../prisma/migrations/20260928200000_estimate_line_template_archive/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const customerCsvImportMigration = readFileSync(
  new URL(
    "../prisma/migrations/20260929010000_customer_csv_import/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const materialPickupRecordedMigration = readFileSync(
  new URL(
    "../prisma/migrations/20260929011100_material_pickup_recorded_quantities/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
check(
  "Estimate line template archive migration is additive and after owner SMS destination",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE|UPDATE\s+"LineItem"|UPDATE\s+"Estimate"/i.test(
    estimateLineTemplateArchiveMigration,
  ) &&
    estimateLineTemplateArchiveMigration.includes(
      'ADD COLUMN IF NOT EXISTS "archived"',
    ) &&
    estimateLineTemplateArchiveMigration.includes(
      "EstimateLineTemplate_businessId_archived_idx",
    ) &&
    !estimateLineTemplateArchiveMigration.includes("CREATE TABLE") &&
    localNames.includes("20260928200000_estimate_line_template_archive") &&
    !localNames.includes("20260928190000_estimate_line_template_archive") &&
    localNames.includes("20260928190000_owner_studio_reminder_sms_destination") &&
    localNames.indexOf("20260928030000_estimate_line_template") <
      localNames.indexOf("20260928200000_estimate_line_template_archive") &&
    localNames.indexOf("20260928190000_owner_studio_reminder_sms_destination") <
      localNames.indexOf("20260928200000_estimate_line_template_archive"),
);
check(
  "Customer CSV import migration is additive and after estimate template archive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(customerCsvImportMigration) &&
    customerCsvImportMigration.includes('CREATE TABLE IF NOT EXISTS "CustomerCsvImport"') &&
    customerCsvImportMigration.includes('CREATE TABLE IF NOT EXISTS "CustomerCsvImportRow"') &&
    customerCsvImportMigration.includes("reusedExistingCustomer") &&
    customerCsvImportMigration.includes("possibleDuplicateCustomerId") &&
    !customerCsvImportMigration.includes("smsConsentStatus") &&
    localNames.includes("20260929010000_customer_csv_import") &&
    !localNames.includes("20260928210000_customer_csv_import") &&
    localNames.includes("20260928200000_estimate_line_template_archive") &&
    localNames.indexOf("20260928200000_estimate_line_template_archive") <
      localNames.indexOf("20260929010000_customer_csv_import"),
);

const timeCorrectionRequestsMigration = readFileSync(
  new URL(
    "../prisma/migrations/20260929010100_time_correction_requests/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
check(
  "Time correction request migration is additive and after estimate template archive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE|UPDATE\s+"TimeEntry"|UPDATE\s+"TimesheetWeek"|UPDATE\s+"PayrollRun"/i.test(
    timeCorrectionRequestsMigration,
  ) &&
    timeCorrectionRequestsMigration.includes('CREATE TABLE IF NOT EXISTS "TimeCorrectionRequest"') &&
    timeCorrectionRequestsMigration.includes('CREATE TABLE IF NOT EXISTS "TimeCorrectionDecision"') &&
    timeCorrectionRequestsMigration.includes("TimeCorrectionRequest_timeEntryId_pending_key") &&
    timeCorrectionRequestsMigration.includes("20260928200000_estimate_line_template_archive") &&
    timeCorrectionRequestsMigration.includes("20260929010100") &&
    localNames.includes("20260929010100_time_correction_requests") &&
    !localNames.includes("20260929010000_time_correction_requests") &&
    localNames.includes("20260928200000_estimate_line_template_archive") &&
    localNames.indexOf("20260928200000_estimate_line_template_archive") <
      localNames.indexOf("20260929010100_time_correction_requests"),
);

const serviceCatalogImportMigration = readFileSync(
  new URL(
    "../prisma/migrations/20260929010200_service_catalog_import/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
check(
  "Service catalog CSV import migration is additive and after estimate-template archive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE|UPDATE\s+"LineItem"|UPDATE\s+"Estimate"|UPDATE\s+"ServiceCatalogItem"/i.test(
    serviceCatalogImportMigration,
  ) &&
    serviceCatalogImportMigration.includes('CREATE TABLE IF NOT EXISTS "ServiceCatalogImport"') &&
    serviceCatalogImportMigration.includes('CREATE TABLE IF NOT EXISTS "ServiceCatalogImportRow"') &&
    serviceCatalogImportMigration.includes("ServiceCatalogImport_businessId_contentSha256_key") &&
    serviceCatalogImportMigration.includes('"matchDecision" TEXT NOT NULL DEFAULT \'SKIP\'') &&
    serviceCatalogImportMigration.includes('"confirmingAt" TIMESTAMP(3)') &&
    serviceCatalogImportMigration.includes("never LineItem") &&
    serviceCatalogImportMigration.includes("hourly") &&
    serviceCatalogImportMigration.includes("20260929010200") &&
    localNames.includes("20260929010200_service_catalog_import") &&
    !localNames.includes("20260929010000_service_catalog_import") &&
    !localNames.includes("20260928200000_service_catalog_import") &&
    localNames.includes("20260928200000_estimate_line_template_archive") &&
    localNames.indexOf("20260928200000_estimate_line_template_archive") <
      localNames.indexOf("20260929010200_service_catalog_import"),
);

const availabilityRequestMigration = readFileSync(
  new URL(
    "../prisma/migrations/20260929010300_workforce_availability_exception_request/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const availabilityRequestOps = readFileSync(
  new URL("../src/lib/workforce-availability-request-ops.ts", import.meta.url),
  "utf8",
);
check(
  "Workforce availability-request migration is additive and after template archive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(availabilityRequestMigration) &&
    availabilityRequestMigration.includes(
      'CREATE TABLE IF NOT EXISTS "MembershipAvailabilityExceptionRequest"',
    ) &&
    availabilityRequestMigration.includes("WHERE \"status\" = 'PENDING'") &&
    availabilityRequestMigration.includes("IF NOT EXISTS") &&
    localNames.includes("20260929010300_workforce_availability_exception_request") &&
    !localNames.includes("20260929010000_workforce_availability_exception_request") &&
    localNames.indexOf("20260928200000_estimate_line_template_archive") <
      localNames.indexOf("20260929010300_workforce_availability_exception_request"),
);
check(
  "Availability-request ops do not run request-time DDL and do not mutate Jobs",
  !availabilityRequestOps.includes("$executeRawUnsafe") &&
    !availabilityRequestOps.includes("CREATE TABLE") &&
    !availabilityRequestOps.includes("ALTER TABLE") &&
    !availabilityRequestOps.includes("assignedMembershipId:") &&
    !availabilityRequestOps.includes("scheduledAt:"),
);

const purchaseOrderReceiptMigration = readFileSync(
  new URL(
    "../prisma/migrations/20260929140000_purchase_order_received_quantities/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
check(
  "Purchase-order received-quantity migration is additive and after template archive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(purchaseOrderReceiptMigration) &&
    purchaseOrderReceiptMigration.includes(
      'ADD COLUMN IF NOT EXISTS "quantityReceived"',
    ) &&
    purchaseOrderReceiptMigration.includes(
      'ADD COLUMN IF NOT EXISTS "lastReceivedAt"',
    ) &&
    purchaseOrderReceiptMigration.includes("MaterialPurchaseOrderItem") &&
    purchaseOrderReceiptMigration.includes(
      'CREATE TABLE IF NOT EXISTS "MaterialPurchaseOrderReceipt"',
    ) &&
    purchaseOrderReceiptMigration.includes(
      'CREATE TABLE IF NOT EXISTS "MaterialPurchaseOrderReceiptItem"',
    ) &&
    purchaseOrderReceiptMigration.includes('ADD COLUMN IF NOT EXISTS "payloadFingerprint"') &&
    !purchaseOrderReceiptMigration.includes("quantityPickedUp") &&
    !/DROP TABLE|DROP COLUMN/i.test(purchaseOrderReceiptMigration) &&
    localNames.includes("20260929140000_purchase_order_received_quantities") &&
    localNames.includes("20260928200000_estimate_line_template_archive") &&
    localNames.indexOf("20260928200000_estimate_line_template_archive") <
      localNames.indexOf("20260929140000_purchase_order_received_quantities"),
);

check(
  "OWNER studio reminder SMS destination migration is additive and after #204",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(ownerStudioSmsDestinationMigration) &&
    ownerStudioSmsDestinationMigration.includes('ADD COLUMN IF NOT EXISTS "studioWeeklyReminderOwnerSmsTo"') &&
    ownerStudioSmsDestinationMigration.includes('ADD COLUMN IF NOT EXISTS "studioWeeklyReminderOwnerSmsOptedIn"') &&
    ownerStudioSmsDestinationMigration.includes('ADD COLUMN IF NOT EXISTS "smsSendClaimedAt"') &&
    ownerStudioSmsDestinationMigration.includes("20260928150000_marketing_studio_weekly_reminder") &&
    ownerStudioSmsDestinationMigration.includes("20260928180000_job_recurrence_occurrence_key") &&
    localNames.includes("20260928190000_owner_studio_reminder_sms_destination") &&
    localNames.includes("20260928180000_job_recurrence_occurrence_key") &&
    !localNames.includes("20260928160000_owner_studio_reminder_sms_destination") &&
    !localNames.includes("20260928180000_owner_studio_reminder_sms_destination") &&
    localNames.indexOf("20260928150000_marketing_studio_weekly_reminder") <
      localNames.indexOf("20260928190000_owner_studio_reminder_sms_destination") &&
    localNames.indexOf("20260928180000_job_recurrence_occurrence_key") <
      localNames.indexOf("20260928190000_owner_studio_reminder_sms_destination"),
);
check(
  "Owner weekly reminder SMS is not sent inside a rollbackable reminder transaction",
  studioWeeklyReminderOps.includes("deliverOwnerStudioWeeklyReminderSms") &&
    studioWeeklyReminderOps.includes("smsSendClaimedAt") &&
    !studioWeeklyReminderOps.includes("publicPhone") &&
    !studioWeeklyReminderOps
      .slice(
        studioWeeklyReminderOps.indexOf("async function claimOwnerStudioReminderSmsIfDestinationUnchanged"),
        studioWeeklyReminderOps.indexOf("async function deliverOwnerStudioWeeklyReminderSms"),
      )
      .includes("sendOwnerSms") &&
    studioWeeklyReminderOps.includes("const sent = await sendOwnerSms"),
);
check(
  "Owner STOP and provider-block writes take the shared reminder lock",
  studioWeeklyReminderOps.includes("export async function recordOwnerStudioReminderStop") &&
    studioWeeklyReminderOps.includes("export async function recordOwnerStudioReminderBlocked") &&
    studioWeeklyReminderOps
      .slice(
        studioWeeklyReminderOps.indexOf("export async function recordOwnerStudioReminderStop"),
        studioWeeklyReminderOps.indexOf("export async function recordOwnerStudioReminderStart"),
      )
      .includes("withReminderLock") &&
    studioWeeklyReminderOps
      .slice(
        studioWeeklyReminderOps.indexOf("export async function recordOwnerStudioReminderBlocked"),
        studioWeeklyReminderOps.indexOf("function asReminder"),
      )
      .includes("withReminderLock") &&
    studioWeeklyReminderOps.includes("await recordOwnerStudioReminderBlocked") &&
    !studioWeeklyReminderOps
      .slice(
        studioWeeklyReminderOps.indexOf("export async function recordOwnerStudioReminderStop"),
        studioWeeklyReminderOps.indexOf("function asReminder"),
      )
      .includes("sendOwnerSms"),
);

const jobCallbackMigration = readFileSync(
  new URL("../prisma/migrations/20260929010900_job_callback/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Job callback migration is additive and after estimate template archive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(jobCallbackMigration) &&
    jobCallbackMigration.includes('CREATE TABLE IF NOT EXISTS "JobCallback"') &&
    jobCallbackMigration.includes('CREATE TABLE IF NOT EXISTS "JobCallbackEvent"') &&
    jobCallbackMigration.includes("JobCallback_open_job_key") &&
    jobCallbackMigration.includes("WHERE \"status\" IN ('RECORDED', 'UNDER_REVIEW')") &&
    !jobCallbackMigration.includes("CREATE TABLE \"Invoice\"") &&
    localNames.includes("20260929010900_job_callback") &&
    localNames.includes("20260928200000_estimate_line_template_archive") &&
    localNames.indexOf("20260928200000_estimate_line_template_archive") <
      localNames.indexOf("20260929010900_job_callback"),
);

const estimateOptionsMigration = readFileSync(
  new URL("../prisma/migrations/20260929010400_estimate_options/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Estimate options migration is additive and after template archive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE|UPDATE\s+"LineItem"|UPDATE\s+"Estimate"/i.test(
    estimateOptionsMigration,
  ) &&
    estimateOptionsMigration.includes('CREATE TABLE IF NOT EXISTS "EstimateOption"') &&
    estimateOptionsMigration.includes('CREATE TABLE IF NOT EXISTS "EstimateVersionOption"') &&
    estimateOptionsMigration.includes('ADD COLUMN IF NOT EXISTS "approvedOptionId"') &&
    estimateOptionsMigration.includes('ADD COLUMN IF NOT EXISTS "approvedEstimateOptionId"') &&
    localNames.includes("20260929010400_estimate_options") &&
    !localNames.includes("20260929010000_estimate_options") &&
    !localNames.includes("20260928200000_estimate_options") &&
    localNames.includes("20260928200000_estimate_line_template_archive") &&
    localNames.indexOf("20260928200000_estimate_line_template_archive") <
      localNames.indexOf("20260929010400_estimate_options"),
);

const monthlyBusinessGoalMigration = readFileSync(
  new URL("../prisma/migrations/20260929010700_monthly_business_goal/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Monthly business goal migration is additive and IF NOT EXISTS",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(monthlyBusinessGoalMigration) &&
    monthlyBusinessGoalMigration.includes('CREATE TABLE IF NOT EXISTS "MonthlyBusinessGoal"') &&
    localNames.includes("20260929010700_monthly_business_goal"),
);

const collectionsWorkItemMigration = readFileSync(
  new URL("../prisma/migrations/20260929011000_invoice_collection_work_item/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Invoice collection work-item migration is additive and after template archive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE|UPDATE\s+"Invoice"|UPDATE\s+"Payment"/i.test(
    collectionsWorkItemMigration,
  ) &&
    collectionsWorkItemMigration.includes('CREATE TABLE IF NOT EXISTS "InvoiceCollectionWorkItem"') &&
    collectionsWorkItemMigration.includes("InvoiceCollectionWorkItem_businessId_invoiceId_key") &&
    collectionsWorkItemMigration.includes("20260928200000_estimate_line_template_archive") &&
    !collectionsWorkItemMigration.includes("ALTER TABLE \"Invoice\"") &&
    localNames.includes("20260929011000_invoice_collection_work_item") &&
    !localNames.includes("20260928200000_invoice_collection_work_item") &&
    localNames.indexOf("20260928200000_estimate_line_template_archive") <
      localNames.indexOf("20260929011000_invoice_collection_work_item"),
);

check(
  "Material pickup recorded-quantity migration is additive and after #210",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(materialPickupRecordedMigration) &&
    materialPickupRecordedMigration.includes('ADD COLUMN IF NOT EXISTS "quantityPickedUp"') &&
    materialPickupRecordedMigration.includes('ADD COLUMN IF NOT EXISTS "pickupException"') &&
    materialPickupRecordedMigration.includes('ADD COLUMN IF NOT EXISTS "pickupRecordedAt"') &&
    materialPickupRecordedMigration.includes("20260928200000_estimate_line_template_archive") &&
    materialPickupRecordedMigration.includes("IF NOT EXISTS") &&
    localNames.includes("20260929011100_material_pickup_recorded_quantities") &&
    localNames.indexOf("20260928200000_estimate_line_template_archive") <
      localNames.indexOf("20260929011100_material_pickup_recorded_quantities"),
);

const customerMergeMigration = readFileSync(
  new URL("../prisma/migrations/20260929020000_customer_merge/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Customer merge audit migration is additive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(customerMergeMigration) &&
    customerMergeMigration.includes('CREATE TABLE IF NOT EXISTS "CustomerMerge"') &&
    customerMergeMigration.includes('"survivorCustomerId"') &&
    customerMergeMigration.includes('"absorbedCustomerId"') &&
    customerMergeMigration.includes('"absorbedSnapshot"') &&
    localNames.includes("20260929020000_customer_merge"),
);

const materialsSchema = readFileSync(
  new URL("../src/lib/materials/schema.ts", import.meta.url),
  "utf8",
);
check(
  "Materials schema is migrate-only and does not run request-time DDL",
  materialsSchema.includes("prisma-migrate") &&
    !materialsSchema.includes("$executeRawUnsafe") &&
    !materialsSchema.includes("ensureMaterialsSuppliersTables") &&
    !materialsSchema.includes("CREATE TABLE IF NOT EXISTS"),
);

const jobAftercareMigration = readFileSync(
  new URL(
    "../prisma/migrations/20261001180000_job_aftercare_instruction/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
check(
  "Job aftercare migration is additive and does not alter Job columns",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(jobAftercareMigration) &&
    jobAftercareMigration.includes('CREATE TABLE IF NOT EXISTS "JobAftercareInstruction"') &&
    jobAftercareMigration.includes('CREATE TABLE IF NOT EXISTS "JobAftercareEvent"') &&
    !jobAftercareMigration.includes('ALTER TABLE "Job"') &&
    !jobAftercareMigration.includes("ADD COLUMN") &&
    localNames.includes("20261001180000_job_aftercare_instruction") &&
    localNames.includes("20261001140000_invoice_checkout_session_and_mismatch_resolved") &&
    localNames.indexOf("20261001140000_invoice_checkout_session_and_mismatch_resolved") <
      localNames.indexOf("20261001180000_job_aftercare_instruction"),
);

const jobReassignmentRequestMigration = readFileSync(
  new URL(
    "../prisma/migrations/20261001194700_job_reassignment_request/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const jobReassignmentRequestOps = readFileSync(
  new URL("../src/lib/job-reassignment-request-ops.ts", import.meta.url),
  "utf8",
);
check(
  "Job reassignment-request migration is additive, uniquely named, and after aftercare",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(jobReassignmentRequestMigration) &&
    jobReassignmentRequestMigration.includes('CREATE TABLE IF NOT EXISTS "JobReassignmentRequest"') &&
    jobReassignmentRequestMigration.includes("WHERE \"status\" = 'PENDING'") &&
    jobReassignmentRequestMigration.includes("IF NOT EXISTS") &&
    !jobReassignmentRequestMigration.includes('ALTER TABLE "Job"') &&
    jobReassignmentRequestMigration.includes("20261001194700") &&
    localNames.includes("20261001194700_job_reassignment_request") &&
    !localNames.includes("20261001180000_job_reassignment_request") &&
    !localNames.includes("20261001190000_job_reassignment_request") &&
    localNames.includes("20261001180000_job_aftercare_instruction") &&
    localNames.indexOf("20261001180000_job_aftercare_instruction") <
      localNames.indexOf("20261001194700_job_reassignment_request"),
);
check(
  "Job reassignment-request ops do not run request-time DDL",
  !jobReassignmentRequestOps.includes("$executeRawUnsafe") &&
    !jobReassignmentRequestOps.includes("CREATE TABLE") &&
    !jobReassignmentRequestOps.includes("ALTER TABLE") &&
    jobReassignmentRequestOps.includes("missingJobReassignmentRequestSchema") &&
    jobReassignmentRequestOps.includes(
      "if (missingJobReassignmentRequestSchema(error)) return []",
    ),
);

const scheduleCalendarSubscriptionMigration = readFileSync(
  new URL(
    "../prisma/migrations/20261001194722_schedule_calendar_feed_subscription/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const scheduleCalendarSubscriptionOps = readFileSync(
  new URL("../src/lib/schedule-calendar-subscription/ops.ts", import.meta.url),
  "utf8",
);
check(
  "Schedule calendar subscription migration is additive, uniquely named, and after aftercare",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(scheduleCalendarSubscriptionMigration) &&
    scheduleCalendarSubscriptionMigration.includes(
      'CREATE TABLE IF NOT EXISTS "ScheduleCalendarSubscription"',
    ) &&
    scheduleCalendarSubscriptionMigration.includes("IF NOT EXISTS") &&
    !scheduleCalendarSubscriptionMigration.includes('ALTER TABLE "Job"') &&
    scheduleCalendarSubscriptionMigration.includes("20261001194722") &&
    localNames.includes("20261001194722_schedule_calendar_feed_subscription") &&
    !localNames.includes("20261001180000_schedule_calendar_feed_subscription") &&
    !localNames.includes("20261001190000_schedule_calendar_feed_subscription") &&
    localNames.includes("20261001180000_job_aftercare_instruction") &&
    localNames.indexOf("20261001180000_job_aftercare_instruction") <
      localNames.indexOf("20261001194722_schedule_calendar_feed_subscription"),
);
check(
  "Schedule calendar subscription ops do not run request-time DDL",
  !scheduleCalendarSubscriptionOps.includes("$executeRawUnsafe") &&
    !scheduleCalendarSubscriptionOps.includes("CREATE TABLE") &&
    !scheduleCalendarSubscriptionOps.includes("ALTER TABLE"),
);

const esignSignatureRequestIdMigration = readFileSync(
  new URL(
    "../prisma/migrations/20261002193000_esign_signature_request_id/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
check(
  "E-sign signature_request_id migration is additive and uses the reserved timestamp",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(esignSignatureRequestIdMigration) &&
    esignSignatureRequestIdMigration.includes('ADD COLUMN IF NOT EXISTS "esignSignatureRequestId"') &&
    esignSignatureRequestIdMigration.includes('ADD COLUMN IF NOT EXISTS "esignSendingClaimedAt"') &&
    esignSignatureRequestIdMigration.includes("Reserved timestamp 20261002193000") &&
    localNames.includes("20261002193000_esign_signature_request_id") &&
    localNames.includes("20261002192000_native_push_alerts") &&
    localNames.indexOf("20261002192000_native_push_alerts") <
      localNames.indexOf("20261002193000_esign_signature_request_id"),
);

const bankPlaidConnectionMigration = readFileSync(
  new URL(
    "../prisma/migrations/20261003013000_bank_plaid_connection/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
check(
  "Plaid bank connection migration is additive and uses the reserved timestamp",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(bankPlaidConnectionMigration) &&
    bankPlaidConnectionMigration.includes('CREATE TABLE IF NOT EXISTS "BankPlaidItem"') &&
    bankPlaidConnectionMigration.includes('ADD COLUMN IF NOT EXISTS "externalTransactionId"') &&
    bankPlaidConnectionMigration.includes("Reserved timestamp 20261003013000") &&
    localNames.includes("20261003013000_bank_plaid_connection") &&
    localNames.includes("20261002193000_esign_signature_request_id") &&
    localNames.indexOf("20261002193000_esign_signature_request_id") <
      localNames.indexOf("20261003013000_bank_plaid_connection"),
);
const payrollProviderConnectionMigration = readFileSync(
  new URL(
    "../prisma/migrations/20261003180000_payroll_provider_connection/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const payrollConnectOps = readFileSync(
  new URL("../src/lib/payroll-connect/connection.ts", import.meta.url),
  "utf8",
);
check(
  "Gusto payroll connection migration is additive, idempotent, and after the bank stamp",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(payrollProviderConnectionMigration) &&
    payrollProviderConnectionMigration.includes('CREATE TABLE IF NOT EXISTS "PayrollConnection"') &&
    payrollProviderConnectionMigration.includes(
      'CREATE TABLE IF NOT EXISTS "PayrollConnectionOAuthState"',
    ) &&
    payrollProviderConnectionMigration.includes(
      'CREATE TABLE IF NOT EXISTS "PayrollProviderPayrollFact"',
    ) &&
    payrollProviderConnectionMigration.includes(
      'CREATE TABLE IF NOT EXISTS "PayrollProviderPayrollFactLine"',
    ) &&
    payrollProviderConnectionMigration.includes("IF NOT EXISTS") &&
    payrollProviderConnectionMigration.includes("PayrollConnection_businessId_fkey") &&
    payrollProviderConnectionMigration.includes(
      "PayrollConnection_provider_externalCompanyId_active_key",
    ) &&
    payrollProviderConnectionMigration.includes("20261003180000") &&
    !payrollProviderConnectionMigration.includes('ALTER TABLE "PayrollRun"') &&
    !payrollProviderConnectionMigration.includes('ALTER TABLE "Payment"') &&
    localNames.includes("20261003180000_payroll_provider_connection") &&
    localNames.includes("20261003013000_bank_plaid_connection") &&
    localNames.indexOf("20261003013000_bank_plaid_connection") <
      localNames.indexOf("20261003180000_payroll_provider_connection"),
);
check(
  "Gusto payroll connection ops do not run request-time DDL",
  !payrollConnectOps.includes("$executeRawUnsafe") &&
    !payrollConnectOps.includes("CREATE TABLE") &&
    !payrollConnectOps.includes("ALTER TABLE") &&
    payrollConnectOps.includes("ensurePayrollConnectSchema") &&
    payrollConnectOps.includes("FOR UPDATE"),
);

const projectDocumentReviewMigration = readFileSync(
  new URL(
    "../prisma/migrations/20261001200000_project_document_review/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
check(
  "Project document review migration is additive and does not alter StoredAsset or Job columns",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(projectDocumentReviewMigration) &&
    projectDocumentReviewMigration.includes('CREATE TABLE IF NOT EXISTS "ProjectDocumentReview"') &&
    !projectDocumentReviewMigration.includes('ALTER TABLE "Job"') &&
    !projectDocumentReviewMigration.includes('ALTER TABLE "StoredAsset"') &&
    !projectDocumentReviewMigration.includes("ADD COLUMN") &&
    localNames.includes("20261001200000_project_document_review") &&
    localNames.includes("20261001180000_job_aftercare_instruction") &&
    localNames.indexOf("20261001180000_job_aftercare_instruction") <
      localNames.indexOf("20261001200000_project_document_review"),
);

const jobMilestonesMigration = readFileSync(
  new URL("../prisma/migrations/20260929010600_job_milestones/migration.sql", import.meta.url),
  "utf8",
);
check(
  "Job milestones migration is additive and does not alter Job columns",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(jobMilestonesMigration) &&
    jobMilestonesMigration.includes('CREATE TABLE IF NOT EXISTS "JobMilestone"') &&
    jobMilestonesMigration.includes('CREATE TABLE IF NOT EXISTS "JobMilestoneEvent"') &&
    !jobMilestonesMigration.includes('ALTER TABLE "Job"') &&
    !jobMilestonesMigration.includes('ADD COLUMN') &&
    localNames.includes("20260929010600_job_milestones") &&
    localNames.includes("20260928190000_owner_studio_reminder_sms_destination") &&
    !localNames.includes("20260929010000_job_milestones") &&
    !localNames.includes("20260928190000_job_milestones") &&
    localNames.indexOf("20260928190000_owner_studio_reminder_sms_destination") <
      localNames.indexOf("20260929010600_job_milestones"),
);

const ownerEquipmentRegisterMigration = readFileSync(
  new URL(
    "../prisma/migrations/20260929010800_owner_equipment_register/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
check(
  "OWNER equipment register migration is additive and after template archive",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE|UPDATE\s+"Expense"|UPDATE\s+"MaterialCatalogItem"/i.test(
    ownerEquipmentRegisterMigration,
  ) &&
    ownerEquipmentRegisterMigration.includes('CREATE TABLE IF NOT EXISTS "EquipmentItem"') &&
    ownerEquipmentRegisterMigration.includes(
      'CREATE TABLE IF NOT EXISTS "EquipmentMaintenanceEntry"',
    ) &&
    ownerEquipmentRegisterMigration.includes("purchaseExpenseId") &&
    ownerEquipmentRegisterMigration.includes("attemptKey") &&
    ownerEquipmentRegisterMigration.includes("20260928200000_estimate_line_template_archive") &&
    !/ALTER TABLE "Expense"/.test(ownerEquipmentRegisterMigration) &&
    !/ALTER TABLE "MaterialCatalogItem"/.test(ownerEquipmentRegisterMigration) &&
    localNames.includes("20260929010800_owner_equipment_register") &&
    !localNames.includes("20260928210000_owner_equipment_register") &&
    localNames.indexOf("20260928200000_estimate_line_template_archive") <
      localNames.indexOf("20260929010800_owner_equipment_register"),
);

const revenueIsolationMigration = readFileSync(
  new URL(
    "../prisma/migrations/20260929233000_revenue_integrity_business_isolation/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
check(
  "Revenue-integrity business-isolation migration is forward-only after the original backfill",
  localNames.includes("20260929233000_revenue_integrity_business_isolation") &&
    localNames.indexOf("20260926100000_revenue_integrity_supplemental_invoices") <
      localNames.indexOf("20260929233000_revenue_integrity_business_isolation") &&
    revenueIsolationMigration.includes("Do not edit that already-applied migration") &&
    revenueIsolationMigration.includes("RevenueIntegrityBusinessIsolationFinding") &&
    revenueIsolationMigration.includes("change_order_attached_foreign_invoice") &&
    revenueIsolationMigration.includes("payment_attached_foreign_invoice") &&
    !/DELETE FROM "(Invoice|Payment|ChangeOrder)"/i.test(revenueIsolationMigration),
);
check(
  "Original revenue-integrity backfill is unchanged and still lacks business-equality predicates",
  revenueIntegrityMigration.includes('WHERE co."jobId" = first_invoice."jobId"') &&
    !revenueIntegrityMigration.includes('co."businessId" = first_invoice."businessId"') &&
    !revenueIntegrityMigration.includes('p."businessId" = original."businessId"') &&
    !revenueIntegrityMigration.includes('p."businessId" = j."businessId"'),
);
check(
  "Corrective revenue-integrity backfill requires business-equality on every attach UPDATE",
  revenueIsolationMigration.includes('AND co."businessId" = first_invoice."businessId"') &&
    revenueIsolationMigration.includes('AND p."businessId" = original."businessId"') &&
    revenueIsolationMigration.includes('AND p."businessId" = j."businessId"') &&
    revenueIsolationMigration.includes('AND original."businessId" = j."businessId"') &&
    revenueIsolationMigration.includes('p."invoiceId" IS NULL') &&
    revenueIsolationMigration.includes('co."invoiceId" IS NULL'),
);

check(
  "Preview is the shared-production runtime that skips migrate",
  isPreviewSharedProductionRuntime({ vercelEnv: "preview" }) === true &&
    isPreviewSharedProductionRuntime({ vercelEnv: "production" }) === false,
);
check("Request-path schema writes are always blocked", requestPathSchemaWritesBlocked() === true);
check(
  "Request-path CREATE/INSERT statements fail closed",
  planRequestPathSchemaEnsure({
    statements: [
      'CREATE TABLE IF NOT EXISTS "BusinessSaasSubscription" (id text)',
      'INSERT INTO "BusinessSaasSubscription" ("id") VALUES (\'x\')',
    ],
  }).allowed === false &&
    classifyRequestPathSql("ALTER TABLE \"Business\" ADD COLUMN IF NOT EXISTS \"publicPhone\" TEXT")
      .schemaDdl === true,
);
check(
  "Request-path information_schema reads stay allowed",
  planRequestPathSchemaEnsure({
    statements: [
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'Business'",
    ],
  }).allowed === true,
);
check(
  "Missing required schema fail-closes",
  failClosedRequiredSchema({ present: false, name: "Business.publicPhone" }).failClosed === true &&
    failClosedRequiredSchema({ present: false, name: "Business.publicPhone" }).ok === false &&
    failClosedRequiredSchema({ present: true, name: "Business.publicPhone" }).ok === true,
);

const hostedRecovery = readFileSync(
  new URL("../docs/NEON_PITR_R2_RECOVERY.md", import.meta.url),
  "utf8",
);
check(
  "Hosted Neon PITR + private R2 runbook is documentation-only and not the localhost drill",
  hostedRecovery.includes("store_2ie8U4PWbJ5J3agg") &&
    hostedRecovery.includes("empty-cherry-05140338") &&
    hostedRecovery.includes("planProductionMigrateDeploy") &&
    hostedRecovery.includes("HeadObject") &&
    hostedRecovery.includes("Rollback decision") &&
    hostedRecovery.includes("TBBT_FOUNDER_PRODUCTION_READONLY_DATABASE_URL") &&
    hostedRecovery.includes("collpro-s-projects5") &&
    hostedRecovery.includes("businesses/") &&
    hostedRecovery.includes("docs/DATABASE_RESTORE.md") &&
    hostedRecovery.includes("not the localhost") &&
    !hostedRecovery.includes("pg_dump --dbname"),
);
check(
  "Hosted recovery runbook forbids Production restore, retention changes, and customer-byte copies",
  hostedRecovery.includes("Forbidden until a recorded GO decision") &&
    hostedRecovery.includes("history_retention_seconds") &&
    hostedRecovery.includes("GetObject") &&
    hostedRecovery.includes("NO-GO"),
);
check(
  "Hosted recovery runbook uses documented Neon --parent timestamp and confirms parent_timestamp",
  hostedRecovery.includes('--parent "$T"') &&
    hostedRecovery.includes("parent_timestamp") &&
    hostedRecovery.includes("neon projects get \"$PROJECT\" --output json") &&
    hostedRecovery.includes("--no-secrets") &&
    hostedRecovery.includes("unrecoverable") &&
    hostedRecovery.includes("lifecycle") &&
    !hostedRecovery.includes("--timestamp \"$T\"") &&
    !hostedRecovery.includes("--parent production") &&
    !hostedRecovery.includes("135 local") &&
    !hostedRecovery.includes("20261002193000_esign_signature_request_id"),
);
check(
  "Hosted recovery runbook gates Neon CLI 4.9.0+ and discovers $ROOT_BRANCH before restore",
  hostedRecovery.includes("4.9.0") &&
    hostedRecovery.includes("scripts/require-neon-cli.mjs") &&
    hostedRecovery.includes(
      "node scripts/require-neon-cli.mjs || return 1 2>/dev/null || exit 1",
    ) &&
    hostedRecovery.includes("$ROOT_BRANCH") &&
    hostedRecovery.includes('.default == true') &&
    hostedRecovery.includes("Upgrade first") &&
    hostedRecovery.includes("--psql") &&
    hostedRecovery.includes('neon connection-string "$VERIFY_NAME"') &&
    hostedRecovery.includes("command substitution") &&
    hostedRecovery.includes("$(…)") &&
    hostedRecovery.includes("${VERIFY_NAME//[[:space:]]/}") &&
    hostedRecovery.includes("${PROJECT//[[:space:]]/}") &&
    hostedRecovery.includes("${ROOT_BRANCH//[[:space:]]/}") &&
    hostedRecovery.includes("ROOT_BRANCH must be a single default root") &&
    !hostedRecovery.includes("${ROOT_BRANCH:?") &&
    !hostedRecovery.includes("${VERIFY_NAME:?") &&
    !hostedRecovery.includes("${PROJECT:?") &&
    !hostedRecovery.includes("${T:?") &&
    !hostedRecovery.includes('psql "$(neon connection-string') &&
    !hostedRecovery.includes("neon branches restore production") &&
    !hostedRecovery.includes('restore production "^self'),
);

const requireNeonCliPath = fileURLToPath(new URL("./require-neon-cli.mjs", import.meta.url));
const requireNeonCliSrc = readFileSync(requireNeonCliPath, "utf8");
const neonCliVersionSrc = readFileSync(
  new URL("./lib/neon-cli-version.mjs", import.meta.url),
  "utf8",
);

function fencedBashBlocks(markdown) {
  return [...markdown.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1]);
}

function uncommentedBashLines(block) {
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function lineCallsNeon(line) {
  return /(?:^|[;&|]\s*)neon\s/.test(line) || /\$\(\s*neon\s/.test(line);
}

function lineIsGuard(line) {
  return line === "node scripts/require-neon-cli.mjs || return 1 2>/dev/null || exit 1";
}

const neonBashBlocks = fencedBashBlocks(hostedRecovery).filter((block) =>
  uncommentedBashLines(block).some(lineCallsNeon),
);
check(
  "Every pasteable neon block starts with require-neon-cli.mjs and aborts on failure",
  neonBashBlocks.length >= 5 &&
    neonBashBlocks.every((block) => {
      const lines = uncommentedBashLines(block);
      const guardIdx = lines.findIndex(lineIsGuard);
      const neonIdx = lines.findIndex(lineCallsNeon);
      return guardIdx === 0 && neonIdx > 0;
    }) &&
    !fencedBashBlocks(hostedRecovery).some((block) =>
      uncommentedBashLines(block).some((line) => line === "neon --version"),
    ),
);

check(
  "VERIFY_NAME is assigned and fail-closed before branches create/get and connection-string",
  hostedRecoveryVerifyNameSafety(hostedRecovery) === true &&
    !requireNeonCliSrc.includes("NEON_CLI_VERSION_TEXT") &&
    !neonCliVersionSrc.includes("NEON_CLI_VERSION_TEXT"),
);
const assignAfterCreate = hostedRecovery
  .replace(/^\s*VERIFY_NAME="tbbt-pitr-verify-\$\(date -u \+%Y%m%dT%H%M%SZ\)"\n/m, "")
  .replace(/--no-secrets\n/, '--no-secrets\nVERIFY_NAME="tbbt-pitr-verify-late"\n');
const assignAfterGet = hostedRecovery
  .replace(/^\s*VERIFY_NAME="tbbt-pitr-verify-\$\(date -u \+%Y%m%dT%H%M%SZ\)"\n/m, "")
  .replace(
    /neon branches get "\$VERIFY_NAME"/,
    'neon branches get "$VERIFY_NAME"\nVERIFY_NAME="tbbt-pitr-verify-late"',
  );
const emptyVerifyAssign = hostedRecovery.replace(
  /VERIFY_NAME="tbbt-pitr-verify-\$\(date -u \+%Y%m%dT%H%M%SZ\)"/,
  'VERIFY_NAME=""',
);
check(
  "VERIFY_NAME assigned after branches create or get, or as empty, fails the suite",
  hostedRecoveryVerifyNameSafety(assignAfterCreate) === false &&
    hostedRecoveryVerifyNameSafety(assignAfterGet) === false &&
    hostedRecoveryVerifyNameSafety(emptyVerifyAssign) === false,
);
check(
  "Removing any one interactive abort check fails the VERIFY_NAME safety suite",
  REQUIRED_CHECKS.every(
    (line) => hostedRecoveryVerifyNameSafety(hostedRecovery.replaceAll(line, "")) === false,
  ),
);

const bashSyntax = bashSyntaxResults(hostedRecovery);
check(
  "Every fenced bash block in the hosted recovery runbook parses under bash -n",
  bashSyntax.length >= 8 && bashSyntax.every((entry) => entry.ok === true),
);

const section42Flow = runSection42Flow(hostedRecovery);
check(
  "Section 4.2 flow with a 4.9.0 neon shim sets VERIFY_NAME before get/connection-string and forbids restore",
  section42Flow.flowStatus === 0 &&
    section42Flow.expectedSequence === true &&
    section42Flow.verifyNameBeforeGetAndConn === true &&
    section42Flow.emptyBranchArgs.length === 0 &&
    section42Flow.forbiddenStatus !== 0 &&
    section42Flow.forbiddenRanRestore === false,
);

const gatingMatrix = runGatingMatrix(hostedRecovery);
const neonBlocks = neonInvokingBlocks(hostedRecovery);
check(
  "Every neon-invoking block lists the expected gating variables",
  neonBlocks.length >= 6 &&
    neonBlocks.some((block) => block.discovery && block.vars.includes("PROJECT")) &&
    neonBlocks.some(
      (block) =>
        block.block.includes("neon branches restore") &&
        block.vars.includes("T") &&
        block.vars.includes("PROJECT") &&
        block.vars.includes("ROOT_BRANCH"),
    ) &&
    neonBlocks.some(
      (block) =>
        block.block.includes("neon branches create") &&
        block.vars.includes("DEFAULT_BRANCH") &&
        block.vars.includes("T") &&
        !block.vars.includes("VERIFY_NAME"),
    ),
);
check(
  "Every neon-invoking block aborts on unset/empty/space/tab in all five shell modes",
  gatingMatrix.failures.length === 0 &&
    gatingMatrix.blockCount >= 6 &&
    gatingMatrix.caseCount >= 5 * 4 * 5 &&
    gatingMatrix.modes.length === 5,
);

function withNeonShim(spec, run) {
  const dir = mkdtempSync(path.join(tmpdir(), "tbbt-neon-shim-"));
  const env = { ...process.env, PATH: spec.missing ? dir : `${dir}${path.delimiter}${process.env.PATH ?? ""}` };
  delete env.NEON_CLI_VERSION_TEXT;
  delete env.TBBT_NEON_CLI_VERSION_TEXT;
  if (!spec.missing) {
    writeFileSync(
      path.join(dir, "neon"),
      `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(spec.stdout ?? "")});
process.stderr.write(${JSON.stringify(spec.stderr ?? "")});
process.exit(${Number(spec.status ?? 0)});
`,
      { mode: 0o755 },
    );
  }
  try {
    return run(env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function spawnRequireNeonCli(spec) {
  return withNeonShim(spec, (env) =>
    spawnSync(process.execPath, [requireNeonCliPath], {
      encoding: "utf8",
      env,
    }),
  );
}

check("Neon CLI version floor is 4.9.0", MIN_NEON_CLI_VERSION === "4.9.0");
check(
  "Neon CLI 4.8.9 fails the hosted recovery version gate",
  evaluateNeonCliVersion("4.8.9").ok === false &&
    evaluateNeonCliVersion("v4.8.9").ok === false &&
    evaluateNeonCliVersion("neon 4.8.9").ok === false &&
    /4\.8\.9/.test(evaluateNeonCliVersion("4.8.9").reason) &&
    /Upgrade first/.test(evaluateNeonCliVersion("4.8.9").reason),
);
check(
  "Neon CLI 4.9.0 and 4.9.1 pass the hosted recovery version gate",
  evaluateNeonCliVersion("4.9.0").ok === true &&
    evaluateNeonCliVersion("v4.9.0").ok === true &&
    evaluateNeonCliVersion("neon 4.9.0").ok === true &&
    evaluateNeonCliVersion("4.9.1").ok === true,
);
check(
  "Neon CLI 4.10.0 and 5.0.0 pass the hosted recovery version gate",
  evaluateNeonCliVersion("4.10.0").ok === true &&
    evaluateNeonCliVersion("v4.10.0").ok === true &&
    evaluateNeonCliVersion("5.0.0").ok === true &&
    evaluateNeonCliVersion("4.10.0-rc.1").ok === true,
);
check(
  "Neon CLI garbage, missing, 4.9, and 4.9.0 prerelease fail closed",
  evaluateNeonCliVersion("").ok === false &&
    evaluateNeonCliVersion(null).ok === false &&
    evaluateNeonCliVersion(undefined).ok === false &&
    evaluateNeonCliVersion("not-a-version").ok === false &&
    evaluateNeonCliVersion("4.9").ok === false &&
    evaluateNeonCliVersion("4.9.0-beta").ok === false &&
    evaluateNeonCliVersion("4.9.0-beta.1").ok === false &&
    /missing/.test(evaluateNeonCliVersion("").reason) &&
    /unreadable/.test(evaluateNeonCliVersion("garbage").reason) &&
    /Upgrade first/.test(evaluateNeonCliVersion("not-a-version").reason),
);
check(
  "Neon CLI version parse fails closed on banners, path prefixes, and mixed stderr",
  evaluateNeonCliVersion("Update available 5.0.0...\nneon 4.8.0").ok === false &&
    evaluateNeonCliVersion("/usr/local/n/versions/node/18.0.0/bin/neon 4.8.9").ok === false &&
    evaluateNeonCliVersionProcess({
      status: 1,
      stdout: "",
      stderr: "v20.11.0\n",
    }).ok === false &&
    evaluateNeonCliVersionProcess({
      status: 1,
      stdout: "4.9.0",
      stderr: "",
    }).ok === false &&
    evaluateNeonCliVersionProcess({
      status: 0,
      stdout: "4.9.0",
      stderr: "Update available 5.0.0\n",
    }).ok === true &&
    evaluateNeonCliVersionProcess({
      error: Object.assign(new Error("not found"), { code: "ENOENT" }),
    }).ok === false,
);
check(
  "NEON_CLI_VERSION_TEXT cannot skip the live neon binary",
  !requireNeonCliSrc.includes("NEON_CLI_VERSION_TEXT") &&
    spawnRequireNeonCli({
      stdout: "4.8.9\n",
      status: 0,
    }).status !== 0,
);

const shimCases = [
  { label: "4.8.9", stdout: "4.8.9\n", status: 0, ok: false },
  { label: "4.9.0-beta", stdout: "4.9.0-beta\n", status: 0, ok: false },
  { label: "4.9", stdout: "4.9\n", status: 0, ok: false },
  { label: "empty", stdout: "", status: 0, ok: false },
  { label: "garbage", stdout: "not-a-version\n", status: 0, ok: false },
  { label: "banner then 4.8.0", stdout: "Update available 5.0.0...\nneon 4.8.0\n", status: 0, ok: false },
  { label: "stderr node version", stdout: "", stderr: "v20.11.0\n", status: 1, ok: false },
  { label: "path prefix 18.0.0", stdout: "/usr/local/n/versions/node/18.0.0/bin/neon 4.8.9\n", status: 0, ok: false },
  { label: "4.9.0 with exit 1", stdout: "4.9.0\n", status: 1, ok: false },
  { label: "ENOENT", missing: true, ok: false },
  { label: "4.9.0", stdout: "4.9.0\n", status: 0, ok: true },
  { label: "4.9.1", stdout: "4.9.1\n", status: 0, ok: true },
  { label: "5.0.0", stdout: "5.0.0\n", status: 0, ok: true },
  { label: "4.10.0", stdout: "4.10.0\n", status: 0, ok: true },
  { label: "neon 4.9.0", stdout: "neon 4.9.0\n", status: 0, ok: true },
  { label: "v4.9.0", stdout: "v4.9.0\n", status: 0, ok: true },
];
const shimResults = shimCases.map((spec) => ({
  ...spec,
  result: spawnRequireNeonCli(spec),
}));
check(
  "require-neon-cli.mjs spawn path fail-closes shims that used to pass and accepts 4.9.0+",
  shimResults.every((entry) => (entry.result.status === 0) === entry.ok) &&
    shimResults
      .filter((entry) => !entry.ok)
      .every((entry) => /Upgrade first|missing|unreadable|exited/.test(entry.result.stderr)) &&
    spawnRequireNeonCli({ stdout: "4.8.9\n", status: 0, extraEnv: true }).status !== 0,
);

const envHookPoison = withNeonShim({ stdout: "4.8.9\n", status: 0 }, (env) => {
  env.NEON_CLI_VERSION_TEXT = "9.9.9";
  return spawnSync(process.execPath, [requireNeonCliPath], {
    encoding: "utf8",
    env,
  });
});
check(
  "NEON_CLI_VERSION_TEXT=9.9.9 does not skip a failing neon shim",
  envHookPoison.status !== 0 && /4\.8\.9|Upgrade first/.test(envHookPoison.stderr),
);

const marketingConnectionsMigration = readFileSync(
  new URL("../prisma/migrations/20261003190000_marketing_connections/migration.sql", import.meta.url),
  "utf8",
);
const marketingConnectionsService = readFileSync(
  new URL("../src/lib/marketing-connections/service.ts", import.meta.url),
  "utf8",
);
const marketingConnectionsSchema = readFileSync(
  new URL("../src/lib/marketing-connections/schema-guard.ts", import.meta.url),
  "utf8",
);
check(
  "Marketing connections migration is additive and does not drop data",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(marketingConnectionsMigration) &&
    marketingConnectionsMigration.includes('ADD COLUMN IF NOT EXISTS "accessTokenCiphertext"') &&
    marketingConnectionsMigration.includes('ADD COLUMN IF NOT EXISTS "refreshTokenCiphertext"') &&
    marketingConnectionsMigration.includes('ADD COLUMN IF NOT EXISTS "connectionStatus"') &&
    marketingConnectionsMigration.includes('CREATE TABLE IF NOT EXISTS "MarketingConnectionOAuthState"') &&
    marketingConnectionsMigration.includes("MarketingConnectionOAuthState_businessId_fkey") &&
    marketingConnectionsMigration.includes("MarketingConnectionOAuthState_membershipId_fkey") &&
    marketingConnectionsMigration.includes("IF NOT EXISTS ("),
);
check(
  "Marketing connections request path fail-closes instead of CREATE TABLE",
  marketingConnectionsSchema.includes("assertRequiredTablesExist") &&
    marketingConnectionsSchema.includes("assertRequiredColumnsExist") &&
    marketingConnectionsSchema.includes("never runs DDL") &&
    marketingConnectionsService.includes("assertMarketingConnectionSchema") &&
    !marketingConnectionsService.includes("$executeRaw") &&
    !marketingConnectionsService.includes("CREATE TABLE") &&
    !marketingConnectionsSchema.includes("$executeRaw"),
);

console.log(
  failed === 0
    ? `\nAll production-migrate checks passed (${passed}).`
    : `\n${failed} production-migrate check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
