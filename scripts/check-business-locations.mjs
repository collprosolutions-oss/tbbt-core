/**
 * Business Location foundation: additive migrate, OWNER manage,
 * office read, MEMBER field-scope, and no silent timezone / Stripe /
 * service-area / tenant / historical-job changes.
 *
 * Dedicated test database: tbbt_business_locations_test
 *
 * Run with:
 *   npm run test:business-locations
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError, requireBusinessRole } = await import("@/lib/authorization");
const { APP_NAV, visibleAppNav } = await import("@/lib/nav");
const { SETTINGS_SECTIONS } = await import("@/lib/settings");
const {
  LOCATION_ADDITIVE_MESSAGE,
  LOCATION_EMPTY_MESSAGE,
  LOCATION_FIELD_SCOPED_MESSAGE,
  LOCATION_OWNER_ONLY_MESSAGE,
  LOCATION_UNAVAILABLE_MESSAGE,
  formatLocationAddress,
  parseLocationName,
} = await import("@/lib/business-locations");
const { BUSINESS_LOCATION_SCHEMA_SOURCE } = await import("@/lib/business-location-schema");
const {
  BusinessLocationError,
  BusinessLocationUnavailableError,
  createBusinessLocation,
  listBusinessLocations,
  loadBusinessLocationDirectory,
  missingBusinessLocationSchema,
  requireLocationOwner,
  requireLocationRead,
  setBusinessLocationStatus,
  updateBusinessLocation,
} = await import("@/lib/business-location-ops");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_business_locations_test";
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
  console.error("Failed to push schema for business-locations test database.");
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
const migration = readRepo("prisma/migrations/20260927190000_add_business_location/migration.sql");
const navSource = readRepo("src/lib/nav.ts");
const settingsSource = readRepo("src/lib/settings.ts");
const settingsWorkspace = readRepo("src/components/settings/settings-workspace.tsx");
const opsSource = readRepo("src/lib/business-location-ops.ts");
const schemaHelper = readRepo("src/lib/business-location-schema.ts");
const panelSource = readRepo("src/components/settings/business-locations-panel.tsx");
const actionsSource = readRepo("src/app/actions/business-locations.ts");
const jobActions = readRepo("src/app/actions/job.ts");
const workspaceLoader = readRepo("src/lib/workspace.ts");
const authorizationSource = readRepo("src/lib/authorization.ts");
const settingsPage = readRepo("src/app/(app)/settings/page.tsx");

function hasRequestTimeDdl(source) {
  return /\$executeRawUnsafe|\$executeRaw\b|CREATE TABLE IF NOT EXISTS|ADD COLUMN IF NOT EXISTS/.test(
    source,
  );
}

try {
  console.log("\nSTATIC — Additive location foundation");
  check(
    "BusinessLocation model is optional and default ACTIVE",
    /model BusinessLocation[\s\S]*status\s+String\s+@default\("ACTIVE"\)/.test(schema) &&
      /Job\.businessLocationId remains null/.test(schema),
  );
  check(
    "Job location attachment is nullable",
    /businessLocationId\s+String\?/.test(schema) &&
      schema.includes("businessLocation        BusinessLocation?"),
  );
  check(
    "Migration is additive, isolated, and does not rewrite tenants",
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migration) &&
      migration.includes('CREATE TABLE IF NOT EXISTS "BusinessLocation"') &&
      migration.includes('ADD COLUMN IF NOT EXISTS "businessLocationId"') &&
      !migration.includes('ALTER TABLE "Business"') &&
      !/UPDATE\s+"Business"/i.test(migration) &&
      !/UPDATE\s+"Job"/i.test(migration) &&
      !/UPDATE\s+"ServiceArea"/i.test(migration) &&
      !/UPDATE\s+"BusinessPaymentAccount"/i.test(migration) &&
      !migration.includes("BsosNetworkParticipation") &&
      !migration.includes("JobCrewVisit") &&
      migration.includes("20260927150000_bsos_network_participation") &&
      migration.includes("20260927180000_job_crew_visit"),
  );
  check(
    "Network and Cleaning keep their own migrations and relations",
    !migration.includes("BsosNetworkParticipation") &&
      !migration.includes("JobCrewVisit") &&
      schema.includes("model BsosNetworkParticipation") &&
      schema.includes("model JobCrewVisit") &&
      schema.includes("model BusinessLocation") &&
      schema.includes("bsosNetworkParticipation BsosNetworkParticipation?") &&
      schema.includes("locations                BusinessLocation[]") &&
      schema.includes("crewVisits               JobCrewVisit[]") &&
      existsSync(new URL("../prisma/migrations/20260927150000_bsos_network_participation/migration.sql", import.meta.url)) &&
      existsSync(new URL("../prisma/migrations/20260927180000_job_crew_visit/migration.sql", import.meta.url)) &&
      existsSync(new URL("../prisma/migrations/20260927190000_add_business_location/migration.sql", import.meta.url)),
  );
  check(
    "Locations are not in global APP_NAV",
    !APP_NAV.some((item) => /location/i.test(item.href) || /location/i.test(item.label)) &&
      !navSource.includes("/locations") &&
      !visibleAppNav("OWNER").some((item) => item.href === "/locations"),
  );
  check(
    "Settings sections were not expanded for locations",
    !SETTINGS_SECTIONS.includes("locations") &&
      !settingsSource.includes("locations:") &&
      settingsWorkspace.includes("BusinessLocationsPanel"),
  );
  check(
    "authorization.ts capability matrix is unchanged",
    !authorizationSource.includes("MANAGE_BUSINESS_LOCATIONS") &&
      !authorizationSource.includes("BusinessLocation"),
  );
  check(
    "Workspace load does not run location DDL",
    !workspaceLoader.includes("BusinessLocation") &&
      !workspaceLoader.includes("business-location"),
  );
  check(
    "Location schema is migrate-only",
    BUSINESS_LOCATION_SCHEMA_SOURCE === "prisma-migrate" &&
      !schemaHelper.includes("$executeRaw") &&
      !schemaHelper.includes("ensureBusinessLocationSchema") &&
      schemaHelper.includes("20260927190000_add_business_location"),
  );
  check(
    "Settings page load and location writes execute no DDL",
    ![opsSource, panelSource, actionsSource, settingsPage, settingsWorkspace].some(
      hasRequestTimeDdl,
    ) &&
      !opsSource.includes("ensureBusinessLocationSchema") &&
      panelSource.includes("loadBusinessLocationDirectory") &&
      panelSource.includes("LOCATION_UNAVAILABLE_MESSAGE"),
  );
  check(
    "Missing-table detector is fail-closed",
    missingBusinessLocationSchema({ code: "P2021", message: "The table `BusinessLocation` does not exist in the current database." }) &&
      missingBusinessLocationSchema({
        code: "P2022",
        message: "The column `Job.businessLocationId` does not exist in the current database.",
      }) &&
      !missingBusinessLocationSchema({ code: "P2002", message: "Unique constraint failed" }),
  );
  check("Unavailable copy does not create schema", /does not create the table/.test(LOCATION_UNAVAILABLE_MESSAGE));
  check(
    "Location writes do not touch timezone, Stripe, service areas, or jobs",
    !opsSource.includes("business.update") &&
      !opsSource.includes("businessPaymentAccount") &&
      !opsSource.includes("serviceArea") &&
      !opsSource.includes("prisma.job") &&
      !actionsSource.includes("business.update") &&
      !jobActions.includes("businessLocationId"),
  );
  check("Additive copy is present", /does not change timezone, Stripe/.test(LOCATION_ADDITIVE_MESSAGE));
  check("Empty-state copy keeps jobs unassigned", /Existing jobs stay unassigned/.test(LOCATION_EMPTY_MESSAGE));
  check("OWNER-only copy is present", /Only the owner/.test(LOCATION_OWNER_ONLY_MESSAGE));
  check("Field-scope copy is present", /assigned jobs/.test(LOCATION_FIELD_SCOPED_MESSAGE));
  check(
    "Name parser rejects a blank location",
    (() => {
      try {
        parseLocationName("   ");
        return false;
      } catch {
        return true;
      }
    })(),
  );
  check(
    "Address formatter stays display-only",
    formatLocationAddress({
      addressLine1: "100 Main",
      addressLine2: "",
      city: "Reno",
      region: "NV",
      postalCode: "89501",
    }) === "100 Main · Reno, NV, 89501",
  );

  const suffix = randomUUID().slice(0, 8);
  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Locations",
      slug: `alpha-loc-${suffix}`,
      tradeCode: "HANDYMAN",
      timezone: "America/Los_Angeles",
      publicServiceAreaLabel: "Reno, NV",
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Locations",
      slug: `beta-loc-${suffix}`,
      tradeCode: "HANDYMAN",
      timezone: "America/New_York",
      publicServiceAreaLabel: "Fort Myers, FL",
    },
  });

  const ownerAUser = await prisma.user.create({
    data: { name: "Olivia", email: `owner-a-loc-${suffix}@example.com`, passwordHash: "x" },
  });
  const adminAUser = await prisma.user.create({
    data: { name: "Ada", email: `admin-a-loc-${suffix}@example.com`, passwordHash: "x" },
  });
  const memberAUser = await prisma.user.create({
    data: { name: "Mia", email: `member-a-loc-${suffix}@example.com`, passwordHash: "x" },
  });
  const ownerBUser = await prisma.user.create({
    data: { name: "Ben", email: `owner-b-loc-${suffix}@example.com`, passwordHash: "x" },
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

  const paymentA = await prisma.businessPaymentAccount.create({
    data: {
      businessId: businessA.id,
      provider: "stripe",
      stripeAccountId: `acct_alpha_${suffix}`,
    },
  });
  const paymentB = await prisma.businessPaymentAccount.create({
    data: {
      businessId: businessB.id,
      provider: "stripe",
      stripeAccountId: `acct_beta_${suffix}`,
    },
  });
  const areaA = await prisma.serviceArea.create({
    data: {
      businessId: businessA.id,
      kind: "CITY",
      label: "Reno",
      city: "Reno",
      region: "NV",
      enabled: true,
    },
  });
  const historicalJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });

  async function snapshotBoundaries(businessId) {
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true, timezone: true, slug: true, publicServiceAreaLabel: true },
    });
    const payment = await prisma.businessPaymentAccount.findUnique({
      where: { businessId },
      select: { id: true, stripeAccountId: true },
    });
    const areas = await prisma.serviceArea.findMany({
      where: { businessId },
      select: { id: true, label: true, enabled: true },
      orderBy: { id: "asc" },
    });
    const jobs = await prisma.job.findMany({
      where: { businessId },
      select: { id: true, businessLocationId: true, status: true },
      orderBy: { id: "asc" },
    });
    return { business, payment, areas, jobs };
  }

  console.log("\nTEST — Existing tenant behavior before any location");
  const beforeA = await snapshotBoundaries(businessA.id);
  const existingLocations = await prisma.businessLocation.findMany({
    where: { businessId: businessA.id },
  });
  check("Existing business has zero locations after migrate", existingLocations.length === 0);
  check(
    "Existing timezone, Stripe, service area, and job are intact",
    beforeA.business.timezone === "America/Los_Angeles" &&
      beforeA.payment.stripeAccountId === `acct_alpha_${suffix}` &&
      beforeA.areas.length === 1 &&
      beforeA.areas[0].id === areaA.id &&
      beforeA.jobs.length === 1 &&
      beforeA.jobs[0].id === historicalJob.id &&
      beforeA.jobs[0].businessLocationId === null,
  );
  const listedBefore = await listBusinessLocations(prisma, ownerA);
  check("OWNER list is empty for an existing business", listedBefore.length === 0);

  const ddlCalls = [];
  const originalExecuteUnsafe = prisma.$executeRawUnsafe.bind(prisma);
  const originalExecute = prisma.$executeRaw.bind(prisma);
  prisma.$executeRawUnsafe = async (...args) => {
    ddlCalls.push(String(args[0] ?? ""));
    return originalExecuteUnsafe(...args);
  };
  prisma.$executeRaw = async (...args) => {
    ddlCalls.push(String(args[0] ?? ""));
    return originalExecute(...args);
  };
  const pageLoad = await loadBusinessLocationDirectory(prisma, ownerA);
  check(
    "Settings page load issues no raw DDL",
    pageLoad.available === true &&
      pageLoad.locations.length === 0 &&
      ddlCalls.length === 0,
  );

  console.log("\nTEST — Authorization");
  await expectError(
    "MEMBER cannot read locations",
    () => listBusinessLocations(prisma, memberA),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot create a location",
    () => createBusinessLocation(prisma, memberA, { name: "Field shop" }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "ADMIN cannot create a location",
    () => createBusinessLocation(prisma, adminA, { name: "Office shop" }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "requireLocationRead denies MEMBER",
    async () => {
      requireLocationRead(memberA);
    },
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "requireLocationOwner denies ADMIN",
    async () => {
      requireLocationOwner(adminA);
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
  await expectError(
    "Blank name is rejected",
    () => createBusinessLocation(prisma, ownerA, { name: "   " }),
    (error) => error instanceof BusinessLocationError,
  );

  console.log("\nTEST — OWNER create does not rewrite tenant boundaries");
  const created = await createBusinessLocation(prisma, ownerA, {
    name: "Reno shop",
    addressLine1: "100 Main St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Parts shelf",
  });
  check("OWNER can create a location", created.name === "Reno shop" && created.status === "ACTIVE");
  check("Created location stays on the caller's businessId", created.businessId === businessA.id);

  const afterCreate = await snapshotBoundaries(businessA.id);
  check(
    "Adding a location does not change Business.timezone",
    afterCreate.business.timezone === beforeA.business.timezone &&
      afterCreate.business.timezone === "America/Los_Angeles",
  );
  check(
    "Adding a location does not change the Stripe account",
    afterCreate.payment.id === paymentA.id &&
      afterCreate.payment.stripeAccountId === paymentA.stripeAccountId,
  );
  check(
    "Adding a location does not change service areas",
    afterCreate.areas.length === 1 &&
      afterCreate.areas[0].id === areaA.id &&
      afterCreate.areas[0].label === "Reno" &&
      afterCreate.business.publicServiceAreaLabel === "Reno, NV",
  );
  check(
    "Adding a location does not assign historical jobs",
    afterCreate.jobs.length === 1 &&
      afterCreate.jobs[0].id === historicalJob.id &&
      afterCreate.jobs[0].businessLocationId === null &&
      afterCreate.jobs[0].status === "COMPLETED",
  );
  check(
    "Tenant slug and id stay the same",
    afterCreate.business.id === businessA.id && afterCreate.business.slug === businessA.slug,
  );

  const laterJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      status: "UNSCHEDULED",
      projectToken: randomUUID(),
    },
  });
  check(
    "New jobs still default to no location",
    laterJob.businessLocationId === null,
  );

  console.log("\nTEST — Office read + OWNER manage");
  const officeList = await listBusinessLocations(prisma, adminA);
  check(
    "ADMIN can read the office location directory",
    officeList.length === 1 && officeList[0].id === created.id && officeList[0].name === "Reno shop",
  );
  await expectError(
    "ADMIN cannot update a location",
    () =>
      updateBusinessLocation(prisma, adminA, {
        locationId: created.id,
        name: "Hijacked",
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "ADMIN cannot archive a location",
    () => setBusinessLocationStatus(prisma, adminA, { locationId: created.id, status: "ARCHIVED" }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER still cannot read after a location exists",
    () => listBusinessLocations(prisma, memberA),
    (error) => error instanceof ForbiddenError,
  );

  const updated = await updateBusinessLocation(prisma, ownerA, {
    locationId: created.id,
    name: "Reno shop north",
    addressLine1: "200 Second St",
    city: "Reno",
    region: "NV",
    postalCode: "89502",
  });
  check("OWNER can update a location name/address", updated.name === "Reno shop north");
  const archived = await setBusinessLocationStatus(prisma, ownerA, {
    locationId: created.id,
    status: "ARCHIVED",
  });
  check("OWNER can archive a location", archived.status === "ARCHIVED");
  const restored = await setBusinessLocationStatus(prisma, ownerA, {
    locationId: created.id,
    status: "ACTIVE",
  });
  check("OWNER can restore a location", restored.status === "ACTIVE");

  const afterManage = await snapshotBoundaries(businessA.id);
  check(
    "Manage/archive still leaves timezone, Stripe, service areas, and jobs unchanged",
    afterManage.business.timezone === "America/Los_Angeles" &&
      afterManage.payment.stripeAccountId === paymentA.stripeAccountId &&
      afterManage.areas[0].id === areaA.id &&
      afterManage.jobs.every((job) => job.businessLocationId === null),
  );

  console.log("\nTEST — Isolation");
  const createdB = await createBusinessLocation(prisma, ownerB, {
    name: "Fort Myers shop",
    city: "Fort Myers",
    region: "FL",
  });
  const listA = await listBusinessLocations(prisma, ownerA);
  const listB = await listBusinessLocations(prisma, ownerB);
  check(
    "OWNER A only sees A locations",
    listA.length === 1 &&
      listA[0].id === created.id &&
      !listA.some((row) => row.id === createdB.id) &&
      !JSON.stringify(listA).includes("Fort Myers"),
  );
  check(
    "OWNER B only sees B locations",
    listB.length === 1 &&
      listB[0].id === createdB.id &&
      !listB.some((row) => row.id === created.id) &&
      !JSON.stringify(listB).includes("Reno shop"),
  );
  await expectError(
    "OWNER A cannot update OWNER B's location",
    () =>
      updateBusinessLocation(prisma, ownerA, {
        locationId: createdB.id,
        name: "Cross-tenant",
      }),
    (error) => error instanceof Error,
  );
  await expectError(
    "OWNER A cannot archive OWNER B's location",
    () => setBusinessLocationStatus(prisma, ownerA, { locationId: createdB.id, status: "ARCHIVED" }),
    (error) => error instanceof Error,
  );

  const afterB = await snapshotBoundaries(businessB.id);
  check(
    "B timezone and Stripe stay isolated from A's location work",
    afterB.business.timezone === "America/New_York" &&
      afterB.payment.stripeAccountId === paymentB.stripeAccountId &&
      afterB.business.id === businessB.id,
  );
  const aPayment = await prisma.businessPaymentAccount.findUnique({
    where: { businessId: businessA.id },
  });
  check(
    "A Stripe account was never rewritten to B's account",
    aPayment.stripeAccountId === `acct_alpha_${suffix}` &&
      aPayment.stripeAccountId !== paymentB.stripeAccountId,
  );

  const audits = await prisma.settingsAuditLog.findMany({
    where: { businessId: businessA.id, settingArea: "locations" },
  });
  check(
    "Location audit stays on the owning business",
    audits.length >= 1 &&
      audits.every((row) => row.businessId === businessA.id) &&
      !audits.some((row) => row.businessId === businessB.id),
  );

  console.log("\nTEST — Preview missing table is unavailable, not created");
  ddlCalls.length = 0;
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "BusinessLocation" CASCADE`);
  const afterDrop = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'BusinessLocation'`,
  );
  check("Dropped location table to simulate Preview skip-migrate", afterDrop[0]?.n === 0);

  const previewLoad = await loadBusinessLocationDirectory(prisma, ownerA);
  check(
    "Page load shows unavailable and does not recreate the table",
    previewLoad.available === false &&
      previewLoad.locations.length === 0 &&
      !ddlCalls.some((sql) => /CREATE TABLE|ALTER TABLE|CREATE INDEX/i.test(sql)),
  );
  const stillMissing = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'BusinessLocation'`,
  );
  check("Location table is still absent after page load", stillMissing[0]?.n === 0);

  await expectError(
    "MEMBER is still denied when the table is absent",
    () => listBusinessLocations(prisma, memberA),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "OWNER write does not create the missing table",
    () => createBusinessLocation(prisma, ownerA, { name: "Preview shop" }),
    (error) =>
      error instanceof BusinessLocationUnavailableError &&
      error.message === LOCATION_UNAVAILABLE_MESSAGE,
  );
  const stillMissingAfterWrite = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'BusinessLocation'`,
  );
  check(
    "OWNER write left the missing table absent",
    stillMissingAfterWrite[0]?.n === 0 &&
      !ddlCalls.some((sql) => /CREATE TABLE|ALTER TABLE|CREATE INDEX/i.test(sql)),
  );

  if (failures > 0) {
    console.error(`\n${failures} business-location check(s) failed.`);
    process.exit(1);
  }
  console.log("\nBusiness location checks passed.");
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}
