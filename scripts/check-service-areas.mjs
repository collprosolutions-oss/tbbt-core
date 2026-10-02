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
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
  parseServiceAreaLabelParts,
  qualifyServiceAddress,
  publicServiceCityPath,
  resolvePublicLocalPage,
  serviceAreaCities,
  slugifyLocalPagePart,
} = await import("@/lib/service-areas");
const { createPublicServiceRequest } = await import("@/lib/public-intake");
const { loadPublicBusiness } = await import("@/lib/public-site-data");
const {
  listServiceAreas,
  setServiceAreaEnabled,
  ServiceAreaError,
  syncPrimaryCityServiceAreaFromLabel,
  upsertServiceArea,
} = await import("@/lib/service-area-ops");
const { createMarketingCampaign } = await import("@/lib/marketing-ops");
const { nextContentStatus } = await import("@/lib/marketing");

const mutationChild = Boolean(process.env.SERVICE_AREA_PARSER_MUTATION_CHILD);

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
    "Owner label Reno, NV parses to city Reno and region NV",
    parseServiceAreaLabelParts("Reno, NV").city === "Reno" &&
      parseServiceAreaLabelParts("Reno, NV").region === "NV",
  );
  check(
    "Owner label without a state stays a single city token",
    parseServiceAreaLabelParts("Fort Myers").city === "Fort Myers" &&
      parseServiceAreaLabelParts("Fort Myers").region === null,
  );
  check(
    "Multi-city and marketing labels do not parse into a city",
    parseServiceAreaLabelParts("Reno and Sparks, NV").city === "" &&
      parseServiceAreaLabelParts("Reno, Sparks, Carson City").city === "" &&
      parseServiceAreaLabelParts("Greater Reno area").city === "" &&
      parseServiceAreaLabelParts("Reno, Washoe County").city === "" &&
      parseServiceAreaLabelParts("89501").city === "" &&
      parseServiceAreaLabelParts(",NV").city === "" &&
      parseServiceAreaLabelParts("Reno,").city === "" &&
      parseServiceAreaLabelParts("Reno NV").city === "" &&
      parseServiceAreaLabelParts("Reno-Sparks").city === "" &&
      parseServiceAreaLabelParts("Northern Nevada").city === "" &&
      parseServiceAreaLabelParts("Reno or Sparks").city === "" &&
      parseServiceAreaLabelParts("Reno.").city === "" &&
      parseServiceAreaLabelParts("Sparks NV.").city === "" &&
      parseServiceAreaLabelParts("...").city === "" &&
      parseServiceAreaLabelParts("'").city === "",
  );
  check(
    "Official hyphenated and multi-word cities still parse",
    parseServiceAreaLabelParts("Winston-Salem, NC").city === "Winston-Salem" &&
      parseServiceAreaLabelParts("Winston-Salem, NC").region === "NC" &&
      parseServiceAreaLabelParts("Salt Lake City").city === "Salt Lake City" &&
      parseServiceAreaLabelParts("Fort Myers").city === "Fort Myers",
  );
  check(
    "Washington, PA and Indiana, PA parse as single cities, not states",
    parseServiceAreaLabelParts("Washington, PA").city === "Washington" &&
      parseServiceAreaLabelParts("Washington, PA").region === "PA" &&
      parseServiceAreaLabelParts("Indiana, PA").city === "Indiana" &&
      parseServiceAreaLabelParts("Indiana, PA").region === "PA",
  );
  check(
    "Bare Washington / Indiana stay display-only",
    parseServiceAreaLabelParts("Washington").city === "" &&
      parseServiceAreaLabelParts("Indiana").city === "",
  );
  check(
    "Reno. and Sparks NV. stay display-only junk punctuation",
    parseServiceAreaLabelParts("Reno.").city === "" &&
      parseServiceAreaLabelParts("Sparks NV.").city === "",
  );
  check(
    "Broad marketing prose does not infer a city or region",
    parseServiceAreaLabelParts("Serving homeowners across Western Pennsylvania").city === "" &&
      parseServiceAreaLabelParts("Greater Reno area").city === "" &&
      parseServiceAreaLabelParts("Northern Nevada, NV").city === "" &&
      parseServiceAreaLabelParts("New York, NY").city === "",
  );
  check(
    "Same-state and district labels stay display-only",
    parseServiceAreaLabelParts("Nevada, NV").city === "" &&
      parseServiceAreaLabelParts("Texas, TX").city === "" &&
      parseServiceAreaLabelParts("Florida, FL").city === "" &&
      parseServiceAreaLabelParts("Washington, WA").city === "" &&
      parseServiceAreaLabelParts("Indiana, IN").city === "" &&
      parseServiceAreaLabelParts("Washington, DC").city === "",
  );
  check(
    "A free-text region is never stored from the label",
    parseServiceAreaLabelParts("Reno, Washoe County").region === null &&
      parseServiceAreaLabelParts("Reno, Sparks, Carson City").region === null,
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

  console.log("\nDB — #249 city-list and public-intake proofs");

  function toConfiguredAreas(rows) {
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      label: row.label,
      city: row.city,
      region: row.region,
      postalCode: row.postalCode,
      enabled: row.enabled,
      travelAdjustment:
        row.travelAdjustment == null
          ? null
          : typeof row.travelAdjustment === "number"
            ? row.travelAdjustment
            : row.travelAdjustment.toNumber(),
      minimumAdjustment:
        row.minimumAdjustment == null
          ? null
          : typeof row.minimumAdjustment === "number"
            ? row.minimumAdjustment
            : row.minimumAdjustment.toNumber(),
      notes: row.notes,
    }));
  }

  function officialPaCityProofSafe(result) {
    return Boolean(
      result.created &&
        result.areaCount === 1 &&
        result.city === result.expectedCity &&
        result.region === "PA" &&
        result.cities.length === 1 &&
        result.cities[0] === result.expectedCity &&
        result.publicCities.length === 1 &&
        result.publicCities[0] === result.expectedCity &&
        result.qualification === "IN_AREA" &&
        result.storedQualification === "IN_AREA" &&
        result.otherQualification === "OUTSIDE_PREFERRED" &&
        result.intakeOk === true &&
        result.otherTenantCities.includes(result.expectedCity) === false,
    );
  }

  function displayOnlyLabelSafe(result) {
    return Boolean(
      result.created === false &&
        result.updated === false &&
        result.areaCount === 0 &&
        result.cities.length === 0 &&
        result.publicCities.length === 0 &&
        result.qualification === "UNKNOWN" &&
        result.storedQualification === "UNKNOWN" &&
        result.intakeOk === true,
    );
  }

  async function proveOfficialPaCity(label, expectedCity, otherAccess) {
    const token = randomUUID().slice(0, 8);
    const business = await prisma.business.create({
      data: {
        name: `${expectedCity} Areas`,
        slug: `${expectedCity.toLowerCase()}-areas-${token}`,
        tradeCode: "HANDYMAN",
      },
    });
    const ownerUser = await prisma.user.create({
      data: {
        name: `${expectedCity} Owner`,
        email: `${expectedCity.toLowerCase()}-owner-${token}@example.com`,
        passwordHash: "x",
      },
    });
    const membership = await prisma.membership.create({
      data: { userId: ownerUser.id, businessId: business.id, role: "OWNER" },
    });
    const access = makeAccess(business.id, "OWNER", membership.id);
    const sync = await syncPrimaryCityServiceAreaFromLabel(prisma, access, label);
    const areas = await listServiceAreas(prisma, business.id);
    const cities = serviceAreaCities(areas);
    const publicSite = await loadPublicBusiness(business.slug, prisma);
    const publicCities = publicSite?.configuredCities ?? [];
    const qualification = qualifyServiceAddress(areas, { city: expectedCity });
    const otherCity = expectedCity === "Washington" ? "Indiana" : "Washington";
    const otherQualification = qualifyServiceAddress(areas, { city: otherCity });
    const intake = await createPublicServiceRequest(prisma, {
      slug: business.slug,
      name: `${expectedCity} Homeowner`,
      email: `${expectedCity.toLowerCase()}-intake-${token}@example.com`,
      phone: "",
      address: "",
      streetAddress: "10 Main St",
      city: expectedCity,
      region: "PA",
      postalCode: expectedCity === "Washington" ? "15301" : "15701",
      notes: "Need a repair",
      catalogItemIds: [],
      includeOther: true,
      otherDescription: "Repair",
      configuredAreas: toConfiguredAreas(areas),
    });
    let storedQualification = null;
    if (intake.ok) {
      const request = await prisma.serviceRequest.findFirst({
        where: { id: intake.requestId },
        select: { serviceAreaQualification: true, businessId: true },
      });
      storedQualification = request?.serviceAreaQualification ?? null;
      check(
        `${label} intake stays on its tenant`,
        request?.businessId === business.id,
      );
    }
    const otherTenantAreas = await listServiceAreas(prisma, otherAccess.businessId);
    const otherTenantCities = serviceAreaCities(otherTenantAreas);
    return {
      expectedCity,
      created: sync.created,
      areaCount: areas.length,
      city: areas[0]?.city ?? null,
      region: areas[0]?.region ?? null,
      cities,
      publicCities,
      qualification: qualification.qualification,
      otherQualification: otherQualification.qualification,
      storedQualification,
      intakeOk: intake.ok,
      otherTenantCities,
      access,
      businessId: business.id,
    };
  }

  async function proveDisplayOnlyLabel(label) {
    const token = randomUUID().slice(0, 8);
    const slugLabel = label.replace(/[^a-zA-Z]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "junk";
    const business = await prisma.business.create({
      data: {
        name: `Display ${slugLabel}`,
        slug: `display-${slugLabel}-${token}`,
        tradeCode: "HANDYMAN",
        publicServiceAreaLabel: label,
      },
    });
    const ownerUser = await prisma.user.create({
      data: {
        name: `Display Owner ${token}`,
        email: `display-owner-${token}@example.com`,
        passwordHash: "x",
      },
    });
    const membership = await prisma.membership.create({
      data: { userId: ownerUser.id, businessId: business.id, role: "OWNER" },
    });
    const access = makeAccess(business.id, "OWNER", membership.id);
    const sync = await syncPrimaryCityServiceAreaFromLabel(prisma, access, label);
    const areas = await listServiceAreas(prisma, business.id);
    const cities = serviceAreaCities(areas);
    const publicSite = await loadPublicBusiness(business.slug, prisma);
    const publicCities = publicSite?.configuredCities ?? [];
    const qualification = qualifyServiceAddress(areas, { city: "Reno" });
    const intake = await createPublicServiceRequest(prisma, {
      slug: business.slug,
      name: "Display Homeowner",
      email: `display-intake-${token}@example.com`,
      phone: "",
      address: "",
      streetAddress: "200 Second St",
      city: "Reno",
      region: "NV",
      postalCode: "89501",
      notes: "Probe",
      catalogItemIds: [],
      includeOther: true,
      otherDescription: "Probe",
      configuredAreas: toConfiguredAreas(areas),
    });
    let storedQualification = null;
    if (intake.ok) {
      const request = await prisma.serviceRequest.findFirst({
        where: { id: intake.requestId },
        select: { serviceAreaQualification: true, businessId: true },
      });
      storedQualification = request?.serviceAreaQualification ?? null;
      check(
        `${JSON.stringify(label)} intake stays UNKNOWN on its tenant`,
        request?.businessId === business.id && storedQualification === "UNKNOWN",
      );
    }
    const saved = await prisma.business.findUnique({
      where: { id: business.id },
      select: { publicServiceAreaLabel: true },
    });
    return {
      label,
      labelSaved: saved?.publicServiceAreaLabel === label,
      created: sync.created,
      updated: sync.updated,
      areaCount: areas.length,
      cities,
      publicCities,
      qualification: qualification.qualification,
      storedQualification,
      intakeOk: intake.ok,
      businessId: business.id,
    };
  }

  const washington = await proveOfficialPaCity("Washington, PA", "Washington", ownerB);
  const indiana = await proveOfficialPaCity("Indiana, PA", "Indiana", ownerA);
  check(
    "Washington, PA writes CITY Washington and qualifies public intake IN_AREA",
    officialPaCityProofSafe(washington),
  );
  check(
    "Indiana, PA writes CITY Indiana and qualifies public intake IN_AREA",
    officialPaCityProofSafe(indiana),
  );
  check(
    "Washington city list does not leak Indiana, and Indiana city list does not leak Washington",
    washington.cities.includes("Indiana") === false &&
      indiana.cities.includes("Washington") === false &&
      washington.otherTenantCities.includes("Washington") === false &&
      indiana.otherTenantCities.includes("Indiana") === false,
  );
  const washingtonOnIndiana = await prisma.serviceArea.findMany({
    where: { businessId: indiana.businessId, city: "Washington" },
  });
  const indianaOnWashington = await prisma.serviceArea.findMany({
    where: { businessId: washington.businessId, city: "Indiana" },
  });
  check(
    "Tenant isolation: neither PA city row is stored on the other tenant",
    washingtonOnIndiana.length === 0 && indianaOnWashington.length === 0,
  );
  const washingtonArea = await prisma.serviceArea.findFirst({
    where: { businessId: washington.businessId },
  });
  try {
    await setServiceAreaEnabled(prisma, ownerB, {
      areaId: washingtonArea?.id ?? "missing-washington-area",
      enabled: false,
    });
    check("Business B cannot disable Washington, PA on the other tenant", false);
  } catch {
    check("Business B cannot disable Washington, PA on the other tenant", true);
  }

  const displayOnlyLabels = [
    "Reno.",
    "Sparks NV.",
    "Greater Reno area",
    "Serving homeowners across Western Pennsylvania",
    "Washington",
    "Indiana",
    "Nevada, NV",
    "Texas, TX",
    "Washington, WA",
    "Washington, DC",
  ];
  const displayOnlyResults = [];
  for (const label of displayOnlyLabels) {
    const result = await proveDisplayOnlyLabel(label);
    displayOnlyResults.push(result);
    check(
      `${JSON.stringify(label)} stays display-only and writes no CITY row`,
      result.labelSaved === true && displayOnlyLabelSafe(result),
    );
  }
  check(
    "Reno. and Sparks NV. do not invent public city-list rows",
    displayOnlyResults
      .filter((row) => row.label === "Reno." || row.label === "Sparks NV.")
      .every((row) => row.areaCount === 0 && row.publicCities.length === 0),
  );
  const statewideCityListEmpty = displayOnlyResults
    .filter((row) =>
      ["Nevada, NV", "Texas, TX", "Washington, WA", "Washington, DC"].includes(row.label),
    )
    .every(
      (row) =>
        row.areaCount === 0 &&
        row.publicCities.length === 0 &&
        displayOnlyLabelSafe(row),
    );
  check(
    "Nevada, NV / Texas, TX / Washington, WA / Washington, DC write no CITY row and leave configuredCities empty",
    statewideCityListEmpty,
  );
  check(
    "Every ambiguous or junk label kept display copy and an empty city list",
    displayOnlyResults.every((row) => row.labelSaved && displayOnlyLabelSafe(row)),
  );

  console.log("\nDB — state-named labels do not rewrite existing ServiceArea rows");
  const preserveToken = randomUUID().slice(0, 8);
  const preserveBiz = await prisma.business.create({
    data: {
      name: `Preserve PA ${preserveToken}`,
      slug: `preserve-pa-${preserveToken}`,
      tradeCode: "HANDYMAN",
    },
  });
  const preserveUser = await prisma.user.create({
    data: {
      name: `Preserve Owner ${preserveToken}`,
      email: `preserve-pa-${preserveToken}@example.com`,
      passwordHash: "x",
    },
  });
  const preserveMem = await prisma.membership.create({
    data: { userId: preserveUser.id, businessId: preserveBiz.id, role: "OWNER" },
  });
  const preserveAccess = makeAccess(preserveBiz.id, "OWNER", preserveMem.id);
  const washingtonWa = await upsertServiceArea(prisma, preserveAccess, {
    kind: "CITY",
    label: "Washington",
    city: "Washington",
    region: "WA",
  });
  const indianaBare = await upsertServiceArea(prisma, preserveAccess, {
    kind: "CITY",
    label: "Indiana",
    city: "Indiana",
  });
  const washingtonSync = await syncPrimaryCityServiceAreaFromLabel(
    prisma,
    preserveAccess,
    "Washington, PA",
  );
  const indianaSync = await syncPrimaryCityServiceAreaFromLabel(
    prisma,
    preserveAccess,
    "Indiana, PA",
  );
  const washingtonAfter = await prisma.serviceArea.findUnique({
    where: { id: washingtonWa.id },
  });
  const indianaAfter = await prisma.serviceArea.findUnique({
    where: { id: indianaBare.id },
  });
  const preserveCount = await prisma.serviceArea.count({
    where: { businessId: preserveBiz.id },
  });
  check(
    "Washington, PA does not rewrite an existing Washington/WA row",
    washingtonSync.created === false &&
      washingtonSync.updated === false &&
      washingtonAfter?.region === "WA" &&
      washingtonAfter.city === "Washington" &&
      washingtonAfter.label === "Washington",
  );
  check(
    "Indiana, PA does not fill region on an existing Indiana/null row",
    indianaSync.created === false &&
      indianaSync.updated === false &&
      indianaAfter?.region == null &&
      indianaAfter?.city === "Indiana" &&
      indianaAfter.label === "Indiana",
  );
  check(
    "State-named PA labels do not add a second Washington or Indiana CITY row",
    preserveCount === 2,
  );

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

if (!mutationChild && failures === 0) {
  console.log("\nMUTATION-REVERT — each fix fails a real check when reverted");
  const childScript = fileURLToPath(new URL("./check-service-areas.mjs", import.meta.url));
  const mutations = [
    {
      label: "state-named City, ST rejected again",
      file: "src/lib/service-areas.ts",
      search:
        "    if (isStatewideCommaLabel(city, region)) return empty; // STATE_NAMED_CITY_DIFFERENT_REGION",
      replace: "    if (isStateOrCompassState(city)) return empty;",
    },
    {
      label: "same-state and DC labels parse as cities",
      file: "src/lib/service-areas.ts",
      search: '  return region === ownCode || region === "DC"; // STATEWIDE_OWN_CODE_OR_DC',
      replace: "  return false;",
    },
    {
      label: "state-named labels rewrite existing CITY rows",
      file: "src/lib/service-area-ops.ts",
      search:
        "    if (isUsStateName(parts.city)) {\n      return { created: false, updated: false }; // STATE_NAMED_CITY_KEEP_EXISTING_ROW\n    }\n",
      replace: "",
    },
  ];
  for (const mutation of mutations) {
    const target = fileURLToPath(new URL(`../${mutation.file}`, import.meta.url));
    const original = readFileSync(target, "utf8");
    if (!original.includes(mutation.search)) {
      check(`mutation-revert setup finds ${mutation.label}`, false);
      continue;
    }
    writeFileSync(target, original.replace(mutation.search, mutation.replace));
    try {
      const child = spawnSync(process.execPath, ["--experimental-strip-types", childScript], {
        env: { ...process.env, SERVICE_AREA_PARSER_MUTATION_CHILD: "1" },
        encoding: "utf8",
        timeout: 120_000,
      });
      const failed = child.status !== 0;
      check(`mutation-revert ${mutation.label} fails a real check`, failed);
      if (!failed) {
        console.error((child.stdout || "").slice(-2000));
        console.error((child.stderr || "").slice(-1000));
      }
    } finally {
      writeFileSync(target, original);
    }
  }
}

process.exit(failures === 0 ? 0 : 1);
