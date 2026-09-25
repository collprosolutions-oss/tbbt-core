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

console.log(
  failed === 0
    ? `\nAll production-migrate checks passed (${passed}).`
    : `\n${failed} production-migrate check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
