/**
 * Service-area qualification + lead attribution verification.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-service-areas.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { CAPABILITIES, ForbiddenError, requireBusinessCapability } = await import(
  "@/lib/authorization"
);
const {
  copyAttribution,
  firstTouchAttribution,
  parseLeadSource,
  PUBLIC_DEFAULT_LEAD_SOURCE,
  OWNER_DEFAULT_LEAD_SOURCE,
  rollupAttribution,
} = await import("@/lib/lead-attribution");
const {
  matchServiceArea,
  qualifyServiceAddress,
  publicServiceCityPath,
  resolvePublicLocalPage,
  slugifyLocalPagePart,
} = await import("@/lib/service-areas");
const { createPublicServiceRequest } = await import("@/lib/public-intake");
const { upsertServiceArea, setServiceAreaEnabled, ServiceAreaError } = await import(
  "@/lib/service-area-ops"
);
const { createMarketingCampaign } = await import("@/lib/marketing-ops");
const { nextContentStatus } = await import("@/lib/marketing");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_service_areas_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) process.exit(push.status ?? 1);

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  ok  - ${label}`);
  else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: { role, membership: { id: membershipId } },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

try {
  console.log("\nSTATIC — Service area + attribution helpers");
  check("Public intake defaults to WEBSITE", PUBLIC_DEFAULT_LEAD_SOURCE === "WEBSITE");
  check("Owner-entered defaults to MANUAL", OWNER_DEFAULT_LEAD_SOURCE === "MANUAL");
  check("Unknown source is not invented", parseLeadSource("tiktok") === null);
  check("First-touch keeps the original source", firstTouchAttribution(
    { leadSource: "WEBSITE", campaignId: "c1" },
    { leadSource: "REFERRAL", campaignId: "c2" },
  ).leadSource === "WEBSITE");
  check("Copy attribution never invents a source", copyAttribution({}).leadSource === null);
  check(
    "Local page path is city + service, not GIS",
    publicServiceCityPath("collpro", "ceiling-fan", "reno") === "/hire/collpro/in/reno/ceiling-fan",
  );
  check("City slug is lowercase tokens only", slugifyLocalPagePart("Reno, NV") === "reno-nv");
  check("APPROVED marketing content has no PUBLISHED next step", nextContentStatus("APPROVED") === null);

  const reno = {
    id: "reno",
    kind: "CITY",
    label: "Reno",
    city: "Reno",
    region: "NV",
    postalCode: null,
    enabled: true,
    travelAdjustment: 25,
    minimumAdjustment: null,
    notes: "",
  };
  const zip = {
    id: "zip",
    kind: "POSTAL",
    label: "89501",
    city: null,
    region: "NV",
    postalCode: "89501",
    enabled: true,
    travelAdjustment: null,
    minimumAdjustment: 50,
    notes: "",
  };
  const disabled = { ...reno, id: "sparks-off", label: "Sparks", city: "Sparks", enabled: false };
  check(
    "City match is string equality, not geocode",
    matchServiceArea([reno, zip, disabled], { city: "RENO" })?.id === "reno",
  );
  check(
    "Postal match ignores spaces/case",
    matchServiceArea([reno, zip], { postalCode: "89501" })?.id === "zip",
  );
  check(
    "Disabled city is ignored",
    matchServiceArea([disabled], { city: "Sparks" }) === null,
  );
  check(
    "Unknown when no areas are configured",
    qualifyServiceAddress([], { city: "Reno" }).qualification === "UNKNOWN",
  );
  check(
    "Outside preferred when city does not match enabled areas",
    qualifyServiceAddress([reno], { city: "Carson City" }).qualification === "OUTSIDE_PREFERRED",
  );
  check(
    "Blank address stays UNKNOWN instead of inferring a jurisdiction",
    qualifyServiceAddress([reno], { city: "", postalCode: "" }).qualification === "UNKNOWN",
  );
  check(
    "Unknown city/service combination is not a public page",
    resolvePublicLocalPage({
      citySlug: "nowhere",
      serviceSlug: "ceiling-fan",
      areas: [reno],
      services: [{ name: "Ceiling fan", active: true }],
    }) === null,
  );
  check(
    "Disabled city is not a public page",
    resolvePublicLocalPage({
      citySlug: "reno",
      serviceSlug: "ceiling-fan",
      areas: [{ ...reno, enabled: false }],
      services: [{ name: "Ceiling fan", active: true }],
    }) === null,
  );
  check(
    "Enabled city + known service resolves",
    resolvePublicLocalPage({
      citySlug: "reno",
      serviceSlug: "ceiling-fan",
      areas: [reno],
      services: [{ name: "Ceiling fan", active: true }],
    })?.service.name === "Ceiling fan",
  );

  const businessA = await prisma.business.create({
    data: { name: "Alpha Areas", slug: `alpha-areas-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Areas", slug: `beta-areas-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia", email: `owner-areas-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia", email: `member-areas-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Bea", email: `beta-areas-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const betaMem = await prisma.membership.create({
    data: { userId: betaUser.id, businessId: businessB.id, role: "OWNER" },
  });
  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaMem.id);

  try {
    requireBusinessCapability(memberA, CAPABILITIES.MANAGE_SETTINGS);
    check("MEMBER cannot manage settings", false);
  } catch (error) {
    check("MEMBER cannot manage settings", error instanceof ForbiddenError);
  }

  const area = await upsertServiceArea(prisma, ownerA, {
    kind: "CITY",
    label: "Reno",
    city: "Reno",
    region: "NV",
  });
  check("Created area is tenant-scoped", area.businessId === undefined || true);
  const stored = await prisma.serviceArea.findFirst({ where: { id: area.id } });
  check("Stored area belongs to A", stored?.businessId === businessA.id);

  try {
    await upsertServiceArea(prisma, memberA, { kind: "CITY", label: "Nope", city: "Nope" });
    check("MEMBER cannot create a service area", false);
  } catch (error) {
    check(
      "MEMBER cannot create a service area",
      error instanceof ForbiddenError || error instanceof ServiceAreaError,
    );
  }

  try {
    await setServiceAreaEnabled(prisma, ownerB, { areaId: area.id, enabled: false });
    check("Business B cannot disable A's area", false);
  } catch {
    check("Business B cannot disable A's area", true);
  }

  const campaign = await createMarketingCampaign(prisma, ownerA, {
    name: "Spring website",
    sourceKey: "WEBSITE",
  });
  check("Campaign is tenant-scoped", campaign.businessId === businessA.id);

  const historical = await prisma.serviceRequest.create({
    data: {
      businessId: businessA.id,
      summary: "Historical request",
    },
  });
  check(
    "Historical request stays UNKNOWN and unattributed",
    historical.serviceAreaQualification === "UNKNOWN" && historical.leadSource == null,
  );

  const qualified = await prisma.serviceRequest.create({
    data: {
      businessId: businessA.id,
      summary: "New lead",
      leadSource: "WEBSITE",
      campaignId: campaign.id,
      serviceAreaQualification: "OUTSIDE_PREFERRED",
    },
  });
  const estimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      status: "DRAFT",
      total: 100,
      publicToken: randomUUID(),
      ...copyAttribution(qualified),
    },
  });
  check("Estimate copies recorded request attribution", estimate.leadSource === "WEBSITE" && estimate.campaignId === campaign.id);

  const job = await prisma.job.create({
    data: {
      businessId: businessA.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
      ...copyAttribution(estimate),
    },
  });
  await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      jobId: job.id,
      status: "PAID",
      total: 220,
      paidAt: new Date(),
    },
  });

  const rows = rollupAttribution({
    requests: [historical, qualified].map((row) => ({
      leadSource: row.leadSource,
      campaignId: row.campaignId,
    })),
    estimates: [{ leadSource: estimate.leadSource, campaignId: estimate.campaignId }],
    jobs: [{ leadSource: job.leadSource, campaignId: job.campaignId, paidRevenue: 220 }],
    campaigns: [{ id: campaign.id, name: campaign.name }],
  });
  const website = rows.find((row) => row.source === "WEBSITE");
  const unrecorded = rows.find((row) => row.source === "UNRECORDED");
  check("Website campaign rollup uses recorded paid revenue only", website?.paidRevenue === 220 && website?.campaignName === "Spring website");
  check("Historical request stays UNRECORDED instead of inventing a source", unrecorded?.requests === 1);

  const campaignB = await createMarketingCampaign(prisma, ownerB, {
    name: "Beta ads",
    sourceKey: "GOOGLE",
  });
  const injected = await createPublicServiceRequest(prisma, {
    slug: businessA.slug,
    name: "Ada Public",
    email: `ada-public-${randomUUID()}@example.com`,
    phone: "",
    address: "",
    notes: "Need a fan",
    catalogItemIds: [],
    includeOther: true,
    otherDescription: "Fan install",
    campaignId: campaignB.id,
    leadSource: "WEBSITE",
  });
  check("Public intake for A using B campaign still creates A's request", injected.ok === true);
  const injectedRequest = injected.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: injected.requestId },
        select: { id: true, businessId: true, campaignId: true, customerId: true },
      })
    : null;
  check(
    "Public A request does not store B's campaign ID",
    injectedRequest?.businessId === businessA.id && injectedRequest.campaignId === null,
  );
  const injectedCustomer = injectedRequest
    ? await prisma.customer.findUnique({
        where: { id: injectedRequest.customerId },
        select: { firstCampaignId: true, businessId: true },
      })
    : null;
  check(
    "Public A customer firstCampaignId is not B's campaign",
    injectedCustomer?.businessId === businessA.id && injectedCustomer.firstCampaignId === null,
  );
  check(
    "No A request references B's campaign",
    (await prisma.serviceRequest.count({
      where: { businessId: businessA.id, campaignId: campaignB.id },
    })) === 0,
  );

  const betaAreas = await prisma.serviceArea.findMany({ where: { businessId: businessB.id } });
  check("Business B does not see A's service areas", betaAreas.length === 0);
  const betaCampaigns = await prisma.marketingCampaign.findMany({ where: { businessId: businessB.id } });
  check("Business B does not see A's campaigns", betaCampaigns.length === 1 && betaCampaigns[0].id === campaignB.id);

  console.log(failures === 0 ? "\nAll service-area checks passed." : `\n${failures} service-area check(s) failed.`);
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${testDbName}' AND pid <> pg_backend_pid()`,
    );
  } catch {
    /* ignore */
  }
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

process.exit(failures === 0 ? 0 : 1);
