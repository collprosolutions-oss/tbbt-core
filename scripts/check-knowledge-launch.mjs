/**
 * Business Launch + Knowledge Hub expansion proofs.
 *
 * Covers resumability, existing-model writes, owner approval, AI proposal
 * vs action, knowledge provenance, candidate learning approval, tenant
 * isolation, role boundaries, and no unauthorized publish / subscription /
 * trade activation.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-knowledge-launch.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { CAPABILITIES, ForbiddenError, requireBusinessCapability, roleHasCapability } =
  await import("@/lib/authorization");
const { visibleAppNav } = await import("@/lib/nav");
const {
  BUSINESS_LAUNCH_PATH,
  LAUNCH_NO_PUBLISH_MESSAGE,
  LAUNCH_NO_SILENT_PRICING_MESSAGE,
  LAUNCH_STEP_KEYS,
  LAUNCH_TRADE_CONFIRM_ONLY_MESSAGE,
  buildLaunchProgressSummary,
  ownerNeedsBusinessLaunch,
  parseLaunchStepKey,
} = await import("@/lib/business-launch");
const { completeLaunchStep, deferLaunchStep, ensureLaunchProgress, resumeLaunchLater, skipLaunchStep } =
  await import("@/lib/business-launch-ops");
const { loadLaunchWorkspace } = await import("@/lib/business-launch-data");
const { createKnowledgeEntry, setKnowledgeApproval, setKnowledgeArchived, updateKnowledgeEntry } =
  await import("@/lib/knowledge-ops");
const { retrieveTenantKnowledge, answerKnowledgeFromEntries } = await import("@/lib/ai/knowledge");
const { proposeCompanySetupFromDescription } = await import("@/lib/ai/company-setup");
const {
  applyCompanySetupItem,
  createCompanySetupProposal,
  reviewCompanySetupItem,
} = await import("@/lib/company-setup-ops");
const { createOperatingProcedure, setOperatingProcedureApproval } = await import(
  "@/lib/operating-procedures-ops"
);
const { reviewExperienceCandidate, scanExperienceCandidates } = await import(
  "@/lib/experience-intelligence-ops"
);
const { buildBsosRecommendations, EMPTY_BSOS_FACTS } = await import("@/lib/bsos");
const { loadBsosFacts } = await import("@/lib/bsos-data");
const { postAuthenticationPath } = await import("@/lib/first-run-setup");
const { ensurePrimaryBusinessTrade } = await import("@/lib/business-trades");
const { COMPANY_SETUP_FORBIDDEN_MESSAGE } = await import("@/lib/company-setup");
const { OWNER_KNOWLEDGE_APPROVAL_MESSAGE } = await import("@/lib/knowledge");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_knowledge_launch_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for knowledge-launch test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

async function expectError(label, fn, predicate) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: { role, membership: { id: membershipId }, user: { id: "user" }, business: { id: businessId, slug: "x" } },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

try {
  console.log("\nSTATIC — Business Launch and Knowledge expansion");
  check("Launch has 14 defined steps", LAUNCH_STEP_KEYS.length === 14);
  check("Progress uses defined steps, not a fake total", buildLaunchProgressSummary({}).definedStepCount === 14);
  check("Empty progress is 0%", buildLaunchProgressSummary({}).progressPercent === 0);
  check("Synthesized empty progress is not recorded", buildLaunchProgressSummary({}).hasRecordedProgress === false);
  check("Recommended next starts at identity", buildLaunchProgressSummary({}).recommendedNext === "identity");
  check("parseLaunchStepKey falls back", parseLaunchStepKey("nope") === "identity");
  check(
    "Resume-later OWNER is not trapped",
    ownerNeedsBusinessLaunch({
      role: "OWNER",
      launch: { status: "IN_PROGRESS", resumeLaterAt: new Date() },
    }) === false,
  );
  check(
    "In-progress OWNER without resume-later is routed to launch",
    postAuthenticationPath({
      role: "OWNER",
      business: {
        slug: "new-handyman",
        firstRunSetupCompletedAt: new Date(),
        starterServicesSetupCompletedAt: new Date(),
        websiteSetupCompletedAt: new Date(),
      },
      launch: { status: "IN_PROGRESS", resumeLaterAt: null },
    }) === BUSINESS_LAUNCH_PATH,
  );
  check(
    "Existing OWNER without a launch row still goes to dashboard",
    postAuthenticationPath({
      role: "OWNER",
      business: {
        slug: "existing",
        firstRunSetupCompletedAt: new Date(),
        starterServicesSetupCompletedAt: new Date(),
        websiteSetupCompletedAt: new Date(),
      },
    }) === "/dashboard",
  );
  check("Launch nav is visible to OWNER", visibleAppNav("OWNER").some((item) => item.href === "/launch"));
  check("Launch nav is hidden from MEMBER", !visibleAppNav("MEMBER").some((item) => item.href === "/launch"));
  check("MEMBER cannot manage settings", !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_SETTINGS));
  check("MEMBER cannot manage knowledge", !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_KNOWLEDGE));
  check("MEMBER cannot use AI assist", !roleHasCapability("MEMBER", CAPABILITIES.USE_AI_ASSIST));

  const launchOps = readRepo("src/lib/business-launch-ops.ts");
  const companyOps = readRepo("src/lib/company-setup-ops.ts");
  const companyAi = readRepo("src/lib/ai/company-setup.ts");
  check("Launch ops do not call trade activation", !launchOps.includes("activateBusinessTradeOp"));
  check("Launch ops do not publish the website", !launchOps.includes("publishWebsite"));
  check("Launch ops do not touch SaaS subscription writes", !launchOps.includes("BusinessSaasSubscription"));
  check("Company setup apply does not publish", !companyOps.includes("publishWebsite"));
  check("Company setup apply does not activate trades", !companyOps.includes("activateBusinessTradeOp"));
  check("Forbidden trade proposal is represented", companyAi.includes("TRADE_ACTIVATION"));
  check("Launch documents no silent pricing", launchOps.includes("LAUNCH_NO_SILENT_PRICING_MESSAGE"));
  check("Website publish stays a separate action", LAUNCH_NO_PUBLISH_MESSAGE.includes("never publishes"));

  const launchPage = readRepo("src/app/(app)/launch/page.tsx");
  const dashboardPage = readRepo("src/app/(app)/dashboard/page.tsx");
  const dashboardCard = readRepo("src/components/launch/dashboard-card.tsx");
  check(
    "GET /launch does not create launch progress",
    !launchPage.includes("ensureLaunchProgress") && launchPage.includes("loadLaunchWorkspace"),
  );
  check(
    "Dashboard hides unfinished 0-of-14 copy until Launch is recorded",
    dashboardPage.includes("hasRecordedProgress") &&
      dashboardCard.includes("hasRecordedProgress") &&
      dashboardCard.includes("Optional: build out more business settings") &&
      dashboardCard.includes("does not require") &&
      dashboardCard.includes("Continue launch"),
  );
  check(
    "Hours and Scheduling launch steps do not wipe unavailable dates",
    !launchOps.includes("unavailableDates: []") &&
      launchOps.includes("readUnavailableDates") &&
      launchOps.includes("updateSchedulingSettingsOp"),
  );

  const emptyRecs = buildBsosRecommendations(EMPTY_BSOS_FACTS);
  check("Empty BSOS facts still have no recommendations", emptyRecs.length === 0);
  const launchRecs = buildBsosRecommendations({
    ...EMPTY_BSOS_FACTS,
    launchIncompleteSteps: { count: 3 },
    experienceCandidates: { count: 2 },
  });
  check("Incomplete launch becomes a BSOS recommendation", launchRecs.some((row) => row.key === "finish-business-launch"));
  check("Candidate learnings become a BSOS recommendation", launchRecs.some((row) => row.key === "review-experience-learnings"));

  const businessA = await prisma.business.create({
    data: { name: "Alpha Launch", slug: `alpha-launch-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Launch", slug: `beta-launch-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia", email: `owner-launch-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia", email: `member-launch-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Bea", email: `beta-launch-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Amina", email: `admin-launch-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const adminMem = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: businessA.id, role: "ADMIN" },
  });
  const betaMem = await prisma.membership.create({
    data: { userId: betaUser.id, businessId: businessB.id, role: "OWNER" },
  });
  await ensurePrimaryBusinessTrade(prisma, businessA.id, "HANDYMAN");
  await ensurePrimaryBusinessTrade(prisma, businessB.id, "HANDYMAN");
  await prisma.businessSaasSubscription.create({
    data: { businessId: businessA.id, status: "none", legacyExempt: true, planCode: "FOUNDER" },
  });
  await prisma.businessSaasSubscription.create({
    data: { businessId: businessB.id, status: "none", legacyExempt: true, planCode: "FOUNDER" },
  });

  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaMem.id);

  const setupCompleteBusiness = {
    slug: "new-handyman",
    firstRunSetupCompletedAt: new Date(),
    starterServicesSetupCompletedAt: new Date(),
    websiteSetupCompletedAt: new Date(),
  };

  console.log("\nDB — viewing Launch does not create a resume obligation");
  const viewed = await loadLaunchWorkspace(prisma, businessA.id);
  const viewedRow = await prisma.businessLaunchProgress.findFirst({ where: { businessId: businessA.id } });
  check("GET /launch load creates no BusinessLaunchProgress row", viewedRow == null);
  check("Unstarted Launch workspace synthesizes 14 pending steps in memory", viewed.progress.definedStepCount === 14 && viewed.progress.pendingCount === 14);
  check("Unstarted Launch has no recorded progress", viewed.progress.hasRecordedProgress === false);
  check(
    "Unstarted Launch does not force post-auth /launch",
    postAuthenticationPath({
      role: "OWNER",
      business: setupCompleteBusiness,
      launch: viewedRow,
    }) === "/dashboard" &&
      ownerNeedsBusinessLaunch({ role: "OWNER", launch: viewedRow }) === false,
  );

  console.log("\nDB — first Launch mutation creates resumable progress");
  const freshBusiness = await prisma.business.create({
    data: { name: "Fresh Launch", slug: `fresh-launch-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const freshUser = await prisma.user.create({
    data: { name: "Faye", email: `fresh-launch-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const freshMem = await prisma.membership.create({
    data: { userId: freshUser.id, businessId: freshBusiness.id, role: "OWNER" },
  });
  await prisma.businessSaasSubscription.create({
    data: { businessId: freshBusiness.id, status: "none", legacyExempt: true, planCode: "FOUNDER" },
  });
  const freshOwner = makeAccess(freshBusiness.id, "OWNER", freshMem.id);
  await skipLaunchStep(prisma, freshOwner, "identity");
  const afterFirstWrite = await loadLaunchWorkspace(prisma, freshBusiness.id);
  const freshRow = await prisma.businessLaunchProgress.findFirst({
    where: { businessId: freshBusiness.id },
    select: { status: true, resumeLaterAt: true },
  });
  check("First skip creates a BusinessLaunchProgress row", Boolean(freshRow));
  check("First Launch mutation is recorded progress", afterFirstWrite.progress.hasRecordedProgress === true);
  check("First Launch mutation is resumable IN_PROGRESS", freshRow?.status === "IN_PROGRESS" && afterFirstWrite.progress.skippedCount === 1);
  check(
    "Recorded unfinished Launch routes post-auth to /launch",
    postAuthenticationPath({
      role: "OWNER",
      business: { ...setupCompleteBusiness, slug: freshBusiness.slug },
      launch: freshRow,
    }) === BUSINESS_LAUNCH_PATH,
  );
  await resumeLaunchLater(prisma, freshOwner);
  const resumed = await prisma.businessLaunchProgress.findFirst({
    where: { businessId: freshBusiness.id },
    select: { status: true, resumeLaterAt: true },
  });
  check(
    "Resume later still releases the next login from /launch",
    resumed?.status === "IN_PROGRESS" &&
      Boolean(resumed?.resumeLaterAt) &&
      ownerNeedsBusinessLaunch({ role: "OWNER", launch: resumed }) === false &&
      postAuthenticationPath({
        role: "OWNER",
        business: { ...setupCompleteBusiness, slug: freshBusiness.slug },
        launch: resumed,
      }) === "/dashboard",
  );
  for (const stepKey of LAUNCH_STEP_KEYS) {
    if (stepKey === "identity") continue;
    await skipLaunchStep(prisma, freshOwner, stepKey);
  }
  const completedFresh = await loadLaunchWorkspace(prisma, freshBusiness.id);
  const completedRow = await prisma.businessLaunchProgress.findFirst({
    where: { businessId: freshBusiness.id },
    select: { status: true, resumeLaterAt: true, completedAt: true },
  });
  check("Completed Launch is recorded COMPLETED", completedFresh.progress.status === "COMPLETED" && completedRow?.status === "COMPLETED");
  check(
    "Completed Launch does not force post-auth /launch",
    ownerNeedsBusinessLaunch({ role: "OWNER", launch: completedRow }) === false &&
      postAuthenticationPath({
        role: "OWNER",
        business: { ...setupCompleteBusiness, slug: freshBusiness.slug },
        launch: completedRow,
      }) === "/dashboard",
  );

  console.log("\nDB — Hours and Scheduling preserve unavailable dates");
  const hoursBusiness = await prisma.business.create({
    data: { name: "Hours Launch", slug: `hours-launch-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const hoursUser = await prisma.user.create({
    data: { name: "Hana", email: `hours-launch-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const hoursMem = await prisma.membership.create({
    data: { userId: hoursUser.id, businessId: hoursBusiness.id, role: "OWNER" },
  });
  const hoursAdminUser = await prisma.user.create({
    data: { name: "Hal", email: `hours-admin-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const hoursAdminMem = await prisma.membership.create({
    data: { userId: hoursAdminUser.id, businessId: hoursBusiness.id, role: "ADMIN" },
  });
  await prisma.businessSaasSubscription.create({
    data: { businessId: hoursBusiness.id, status: "none", legacyExempt: true, planCode: "FOUNDER" },
  });
  const hoursOwner = makeAccess(hoursBusiness.id, "OWNER", hoursMem.id);
  const hoursAdmin = makeAccess(hoursBusiness.id, "ADMIN", hoursAdminMem.id);
  await prisma.businessUnavailableDate.createMany({
    data: [
      { businessId: hoursBusiness.id, date: "2026-10-01" },
      { businessId: hoursBusiness.id, date: "2026-10-15" },
      { businessId: businessB.id, date: "2026-11-01" },
    ],
  });
  await expectError(
    "ADMIN cannot complete a launch step",
    () =>
      completeLaunchStep(prisma, hoursAdmin, {
        stepKey: "hours",
        workStartMinutes: 540,
        workEndMinutes: 1080,
        workingWeekdays: [1, 2, 3, 4, 5],
        schedulingBufferMinutes: 15,
      }),
    (error) => error instanceof ForbiddenError || error.name === "ForbiddenError",
  );
  await expectError(
    "ADMIN cannot skip a launch step",
    () => skipLaunchStep(prisma, hoursAdmin, "hours"),
    (error) => error instanceof ForbiddenError || error.name === "ForbiddenError",
  );
  await expectError(
    "MEMBER cannot skip a launch step",
    () => skipLaunchStep(prisma, memberA, "hours"),
    (error) => error instanceof ForbiddenError || error.name === "ForbiddenError",
  );
  await expectError(
    "ADMIN cannot resume launch later",
    () => resumeLaunchLater(prisma, hoursAdmin),
    (error) => error instanceof ForbiddenError || error.name === "ForbiddenError",
  );
  await expectError(
    "MEMBER cannot resume launch later",
    () => resumeLaunchLater(prisma, memberA),
    (error) => error instanceof ForbiddenError || error.name === "ForbiddenError",
  );
  await completeLaunchStep(prisma, hoursOwner, {
    stepKey: "hours",
    workStartMinutes: 540,
    workEndMinutes: 1080,
    workingWeekdays: [1, 2, 3, 4, 5],
    schedulingBufferMinutes: 15,
  });
  const afterHours = await prisma.businessUnavailableDate.findMany({
    where: { businessId: hoursBusiness.id },
    select: { date: true },
    orderBy: { date: "asc" },
  });
  const afterHoursSettings = await prisma.businessSettings.findUnique({ where: { businessId: hoursBusiness.id } });
  check(
    "Hours preserves existing unavailable dates",
    afterHours.map((row) => row.date).join(",") === "2026-10-01,2026-10-15",
  );
  check("Hours still writes working hours", afterHoursSettings?.workStartMinutes === 540 && afterHoursSettings?.schedulingBufferMinutes === 15);
  await completeLaunchStep(prisma, hoursOwner, {
    stepKey: "scheduling",
    workStartMinutes: 540,
    workEndMinutes: 1080,
    workingWeekdays: [1, 2, 3, 4, 5],
    schedulingBufferMinutes: 45,
    schedulingNotes: "Keep the October blocks",
  });
  const afterScheduling = await prisma.businessUnavailableDate.findMany({
    where: { businessId: hoursBusiness.id },
    select: { date: true },
    orderBy: { date: "asc" },
  });
  const afterSchedulingSettings = await prisma.businessSettings.findUnique({
    where: { businessId: hoursBusiness.id },
  });
  check(
    "Scheduling preserves existing unavailable dates",
    afterScheduling.map((row) => row.date).join(",") === "2026-10-01,2026-10-15",
  );
  check("Scheduling still writes buffer and notes", afterSchedulingSettings?.schedulingBufferMinutes === 45 && afterSchedulingSettings?.schedulingPreferenceNotes === "Keep the October blocks");
  const betaDates = await prisma.businessUnavailableDate.findMany({
    where: { businessId: businessB.id },
    select: { date: true },
  });
  check("Hours/Scheduling writes stay tenant-scoped", betaDates.map((row) => row.date).join(",") === "2026-11-01");
  const betaProgress = await prisma.businessLaunchProgress.findFirst({ where: { businessId: businessB.id } });
  check("Hours/Scheduling does not create another tenant's launch progress", betaProgress == null);

  console.log("\nDB — resumability and existing-model writes");
  const started = await ensureLaunchProgress(prisma, ownerA);
  check("Launch creates every defined step", started.steps.length === LAUNCH_STEP_KEYS.length);
  const first = await loadLaunchWorkspace(prisma, businessA.id);
  check("Fresh launch progress is 0%", first.progress.progressPercent === 0);
  check("Recommended next is identity", first.progress.recommendedNext === "identity");
  check("Ensured launch progress is recorded", first.progress.hasRecordedProgress === true);

  await expectError(
    "MEMBER cannot complete a launch step",
    () =>
      completeLaunchStep(prisma, memberA, {
        stepKey: "identity",
        name: "Nope",
        phone: "555-0100",
        email: "x@example.com",
      }),
    (error) => error instanceof ForbiddenError || error.name === "ForbiddenError",
  );

  await completeLaunchStep(prisma, ownerA, {
    stepKey: "identity",
    name: "Alpha Handyman Co",
    phone: "555-0100",
    email: "hello@alpha.test",
    website: "https://alpha.test",
  });
  const afterIdentity = await loadLaunchWorkspace(prisma, businessA.id);
  check("Identity step is completed", afterIdentity.progress.steps.find((row) => row.stepKey === "identity")?.status === "COMPLETED");
  check("Progress is 1/14", afterIdentity.progress.completedCount === 1 && afterIdentity.progress.progressPercent === 7);
  const renamed = await prisma.business.findUnique({ where: { id: businessA.id } });
  check("Identity wrote Business.name", renamed?.name === "Alpha Handyman Co");
  check("Identity wrote public phone", renamed?.publicPhone === "555-0100");

  await expectError(
    "Launch cannot confirm an unauthorized trade",
    () => completeLaunchStep(prisma, ownerA, { stepKey: "trades", confirmTrades: ["CLEANING"] }),
    (error) => String(error.message).includes("cannot enable") || String(error.message) === LAUNCH_TRADE_CONFIRM_ONLY_MESSAGE,
  );
  await completeLaunchStep(prisma, ownerA, { stepKey: "trades", confirmTrades: ["HANDYMAN"] });
  const trades = await prisma.businessTrade.findMany({ where: { businessId: businessA.id } });
  check("No extra trade was activated", trades.length === 1 && trades[0].tradeCode === "HANDYMAN");

  await completeLaunchStep(prisma, ownerA, {
    stepKey: "service_area",
    phone: "555-0100",
    email: "hello@alpha.test",
    serviceAreaLabel: "Reno, NV",
    serviceAreaCity: "Reno",
    serviceAreaRegion: "NV",
  });
  const areaBiz = await prisma.business.findUnique({ where: { id: businessA.id } });
  const areas = await prisma.serviceArea.findMany({ where: { businessId: businessA.id } });
  check("Service area wrote public label", areaBiz?.publicServiceAreaLabel === "Reno, NV");
  check("Service area wrote Core ServiceArea row", areas.some((row) => row.city === "Reno"));

  await completeLaunchStep(prisma, ownerA, { stepKey: "services", serviceNames: ["Door repair"] });
  const catalog = await prisma.serviceCatalogItem.findMany({ where: { businessId: businessA.id } });
  check("Service write created a catalog item", catalog.some((row) => row.name === "Door repair"));
  check("New service has no silent price", catalog.every((row) => row.name !== "Door repair" || row.price == null));
  check("New service is custom quote", catalog.some((row) => row.name === "Door repair" && row.pricingMode === "CUSTOM_QUOTE"));

  await expectError(
    "Pricing does not write a minimum without owner confirm",
    () =>
      completeLaunchStep(prisma, ownerA, {
        stepKey: "pricing",
        pricingApproach: "MIXED",
        laborMinimumEnabled: true,
        laborMinimumAmount: "125",
      }),
    (error) => String(error.message) === LAUNCH_NO_SILENT_PRICING_MESSAGE,
  );
  await completeLaunchStep(prisma, ownerA, {
    stepKey: "pricing",
    pricingApproach: "MIXED",
    laborMinimumEnabled: true,
    laborMinimumAmount: "125",
    confirmPricing: true,
  });
  const priced = await prisma.business.findUnique({ where: { id: businessA.id } });
  const settings = await prisma.businessSettings.findUnique({ where: { businessId: businessA.id } });
  check("Confirmed minimum wrote Business.laborMinimumAmount", priced?.laborMinimumAmount?.toString() === "125");
  check("Pricing approach wrote BusinessSettings", settings?.pricingApproach === "MIXED");

  await skipLaunchStep(prisma, ownerA, "team");
  await deferLaunchStep(prisma, ownerA, "payments");
  const mid = await loadLaunchWorkspace(prisma, businessA.id);
  check("Skipped team is not counted complete", mid.progress.skippedCount === 1 && mid.progress.steps.find((row) => row.stepKey === "team")?.status === "SKIPPED");
  check("Deferred payments keep launch in progress", mid.progress.status === "IN_PROGRESS");
  check("Recommended next is first pending, not skipped", mid.progress.recommendedNext === "hours");

  await completeLaunchStep(prisma, ownerA, {
    stepKey: "goals",
    goalTitle: "Book more repeat customers",
    goalDescription: "From launch setup",
  });
  const goals = await prisma.businessGoal.findMany({ where: { businessId: businessA.id } });
  check("Goal wrote BusinessGoal", goals.some((row) => row.title === "Book more repeat customers"));

  const publishedBefore = await prisma.websitePublish.count({ where: { businessId: businessA.id } });
  await completeLaunchStep(prisma, ownerA, { stepKey: "website", about: "We fix homes in Reno with honest pricing." });
  const publishedAfter = await prisma.websitePublish.count({ where: { businessId: businessA.id } });
  check("Website step did not publish", publishedBefore === 0 && publishedAfter === 0);
  check("Business.publishedWebsiteId stays null", (await prisma.business.findUnique({ where: { id: businessA.id } }))?.publishedWebsiteId == null);

  console.log("\nDB — AI proposal vs action and approval");
  const proposalDraft = proposeCompanySetupFromDescription({
    description: "We are a friendly Reno handyman company. We install doors and also want to add cleaning.",
    activeTradeCodes: ["HANDYMAN"],
  });
  check("Proposal includes a blocked trade item", proposalDraft.items.some((item) => item.kind === "TRADE_ACTIVATION"));
  const proposal = await createCompanySetupProposal(prisma, ownerA, {
    inputText: "We are a friendly Reno handyman company. We install doors and also want to add cleaning.",
    summary: proposalDraft.summary,
    items: proposalDraft.items,
  });
  const blocked = proposal.items.find((item) => item.kind === "TRADE_ACTIVATION");
  check("Trade activation item is stored BLOCKED", blocked?.status === "BLOCKED");
  await expectError(
    "Blocked trade item cannot be approved into an action",
    () => reviewCompanySetupItem(prisma, ownerA, { itemId: blocked.id, decision: "APPROVED" }),
    (error) => String(error.message) === COMPANY_SETUP_FORBIDDEN_MESSAGE,
  );
  const serviceItem = proposal.items.find((item) => item.kind === "SERVICE");
  await expectError(
    "Unapproved proposal item cannot be applied",
    () => applyCompanySetupItem(prisma, ownerA, serviceItem.id),
    (error) => String(error.message).includes("Approve the proposal"),
  );
  await reviewCompanySetupItem(prisma, ownerA, { itemId: serviceItem.id, decision: "APPROVED" });
  await applyCompanySetupItem(prisma, ownerA, serviceItem.id);
  const applied = await prisma.companySetupProposalItem.findUnique({ where: { id: serviceItem.id } });
  check("Approved service item was applied", applied?.status === "APPLIED" && applied.appliedRecordKind === "SERVICE");
  await expectError(
    "MEMBER cannot create a company proposal",
    () =>
      createCompanySetupProposal(prisma, memberA, {
        inputText: "I should not be able to propose this business.",
        summary: "nope",
        items: [{ kind: "GOAL", title: "x", body: "y" }],
      }),
    (error) => error instanceof ForbiddenError || error.name === "ForbiddenError",
  );

  console.log("\nDB — knowledge provenance, approval, and ask grounding");
  const knowledge = await createKnowledgeEntry(prisma, ownerA, {
    title: "Door hardware lesson",
    body: "Always confirm hinge side before ordering a prehung door.",
    category: "JOB_PROCEDURES",
    sourceType: "OWNER_CREATED",
    knowledgeKind: "FIELD_TECHNIQUE",
  });
  check("New knowledge starts unreviewed", knowledge.approvalState === "UNREVIEWED");
  await expectError(
    "SYSTEM_DERIVED still cannot be written",
    () =>
      createKnowledgeEntry(prisma, ownerA, {
        title: "Invented",
        body: "Machine invented this policy.",
        category: "JOB_PROCEDURES",
        sourceType: "SYSTEM_DERIVED",
      }),
    (error) => String(error.message).includes("System-derived"),
  );
  const unapprovedHits = await retrieveTenantKnowledge(prisma, businessA.id, "door hinge");
  check("Unapproved knowledge is labeled inference", unapprovedHits.some((hit) => hit.id === knowledge.id && hit.grounding === "inference"));
  await setKnowledgeApproval(prisma, ownerA, { entryId: knowledge.id, approvalState: "APPROVED" });
  const approvedHits = await retrieveTenantKnowledge(prisma, businessA.id, "door hinge");
  check("Approved knowledge is labeled approved", approvedHits.some((hit) => hit.id === knowledge.id && hit.grounding === "approved"));
  const answer = answerKnowledgeFromEntries("How do we hang a door?", approvedHits);
  check("Ask answer distinguishes approved knowledge", answer.text.includes("Approved knowledge"));
  check("Ask answer stays tenant-scoped", answer.citedFactKeys.every((id) => id === knowledge.id || approvedHits.some((hit) => hit.id === id)));

  const procedure = await createOperatingProcedure(prisma, ownerA, {
    title: "Door install checklist",
    summary: "First visit",
    steps: [{ title: "Confirm swing" }, { title: "Photograph jamb" }],
  });
  await setOperatingProcedureApproval(prisma, ownerA, { procedureId: procedure.id, approvalState: "APPROVED" });
  const linked = await prisma.operatingProcedure.findUnique({ where: { id: procedure.id } });
  check("Approved procedure created a knowledge entry", Boolean(linked?.knowledgeEntryId));

  console.log("\nDB — experience intelligence and tenant isolation");
  const customer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Ada Homeowner" },
  });
  const job = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "COMPLETED",
      scheduledDurationMinutes: 60,
      projectToken: randomUUID(),
    },
  });
  await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: ownerMem.id,
      jobId: job.id,
      activityType: "JOB",
      status: "APPROVED",
      startedAt: new Date("2026-09-01T08:00:00Z"),
      endedAt: new Date("2026-09-01T10:30:00Z"),
      approvedHours: 2.5,
    },
  });
  await scanExperienceCandidates(prisma, ownerA);
  const candidates = await prisma.experienceLearningCandidate.findMany({ where: { businessId: businessA.id } });
  check("Duration variance created a candidate", candidates.some((row) => row.kind === "DURATION_VARIANCE"));
  const candidate = candidates.find((row) => row.kind === "DURATION_VARIANCE");
  check("Candidate is not trusted policy yet", candidate.status === "CANDIDATE" && !candidate.knowledgeEntryId);
  await reviewExperienceCandidate(prisma, ownerA, { candidateId: candidate.id, status: "APPROVED" });
  const approvedCandidate = await prisma.experienceLearningCandidate.findUnique({ where: { id: candidate.id } });
  check("Approved candidate created knowledge", Boolean(approvedCandidate?.knowledgeEntryId));
  const promoted = await prisma.knowledgeEntry.findUnique({ where: { id: approvedCandidate.knowledgeEntryId } });
  check("Promoted knowledge is owner-approved, not system-derived", promoted?.sourceType !== "SYSTEM_DERIVED" && promoted?.approvalState === "APPROVED");
  check("Duration candidate provenance is Experience evidence", promoted?.sourceType === "TBBT_RECORD" && promoted?.sourceKind === "EXPERIENCE_CANDIDATE" && promoted?.sourceReferenceId === candidate.id);

  await expectError(
    "Business B cannot approve A's candidate",
    () => reviewExperienceCandidate(prisma, ownerB, { candidateId: candidate.id, status: "REJECTED" }),
    (error) => error instanceof Error,
  );
  const bSource = await loadLaunchWorkspace(prisma, businessB.id);
  check("Business B launch is empty", bSource.progress.completedCount === 0 && bSource.progress.hasRecordedProgress === false);
  const bHits = await retrieveTenantKnowledge(prisma, businessB.id, "door hinge");
  check("Ask Knowledge does not retrieve cross-tenant entries", bHits.length === 0);
  const bFacts = await loadBsosFacts(prisma, businessB.id);
  const aFacts = await loadBsosFacts(prisma, businessA.id);
  check("BSOS launch facts stay tenant-scoped", aFacts.launchIncompleteSteps.count > 0 && bFacts.launchIncompleteSteps.count === 0);
  check("BSOS candidate facts stay tenant-scoped", aFacts.experienceCandidates.count >= 0 && bFacts.experienceCandidates.count === 0);

  const saasA = await prisma.businessSaasSubscription.findUnique({ where: { businessId: businessA.id } });
  check("Subscription was not changed by launch or AI apply", saasA?.status === "none" && saasA.legacyExempt === true);

  await expectError(
    "MEMBER cannot approve knowledge",
    () => setKnowledgeApproval(prisma, memberA, { entryId: knowledge.id, approvalState: "APPROVED" }),
    (error) => error instanceof ForbiddenError || error.name === "ForbiddenError",
  );

  console.log("\nDB — approval invalidation and OWNER authority");
  const policy = await createKnowledgeEntry(prisma, adminA, {
    title: "Approved door swing policy",
    body: "Confirm hinge side before ordering a prehung door.",
    category: "JOB_PROCEDURES",
    sourceType: "OWNER_CREATED",
    knowledgeKind: "OWNER_POLICY",
  });
  await expectError(
    "ADMIN cannot owner-approve knowledge",
    () => setKnowledgeApproval(prisma, adminA, { entryId: policy.id, approvalState: "APPROVED" }),
    (error) => String(error.message) === OWNER_KNOWLEDGE_APPROVAL_MESSAGE,
  );
  await expectError(
    "ADMIN cannot reject knowledge as owner authority",
    () => setKnowledgeApproval(prisma, adminA, { entryId: policy.id, approvalState: "REJECTED" }),
    (error) => String(error.message) === OWNER_KNOWLEDGE_APPROVAL_MESSAGE,
  );
  await setKnowledgeApproval(prisma, ownerA, { entryId: policy.id, approvalState: "APPROVED" });
  const approvedPolicy = await prisma.knowledgeEntry.findUnique({ where: { id: policy.id } });
  check("OWNER can approve knowledge", approvedPolicy?.approvalState === "APPROVED" && Boolean(approvedPolicy.approvedAt));
  const archivedStillApproved = await setKnowledgeArchived(prisma, adminA, {
    entryId: policy.id,
    archived: true,
  });
  check("Archiving alone keeps owner approval", archivedStillApproved.approvalState === "APPROVED");
  await setKnowledgeArchived(prisma, adminA, { entryId: policy.id, archived: false });
  const editedByAdmin = await updateKnowledgeEntry(prisma, adminA, {
    entryId: policy.id,
    body: "Confirm hinge side and rough opening before ordering a prehung door.",
  });
  check("ADMIN can edit knowledge", editedByAdmin.body.includes("rough opening"));
  check("Material edit clears owner approval", editedByAdmin.approvalState === "UNREVIEWED");
  check("Material edit clears approvedAt", editedByAdmin.approvedAt == null);
  check("Material edit clears approvedBy", editedByAdmin.approvedByMembershipId == null);
  const editedHits = await retrieveTenantKnowledge(prisma, businessA.id, "prehung door");
  check(
    "Ask Knowledge no longer labels the edited version approved",
    editedHits.some((hit) => hit.id === policy.id && hit.grounding !== "approved"),
  );
  await expectError(
    "MEMBER cannot edit knowledge",
    () => updateKnowledgeEntry(prisma, memberA, { entryId: policy.id, body: "Member should not edit this." }),
    (error) => error instanceof ForbiddenError || error.name === "ForbiddenError",
  );
  await setKnowledgeApproval(prisma, ownerA, { entryId: policy.id, approvalState: "APPROVED" });
  const reapproved = await prisma.knowledgeEntry.findUnique({ where: { id: policy.id } });
  check("OWNER reapproval restores approved state", reapproved?.approvalState === "APPROVED");
  await expectError(
    "ADMIN cannot owner-approve an operating procedure",
    () => setOperatingProcedureApproval(prisma, adminA, { procedureId: procedure.id, approvalState: "APPROVED" }),
    (error) => String(error.message) === OWNER_KNOWLEDGE_APPROVAL_MESSAGE,
  );

  console.log("\nDB — concurrent apply, proposal retry, and launch writes");
  const retryId = `company-setup-retry-${randomUUID()}`;
  const retryDraft = proposeCompanySetupFromDescription({
    description: "We repair fences and want a written first-visit checklist.",
    activeTradeCodes: ["HANDYMAN"],
  });
  const [retryOne, retryTwo] = await Promise.all([
    createCompanySetupProposal(prisma, ownerA, {
      inputText: "We repair fences and want a written first-visit checklist.",
      summary: retryDraft.summary,
      items: retryDraft.items,
      interactionId: retryId,
    }),
    createCompanySetupProposal(prisma, ownerA, {
      inputText: "We repair fences and want a written first-visit checklist.",
      summary: retryDraft.summary,
      items: retryDraft.items,
      interactionId: retryId,
    }),
  ]);
  check("Same AI attempt returns one proposal", retryOne.id === retryTwo.id);
  const retryCount = await prisma.companySetupProposal.count({
    where: { businessId: businessA.id, interactionId: retryId },
  });
  check("Retry-safe proposal persisted once", retryCount === 1);

  async function approveAndApplyTwice(kind, title, payload = {}) {
    const created = await createCompanySetupProposal(prisma, ownerA, {
      inputText: `Concurrent apply proof for ${kind} ${title} needs enough text.`,
      summary: `${kind} apply`,
      items: [{ kind, title, body: `${title} body for concurrent apply.`, payload }],
    });
    const item = created.items.find((row) => row.kind === kind);
    await reviewCompanySetupItem(prisma, ownerA, { itemId: item.id, decision: "APPROVED" });
    await Promise.all([
      applyCompanySetupItem(prisma, ownerA, item.id),
      applyCompanySetupItem(prisma, ownerA, item.id),
    ]);
    return prisma.companySetupProposalItem.findUnique({ where: { id: item.id } });
  }

  const appliedService = await approveAndApplyTwice("SERVICE", "Fence repair");
  const fenceServices = await prisma.serviceCatalogItem.findMany({
    where: { businessId: businessA.id, name: "Fence repair" },
  });
  check("Concurrent SERVICE apply creates one catalog item", fenceServices.length === 1);
  check("Concurrent SERVICE apply is APPLIED once", appliedService?.status === "APPLIED" && appliedService.appliedRecordId === fenceServices[0].id);

  const appliedGoal = await approveAndApplyTwice("GOAL", "Book more fence work");
  const fenceGoals = await prisma.businessGoal.findMany({
    where: { businessId: businessA.id, title: "Book more fence work", recommendationKey: "launch-ai-goal" },
  });
  check("Concurrent GOAL apply creates one goal", fenceGoals.length === 1);
  check("Concurrent GOAL apply is APPLIED once", appliedGoal?.status === "APPLIED" && appliedGoal.appliedRecordId === fenceGoals[0].id);

  const appliedProcedure = await approveAndApplyTwice("PROCEDURE", "Fence visit checklist", {
    steps: [{ title: "Confirm the fence line" }],
  });
  const fenceProcedures = await prisma.operatingProcedure.findMany({
    where: { businessId: businessA.id, title: "Fence visit checklist" },
  });
  check("Concurrent PROCEDURE apply creates one procedure", fenceProcedures.length === 1);
  check(
    "Concurrent PROCEDURE apply is APPLIED once",
    appliedProcedure?.status === "APPLIED" && appliedProcedure.appliedRecordId === fenceProcedures[0].id,
  );

  const appliedChoice = await approveAndApplyTwice("SETUP_CHOICE", "Always photograph the posts");
  const choiceKnowledge = await prisma.knowledgeEntry.findMany({
    where: { businessId: businessA.id, title: "Always photograph the posts", knowledgeKind: "BUSINESS_RULE" },
  });
  check("Concurrent SETUP_CHOICE apply creates one knowledge record", choiceKnowledge.length === 1);
  check(
    "Concurrent SETUP_CHOICE apply is APPLIED once",
    appliedChoice?.status === "APPLIED" && appliedChoice.appliedRecordId === choiceKnowledge[0].id,
  );

  await Promise.all([
    completeLaunchStep(prisma, ownerA, { stepKey: "services", serviceNames: ["Gate latch repair"] }),
    completeLaunchStep(prisma, ownerA, { stepKey: "services", serviceNames: ["Gate latch repair"] }),
  ]);
  const gateServices = await prisma.serviceCatalogItem.findMany({
    where: { businessId: businessA.id, name: "Gate latch repair" },
  });
  check("Concurrent launch services create one catalog item", gateServices.length === 1);

  await Promise.all([
    completeLaunchStep(prisma, ownerA, {
      stepKey: "goals",
      goalTitle: "Finish the remaining launch steps",
      goalDescription: "Owner-entered goal",
    }),
    completeLaunchStep(prisma, ownerA, {
      stepKey: "goals",
      goalTitle: "Finish the remaining launch steps",
      goalDescription: "Owner-entered goal",
    }),
  ]);
  const launchGoals = await prisma.businessGoal.findMany({
    where: { businessId: businessA.id, title: "Finish the remaining launch steps", recommendationKey: "launch-goal" },
  });
  check("Concurrent launch goals create one goal", launchGoals.length === 1);

  const areasBefore = await prisma.serviceArea.count({
    where: { businessId: businessA.id, city: "Sparks" },
  });
  await Promise.all([
    completeLaunchStep(prisma, ownerA, {
      stepKey: "service_area",
      phone: "555-0100",
      email: "hello@alpha.test",
      serviceAreaLabel: "Sparks, NV",
      serviceAreaCity: "Sparks",
      serviceAreaRegion: "NV",
    }),
    completeLaunchStep(prisma, ownerA, {
      stepKey: "service_area",
      phone: "555-0100",
      email: "hello@alpha.test",
      serviceAreaLabel: "Sparks, NV",
      serviceAreaCity: "Sparks",
      serviceAreaRegion: "NV",
    }),
  ]);
  const sparksAreas = await prisma.serviceArea.count({
    where: { businessId: businessA.id, city: "Sparks" },
  });
  check("Concurrent launch service area creates one city row", areasBefore === 0 && sparksAreas === 1);

  console.log("\nDB — experience provenance and OWNER-only promotion");
  await prisma.serviceRequest.createMany({
    data: [
      {
        businessId: businessA.id,
        summary: "Customers keep asking about latch replacement cost",
        description: "Customers keep asking about latch replacement before booking.",
      },
      {
        businessId: businessA.id,
        summary: "Customers keep asking about latch replacement timing",
        description: "Customers keep asking about latch replacement on the first visit.",
      },
    ],
  });
  await scanExperienceCandidates(prisma, ownerA);
  const questionCandidates = await prisma.experienceLearningCandidate.findMany({
    where: { businessId: businessA.id, kind: "RECURRING_CUSTOMER_QUESTION" },
  });
  check("Recurring-question candidate was created", questionCandidates.length >= 1);
  const question = questionCandidates[0];
  await expectError(
    "ADMIN cannot promote a candidate into trusted knowledge",
    () => reviewExperienceCandidate(prisma, adminA, { candidateId: question.id, status: "APPROVED" }),
    (error) => String(error.message) === OWNER_KNOWLEDGE_APPROVAL_MESSAGE,
  );
  const stillCandidate = await prisma.experienceLearningCandidate.findUnique({ where: { id: question.id } });
  check("ADMIN review did not promote the candidate", stillCandidate?.status === "CANDIDATE" && !stillCandidate.knowledgeEntryId);
  await reviewExperienceCandidate(prisma, ownerA, { candidateId: question.id, status: "APPROVED" });
  const promotedQuestion = await prisma.experienceLearningCandidate.findUnique({ where: { id: question.id } });
  const questionKnowledge = await prisma.knowledgeEntry.findUnique({
    where: { id: promotedQuestion.knowledgeEntryId },
  });
  check("Promoted recurring-question knowledge is APPROVED", questionKnowledge?.approvalState === "APPROVED");
  check("Promoted knowledge stays TBBT evidence", questionKnowledge?.sourceType === "TBBT_RECORD");
  check(
    "Promoted knowledge points at the Experience candidate",
    questionKnowledge?.sourceKind === "EXPERIENCE_CANDIDATE" &&
      questionKnowledge.sourceReferenceId === question.id,
  );
  check("Promoted knowledge does not claim OWNER_CREATED", questionKnowledge?.sourceType !== "OWNER_CREATED");
  await expectError(
    "Business B cannot promote A's recurring-question candidate",
    () => reviewExperienceCandidate(prisma, ownerB, { candidateId: question.id, status: "REJECTED" }),
    (error) => error instanceof Error,
  );

  console.log(
    failures === 0 ? "\nAll knowledge-launch checks passed." : `\n${failures} knowledge-launch check(s) failed.`,
  );
} finally {
  await prisma.$disconnect();
}

process.exit(failures === 0 ? 0 : 1);
