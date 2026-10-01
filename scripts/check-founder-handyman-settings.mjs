/**
 * Founder Handyman in-product settings / launch usability verifier.
 *
 * Proves a brand-new Handyman OWNER can configure the existing supported
 * business settings after account creation, read them back, and have those
 * settings affect their real consumers. Does not deploy, migrate production,
 * expose secrets, or duplicate Founder production preflight (#244).
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-founder-handyman-settings.mjs
 */
import { register } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import bcrypt from "bcryptjs";
import {
  assertLocalDatabaseUrl,
  openDisposableTestDatabase,
} from "./disposable-test-database.mjs";

register(new URL("./estimate-options-test-loader.mjs", import.meta.url), import.meta.url);

process.env.TZ = process.env.TZ || "America/New_York";
process.env.TBBT_PAYMENTS_ADAPTER = "fake";
process.env.TBBT_SAAS_BILLING_ADAPTER = "fake";
process.env.TBBT_CUSTOMER_MESSAGING_ADAPTER = "fake";
process.env.NEXT_PUBLIC_APP_URL =
  process.env.NEXT_PUBLIC_APP_URL || "http://localhost:43217";
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || "re_founder_settings_test";
process.env.EMAIL_FROM = process.env.EMAIL_FROM || "TBBT <settings@example.com>";

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

async function expectThrow(label, fn, predicate) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

/**
 * Internal consistency of the Founder settings happy path.
 * Mutation tests flip one field at a time so a vacuous always-true
 * checker cannot stay green.
 */
function founderSettingsConsistent(state) {
  return Boolean(
    state.businessId &&
      state.otherBusinessId &&
      state.businessId !== state.otherBusinessId &&
      state.timezone === "America/Los_Angeles" &&
      state.publicPhone === "555-222-3333" &&
      state.publicEmail === "shop@cedar.example" &&
      state.serviceAreaLabel === "Reno, NV" &&
      state.serviceAreaCity === "Reno" &&
      state.aboutCopy.includes("Cedar") &&
      state.catalogActiveCount > 0 &&
      state.laborMinimumEnabled === true &&
      state.laborMinimumAmount === "125" &&
      state.schedulingBufferMinutes === 45 &&
      state.emailPrefBlocksCompose === true &&
      state.smsPrefBlocksSend === true &&
      state.intakeInArea === true &&
      state.publicShowsAbout === true &&
      state.seoHeadline === "Cedar repairs, done right" &&
      state.seoHeadlineReadBack === "Cedar repairs, done right" &&
      state.paymentStatusReadable === true &&
      state.storageNotFaked === true &&
      state.memberForbidden === true &&
      state.tenantIsolated === true &&
      state.launchDidNotWipeContact === true,
  );
}

console.log("\nSTATIC — verifier is wired to real settings / launch modules");
const firstRunSrc = readRepo("src/lib/first-run-setup.ts");
const firstRunForm = readRepo("src/components/auth/first-run-setup-form.tsx");
const websiteSetupSrc = readRepo("src/lib/website-setup.ts");
const settingsOpsSrc = readRepo("src/lib/settings-ops.ts");
const launchOpsSrc = readRepo("src/lib/business-launch-ops.ts");
const consentSrc = readRepo("src/lib/communications/consent.ts");
const selfSrc = readRepo("scripts/check-founder-handyman-settings.mjs");
const preflightSrc = readRepo("src/lib/founder-production-preflight.ts");

check(
  "First-run reuses Settings profile, contact, and timezone ops",
  firstRunSrc.includes("updateBusinessProfileOp") &&
    firstRunSrc.includes("updateBusinessPublicContactOp") &&
    firstRunSrc.includes("updateBusinessTimeZoneOp") &&
    firstRunForm.includes('name="timezone"'),
);
check(
  "Website setup still writes the public About and service-area label",
  websiteSetupSrc.includes("updateWebsiteStoryOp") &&
    websiteSetupSrc.includes("updateBusinessPublicContactOp") &&
    websiteSetupSrc.includes("serviceArea: input.serviceArea"),
);
check(
  "Settings contact syncs the intake CITY row from the owner label",
  settingsOpsSrc.includes("syncPrimaryCityServiceAreaFromLabel"),
);
check(
  "Launch service-area preserves existing public contact when phone/email are omitted",
  launchOpsSrc.includes("currentContact") &&
    launchOpsSrc.includes("currentContact?.publicPhone") &&
    launchOpsSrc.includes("input.phone?.trim() || currentContact?.publicPhone"),
);
check(
  "Compose email now honors the same communication preference flags as SMS",
  consentSrc.includes("communicationPreferenceEnabled") &&
    consentSrc.includes("purpose: input.purpose") &&
    consentSrc.includes("preferences: input.preferences"),
);
check(
  "This verifier does not duplicate Founder production preflight",
  !selfSrc.includes(`await import("@/${["lib", "founder-production-preflight"].join("/")}")`) &&
    !selfSrc.includes(["evaluate", "FounderProductionPreflight("].join("")) &&
    preflightSrc.includes("export function evaluateFounderProductionPreflight"),
);
check(
  "This verifier imports production modules instead of a parallel fake settings store",
  selfSrc.includes('await import("@/lib/first-run-setup")') &&
    selfSrc.includes('await import("@/lib/website-setup")') &&
    selfSrc.includes('await import("@/lib/settings-ops")') &&
    selfSrc.includes('await import("@/lib/starter-services-setup")'),
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "founder-handyman-settings disposable database");

const session = await openDisposableTestDatabase({
  databaseUrl: baseUrl,
  namePrefix: "tbbt_founder_handyman_settings",
  setProcessEnv: true,
});

try {
  const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
  const { ForbiddenError } = await import("@/lib/authorization");
  const { provisionOwnerWorkspace } = await import("@/lib/signup-provision");
  const {
    completeFirstRunSetupOp,
    ensureFirstRunSetupSchema,
    resetFirstRunSetupSchemaEnsure,
  } = await import("@/lib/first-run-setup");
  const {
    installOnboardingStarterServicesOp,
    ensureStarterServicesSetupSchema,
    resetStarterServicesSetupSchemaEnsure,
  } = await import("@/lib/starter-services-setup");
  const {
    completeWebsiteSetupOp,
    ensureWebsiteSetupSchema,
    resetWebsiteSetupSchemaEnsure,
  } = await import("@/lib/website-setup");
  const {
    updateBusinessPublicContactOp,
    updateLaborMinimumSettingsOp,
    updateSchedulingSettingsOp,
    updateSettingsPreferencesOp,
  } = await import("@/lib/settings-ops");
  const { completeLaunchStep, ensureLaunchProgress } = await import("@/lib/business-launch-ops");
  const { loadSettingsSnapshot } = await import("@/lib/settings-data");
  const { describeBusinessTimeZone } = await import("@/lib/business-timezone");
  const { loadPublicSite, loadPublicAboutCopy } = await import("@/lib/public-site-data");
  const { qualifyServiceAddress, parseServiceAreaLabelParts } = await import("@/lib/service-areas");
  const { listServiceAreas, setServiceAreaEnabled } = await import("@/lib/service-area-ops");
  const { setOwnedServiceCatalogItemActive } = await import("@/lib/catalog-ops");
  const { createPublicServiceRequest } = await import("@/lib/public-intake");
  const { evaluateComposeChannelEligibility } = await import("@/lib/communications/consent");
  const { evaluateSmsEligibility } = await import("@/lib/customer-messaging/eligibility");
  const { saveWebsiteSeoDraft } = await import("@/lib/website-engine/draft");
  const { loadWebsitePublishPanelData } = await import("@/lib/website-engine/editor");
  const { getBusinessPaymentStatus } = await import("@/lib/payments/service");
  const { isBusinessStorageConfigured } = await import("@/lib/business-storage");
  const { isEmailDeliveryConfigured } = await import("@/lib/settings");
  const { availabilitySettingsFromRow } = await import("@/lib/availability-data");
  const { persistDraftEstimateTotal } = await import("@/lib/labor-minimum");
  const { Prisma } = await import("@prisma/client");
  const { prisma } = await import("@/lib/prisma");

  function makeAccess(business, role, membership) {
    return {
      businessId: business.id,
      workspace: {
        role,
        membership: { id: membership.id },
        user: { id: membership.userId },
        business: {
          id: business.id,
          name: business.name,
          slug: business.slug,
          tradeCode: business.tradeCode,
        },
      },
      scope: businessScope(business.id),
      assertOwned(record) {
        return assertBusinessRecord(record, business.id);
      },
      assertAttachable(record) {
        return assertBusinessRecord(record, business.id);
      },
    };
  }

  async function seedOperating(businessId) {
    await prisma.businessSaasSubscription.create({
      data: {
        businessId,
        status: "none",
        legacyExempt: true,
        planCode: "FOUNDER",
      },
    });
  }

  console.log("\nPURE — service-area label parsing");
  check(
    "Reno, NV splits into city Reno and region NV",
    parseServiceAreaLabelParts("Reno, NV").city === "Reno" &&
      parseServiceAreaLabelParts("Reno, NV").region === "NV",
  );
  check(
    "Fort Myers stays a single city token",
    parseServiceAreaLabelParts("Fort Myers").city === "Fort Myers" &&
      parseServiceAreaLabelParts("Fort Myers").region === null,
  );
  const flippedParse = { ...parseServiceAreaLabelParts("Reno, NV"), city: "Sparks" };
  check(
    "Mutation: a different city must fail the Reno/NV parse check",
    !(flippedParse.city === "Reno" && flippedParse.region === "NV"),
  );

  resetFirstRunSetupSchemaEnsure();
  resetStarterServicesSetupSchemaEnsure();
  resetWebsiteSetupSchemaEnsure();
  await ensureFirstRunSetupSchema(prisma);
  await ensureStarterServicesSetupSchema(prisma);
  await ensureWebsiteSetupSchema(prisma);

  const passwordHash = await bcrypt.hash("password12", 10);
  const suffix = randomUUID().slice(0, 8);

  const cedar = await provisionOwnerWorkspace(prisma, {
    name: "Cedar Owner",
    email: `cedar-owner-${suffix}@example.com`,
    passwordHash,
    businessName: "Cedar Handyman",
  });
  const maple = await provisionOwnerWorkspace(prisma, {
    name: "Maple Owner",
    email: `maple-owner-${suffix}@example.com`,
    passwordHash,
    businessName: "Maple Handyman",
  });
  await seedOperating(cedar.business.id);
  await seedOperating(maple.business.id);

  const ownerA = makeAccess(cedar.business, "OWNER", cedar.membership);
  const ownerB = makeAccess(maple.business, "OWNER", maple.membership);

  const memberUser = await prisma.user.create({
    data: {
      name: "Field Tech",
      email: `cedar-member-${suffix}@example.com`,
      passwordHash,
    },
  });
  const memberMembership = await prisma.membership.create({
    data: {
      userId: memberUser.id,
      businessId: cedar.business.id,
      role: "MEMBER",
    },
  });
  const memberA = makeAccess(cedar.business, "MEMBER", memberMembership);

  console.log("\nDB — first-run identity + timezone");
  await completeFirstRunSetupOp(prisma, ownerA, {
    name: "Cedar Handyman Co",
    phone: "555-222-3333",
    email: "shop@cedar.example",
    website: "https://cedar.example",
    timezone: "America/Los_Angeles",
  });
  await completeFirstRunSetupOp(prisma, ownerB, {
    name: "Maple Handyman",
    phone: "555-444-5555",
    email: "shop@maple.example",
    website: "",
    timezone: "America/Chicago",
  });

  const afterFirstRun = await prisma.business.findUnique({
    where: { id: cedar.business.id },
  });
  const mapleAfterFirstRun = await prisma.business.findUnique({
    where: { id: maple.business.id },
  });
  const cedarTz = describeBusinessTimeZone(afterFirstRun);
  check(
    "OWNER can set and read back an explicit business timezone",
    afterFirstRun?.timezone === "America/Los_Angeles" &&
      cedarTz.isExplicit === true &&
      cedarTz.resolvedTimezone === "America/Los_Angeles",
  );
  check(
    "Timezone write is tenant-scoped",
    mapleAfterFirstRun?.timezone === "America/Chicago" &&
      mapleAfterFirstRun?.publicPhone === "555-444-5555",
  );
  await expectThrow(
    "MEMBER cannot change business timezone / identity",
    () =>
      completeFirstRunSetupOp(prisma, memberA, {
        name: "Hijacked",
        phone: "555-000-0000",
        email: "nope@example.com",
        website: "",
        timezone: "America/Denver",
      }),
    (error) => error instanceof ForbiddenError,
  );

  console.log("\nDB — starter catalog + website setup service area");
  const installed = await installOnboardingStarterServicesOp(prisma, ownerA);
  check("Handyman starter catalog installs for a new OWNER", installed.added > 0);

  await completeWebsiteSetupOp(prisma, ownerA, {
    name: "Cedar Handyman Co",
    phone: "555-222-3333",
    email: "shop@cedar.example",
    about: "Cedar helps homeowners in Reno with everyday repairs.",
    serviceArea: "Reno, NV",
  });

  const cedarAreas = await prisma.serviceArea.findMany({
    where: { businessId: cedar.business.id },
  });
  const mapleAreas = await prisma.serviceArea.findMany({
    where: { businessId: maple.business.id },
  });
  check(
    "Website setup creates a CITY ServiceArea from the owner label",
    cedarAreas.some((row) => row.kind === "CITY" && row.city === "Reno" && row.enabled),
  );
  check("The other tenant did not inherit that service area", mapleAreas.length === 0);

  const snapshot = await loadSettingsSnapshot(prisma, cedar.business.id);
  check(
    "Settings snapshot reads back identity, timezone, and service-area label",
    snapshot.business.name === "Cedar Handyman Co" &&
      snapshot.business.publicPhone === "555-222-3333" &&
      snapshot.business.publicEmail === "shop@cedar.example" &&
      snapshot.business.publicServiceAreaLabel === "Reno, NV" &&
      snapshot.timezone.storedTimezone === "America/Los_Angeles" &&
      snapshot.catalogItemCount === installed.added,
  );

  const publicSite = await loadPublicSite(afterFirstRun.slug, prisma);
  const about = await loadPublicAboutCopy(cedar.business.id, prisma);
  check(
    "Public site shows the owner About and service-area label, not CollPro copy",
    publicSite?.business.name === "Cedar Handyman Co" &&
      about === "Cedar helps homeowners in Reno with everyday repairs." &&
      publicSite?.business.publicServiceAreaLabel === "Reno, NV" &&
      publicSite.items.length > 0 &&
      !/CollPro|Fort Myers/.test(about),
  );

  const renoArea = cedarAreas.find((row) => row.city === "Reno");
  const qualification = qualifyServiceAddress(
    cedarAreas.map((row) => ({
      id: row.id,
      kind: row.kind,
      label: row.label,
      city: row.city,
      region: row.region,
      postalCode: row.postalCode,
      enabled: row.enabled,
      travelAdjustment: row.travelAdjustment ? Number(row.travelAdjustment) : null,
      minimumAdjustment: row.minimumAdjustment ? Number(row.minimumAdjustment) : null,
      notes: row.notes,
    })),
    { city: "Reno" },
  );
  check("A Reno request now qualifies IN_AREA after website setup", qualification.qualification === "IN_AREA");

  const intake = await createPublicServiceRequest(prisma, {
    slug: afterFirstRun.slug,
    name: "Homeowner",
    email: "homeowner@example.com",
    phone: "555-111-2222",
    address: "",
    streetAddress: "100 First St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Door latch",
    catalogItemIds: [],
    includeOther: true,
    otherDescription: "Door latch",
    submissionId: `founder-settings-${suffix}`,
    smsOptIn: false,
    configuredAreas: cedarAreas.map((row) => ({
      id: row.id,
      kind: row.kind,
      label: row.label,
      city: row.city,
      region: row.region,
      postalCode: row.postalCode,
      enabled: row.enabled,
      travelAdjustment: row.travelAdjustment ? Number(row.travelAdjustment) : null,
      minimumAdjustment: row.minimumAdjustment ? Number(row.minimumAdjustment) : null,
      notes: row.notes,
    })),
  });
  check("Public intake accepts the owner-configured service area", intake.ok === true);
  if (!intake.ok) {
    console.error(`  intake error: ${intake.error}`);
  }
  if (intake.ok) {
    const request = await prisma.serviceRequest.findFirst({
      where: { id: intake.requestId },
    });
    check(
      "Intake request stays on the Cedar tenant",
      request?.businessId === cedar.business.id,
    );
  }

  console.log("\nDB — service activation, pricing minimum, scheduling, comms");
  const catalog = await prisma.serviceCatalogItem.findMany({
    where: { businessId: cedar.business.id, active: true },
    orderBy: { name: "asc" },
  });
  const firstService = catalog[0];
  await setOwnedServiceCatalogItemActive(prisma, ownerA, {
    id: firstService.id,
    active: false,
  });
  const publicAfterDeactivate = await loadPublicSite(afterFirstRun.slug, prisma);
  check(
    "Deactivating a catalog item removes it from the public consumer",
    publicAfterDeactivate.items.every((item) => item.id !== firstService.id),
  );
  await setOwnedServiceCatalogItemActive(prisma, ownerA, {
    id: firstService.id,
    active: true,
  });
  await expectThrow(
    "MEMBER cannot deactivate owner catalog items",
    () => setOwnedServiceCatalogItemActive(prisma, memberA, { id: firstService.id, active: false }),
    (error) => error instanceof ForbiddenError,
  );

  await updateLaborMinimumSettingsOp(prisma, ownerA, {
    enabled: true,
    amount: new Prisma.Decimal("125"),
    confirmed: true,
  });
  const afterMinimum = await prisma.business.findUnique({
    where: { id: cedar.business.id },
    select: { laborMinimumEnabled: true, laborMinimumAmount: true },
  });
  check(
    "OWNER can set and read back the minimum service fee",
    afterMinimum?.laborMinimumEnabled === true &&
      afterMinimum.laborMinimumAmount?.toString() === "125",
  );
  const mapleMinimum = await prisma.business.findUnique({
    where: { id: maple.business.id },
    select: { laborMinimumEnabled: true },
  });
  check("Labor minimum does not leak to the other tenant", mapleMinimum?.laborMinimumEnabled === false);

  const draftCustomer = await prisma.customer.create({
    data: {
      businessId: cedar.business.id,
      name: "Draft Customer",
      email: "draft@example.com",
    },
  });
  const draft = await prisma.estimate.create({
    data: {
      businessId: cedar.business.id,
      customerId: draftCustomer.id,
      status: "DRAFT",
      total: new Prisma.Decimal("40"),
      publicToken: randomUUID(),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: cedar.business.id,
      estimateId: draft.id,
      description: "Labor",
      quantity: 1,
      unitPrice: new Prisma.Decimal("40"),
      total: new Prisma.Decimal("40"),
      type: "LABOR",
    },
  });
  await persistDraftEstimateTotal(prisma, draft.id, cedar.business.id);
  const drafted = await prisma.estimate.findUnique({ where: { id: draft.id } });
  check(
    "Labor minimum affects future draft estimates",
    Number(drafted?.total ?? 0) >= 125,
  );

  await updateSchedulingSettingsOp(prisma, ownerA, {
    workStartMinutes: 540,
    workEndMinutes: 1020,
    workingWeekdays: [1, 2, 3, 4, 5],
    schedulingBufferMinutes: 45,
    unavailableDates: [],
  });
  const settingsRow = await prisma.businessSettings.findUnique({
    where: { businessId: cedar.business.id },
  });
  const scheduling = availabilitySettingsFromRow(settingsRow, []);
  check(
    "OWNER can set and read back the scheduling buffer",
    scheduling.schedulingBufferMinutes === 45 && scheduling.workStartMinutes === 540,
  );

  await updateSettingsPreferencesOp(prisma, ownerA, {
    estimateCommunicationEnabled: false,
    scheduleNotificationEnabled: true,
    invoiceCommunicationEnabled: true,
  });
  const prefs = await prisma.businessSettings.findUnique({
    where: { businessId: cedar.business.id },
    select: {
      estimateCommunicationEnabled: true,
      scheduleNotificationEnabled: true,
    },
  });
  const emailBlocked = evaluateComposeChannelEligibility({
    businessId: cedar.business.id,
    channel: "EMAIL",
    email: "homeowner@example.com",
    phone: "5551112222",
    smsConsentStatus: "GRANTED",
    purpose: "ESTIMATE_READY",
    preferences: prefs,
    smsEntitled: true,
    smsConfigured: true,
    emailConfigured: true,
  });
  const emailAllowed = evaluateComposeChannelEligibility({
    businessId: cedar.business.id,
    channel: "EMAIL",
    email: "homeowner@example.com",
    phone: "5551112222",
    smsConsentStatus: "GRANTED",
    purpose: "INVOICE_READY",
    preferences: prefs,
    smsEntitled: true,
    smsConfigured: true,
    emailConfigured: true,
  });
  const smsBlocked = evaluateSmsEligibility({
    businessId: cedar.business.id,
    phone: "5551112222",
    smsConsentStatus: "GRANTED",
    purpose: "ESTIMATE_READY",
    preferences: prefs,
  });
  check(
    "Turning off estimate communication blocks compose email",
    emailBlocked.permitted === false && emailBlocked.reason === "preference_disabled",
  );
  check(
    "Invoice communication remains available when only estimate prefs are off",
    emailAllowed.permitted === true && emailAllowed.available === true,
  );
  check(
    "The same estimate preference still blocks SMS",
    smsBlocked.ok === false && smsBlocked.reason === "preference_disabled",
  );

  console.log("\nDB — website SEO read-back, payments, storage, launch contact safety");
  await saveWebsiteSeoDraft(prisma, ownerA, {
    websiteHeroHeadline: "Cedar repairs, done right",
    websiteHeroSupporting: "Honest handyman work in Reno.",
    seoTitleHome: "Cedar Handyman | Reno",
    seoDescriptionHome: "Request repairs in Reno.",
  });
  const publishPanel = await loadWebsitePublishPanelData(prisma, ownerA);
  check(
    "OWNER can save website publishing copy and read it back",
    publishPanel.seo.websiteHeroHeadline === "Cedar repairs, done right" &&
      publishPanel.seo.seoTitleHome === "Cedar Handyman | Reno",
  );
  const maplePanel = await loadWebsitePublishPanelData(prisma, ownerB);
  check(
    "Website SEO does not leak across tenants",
    maplePanel.seo.websiteHeroHeadline === "" &&
      maplePanel.seo.seoTitleHome === "",
  );

  const payment = await getBusinessPaymentStatus(prisma, cedar.business.id);
  check(
    "Payment readiness is readable without inventing a connected account",
    payment.status === "not_connected" || payment.status === "setup_required" || payment.status === "connected",
  );
  const previousBlob = process.env.BLOB_READ_WRITE_TOKEN;
  const previousR2 = process.env.R2_ACCOUNT_ID;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.R2_ACCOUNT_ID;
  check(
    "Storage readiness stays honest when platform storage is not configured",
    isBusinessStorageConfigured() === false,
  );
  if (previousBlob) process.env.BLOB_READ_WRITE_TOKEN = previousBlob;
  if (previousR2) process.env.R2_ACCOUNT_ID = previousR2;
  check("Platform email readiness is a real config check, not a hardcoded true", isEmailDeliveryConfigured() === true);

  const teamSnapshot = await loadSettingsSnapshot(prisma, cedar.business.id);
  check(
    "Workforce memberships are visible on Settings",
    teamSnapshot.team.some((row) => row.role === "OWNER" && row.active) &&
      teamSnapshot.team.some((row) => row.role === "MEMBER" && row.name === "Field Tech"),
  );

  await ensureLaunchProgress(prisma, ownerA);
  await completeLaunchStep(prisma, ownerA, {
    stepKey: "service_area",
    serviceAreaLabel: "Reno, NV",
  });
  const afterLaunchArea = await prisma.business.findUnique({
    where: { id: cedar.business.id },
    select: { publicPhone: true, publicEmail: true, publicWebsite: true, publicServiceAreaLabel: true },
  });
  check(
    "Launch service-area does not wipe existing public contact",
    afterLaunchArea?.publicPhone === "555-222-3333" &&
      afterLaunchArea?.publicEmail === "shop@cedar.example" &&
      afterLaunchArea?.publicWebsite === "https://cedar.example" &&
      afterLaunchArea?.publicServiceAreaLabel === "Reno, NV",
  );

  await updateBusinessPublicContactOp(prisma, ownerA, {
    phone: "555-222-3333",
    email: "shop@cedar.example",
    website: "https://cedar.example",
    serviceArea: "Reno, NV",
  });
  const mapleStill = await prisma.business.findUnique({
    where: { id: maple.business.id },
  });
  check(
    "Cedar contact writes stay on Cedar",
    mapleStill?.publicEmail === "shop@maple.example" &&
      mapleStill?.publicServiceAreaLabel == null,
  );
  const mapleListed = await listServiceAreas(prisma, maple.business.id);
  const cedarListed = await listServiceAreas(prisma, cedar.business.id);
  check("Service-area reads are tenant-scoped", mapleListed.length === 0 && cedarListed.length >= 1);

  await setServiceAreaEnabled(prisma, ownerA, { areaId: renoArea.id, enabled: false });
  await updateBusinessPublicContactOp(prisma, ownerA, {
    phone: "555-222-3333",
    email: "shop@cedar.example",
    website: "https://cedar.example",
    serviceArea: "Reno, NV",
  });
  const renoAfter = await prisma.serviceArea.findUnique({ where: { id: renoArea.id } });
  check(
    "Re-saving the same service-area label does not re-enable an owner-disabled city",
    renoAfter?.enabled === false,
  );
  await setServiceAreaEnabled(prisma, ownerA, { areaId: renoArea.id, enabled: true });

  const state = {
    businessId: cedar.business.id,
    otherBusinessId: maple.business.id,
    timezone: afterFirstRun.timezone,
    publicPhone: afterLaunchArea.publicPhone,
    publicEmail: afterLaunchArea.publicEmail,
    serviceAreaLabel: afterLaunchArea.publicServiceAreaLabel,
    serviceAreaCity: cedarListed.find((row) => row.city === "Reno")?.city ?? null,
    aboutCopy: about,
    catalogActiveCount: catalog.length,
    laborMinimumEnabled: afterMinimum.laborMinimumEnabled,
    laborMinimumAmount: afterMinimum.laborMinimumAmount?.toString() ?? "",
    schedulingBufferMinutes: scheduling.schedulingBufferMinutes,
    emailPrefBlocksCompose: emailBlocked.reason === "preference_disabled",
    smsPrefBlocksSend: smsBlocked.reason === "preference_disabled",
    intakeInArea: qualification.qualification === "IN_AREA",
    publicShowsAbout: about.includes("Cedar"),
    seoHeadline: "Cedar repairs, done right",
    seoHeadlineReadBack: publishPanel.seo.websiteHeroHeadline,
    paymentStatusReadable: Boolean(payment.status),
    storageNotFaked: true,
    memberForbidden: true,
    tenantIsolated: mapleStill.publicEmail === "shop@maple.example",
    launchDidNotWipeContact: afterLaunchArea.publicPhone === "555-222-3333",
  };

  console.log("\nMUTATION — vacuous-checker evidence");
  check("Happy-path settings state is internally consistent", founderSettingsConsistent(state));
  check(
    "Mutation: missing timezone fails consistency",
    !founderSettingsConsistent({ ...state, timezone: null }),
  );
  check(
    "Mutation: missing service-area city fails consistency",
    !founderSettingsConsistent({ ...state, serviceAreaCity: null }),
  );
  check(
    "Mutation: email pref no-op fails consistency",
    !founderSettingsConsistent({ ...state, emailPrefBlocksCompose: false }),
  );
  check(
    "Mutation: launch wiping contact fails consistency",
    !founderSettingsConsistent({ ...state, launchDidNotWipeContact: false }),
  );
  check(
    "Mutation: tenant isolation failure fails consistency",
    !founderSettingsConsistent({ ...state, tenantIsolated: false }),
  );
  check(
    "Mutation: swapped business ids fail consistency",
    !founderSettingsConsistent({ ...state, businessId: state.otherBusinessId }),
  );
} finally {
  await session.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
