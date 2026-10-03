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
  WEBSITE_DOMAIN_DNS_LOOKUP_TIMEOUT_MS,
  WEBSITE_DOMAIN_VERCEL_A_ADDRESSES,
  websiteDomainApexATargetsLabel,
  buildPublicSitemap,
  defaultWebsiteDomainDnsLookup,
  dnsRecordsPointAtTbbt,
  getWebsiteDomainDnsLookup,
  isVercelApexAddress,
  isVercelDnsCname,
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
const settingsCard = read("src/components/settings/website-domain-verification.tsx");
const goLiveData = read("src/lib/go-live-data.ts");
const readme = read("README.md");
const certification = read("docs/PRODUCTION_CERTIFICATION.md");
check(
  "Verification never writes DNS, publish, or stored VERIFIED from text",
  verificationSrc.includes("Never writes DNS") &&
    verificationSrc.includes("never treats a typed publicWebsite URL as connected") &&
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
    goLiveData.includes("websiteHostBinding.findMany") &&
    goLiveData.includes("verifyHostnameForBusiness"),
);
check(
  "Public routing uses stored VERIFIED only and never live DNS",
  hostsSrc.includes('status !== "VERIFIED"') &&
    !hostsSrc.includes("verifyHostnameForBusiness") &&
    !hostsSrc.includes("setWebsiteDomainDnsLookup") &&
    !sitemapSrc.includes("verifyHostnameForBusiness"),
);
check(
  "Website Publish instructions use the same apex A targets as verification",
  settingsCard.includes("websiteDomainApexATargetsLabel") &&
    websiteDomainApexATargetsLabel() === [...WEBSITE_DOMAIN_VERCEL_A_ADDRESSES].join(" / ") &&
    WEBSITE_DOMAIN_VERCEL_A_ADDRESSES.includes("216.198.79.1") &&
    !WEBSITE_DOMAIN_VERCEL_A_ADDRESSES.includes("76.76.21.21") &&
    !WEBSITE_DOMAIN_VERCEL_A_ADDRESSES.includes("76.76.21.22") &&
    !settingsCard.includes("76.76.21.21") &&
    !settingsCard.includes("76.76.21.22") &&
    readme.includes("`216.198.79.1`") &&
    certification.includes("`216.198.79.1`") &&
    !readme.includes("76.76.21.") &&
    !certification.includes("76.76.21."),
);
check(
  "Display matching accepts Vercel apex A and project CNAMEs",
  isVercelApexAddress("216.198.79.1") &&
    !isVercelApexAddress("76.76.21.21") &&
    !isVercelApexAddress("76.76.21.22") &&
    dnsRecordsPointAtTbbt({ cnames: [], addresses: [WEBSITE_DOMAIN_VERCEL_A_ADDRESSES[0]] }) &&
    dnsRecordsPointAtTbbt({
      cnames: [],
      addresses: [...WEBSITE_DOMAIN_VERCEL_A_ADDRESSES],
    }) &&
    dnsRecordsPointAtTbbt({ cnames: ["abc.vercel-dns-017.com"], addresses: [] }) &&
    dnsRecordsPointAtTbbt({ cnames: [WEBSITE_DOMAIN_DNS_CNAME_TARGET], addresses: [] }) &&
    dnsRecordsPointAtTbbt({
      cnames: [WEBSITE_DOMAIN_DNS_CNAME_TARGET],
      addresses: [WEBSITE_DOMAIN_VERCEL_A_ADDRESSES[0]],
    }) &&
    !dnsRecordsPointAtTbbt({ cnames: [], addresses: ["203.0.113.10"] }) &&
    !dnsRecordsPointAtTbbt({ cnames: [], addresses: ["76.76.21.21"] }),
);
check(
  "A single good record cannot verify a host that also has a hostile record",
  !dnsRecordsPointAtTbbt({
    cnames: [],
    addresses: [WEBSITE_DOMAIN_VERCEL_A_ADDRESSES[0], "203.0.113.10"],
  }) &&
    !dnsRecordsPointAtTbbt({
      cnames: ["evil.attacker.net"],
      addresses: [WEBSITE_DOMAIN_VERCEL_A_ADDRESSES[0]],
    }) &&
    !dnsRecordsPointAtTbbt({
      cnames: [WEBSITE_DOMAIN_DNS_CNAME_TARGET],
      addresses: ["203.0.113.10"],
    }) &&
    !dnsRecordsPointAtTbbt({
      cnames: [WEBSITE_DOMAIN_DNS_CNAME_TARGET, "evil.attacker.net"],
      addresses: [],
    }),
);
check(
  "Lookalike vercel-dns suffixes do not match",
  !isVercelDnsCname("notvercel-dns.com") &&
    !isVercelDnsCname("cname.vercel-dns.com.attacker.net") &&
    !isVercelDnsCname("abc.vercel-dns-017.com.attacker.net") &&
    !dnsRecordsPointAtTbbt({ cnames: ["notvercel-dns.com"], addresses: [] }) &&
    !dnsRecordsPointAtTbbt({
      cnames: ["cname.vercel-dns.com.attacker.net"],
      addresses: [],
    }),
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

console.log("\nUNIT — Default DNS lookup timeout");
{
  const hang = () => new Promise(() => {});
  const started = Date.now();
  const lookup = defaultWebsiteDomainDnsLookup("never-resolves.example.test", {
    resolveCname: hang,
    resolve4: hang,
  });
  lookup.catch(() => {});
  const outcome = await Promise.race([
    lookup.then(
      () => ({ kind: "resolved" }),
      (error) => ({
        kind: "error",
        code: error && typeof error === "object" && "code" in error ? String(error.code) : "",
      }),
    ),
    new Promise((resolve) =>
      setTimeout(
        () => resolve({ kind: "watchdog" }),
        WEBSITE_DOMAIN_DNS_LOOKUP_TIMEOUT_MS + 2000,
      ),
    ),
  ]);
  const elapsed = Date.now() - started;
  check(
    "defaultWebsiteDomainDnsLookup times out hanging resolvers with ETIMEOUT",
    outcome.kind === "error" &&
      outcome.code === "ETIMEOUT" &&
      elapsed >= WEBSITE_DOMAIN_DNS_LOOKUP_TIMEOUT_MS - 250 &&
      elapsed < WEBSITE_DOMAIN_DNS_LOOKUP_TIMEOUT_MS + 1500,
  );
}

try {
  console.log("\nLIVE — Fake DNS, isolation, Pending, OWNER gate");
  let dnsLookups = 0;
  const dnsByHost = new Map();
  const timeoutHosts = new Set();
  setWebsiteDomainDnsLookup(async (hostname) => {
    dnsLookups += 1;
    if (timeoutHosts.has("*") || timeoutHosts.has(hostname)) throw timeoutError();
    if (dnsByHost.has(hostname)) return dnsByHost.get(hostname);
    return { cnames: [], addresses: [] };
  });
  check(
    "Fake DNS is injected before any LIVE lookup",
    getWebsiteDomainDnsLookup() !== defaultWebsiteDomainDnsLookup && dnsLookups === 0,
  );

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

  const businessTyped = await prisma.business.create({
    data: {
      name: "Typed Only",
      slug: `typed-dv-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      publicWebsite: "https://typed-only.example.test",
    },
  });
  const typedLookupsBefore = dnsLookups;
  const typedOnly = await verifyConfiguredWebsiteDomain(prisma, businessTyped.id);
  check(
    "Typed publicWebsite URL with no binding is not VERIFIED",
    typedOnly.state === "NOT_CONFIGURED" &&
      typedOnly.state !== "VERIFIED" &&
      typedOnly.enteredWebsiteHostname === "typed-only.example.test" &&
      typedOnly.hostname === "typed-only.example.test" &&
      typedOnly.bindingBusinessId === null &&
      dnsLookups === typedLookupsBefore,
  );

  const businessPendingPub = await prisma.business.create({
    data: {
      name: "Pending Publish",
      slug: `pend-dv-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
    },
  });
  const hostPendingPub = `pending-pub-${randomUUID().slice(0, 8)}.example.test`;
  await prisma.websiteHostBinding.create({
    data: { businessId: businessPendingPub.id, hostname: hostPendingPub, status: "VERIFIED" },
  });
  dnsByHost.set(hostPendingPub, pointingDns());
  const noPublish = await verifyConfiguredWebsiteDomain(prisma, businessPendingPub.id);
  check(
    "No published site stays Pending after DNS matches",
    noPublish.state === "PENDING" &&
      noPublish.publishedSite === false &&
      noPublish.hostname === hostPendingPub &&
      noPublish.detail.includes("published site"),
  );

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
  dnsByHost.set(hostA, { cnames: [], addresses: [] });
  dnsByHost.set(hostB, pointingDns());
  dnsByHost.set(hostUnknown, { cnames: [], addresses: [] });

  const beforeMatch = await verifyConfiguredWebsiteDomain(prisma, businessA.id);
  check(
    "Typed website URL on a bound host is still not verified from text",
    beforeMatch.enteredWebsiteHostname === "typed-only.example.test" &&
      beforeMatch.hostname === hostA &&
      beforeMatch.state !== "VERIFIED",
  );

  dnsByHost.set(hostA, pointingDns());

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

  timeoutHosts.add("*");
  const pendingA = await verifyConfiguredWebsiteDomain(prisma, businessA.id);
  check(
    "DNS timeout is Pending and never connected",
    pendingA.state === "PENDING" &&
      pendingA.label === "Pending" &&
      pendingA.hostname === hostA &&
      pendingA.detail.includes("Pending"),
  );
  timeoutHosts.clear();
  dnsByHost.set(hostA, { cnames: [], addresses: ["203.0.113.10"] });
  const unknownApex = await verifyConfiguredWebsiteDomain(prisma, businessA.id);
  check(
    "Unknown A-only records fail instead of staying Pending",
    unknownApex.state === "FAILED" && unknownApex.hostname === hostA,
  );

  dnsByHost.set(hostA, { cnames: [], addresses: [WEBSITE_DOMAIN_VERCEL_A_ADDRESSES[0]] });
  const apexA = await verifyConfiguredWebsiteDomain(prisma, businessA.id);
  check(
    "Vercel apex A record can complete display verification",
    apexA.state === "VERIFIED" && apexA.hostname === hostA,
  );

  dnsByHost.set(hostA, { cnames: ["abc.vercel-dns-017.com"], addresses: [] });
  const projectCname = await verifyConfiguredWebsiteDomain(prisma, businessA.id);
  check(
    "Project-specific Vercel CNAME can complete display verification",
    projectCname.state === "VERIFIED" && projectCname.hostname === hostA,
  );

  dnsByHost.set(hostA, {
    cnames: [],
    addresses: [WEBSITE_DOMAIN_VERCEL_A_ADDRESSES[0], "203.0.113.10"],
  });
  const mixedA = await verifyConfiguredWebsiteDomain(prisma, businessA.id);
  check(
    "Mixed good/bad A records do not verify",
    mixedA.state === "FAILED" && mixedA.hostname === hostA,
  );

  dnsByHost.set(hostA, {
    cnames: ["evil.attacker.net"],
    addresses: [WEBSITE_DOMAIN_VERCEL_A_ADDRESSES[0]],
  });
  const attackerCname = await verifyConfiguredWebsiteDomain(prisma, businessA.id);
  check(
    "Attacker CNAME plus Vercel A does not verify",
    attackerCname.state === "FAILED" && attackerCname.hostname === hostA,
  );

  dnsByHost.set(hostA, {
    cnames: [WEBSITE_DOMAIN_DNS_CNAME_TARGET],
    addresses: ["203.0.113.10"],
  });
  const goodCnameBadA = await verifyConfiguredWebsiteDomain(prisma, businessA.id);
  check(
    "Good CNAME plus bad A does not verify",
    goodCnameBadA.state === "FAILED" && goodCnameBadA.hostname === hostA,
  );

  dnsByHost.set(hostA, {
    cnames: [WEBSITE_DOMAIN_DNS_CNAME_TARGET, "evil.attacker.net"],
    addresses: [],
  });
  const mixedCnames = await verifyConfiguredWebsiteDomain(prisma, businessA.id);
  check(
    "Two CNAMEs with one bad do not verify",
    mixedCnames.state === "FAILED" && mixedCnames.hostname === hostA,
  );

  dnsByHost.set(hostA, { cnames: ["other-tenant.example.net"], addresses: [] });
  const failedA = await verifyConfiguredWebsiteDomain(prisma, businessA.id);
  check(
    "Wrong CNAME fails verification for A",
    failedA.state === "FAILED" && failedA.hostname === hostA,
  );

  dnsByHost.set(hostA, pointingDns());
  dnsByHost.set(hostB, pointingDns());
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

  timeoutHosts.add("*");
  const pendingGoLive = await loadGoLiveCenter(prisma, accessA);
  check(
    "Go-live shows Pending when DNS cannot complete",
    goLiveCardById(pendingGoLive, "custom_domain")?.status === "PARTIAL" &&
      /Pending/.test(goLiveCardById(pendingGoLive, "custom_domain")?.currentState ?? ""),
  );
  timeoutHosts.clear();
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

  const hostUnverified = `unverified-${randomUUID().slice(0, 8)}.example.test`;
  await prisma.websiteHostBinding.create({
    data: { businessId: businessA.id, hostname: hostUnverified, status: "UNVERIFIED" },
  });
  dnsByHost.set(hostUnverified, pointingDns());
  const serveUnverified = await resolvePublicHost(prisma, hostUnverified);
  const sitemapUnverified = await buildPublicSitemap(prisma, hostUnverified);

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
  check(
    "UNVERIFIED stored binding never serves site or sitemap even when DNS matches",
    serveUnverified.kind === "unverified" && sitemapUnverified.length === 0,
  );
  const goLiveAllBindings = await loadGoLiveCenter(prisma, accessA);
  check(
    "Go-live stays LIVE when a newer UNVERIFIED binding exists beside a VERIFIED host",
    goLiveCardById(goLiveAllBindings, "custom_domain")?.status === "LIVE" &&
      JSON.stringify(goLiveAllBindings).includes(hostA),
  );

  timeoutHosts.add("*");
  const pendingRoot = await resolvePublicRoot(prisma, hostA);
  const pendingSitemap = await buildPublicSitemap(prisma, hostA);
  const pendingDisplay = await verifyConfiguredWebsiteDomain(prisma, businessA.id);
  check(
    "Stored VERIFIED still serves site and sitemap when display DNS is Pending",
    pendingRoot.kind === "site" &&
      pendingRoot.slug === businessA.slug &&
      pendingSitemap.length > 0 &&
      pendingSitemap.every((entry) => entry.url.startsWith(`https://${hostA}`)) &&
      pendingDisplay.state === "PENDING",
  );
  timeoutHosts.clear();
  check(
    "Suite never fell back to the real DNS resolver",
    getWebsiteDomainDnsLookup() !== defaultWebsiteDomainDnsLookup && dnsLookups > 0,
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
