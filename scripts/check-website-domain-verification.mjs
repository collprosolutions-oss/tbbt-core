/**
 * Read-only website domain verification proofs.
 *
 * Covers OWNER-only visibility, fake DNS ownership checks, Pending when
 * verification cannot be completed, no connected claim from typed website
 * text, and tenant isolation for sitemap/site serving.
 *
 * Run with:
 *   npm run test:website-domain-verification
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const { activateBusinessTradeOp } = await import("@/lib/business-trades");
const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const { ForbiddenError } = await import("@/lib/authorization");
const { loadGoLiveCenter } = await import("@/lib/go-live-data");
const { classifyCustomDomain, goLiveCardById } = await import("@/lib/go-live");
const {
  WEBSITE_DOMAIN_DNS_CNAME_TARGET,
  buildPublicSitemap,
  loadWebsiteDomainVerification,
  publishWebsite,
  resetWebsiteDomainDnsLookup,
  resolvePublicHost,
  resolvePublicRoot,
  setWebsiteDomainDnsLookup,
  verifyConfiguredWebsiteDomain,
  verifyHostnameForBusiness,
} = await import("@/lib/website-engine");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run the website domain verification check.");
  process.exit(1);
}

const testDbName = "tbbt_website_domain_verification_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) process.exit(push.status ?? 1);

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

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

function makeAccess(businessId, membershipId, role = "OWNER") {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      business: { id: businessId },
    },
    scope: businessScope(businessId),
    assertOwned(record) {
      return assertBusinessRecord(record, businessId);
    },
  };
}

async function expectError(label, fn, predicate) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

function pointingDns() {
  return { cnames: [WEBSITE_DOMAIN_DNS_CNAME_TARGET], addresses: [] };
}

function timeoutError() {
  const error = new Error("DNS timed out");
  error.code = "ETIMEOUT";
  return error;
}

console.log("\nSTATIC — Domain verification stays read-only");
const verificationSrc = read("src/lib/website-engine/domain-verification.ts");
const hostsSrc = read("src/lib/website-engine/hosts.ts");
const sitemapSrc = read("src/lib/website-engine/sitemap.ts");
const settingsPage = read("src/app/(app)/settings/page.tsx");
const settingsWorkspace = read("src/components/settings/settings-workspace.tsx");
const goLiveData = read("src/lib/go-live-data.ts");
check(
  "Verification never writes DNS, publish, or stored VERIFIED from text",
  verificationSrc.includes("Never writes DNS") &&
    verificationSrc.includes("never publishes") &&
    !verificationSrc.includes("status: \"VERIFIED\"") &&
    !verificationSrc.includes("publishWebsite(") &&
    !verificationSrc.includes("websiteHostBinding.update") &&
    !verificationSrc.includes("websiteHostBinding.create"),
);
check(
  "OWNER settings and go-live read the live verification",
  settingsPage.includes("loadWebsiteDomainVerification") &&
    settingsPage.includes('role === "OWNER"') &&
    settingsWorkspace.includes("WebsiteDomainVerificationCard") &&
    goLiveData.includes("verifyConfiguredWebsiteDomain") &&
    goLiveData.includes("goLiveDomainFromVerification"),
);
check(
  "Unknown and other-tenant hosts fail closed before sitemap/site",
  hostsSrc.includes("verifyHostnameForBusiness") &&
    sitemapSrc.includes("view.site.business.id !== resolved.businessId") &&
    sitemapSrc.includes("return []"),
);
check(
  "Pending is a first-class verification state",
  classifyCustomDomain({
    verifiedHostname: null,
    unverifiedHostname: null,
    failedHostname: null,
    pendingHostname: "pending.example.test",
  }) === "PARTIAL",
);

try {
  console.log("\nLIVE — Fake DNS, isolation, Pending, OWNER gate");
  const userA = await prisma.user.create({
    data: { name: "Owner A", email: `dv-a-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const userB = await prisma.user.create({
    data: { name: "Owner B", email: `dv-b-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Admin A", email: `dv-admin-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Member A", email: `dv-mem-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Verify",
      slug: `alpha-dv-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      publicWebsite: "https://typed-only.example.test",
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Verify",
      slug: `beta-dv-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      publicWebsite: "https://beta-typed.example.test",
    },
  });
  const memA = await prisma.membership.create({
    data: { userId: userA.id, businessId: businessA.id, role: "OWNER" },
  });
  const memB = await prisma.membership.create({
    data: { userId: userB.id, businessId: businessB.id, role: "OWNER" },
  });
  const adminA = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: businessA.id, role: "ADMIN" },
  });
  const memberA = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const accessA = makeAccess(businessA.id, memA.id, "OWNER");
  const accessB = makeAccess(businessB.id, memB.id, "OWNER");
  const accessAdmin = makeAccess(businessA.id, adminA.id, "ADMIN");
  const accessMember = makeAccess(businessA.id, memberA.id, "MEMBER");

  await activateBusinessTradeOp(prisma, accessA, "HANDYMAN");
  await activateBusinessTradeOp(prisma, accessB, "HANDYMAN");
  await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "TV Mounting",
      category: "Mounting",
      tradeCode: "HANDYMAN",
      active: true,
    },
  });
  await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessB.id,
      name: "Fence Repair",
      category: "Outdoor",
      tradeCode: "HANDYMAN",
      active: true,
    },
  });
  await publishWebsite(prisma, accessA, { idempotencyKey: "dv-a-pub" });
  await publishWebsite(prisma, accessB, { idempotencyKey: "dv-b-pub" });

  const hostA = `alpha-${randomUUID().slice(0, 8)}.example.test`;
  const hostB = `beta-${randomUUID().slice(0, 8)}.example.test`;
  const hostUnknown = `nobody-${randomUUID().slice(0, 8)}.example.test`;
  await prisma.websiteHostBinding.create({
    data: { businessId: businessA.id, hostname: hostA, status: "UNVERIFIED" },
  });
  await prisma.websiteHostBinding.create({
    data: { businessId: businessB.id, hostname: hostB, status: "VERIFIED" },
  });

  const beforeDns = await verifyConfiguredWebsiteDomain(prisma, businessA.id);
  check(
    "Typed website URL alone is never verified",
    beforeDns.enteredWebsiteHostname === "typed-only.example.test" &&
      beforeDns.hostname === hostA &&
      beforeDns.state !== "VERIFIED",
  );

  setWebsiteDomainDnsLookup(async (hostname) => {
    if (hostname === hostA || hostname === hostB) return pointingDns();
    if (hostname === hostUnknown) return { cnames: [], addresses: [] };
    throw timeoutError();
  });

  const matchedUnverified = await verifyConfiguredWebsiteDomain(prisma, businessA.id);
  check(
    "Matching DNS does not claim connected while the binding is still UNVERIFIED",
    matchedUnverified.state === "UNVERIFIED" &&
      matchedUnverified.hostname === hostA &&
      matchedUnverified.publishedSite === true &&
      matchedUnverified.readOnly === true,
  );
  check(
    "Verification does not persist VERIFIED from a successful DNS read",
    (await prisma.websiteHostBinding.findFirst({ where: { hostname: hostA } }))?.status ===
      "UNVERIFIED",
  );
  await prisma.websiteHostBinding.update({
    where: { hostname: hostA },
    data: { status: "VERIFIED" },
  });
  const verifiedA = await verifyConfiguredWebsiteDomain(prisma, businessA.id);
  check(
    "Matching fake DNS plus published site verifies A",
    verifiedA.state === "VERIFIED" &&
      verifiedA.label === "Verified" &&
      verifiedA.hostname === hostA &&
      verifiedA.publishedSite === true &&
      verifiedA.readOnly === true,
  );

  setWebsiteDomainDnsLookup(async () => {
    throw timeoutError();
  });
  const pendingA = await verifyConfiguredWebsiteDomain(prisma, businessA.id);
  check(
    "DNS timeout is Pending and never connected",
    pendingA.state === "PENDING" &&
      pendingA.label === "Pending" &&
      pendingA.hostname === hostA &&
      pendingA.detail.includes("Pending"),
  );

  setWebsiteDomainDnsLookup(async () => ({
    cnames: [],
    addresses: ["203.0.113.10"],
  }));
  const pendingAOnly = await verifyConfiguredWebsiteDomain(prisma, businessA.id);
  check(
    "A-only records cannot complete verification",
    pendingAOnly.state === "PENDING",
  );

  setWebsiteDomainDnsLookup(async () => ({
    cnames: ["other-tenant.example.net"],
    addresses: [],
  }));
  const failedA = await verifyConfiguredWebsiteDomain(prisma, businessA.id);
  check(
    "Wrong CNAME fails verification for A",
    failedA.state === "FAILED" && failedA.hostname === hostA,
  );

  setWebsiteDomainDnsLookup(async (hostname) => {
    if (hostname === hostA || hostname === hostB) return pointingDns();
    return { cnames: [], addresses: [] };
  });
  const otherTenant = await verifyHostnameForBusiness(prisma, businessA.id, hostB);
  check(
    "Another tenant host cannot verify as A",
    otherTenant.state === "FAILED" &&
      otherTenant.bindingBusinessId === businessB.id &&
      otherTenant.detail.includes("another business"),
  );
  const unknownHost = await verifyHostnameForBusiness(prisma, businessA.id, hostUnknown);
  check(
    "Unknown host cannot verify as A",
    unknownHost.state === "FAILED" && unknownHost.bindingBusinessId === null,
  );

  await expectError(
    "ADMIN cannot load OWNER domain verification",
    () => loadWebsiteDomainVerification(prisma, accessAdmin),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot load OWNER domain verification",
    () => loadWebsiteDomainVerification(prisma, accessMember),
    (error) => error instanceof ForbiddenError,
  );
  const ownerView = await loadWebsiteDomainVerification(prisma, accessA);
  check(
    "OWNER can read verification for the same business only",
    ownerView.hostname === hostA && ownerView.state === "VERIFIED",
  );
  await expectError(
    "Mismatched workspace business cannot load verification",
    () =>
      loadWebsiteDomainVerification(prisma, {
        businessId: businessA.id,
        workspace: { role: "OWNER", business: { id: businessB.id } },
      }),
    (error) => error instanceof ForbiddenError,
  );

  const goLiveA = await loadGoLiveCenter(prisma, accessA);
  const goLiveB = await loadGoLiveCenter(prisma, accessB);
  check(
    "Go-live A is LIVE only after DNS + published site",
    goLiveCardById(goLiveA, "custom_domain")?.status === "LIVE" &&
      JSON.stringify(goLiveA).includes(hostA) &&
      !JSON.stringify(goLiveA).includes(hostB),
  );
  check(
    "Go-live B stays tenant-isolated",
    goLiveCardById(goLiveB, "custom_domain")?.status === "LIVE" &&
      JSON.stringify(goLiveB).includes(hostB) &&
      !JSON.stringify(goLiveB).includes(hostA),
  );

  setWebsiteDomainDnsLookup(async () => {
    throw timeoutError();
  });
  const pendingGoLive = await loadGoLiveCenter(prisma, accessA);
  check(
    "Go-live shows Pending when DNS cannot complete",
    goLiveCardById(pendingGoLive, "custom_domain")?.status === "PARTIAL" &&
      /Pending/.test(goLiveCardById(pendingGoLive, "custom_domain")?.currentState ?? ""),
  );

  setWebsiteDomainDnsLookup(async (hostname) => {
    if (hostname === hostA || hostname === hostB) return pointingDns();
    return { cnames: [], addresses: [] };
  });
  const serveA = await resolvePublicHost(prisma, hostA);
  const serveB = await resolvePublicHost(prisma, hostB);
  const serveUnknown = await resolvePublicHost(prisma, hostUnknown);
  const serveBAsA = await verifyHostnameForBusiness(prisma, businessA.id, hostB);
  check(
    "Verified host A serves only tenant A",
    serveA.kind === "tenant" && serveA.businessId === businessA.id && serveA.slug === businessA.slug,
  );
  check(
    "Verified host B serves only tenant B",
    serveB.kind === "tenant" && serveB.businessId === businessB.id && serveB.slug === businessB.slug,
  );
  check("Unknown host never serves a site", serveUnknown.kind === "unknown");
  check("Host B cannot be treated as A's published site", serveBAsA.state === "FAILED");

  const sitemapA = await buildPublicSitemap(prisma, hostA);
  const sitemapB = await buildPublicSitemap(prisma, hostB);
  const sitemapUnknown = await buildPublicSitemap(prisma, hostUnknown);
  check(
    "Sitemap A stays on host A and omits tenant B",
    sitemapA.length > 0 &&
      sitemapA.every((entry) => entry.url.startsWith(`https://${hostA}`)) &&
      !sitemapA.some((entry) => entry.url.includes(hostB) || entry.url.includes(businessB.slug)),
  );
  check(
    "Sitemap B stays on host B and omits tenant A",
    sitemapB.length > 0 &&
      sitemapB.every((entry) => entry.url.startsWith(`https://${hostB}`)) &&
      !sitemapB.some((entry) => entry.url.includes(hostA) || entry.url.includes(businessA.slug)),
  );
  check("Unknown host sitemap is empty", sitemapUnknown.length === 0);

  setWebsiteDomainDnsLookup(async () => {
    throw timeoutError();
  });
  const pendingRoot = await resolvePublicRoot(prisma, hostA);
  const pendingSitemap = await buildPublicSitemap(prisma, hostA);
  check(
    "Pending DNS never serves the tenant site or sitemap",
    pendingRoot.kind === "unknown" && pendingSitemap.length === 0,
  );

  const bindingCount = await prisma.websiteHostBinding.count();
  const publishCount = await prisma.websitePublish.count();
  await verifyConfiguredWebsiteDomain(prisma, businessA.id);
  await loadWebsiteDomainVerification(prisma, accessA);
  check(
    "Read-only verification does not create bindings or publishes",
    (await prisma.websiteHostBinding.count()) === bindingCount &&
      (await prisma.websitePublish.count()) === publishCount,
  );
} catch (error) {
  failed += 1;
  console.error("FAIL - website domain verification live suite", error);
} finally {
  resetWebsiteDomainDnsLookup();
  await prisma.$disconnect();
}

console.log(
  failed === 0
    ? `\nAll website-domain-verification checks passed (${passed}).`
    : `\n${failed} website-domain-verification check(s) failed (${passed} passed).`,
);
process.exit(failed === 0 ? 0 : 1);
