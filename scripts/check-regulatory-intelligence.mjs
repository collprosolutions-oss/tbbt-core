/**
 * Regulatory intelligence read-only slice: unknown/stale handling,
 * authorization, and tenant isolation on a dedicated test database.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-regulatory-intelligence.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError, canAccessManagementConsole } = await import("@/lib/authorization");
const { visibleAppNav } = await import("@/lib/nav");
const {
  DOES_NOT_GATE_WORK_MESSAGE,
  NEVER_CERTIFIES_LICENSE_MESSAGE,
  NEVER_DECLARES_COMPLIANCE_MESSAGE,
  NO_NATIONWIDE_COVERAGE_MESSAGE,
  REGULATORY_FRESHNESS_DAYS,
  classifyRegulatoryNote,
  claimsNationwideCoverage,
  parseRegulatoryLookupQuery,
  resolveRegulatoryLookup,
  shouldGateEstimatesOrJobs,
} = await import("@/lib/regulatory-intelligence");
const {
  FLORIDA_DBPR_CONSTRUCTION_FAQ_URL,
  FLORIDA_STATUTE_489_103_URL,
  LEE_COUNTY_CONTRACTOR_LICENSING_URL,
  LEE_COUNTY_HANDYMAN_CITATION,
  LEE_COUNTY_HANDYMAN_JURISDICTION_CODE,
  LEE_COUNTY_HANDYMAN_TRADE_CODE,
  LEE_COUNTY_ORDINANCE_23_09_URL,
  leeCountyHandymanCatalogNote,
} = await import("@/lib/regulatory-intelligence-catalog");
const { loadRegulatoryIntelligence } = await import("@/lib/regulatory-intelligence-data");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_regulatory_intelligence_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for regulatory-intelligence test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  ok  - ${label}`);
  else {
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

function makeAccess(businessId, role) {
  return {
    businessId,
    workspace: { role, membership: { id: `mem-${role}-${businessId}` } },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

function readRepo(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const now = new Date("2026-09-27T12:00:00.000Z");
const catalog = leeCountyHandymanCatalogNote();

try {
  console.log("\nSTATIC — Regulatory intelligence domain and limits");
  check("Freshness window is 180 days", REGULATORY_FRESHNESS_DAYS === 180);
  check("Never-certifies copy is honest", NEVER_CERTIFIES_LICENSE_MESSAGE.includes("never certifies"));
  check("Never-compliance copy is honest", NEVER_DECLARES_COMPLIANCE_MESSAGE.includes("never declares"));
  check("No nationwide coverage copy is honest", NO_NATIONWIDE_COVERAGE_MESSAGE.includes("does not claim nationwide"));
  check("Does not gate work copy is honest", DOES_NOT_GATE_WORK_MESSAGE.includes("does not gate"));
  check("Nationwide coverage claim is false", claimsNationwideCoverage() === false);
  check("Gate helper is always false for UNKNOWN", shouldGateEstimatesOrJobs("UNKNOWN") === false);
  check("Gate helper is always false for STALE", shouldGateEstimatesOrJobs("STALE") === false);
  check("Gate helper is always false for CONFLICT", shouldGateEstimatesOrJobs("CONFLICT") === false);
  check("Gate helper is always false for CURRENT", shouldGateEstimatesOrJobs("CURRENT") === false);

  const missing = classifyRegulatoryNote({
    ...catalog,
    officialSourceUrl: "",
    retrievedAt: null,
  }, now);
  check("Missing official source/retrieval is UNKNOWN", missing === "UNKNOWN");

  const staleRetrieved = classifyRegulatoryNote({
    ...catalog,
    retrievedAt: new Date("2025-12-01T00:00:00.000Z"),
  }, now);
  check("Retrieval older than 180 days is STALE", staleRetrieved === "STALE");

  const staleExpiry = classifyRegulatoryNote({
    ...catalog,
    expiresOn: new Date("2026-09-26T00:00:00.000Z"),
  }, now);
  check("Past expiry date is STALE", staleExpiry === "STALE");

  check("Catalog example classifies CURRENT on retrieval day", classifyRegulatoryNote(catalog, now) === "CURRENT");

  const unknownLookup = resolveRegulatoryLookup([], now);
  check("Empty lookup is UNKNOWN", unknownLookup.state === "UNKNOWN");
  check("Empty lookup does not certify", unknownLookup.certifiesLicense === false);
  check("Empty lookup does not declare compliance", unknownLookup.declaresLegalCompliance === false);
  check("Empty lookup does not gate estimates", unknownLookup.gatesEstimates === false);
  check("Empty lookup does not gate jobs", unknownLookup.gatesJobs === false);

  const staleLookup = resolveRegulatoryLookup([{
    ...catalog,
    retrievedAt: new Date("2025-01-01T00:00:00.000Z"),
  }], now);
  check("Stale lookup stays STALE", staleLookup.state === "STALE");
  check("Stale lookup never certifies", staleLookup.certifiesLicense === false && staleLookup.declaresLegalCompliance === false);

  const conflictLookup = resolveRegulatoryLookup([
    catalog,
    { ...catalog, officialSourceUrl: "https://example.com/not-official", citation: "Different citation" },
  ], now);
  check("Disagreeing sources are CONFLICT", conflictLookup.state === "CONFLICT");
  check("Conflict never certifies", conflictLookup.certifiesLicense === false);

  const currentLookup = resolveRegulatoryLookup([catalog], now);
  check("Current lookup is CURRENT", currentLookup.state === "CURRENT");
  check("Current lookup still does not certify a license", currentLookup.certifiesLicense === false);
  check("Current lookup still does not declare compliance", currentLookup.declaresLegalCompliance === false);
  check("Current lookup still does not claim nationwide coverage", currentLookup.claimsNationwideCoverage === false);

  check(
    "Catalog citation retains Lee County Contractor Licensing URL",
    LEE_COUNTY_HANDYMAN_CITATION.includes(LEE_COUNTY_CONTRACTOR_LICENSING_URL),
  );
  check("Catalog citation retains Ordinance 23-09 URL", LEE_COUNTY_HANDYMAN_CITATION.includes(LEE_COUNTY_ORDINANCE_23_09_URL));
  check("Catalog citation retains Florida § 489.103 URL", LEE_COUNTY_HANDYMAN_CITATION.includes(FLORIDA_STATUTE_489_103_URL));
  check("Catalog citation retains DBPR FAQ URL", LEE_COUNTY_HANDYMAN_CITATION.includes(FLORIDA_DBPR_CONSTRUCTION_FAQ_URL));
  check("Catalog jurisdiction is US-FL-LEE", catalog.jurisdictionCode === LEE_COUNTY_HANDYMAN_JURISDICTION_CODE);
  check("Catalog trade is HANDYMAN", catalog.tradeCode === LEE_COUNTY_HANDYMAN_TRADE_CODE);
  check(
    "Ordinance geographic scope uses official unincorporated contracting language",
    catalog.summary.includes("performing work or contracting to perform work within unincorporated Lee County"),
  );
  check(
    "Statute § 489.103(9) uses less than $2,500 aggregate contract price wording",
    catalog.summary.includes("aggregate contract price for labor, materials, and all other items is less than $2,500") &&
      !catalog.summary.includes("under a $2,500 aggregate contract price"),
  );
  check(
    "Statute § 489.103(9) keeps the larger-or-major and advertising exceptions",
    catalog.summary.includes("larger or major operation") &&
      catalog.summary.includes("otherwise represents that he or she is qualified to engage in contracting"),
  );
  check(
    "DCD page wording oversees eligibility and compliance rather than administering a license",
    catalog.summary.includes("oversees contractor eligibility and compliance within the county"),
  );
  check(
    "DBPR FAQ is labeled as not the statute",
    catalog.summary.includes("The Florida DBPR Construction Industry FAQ is not the statute"),
  );
  const pageSource = readRepo("src/app/(app)/regulatory-intelligence/page.tsx");
  const workspaceSource = readRepo("src/components/regulatory-intelligence/workspace.tsx");
  check(
    "Page stays a GET lookup, not a write form",
    workspaceSource.includes('method="get"') &&
      !workspaceSource.includes('method="post"') &&
      !pageSource.includes("createRegulatory") &&
      !pageSource.includes("use server"),
  );
  check(
    "Page copy refuses license or compliance determination",
    pageSource.includes("not a license or compliance determination") &&
      workspaceSource.includes("Certifies license: no. Declares legal compliance: no."),
  );

  check("OWNER can access management console", canAccessManagementConsole("OWNER") === true);
  check("ADMIN can access management console", canAccessManagementConsole("ADMIN") === true);
  check("MEMBER cannot access management console", canAccessManagementConsole("MEMBER") === false);
  check(
    "Regulatory intelligence is not in global OWNER nav",
    !visibleAppNav("OWNER").some((item) => item.href === "/regulatory-intelligence"),
  );
  check(
    "Regulatory intelligence is not in global ADMIN nav",
    !visibleAppNav("ADMIN").some((item) => item.href === "/regulatory-intelligence"),
  );
  check(
    "Regulatory intelligence is not in global MEMBER nav",
    !visibleAppNav("MEMBER").some((item) => item.href === "/regulatory-intelligence"),
  );

  const navSource = readRepo("src/lib/nav.ts");
  check("nav.ts was not given a regulatory-intelligence href", !navSource.includes("/regulatory-intelligence"));
  const estimateActions = readRepo("src/app/actions/estimate.ts");
  const jobActions = readRepo("src/app/actions/job.ts");
  check("Estimate actions do not import regulatory intelligence", !estimateActions.includes("regulatory-intelligence"));
  check("Job actions do not import regulatory intelligence", !jobActions.includes("regulatory-intelligence"));

  const parsedLookup = parseRegulatoryLookupQuery({ jurisdiction: "us-fl-lee", trade: "handyman" });
  check("Lookup query normalizes jurisdiction", parsedLookup.jurisdictionCode === "US-FL-LEE");
  check("Lookup query normalizes trade", parsedLookup.tradeCode === "HANDYMAN");

  console.log("\nTEST — Dedicated database isolation, authorization, unknown/stale");
  const businessA = await prisma.business.create({
    data: { name: "Alpha Regulatory", slug: `alpha-reg-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Regulatory", slug: `beta-reg-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const ownerA = makeAccess(businessA.id, "OWNER");
  const adminA = makeAccess(businessA.id, "ADMIN");
  const memberA = makeAccess(businessA.id, "MEMBER");
  const ownerB = makeAccess(businessB.id, "OWNER");

  const tenantNoteA = await prisma.regulatoryIntelligenceNote.create({
    data: {
      businessId: businessA.id,
      jurisdictionCode: LEE_COUNTY_HANDYMAN_JURISDICTION_CODE,
      jurisdictionLabel: catalog.jurisdictionLabel,
      tradeCode: LEE_COUNTY_HANDYMAN_TRADE_CODE,
      officialSourceUrl: catalog.officialSourceUrl,
      officialSourceTitle: catalog.officialSourceTitle,
      citation: catalog.citation,
      retrievedAt: catalog.retrievedAt,
      effectiveOn: catalog.effectiveOn,
      expiresOn: null,
      recordedState: "CURRENT",
      summary: catalog.summary,
    },
  });
  const secretNoteB = await prisma.regulatoryIntelligenceNote.create({
    data: {
      businessId: businessB.id,
      jurisdictionCode: "US-FL-LEE",
      jurisdictionLabel: "Beta-only secret jurisdiction note",
      tradeCode: "HANDYMAN",
      officialSourceUrl: "https://beta.example.invalid/secret",
      officialSourceTitle: "Beta Secret Source",
      citation: "Beta secret citation must never leak",
      retrievedAt: now,
      recordedState: "CURRENT",
      summary: "Tenant B private regulatory note",
    },
  });
  const unknownNoteA = await prisma.regulatoryIntelligenceNote.create({
    data: {
      businessId: businessA.id,
      jurisdictionCode: "US-CA-LA",
      jurisdictionLabel: "Los Angeles County, California",
      tradeCode: "HANDYMAN",
      officialSourceUrl: "https://unknown.example.invalid",
      officialSourceTitle: "Incomplete note",
      citation: "",
      retrievedAt: now,
      recordedState: "UNKNOWN",
      summary: "Missing nationwide research",
    },
  });
  const staleNoteA = await prisma.regulatoryIntelligenceNote.create({
    data: {
      businessId: businessA.id,
      jurisdictionCode: "US-FL-MIA",
      jurisdictionLabel: "Miami-Dade County, Florida",
      tradeCode: "HANDYMAN",
      officialSourceUrl: "https://www.miamidade.gov/example",
      officialSourceTitle: "Stale Miami-Dade example",
      citation: "Stale recorded citation",
      retrievedAt: new Date("2025-01-01T00:00:00.000Z"),
      expiresOn: new Date("2026-01-01T00:00:00.000Z"),
      recordedState: "CURRENT",
      summary: "Old retrieval must classify STALE",
    },
  });

  const loadedA = await loadRegulatoryIntelligence(
    prisma,
    ownerA,
    { jurisdiction: "US-FL-LEE", trade: "HANDYMAN" },
    now,
  );
  check("Owner A sees tenant A's Lee County note", loadedA.tenantNotes.some((row) => row.id === tenantNoteA.id));
  check("Owner A does not see tenant B's note", !loadedA.tenantNotes.some((row) => row.id === secretNoteB.id));
  check("Owner A catalog citation is retained", loadedA.catalogExample.citation.includes(LEE_COUNTY_CONTRACTOR_LICENSING_URL));
  check("Lee County lookup is CURRENT and still uncertified", loadedA.decision.state === "CURRENT" && loadedA.decision.certifiesLicense === false);
  check("Lee County lookup does not declare compliance", loadedA.decision.declaresLegalCompliance === false);
  check("Lee County lookup does not gate work", loadedA.decision.gatesEstimates === false && loadedA.decision.gatesJobs === false);

  const loadedAdmin = await loadRegulatoryIntelligence(
    prisma,
    adminA,
    { jurisdiction: "US-FL-LEE", trade: "HANDYMAN" },
    now,
  );
  check("Admin A can read the same tenant-scoped notes", loadedAdmin.tenantNotes.some((row) => row.id === tenantNoteA.id));

  await expectError(
    "MEMBER cannot read regulatory intelligence",
    () => loadRegulatoryIntelligence(prisma, memberA, { jurisdiction: "US-FL-LEE", trade: "HANDYMAN" }, now),
    (error) => error instanceof ForbiddenError,
  );

  const loadedB = await loadRegulatoryIntelligence(
    prisma,
    ownerB,
    { jurisdiction: "US-FL-LEE", trade: "HANDYMAN" },
    now,
  );
  check("Owner B does not see tenant A's note", !loadedB.tenantNotes.some((row) => row.id === tenantNoteA.id));
  check("Owner B sees only B's tenant note", loadedB.tenantNotes.length === 1 && loadedB.tenantNotes[0].id === secretNoteB.id);
  check("Owner B payload does not include A's citation text", !JSON.stringify(loadedB.tenantNotes).includes(tenantNoteA.citation.slice(0, 40)));

  const unknownLookupLoaded = await loadRegulatoryIntelligence(
    prisma,
    ownerA,
    { jurisdiction: "US-NY-NYC", trade: "PLUMBING" },
    now,
  );
  check("Unresearched jurisdiction/trade is UNKNOWN", unknownLookupLoaded.decision.state === "UNKNOWN");
  check("UNKNOWN lookup never certifies", unknownLookupLoaded.decision.certifiesLicense === false);
  check("UNKNOWN recorded CA note stays UNKNOWN", unknownLookupLoaded.tenantNotes.some((row) => row.id === unknownNoteA.id && row.classifiedState === "UNKNOWN"));

  const staleLookupLoaded = await loadRegulatoryIntelligence(
    prisma,
    ownerA,
    { jurisdiction: "US-FL-MIA", trade: "HANDYMAN" },
    now,
  );
  check("Stale Miami-Dade note classifies STALE", staleLookupLoaded.matchingNotes.some((row) => row.id === staleNoteA.id && row.classifiedState === "STALE"));
  check("Stale lookup never certifies", staleLookupLoaded.decision.state === "STALE" && staleLookupLoaded.decision.certifiesLicense === false);

  const estimateAfterUnknown = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      status: "DRAFT",
      total: new Prisma.Decimal(250),
      publicToken: randomUUID(),
    },
  });
  const jobAfterStale = await prisma.job.create({
    data: {
      businessId: businessA.id,
      status: "UNSCHEDULED",
      projectToken: randomUUID(),
    },
  });
  check("UNKNOWN/STALE notes did not block estimate create", estimateAfterUnknown.id.length > 0);
  check("UNKNOWN/STALE notes did not block job create", jobAfterStale.id.length > 0);
  check(
    "Created estimate is isolated to business A",
    estimateAfterUnknown.businessId === businessA.id,
  );
  check(
    "Created job is isolated to business A",
    jobAfterStale.businessId === businessA.id,
  );

  const stillA = await prisma.regulatoryIntelligenceNote.findMany({ where: { businessId: businessA.id } });
  const stillB = await prisma.regulatoryIntelligenceNote.findMany({ where: { businessId: businessB.id } });
  check("Tenant A still has three notes", stillA.length === 3);
  check("Tenant B still has one note", stillB.length === 1);
  check("Cross-tenant findMany stays isolated", stillB.every((row) => row.businessId === businessB.id));

  console.log(
    failures === 0
      ? "\nAll regulatory intelligence checks passed."
      : `\n${failures} regulatory intelligence check(s) failed.`,
  );
} finally {
  await prisma.$disconnect();
}

process.exit(failures === 0 ? 0 : 1);
