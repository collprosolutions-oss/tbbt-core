/**
 * BSOS Network default-off, opt-out, tenant-safe discovery, MEMBER denial.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-bsos-network.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError, requireBusinessRole } = await import("@/lib/authorization");
const { visibleAppNav, APP_NAV } = await import("@/lib/nav");
const {
  DISCOVERY_LIMIT,
  NETWORK_DEFAULT_OFF_MESSAGE,
  NETWORK_NO_MATCHING_MESSAGE,
  NETWORK_OWNER_ONLY_MESSAGE,
  NETWORK_PRIVACY_MESSAGE,
  listingFieldNames,
  listingHasHiddenFields,
  publicListingFieldNames,
  toPublicListing,
} = await import("@/lib/bsos-network");
const {
  BsosNetworkError,
  optBusinessIntoNetwork,
  optBusinessOutOfNetwork,
  requireNetworkOwner,
  requireNetworkRead,
} = await import("@/lib/bsos-network-ops");
const {
  discoverPublicNetworkListings,
  findPublicNetworkListing,
  loadNetworkWorkspace,
  loadOwnNetworkParticipation,
} = await import("@/lib/bsos-network-data");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_bsos_network_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for BSOS Network test database.");
  process.exit(push.status ?? 1);
}

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

function readRepo(relPath) {
  return readFileSync(new URL(`../${relPath}`, import.meta.url), "utf8");
}

const schema = readRepo("prisma/schema.prisma");
const migration = readRepo("prisma/migrations/20260927150000_bsos_network_participation/migration.sql");
const navSource = readRepo("src/lib/nav.ts");
const dataSource = readRepo("src/lib/bsos-network-data.ts");
const opsSource = readRepo("src/lib/bsos-network-ops.ts");
const workspaceLoader = readRepo("src/lib/workspace.ts");
const actionsSource = readRepo("src/app/actions/bsos-network.ts");
const pageSource = readRepo("src/app/(app)/network/page.tsx");
const workspaceSource = readRepo("src/components/bsos-network/network-workspace.tsx");

try {
  console.log("\nSTATIC — Default-off Network slice");
  check(
    "Participation model defaults optedIn to false",
    /model BsosNetworkParticipation[\s\S]*optedIn\s+Boolean\s+@default\(false\)/.test(schema),
  );
  check(
    "Migration is additive and default-off",
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migration) &&
      migration.includes('CREATE TABLE IF NOT EXISTS "BsosNetworkParticipation"') &&
      migration.includes('"optedIn" BOOLEAN NOT NULL DEFAULT false') &&
      !migration.includes("ALTER TABLE \"Business\" ADD"),
  );
  check(
    "Network is not in global APP_NAV",
    !APP_NAV.some((item) => item.href === "/network") &&
      !navSource.includes("/network") &&
      !visibleAppNav("OWNER").some((item) => item.href === "/network"),
  );
  check(
    "Workspace load does not run Network DDL",
    !workspaceLoader.includes("BsosNetworkParticipation") &&
      !workspaceLoader.includes("bsos-network"),
  );
  check(
    "Slice does not add referrals or matching",
    !opsSource.includes("referral") &&
      !dataSource.includes("referral") &&
      !actionsSource.includes("referral") &&
      /not a referral or automatic matching/i.test(NETWORK_NO_MATCHING_MESSAGE),
  );
  check(
    "Privacy copy names the only allowed public fields",
    /public business name, trade, broad service area/.test(NETWORK_PRIVACY_MESSAGE) &&
      /Customers, jobs, finances/.test(NETWORK_PRIVACY_MESSAGE),
  );
  check("Default-off copy is present", /default-off/.test(NETWORK_DEFAULT_OFF_MESSAGE));
  check("OWNER-only copy is present", /Only the owner/.test(NETWORK_OWNER_ONLY_MESSAGE));
  check("Discovery is bounded", DISCOVERY_LIMIT === 50);
  check("Network page lives at /network", pageSource.includes("BSOS Network"));
  check(
    "Opt-in and opt-out forms remount so success copy cannot leak across states",
    workspaceSource.includes('key="opt-out"') && workspaceSource.includes('key="opt-in"'),
  );

  const sampleListing = toPublicListing({
    id: "listing-1",
    publicName: "Alpha",
    tradeCode: "HANDYMAN",
    serviceAreaLabel: "Reno, NV",
    publicContactMethod: "EMAIL",
    publicContactValue: "hello@alpha.example",
    businessId: "should-drop",
    optedIn: true,
    optedOutAt: new Date(),
    customers: [{ name: "secret" }],
  });
  check(
    "Public listing mapper keeps only the allowlist",
    JSON.stringify(listingFieldNames(sampleListing)) === JSON.stringify(publicListingFieldNames()),
  );
  check("Public listing mapper drops hidden fields", !listingHasHiddenFields(sampleListing));
  check(
    "Public listing does not include businessId or customers",
    !("businessId" in sampleListing) &&
      !("customers" in sampleListing) &&
      sampleListing.publicName === "Alpha" &&
      sampleListing.contactValue === "hello@alpha.example",
  );
  check(
    "Discovery select is the public allowlist only",
    dataSource.includes("select: PUBLIC_LISTING_SELECT") &&
      dataSource.includes("optedIn: true") &&
      !dataSource.includes("include: { customer") &&
      !dataSource.includes("include: { job"),
  );

  await prisma.bsosNetworkParticipation.deleteMany();

  const suffix = randomUUID().slice(0, 8);
  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Network",
      slug: `alpha-net-${suffix}`,
      tradeCode: "HANDYMAN",
      publicPhone: "775-555-0101",
      publicEmail: "private-owner@alpha.example",
      publicWebsite: "https://alpha.example",
      publicServiceAreaLabel: "Reno, NV",
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Network",
      slug: `beta-net-${suffix}`,
      tradeCode: "HANDYMAN",
      publicPhone: "775-555-0202",
      publicEmail: "hello@beta.example",
      publicServiceAreaLabel: "Sparks, NV",
    },
  });
  const businessC = await prisma.business.create({
    data: {
      name: "Gamma Silent",
      slug: `gamma-net-${suffix}`,
      tradeCode: "CLEANING",
      publicEmail: "hidden@gamma.example",
      publicServiceAreaLabel: "Carson City, NV",
    },
  });

  await prisma.businessTrade.createMany({
    data: [
      { businessId: businessA.id, tradeCode: "HANDYMAN", status: "ACTIVE" },
      { businessId: businessB.id, tradeCode: "HANDYMAN", status: "ACTIVE" },
      { businessId: businessC.id, tradeCode: "CLEANING", status: "ACTIVE" },
    ],
  });

  const ownerAUser = await prisma.user.create({
    data: { name: "Olivia", email: `owner-a-${suffix}@example.com`, passwordHash: "x" },
  });
  const adminAUser = await prisma.user.create({
    data: { name: "Ada", email: `admin-a-${suffix}@example.com`, passwordHash: "x" },
  });
  const memberAUser = await prisma.user.create({
    data: { name: "Mia", email: `member-a-${suffix}@example.com`, passwordHash: "x" },
  });
  const ownerBUser = await prisma.user.create({
    data: { name: "Ben", email: `owner-b-${suffix}@example.com`, passwordHash: "x" },
  });

  const ownerAMem = await prisma.membership.create({
    data: { userId: ownerAUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const adminAMem = await prisma.membership.create({
    data: { userId: adminAUser.id, businessId: businessA.id, role: "ADMIN" },
  });
  const memberAMem = await prisma.membership.create({
    data: { userId: memberAUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const ownerBMem = await prisma.membership.create({
    data: { userId: ownerBUser.id, businessId: businessB.id, role: "OWNER" },
  });

  const ownerA = makeAccess(businessA.id, "OWNER", ownerAMem.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminAMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberAMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", ownerBMem.id);

  const secretCustomer = await prisma.customer.create({
    data: {
      businessId: businessB.id,
      name: "Secret Beta Customer",
      email: "customer@beta.example",
      phone: "775-555-9999",
    },
  });
  await prisma.invoice.create({
    data: {
      businessId: businessB.id,
      customerId: secretCustomer.id,
      status: "SENT",
      total: 1287.55,
    },
  });

  console.log("\nTEST — Default-off");
  const before = await discoverPublicNetworkListings(prisma, ownerA);
  check("No listings exist before any owner opts in", before.length === 0);
  const ownBefore = await loadOwnNetworkParticipation(prisma, ownerA);
  check("OWNER sees own business as not opted in by default", ownBefore.optedIn === false && ownBefore.listing === null);
  const silentRow = await prisma.bsosNetworkParticipation.findFirst({
    where: { businessId: businessC.id },
  });
  check("A business with public contact still has no participation row", silentRow === null);
  const unknownLookup = await findPublicNetworkListing(prisma, ownerA, businessC.id);
  check(
    "Lookup of a known silent business id returns the same null as an unknown id",
    unknownLookup === null && (await findPublicNetworkListing(prisma, ownerA, "does-not-exist")) === null,
  );

  console.log("\nTEST — MEMBER denial");
  await expectError(
    "MEMBER cannot read discovery",
    () => discoverPublicNetworkListings(prisma, memberA),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot load own participation",
    () => loadOwnNetworkParticipation(prisma, memberA),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot opt in",
    () =>
      optBusinessIntoNetwork(prisma, memberA, {
        publicName: "Hijack",
        tradeCode: "HANDYMAN",
        serviceAreaLabel: "Reno, NV",
        publicContactMethod: "EMAIL",
        publicContactValue: "mia@alpha.example",
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot opt out",
    () => optBusinessOutOfNetwork(prisma, memberA),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "requireNetworkRead denies MEMBER",
    async () => {
      requireNetworkRead(memberA);
    },
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "requireNetworkOwner denies ADMIN",
    async () => {
      requireNetworkOwner(adminA);
    },
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "requireBusinessRole OWNER denies MEMBER",
    async () => {
      requireBusinessRole(memberA, "OWNER");
    },
    (error) => error instanceof ForbiddenError,
  );

  console.log("\nTEST — OWNER opt-in");
  await expectError(
    "ADMIN cannot opt the business in",
    () =>
      optBusinessIntoNetwork(prisma, adminA, {
        publicName: "Alpha Network",
        tradeCode: "HANDYMAN",
        serviceAreaLabel: "Reno, NV",
        publicContactMethod: "EMAIL",
        publicContactValue: "hello@alpha.example",
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "OWNER cannot list a trade the business does not operate",
    () =>
      optBusinessIntoNetwork(prisma, ownerA, {
        publicName: "Alpha Network",
        tradeCode: "CLEANING",
        serviceAreaLabel: "Reno, NV",
        publicContactMethod: "EMAIL",
        publicContactValue: "hello@alpha.example",
      }),
    (error) => error instanceof BsosNetworkError && /active trades/i.test(error.message),
  );

  const listedA = await optBusinessIntoNetwork(prisma, ownerA, {
    publicName: "Alpha Public",
    tradeCode: "HANDYMAN",
    serviceAreaLabel: "Reno, NV",
    publicContactMethod: "EMAIL",
    publicContactValue: "hello@alpha.example",
  });
  check("OWNER opt-in stores optedIn=true", listedA.optedIn === true && listedA.publicName === "Alpha Public");
  check(
    "OWNER opt-in stores only the chosen public contact",
    listedA.publicContactMethod === "EMAIL" && listedA.publicContactValue === "hello@alpha.example",
  );

  const listedB = await optBusinessIntoNetwork(prisma, ownerB, {
    publicName: "Beta Public",
    tradeCode: "HANDYMAN",
    serviceAreaLabel: "Sparks, NV",
    publicContactMethod: "PHONE",
    publicContactValue: "775-555-0202",
  });
  check("Second OWNER can opt their own business in", listedB.optedIn === true);

  console.log("\nTEST — Tenant-safe discovery");
  const discovered = await discoverPublicNetworkListings(prisma, ownerA);
  check(
    "Discovery returns only opted-in listings",
    discovered.length === 2 &&
      discovered.some((row) => row.publicName === "Alpha Public") &&
      discovered.some((row) => row.publicName === "Beta Public") &&
      !discovered.some((row) => row.publicName === "Gamma Silent"),
  );
  const betaCard = discovered.find((row) => row.publicName === "Beta Public");
  check(
    "Discovered card has only public fields",
    betaCard &&
      JSON.stringify(listingFieldNames(betaCard)) === JSON.stringify(publicListingFieldNames()) &&
      !listingHasHiddenFields(betaCard),
  );
  const serialized = JSON.stringify(betaCard);
  check(
    "Discovered card never discloses customers, jobs, finances, or private contacts",
    betaCard.contactMethod === "PHONE" &&
      betaCard.contactValue === "775-555-0202" &&
      !serialized.includes("Secret Beta Customer") &&
      !serialized.includes("customer@beta.example") &&
      !serialized.includes("775-555-9999") &&
      !serialized.includes("1287.55") &&
      !serialized.includes(businessB.id) &&
      !serialized.includes("private-owner@alpha.example"),
  );
  check(
    "Silent Gamma is not named and not flagged as opted-out",
    !serialized.includes("Gamma") &&
      !JSON.stringify(discovered).includes("optedOut") &&
      !JSON.stringify(discovered).includes(businessC.id),
  );

  const adminDiscovery = await discoverPublicNetworkListings(prisma, adminA);
  check("ADMIN may read opted-in public listings", adminDiscovery.length === 2);

  const filtered = await discoverPublicNetworkListings(prisma, ownerA, { serviceArea: "Sparks" });
  check(
    "Bounded filter uses the approved service-area label only",
    filtered.length === 1 && filtered[0].publicName === "Beta Public",
  );

  const ownAfter = await loadOwnNetworkParticipation(prisma, ownerA);
  check("OWNER sees their own approved listing after opt-in", ownAfter.optedIn === true && ownAfter.listing?.publicName === "Alpha Public");

  const workspace = await loadNetworkWorkspace(prisma, ownerA);
  check(
    "Workspace suggestions stay on the caller's own public identity",
    workspace.suggestions.publicName === "Alpha Network" &&
      workspace.suggestions.contacts.some((item) => item.value === "private-owner@alpha.example") &&
      !JSON.stringify(workspace.listings).includes("Secret Beta Customer"),
  );

  console.log("\nTEST — Opt-out");
  const betaListingId = listedB.id;
  const beforeOut = await findPublicNetworkListing(prisma, ownerA, betaListingId);
  check("Opted-in listing can be loaded by listing id", beforeOut?.publicName === "Beta Public");

  await optBusinessOutOfNetwork(prisma, ownerB);
  const afterOut = await discoverPublicNetworkListings(prisma, ownerA);
  check(
    "Opted-out business disappears from discovery",
    afterOut.length === 1 && afterOut[0].publicName === "Alpha Public" && !afterOut.some((row) => row.publicName === "Beta Public"),
  );
  const lookupAfterOut = await findPublicNetworkListing(prisma, ownerA, betaListingId);
  const lookupUnknown = await findPublicNetworkListing(prisma, ownerA, "missing-listing");
  check(
    "Opted-out listing id returns the same null as an unknown id",
    lookupAfterOut === null && lookupUnknown === null,
  );
  const ownB = await loadOwnNetworkParticipation(prisma, ownerB);
  check("OWNER of the opted-out business sees optedIn=false", ownB.optedIn === false && ownB.listing === null);
  const stillSilent = await prisma.bsosNetworkParticipation.findFirst({
    where: { businessId: businessC.id },
  });
  check("Opt-out of another business does not create a Gamma participation row", stillSilent === null);

  await expectError(
    "ADMIN cannot opt the business out",
    () => optBusinessOutOfNetwork(prisma, adminA),
    (error) => error instanceof ForbiddenError,
  );

  const memberAfter = await prisma.bsosNetworkParticipation.findMany();
  check(
    "MEMBER denial still holds after listings exist",
    memberAfter.some((row) => row.optedIn) === true,
  );
  await expectError(
    "MEMBER still cannot discover after others opted in",
    () => discoverPublicNetworkListings(prisma, memberA),
    (error) => error instanceof ForbiddenError,
  );

  if (failures > 0) {
    console.error(`\n${failures} BSOS Network check(s) failed.`);
    process.exit(1);
  }
  console.log("\nBSOS Network checks passed.");
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
