/**
 * OWNER Job location assignment and owner-schedule location filter.
 *
 * Dedicated localhost test database: tbbt_job_location_assignment_test
 *
 * The localhost host guard runs before any @/lib import or Prisma use.
 * CREATE DATABASE failures abort. The test database is always dropped
 * after backends are terminated.
 *
 * Run with:
 *   npm run test:job-location-assignment
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { register } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function assertLocalDatabaseUrl(urlString) {
  if (!urlString) {
    console.error("DATABASE_URL must be set to run this check.");
    process.exit(1);
  }
  let host;
  try {
    host = new URL(urlString).hostname;
  } catch {
    console.error("DATABASE_URL is not a valid URL.");
    process.exit(1);
  }
  if (!LOCAL_HOSTS.has(host)) {
    console.error(
      `Refusing to run job-location assignment checks against host "${host}". Host must be localhost, 127.0.0.1, or ::1.`,
    );
    process.exit(1);
  }
}

assertLocalDatabaseUrl(process.env.DATABASE_URL);

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError } = await import("@/lib/authorization");
const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const {
  JOB_LOCATION_ADDITIVE_MESSAGE,
  JOB_LOCATION_FILTER_ALL,
  JOB_LOCATION_FILTER_UNASSIGNED,
  JOB_LOCATION_INACTIVE_MESSAGE,
  JOB_LOCATION_INVOICED_MESSAGE,
  JOB_LOCATION_MISSING_JOB_MESSAGE,
  JOB_LOCATION_NOT_OWNED_MESSAGE,
  JOB_LOCATION_OWNER_ONLY_MESSAGE,
  JOB_LOCATION_STALE_MESSAGE,
  JOB_LOCATION_TERMINAL_MESSAGE,
  jobLocationFilterWhere,
  jobLocationSnapshotsEqual,
  parseOwnerScheduleLocationFilter,
  ownerScheduleLocationFilterFellBack,
  resolveOwnerScheduleLocationFilter,
} = await import("@/lib/job-location");
const { JobLocationError, assignJobBusinessLocation } = await import("@/lib/job-location-ops");
const {
  createBusinessLocation,
  resolveCopyableBusinessLocationId,
  setBusinessLocationStatus,
} = await import("@/lib/business-location-ops");

const baseUrl = process.env.DATABASE_URL;
const testDbName = "tbbt_job_location_assignment_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;
assertLocalDatabaseUrl(testUrl);

const adminUrl = new URL(baseUrl);
adminUrl.search = "";

function runPsql(sql) {
  return spawnSync("psql", [adminUrl.toString(), "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
  });
}

function dropTestDatabase() {
  const terminate = runPsql(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${testDbName}' AND pid <> pg_backend_pid()`,
  );
  if (terminate.status !== 0) {
    console.warn(terminate.stderr || terminate.stdout);
  }
  const dropped = runPsql(`DROP DATABASE IF EXISTS "${testDbName}"`);
  if (dropped.status !== 0) {
    console.error(dropped.stderr || dropped.stdout);
    process.exitCode = 1;
  }
}

dropTestDatabase();
const createDb = runPsql(`CREATE DATABASE "${testDbName}"`);
if (createDb.status !== 0) {
  console.error(createDb.stderr || createDb.stdout);
  console.error("Failed to create dedicated job-location assignment test database.");
  process.exit(1);
}

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for job-location assignment test database.");
  dropTestDatabase();
  process.exit(push.status ?? 1);
}

function withPrismaParams(urlString, params) {
  const url = new URL(urlString);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });
const holder = new PrismaClient({ datasourceUrl: testUrl });
const racer = new PrismaClient({
  datasourceUrl: withPrismaParams(testUrl, {
    connection_limit: "1",
    application_name: "job-location-racer",
  }),
});
const pendingRacerSettlements = [];

function createDeferred() {
  let resolveFn;
  let rejectFn;
  let settled = false;
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return {
    promise,
    resolve(value) {
      if (settled) return;
      settled = true;
      resolveFn(value);
    },
    reject(error) {
      if (settled) return;
      settled = true;
      rejectFn(error);
    },
  };
}

function startRacerAssign(gate, run) {
  const settled = gate.promise.then(run).then(
    (v) => ({ ok: true, v }),
    (e) => ({ ok: false, e }),
  );
  pendingRacerSettlements.push(settled);
  return settled;
}

async function holdRowAndReleaseRacer(gate, work) {
  try {
    return await holder.$transaction(async (tx) => {
      try {
        return await work(tx);
      } catch (error) {
        gate.reject(error);
        throw error;
      } finally {
        gate.reject(new Error("Holder transaction ended before releasing the assigner."));
      }
    }, { timeout: 15000 });
  } catch (error) {
    gate.reject(error);
    throw error;
  }
}

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
    scope: businessScope(businessId),
    assertOwned(record) {
      return assertBusinessRecord(record, businessId);
    },
    assertAttachable(record) {
      return assertBusinessRecord(record, businessId);
    },
  };
}

function readRepo(relPath) {
  return readFileSync(new URL(`../${relPath}`, import.meta.url), "utf8");
}

async function readBackendPid(client) {
  const rows = await client.$queryRaw`SELECT pg_backend_pid()::int AS pid`;
  return Number(rows[0]?.pid);
}

async function waitUntilPeerLockWait(racerPid, timeoutMs = 8000) {
  if (!Number.isInteger(racerPid) || racerPid <= 0) {
    throw new Error("Racer backend pid is required to wait on a row lock.");
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS n
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND (
          pid = ${racerPid}
          OR application_name = 'job-location-racer'
        )
    `;
    if ((rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Peer transaction did not wait on a row lock.");
}

const schema = readRepo("prisma/schema.prisma");
const locationMigration = readRepo(
  "prisma/migrations/20260927190000_add_business_location/migration.sql",
);
const opsSource = readRepo("src/lib/job-location-ops.ts");
const helperSource = readRepo("src/lib/job-location.ts");
const actionSource = readRepo("src/app/actions/job-location.ts");
const jobActions = readRepo("src/app/actions/job.ts");
const jobsPage = readRepo("src/app/(app)/jobs/page.tsx");
const jobPage = readRepo("src/app/(app)/jobs/[jobId]/page.tsx");
const authorizationSource = readRepo("src/lib/authorization.ts");
const locationOps = readRepo("src/lib/business-location-ops.ts");
const thisScript = readRepo("scripts/check-job-location-assignment.mjs");
const nextBookingOps = readRepo("src/lib/cleaning-next-booking-ops.ts");
const correctiveOps = readRepo("src/lib/cleaning-corrective-clean-ops.ts");
const recurringOps = readRepo("src/lib/cleaning-recurring-booking-ops.ts");
const migrationsDir = new URL("../prisma/migrations", import.meta.url);
const migrationNames = readdirSync(migrationsDir).filter((name) =>
  existsSync(new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url)),
);
const overlappingLocationMigrations = migrationNames.filter((name) => {
  const sql = readFileSync(new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url), "utf8");
  return /businessLocationId|"BusinessLocation"/.test(sql);
});

console.log("\nSCHEMA OVERLAP — existing BusinessLocation column");
check(
  "No new job-location assignment migration was added",
  !migrationNames.some((name) => /job.location|location.assignment|20260929010800/i.test(name)),
);
check(
  "Assignment reuses the existing nullable Job.businessLocationId column",
  /businessLocationId\s+String\?/.test(schema) &&
    locationMigration.includes('ADD COLUMN IF NOT EXISTS "businessLocationId"') &&
    helperSource.includes("20260927190000_add_business_location"),
);
check(
  "Only the existing location migration mentions Job.businessLocationId",
  overlappingLocationMigrations.length === 1 &&
    overlappingLocationMigrations[0] === "20260927190000_add_business_location",
);
check(
  "Overlap does not rewrite Business, Stripe, Customer, or Property schema",
  !locationMigration.includes('ALTER TABLE "Business"') &&
    !/UPDATE\s+"Business"/i.test(locationMigration) &&
    !/UPDATE\s+"BusinessPaymentAccount"/i.test(locationMigration) &&
    !/UPDATE\s+"Customer"/i.test(locationMigration) &&
    !/UPDATE\s+"Property"/i.test(locationMigration),
);
check(
  "Assignment writes no DDL and no second location column",
  !opsSource.includes("$executeRaw") &&
    !opsSource.includes("CREATE TABLE") &&
    !opsSource.includes("ADD COLUMN") &&
    !helperSource.includes("ensureJobLocationSchema"),
);
check(
  "authorization.ts capability matrix is unchanged",
  !authorizationSource.includes("MANAGE_JOB_LOCATION") &&
    !authorizationSource.includes("JobLocation"),
);
check(
  "Location directory writes still do not assign jobs",
  !locationOps.includes("prisma.job") && !locationOps.includes("businessLocationId:"),
);
check(
  "Existing job.ts schedule writes do not set businessLocationId",
  !jobActions.includes("businessLocationId"),
);
check(
  "Owner schedule filter uses the shared location where helper",
  jobsPage.includes("jobLocationFilterWhere") &&
    jobsPage.includes("resolveOwnerScheduleLocationFilter") &&
    jobsPage.includes("LocationFilterSelect"),
);
check(
  "Work Order assignment is OWNER-gated and snapshot-checked",
  jobPage.includes("AssignJobLocationForm") &&
    jobPage.includes("expectedUpdatedAt") &&
    actionSource.includes("assignJobBusinessLocation"),
);
check(
  "Assignment source never updates timezone, Stripe, customer, or property",
  !opsSource.includes("business.update") &&
    !opsSource.includes("businessPaymentAccount") &&
    !opsSource.includes("timezone:") &&
    !opsSource.includes("customer.update") &&
    !opsSource.includes("property.update") &&
    !actionSource.includes("business.update"),
);
check(
  "Location row is locked FOR SHARE after the Job lock",
  opsSource.includes('FROM "BusinessLocation"') &&
    opsSource.includes("FOR SHARE") &&
    opsSource.indexOf("const locked = await lockTenantOwnedJob") <
      opsSource.lastIndexOf("loadOwnedAssignableLocation("),
);
check(
  "Terminal and invoiced jobs are rejected before write",
  opsSource.includes("JOB_LOCATION_TERMINAL_MESSAGE") &&
    opsSource.includes("JOB_LOCATION_INVOICED_MESSAGE") &&
    opsSource.includes("writeSettingsAuditLog"),
);
check(
  "Directory list is bounded",
  locationOps.includes("BUSINESS_LOCATION_DIRECTORY_LIMIT") && locationOps.includes("take:"),
);
check(
  "Cleaning follow-ups apply the active-location check",
  nextBookingOps.includes("resolveCopyableBusinessLocationId") &&
    correctiveOps.includes("resolveCopyableBusinessLocationId") &&
    recurringOps.includes("resolveCopyableBusinessLocationId"),
);
check(
  "Test script guards localhost before any @/lib import",
  thisScript.indexOf("assertLocalDatabaseUrl(process.env.DATABASE_URL)") <
    thisScript.indexOf('await import("@/lib/authorization")'),
);
check(
  "Failed checks set exitCode and always drop the test database",
  thisScript.includes("process.exitCode = 1") &&
    thisScript.includes("pg_terminate_backend") &&
    thisScript.includes("dropTestDatabase()") &&
    thisScript.includes("pendingRacerSettlements"),
);
const createDbSlice = thisScript.slice(
  thisScript.indexOf("const createDb = runPsql"),
  thisScript.indexOf("const push = spawnSync"),
);
check(
  "CREATE DATABASE fails hard; leftover test DB is dropped first",
  thisScript.indexOf("dropTestDatabase();") < thisScript.indexOf("const createDb = runPsql") &&
    /if \(createDb\.status !== 0\) \{/.test(createDbSlice),
);
check(
  "Barrier uses a deferred gate, settled racer promises, and 15s holder timeout",
  thisScript.includes("createDeferred()") &&
    thisScript.includes("(v) => ({ ok: true, v })") &&
    thisScript.includes("(e) => ({ ok: false, e })") &&
    thisScript.includes("timeout: 15000") &&
    !thisScript.includes("let assignStarted") &&
    !thisScript.includes("archiveAssignStarted"),
);
check(
  "Lock-wait poll is scoped to the racer session",
  thisScript.includes("readBackendPid(racer)") &&
    thisScript.includes("pid = ${racerPid}") &&
    thisScript.includes("application_name = 'job-location-racer'"),
);
check(
  "Today and this-week KPIs apply the location filter",
  jobsPage.includes("...locationWhere,") &&
    jobsPage.includes("JOB_LOCATION_FILTER_UNKNOWN_MESSAGE"),
);
check("Additive copy is present", /does not change timezone, Stripe/.test(JOB_LOCATION_ADDITIVE_MESSAGE));
check(
  "Invalid schedule location query fails closed to all",
  parseOwnerScheduleLocationFilter("not a location") === JOB_LOCATION_FILTER_ALL &&
    parseOwnerScheduleLocationFilter(undefined) === JOB_LOCATION_FILTER_ALL &&
    parseOwnerScheduleLocationFilter("unassigned") === JOB_LOCATION_FILTER_UNASSIGNED,
);
check(
  "Unknown well-formed location id fails closed to all instead of zero jobs",
  resolveOwnerScheduleLocationFilter("clocationunknown", ["clocationknown"]) ===
    JOB_LOCATION_FILTER_ALL &&
    resolveOwnerScheduleLocationFilter("clocationknown", ["clocationknown"]) === "clocationknown" &&
    ownerScheduleLocationFilterFellBack("clocationunknown", ["clocationknown"]) &&
    !ownerScheduleLocationFilterFellBack("clocationknown", ["clocationknown"]) &&
    !ownerScheduleLocationFilterFellBack(undefined, ["clocationknown"]) &&
    !ownerScheduleLocationFilterFellBack("all", ["clocationknown"]),
);
check(
  "Location filter where matches unassigned and a specific id",
  jobLocationFilterWhere(JOB_LOCATION_FILTER_ALL).businessLocationId === undefined &&
    jobLocationFilterWhere(JOB_LOCATION_FILTER_UNASSIGNED).businessLocationId === null &&
    jobLocationFilterWhere("clocation1").businessLocationId === "clocation1",
);
check(
  "Snapshot compare is exact-time, fail-closed",
  jobLocationSnapshotsEqual("2026-09-29T00:00:00.000Z", new Date("2026-09-29T00:00:00.000Z")) &&
    !jobLocationSnapshotsEqual("2026-09-29T00:00:00.000Z", new Date("2026-09-29T00:00:01.000Z")) &&
    !jobLocationSnapshotsEqual("not-a-date", new Date()),
);

try {
  const suffix = randomUUID().slice(0, 8);
  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Job Locations",
      slug: `alpha-job-loc-${suffix}`,
      tradeCode: "HANDYMAN",
      timezone: "America/Los_Angeles",
      publicServiceAreaLabel: "Reno, NV",
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Job Locations",
      slug: `beta-job-loc-${suffix}`,
      tradeCode: "HANDYMAN",
      timezone: "America/New_York",
      publicServiceAreaLabel: "Fort Myers, FL",
    },
  });

  const ownerAUser = await prisma.user.create({
    data: { name: "Olivia", email: `owner-a-jobloc-${suffix}@example.com`, passwordHash: "x" },
  });
  const adminAUser = await prisma.user.create({
    data: { name: "Ada", email: `admin-a-jobloc-${suffix}@example.com`, passwordHash: "x" },
  });
  const memberAUser = await prisma.user.create({
    data: { name: "Mia", email: `member-a-jobloc-${suffix}@example.com`, passwordHash: "x" },
  });
  const ownerBUser = await prisma.user.create({
    data: { name: "Ben", email: `owner-b-jobloc-${suffix}@example.com`, passwordHash: "x" },
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
      stripeAccountId: `acct_alpha_jobloc_${suffix}`,
    },
  });
  const paymentB = await prisma.businessPaymentAccount.create({
    data: {
      businessId: businessB.id,
      provider: "stripe",
      stripeAccountId: `acct_beta_jobloc_${suffix}`,
    },
  });

  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Historical Customer" },
  });
  const propertyA = await prisma.property.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      addressLine1: "10 Virginia St",
      city: "Reno",
      region: "NV",
      postalCode: "89501",
    },
  });
  const historicalJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      status: "COMPLETED",
      updatedAt: new Date("2020-01-15T00:00:00.000Z"),
      projectToken: randomUUID(),
    },
  });
  const cancelledJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      status: "CANCELLED",
      updatedAt: new Date("2020-02-15T00:00:00.000Z"),
      projectToken: randomUUID(),
    },
  });
  const liveJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      status: "SCHEDULED",
      scheduledAt: new Date("2026-09-29T17:00:00.000Z"),
      projectToken: randomUUID(),
    },
  });
  const sparksJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      status: "SCHEDULED",
      scheduledAt: new Date("2026-09-30T17:00:00.000Z"),
      projectToken: randomUUID(),
    },
  });
  const otherLiveJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      status: "UNSCHEDULED",
      projectToken: randomUUID(),
    },
  });
  const invoicedJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      status: "SCHEDULED",
      scheduledAt: new Date("2026-10-01T17:00:00.000Z"),
      projectToken: randomUUID(),
    },
  });
  await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      jobId: invoicedJob.id,
      status: "DRAFT",
      total: 100,
    },
  });
  const jobB = await prisma.job.create({
    data: {
      businessId: businessB.id,
      status: "SCHEDULED",
      scheduledAt: new Date("2026-09-29T18:00:00.000Z"),
      projectToken: randomUUID(),
    },
  });

  const locationA1 = await createBusinessLocation(prisma, ownerA, {
    name: "Reno shop",
    city: "Reno",
    region: "NV",
  });
  const locationA2 = await createBusinessLocation(prisma, ownerA, {
    name: "Sparks shop",
    city: "Sparks",
    region: "NV",
  });
  const locationB = await createBusinessLocation(prisma, ownerB, {
    name: "Fort Myers shop",
    city: "Fort Myers",
    region: "FL",
  });

  async function snapshotBoundaries(businessId) {
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true, timezone: true, slug: true },
    });
    const payment = await prisma.businessPaymentAccount.findUnique({
      where: { businessId },
      select: { id: true, stripeAccountId: true },
    });
    const jobs = await prisma.job.findMany({
      where: { businessId },
      select: {
        id: true,
        businessId: true,
        customerId: true,
        propertyId: true,
        businessLocationId: true,
        status: true,
        updatedAt: true,
      },
      orderBy: { id: "asc" },
    });
    return { business, payment, jobs };
  }

  const beforeA = await snapshotBoundaries(businessA.id);
  const historicalBefore = beforeA.jobs.find((job) => job.id === historicalJob.id);
  check(
    "Historical and new jobs start unassigned",
    historicalJob.businessLocationId === null &&
      liveJob.businessLocationId === null &&
      otherLiveJob.businessLocationId === null,
  );

  console.log("\nTEST — Authorization");
  await expectError(
    "MEMBER cannot assign a location",
    () =>
      assignJobBusinessLocation(prisma, memberA, {
        jobId: liveJob.id,
        locationId: locationA1.id,
        expectedUpdatedAt: liveJob.updatedAt.toISOString(),
      }),
    (error) => error instanceof ForbiddenError && error.message === JOB_LOCATION_OWNER_ONLY_MESSAGE,
  );
  await expectError(
    "ADMIN cannot assign a location",
    () =>
      assignJobBusinessLocation(prisma, adminA, {
        jobId: liveJob.id,
        locationId: locationA1.id,
        expectedUpdatedAt: liveJob.updatedAt.toISOString(),
      }),
    (error) => error instanceof ForbiddenError && error.message === JOB_LOCATION_OWNER_ONLY_MESSAGE,
  );
  const assigned = await assignJobBusinessLocation(prisma, ownerA, {
    jobId: liveJob.id,
    locationId: locationA1.id,
    expectedUpdatedAt: liveJob.updatedAt.toISOString(),
  });
  check("OWNER can assign a same-business location", assigned.businessLocationId === locationA1.id);

  console.log("\nTEST — Additive write boundaries");
  const afterAssign = await snapshotBoundaries(businessA.id);
  const assignedRow = afterAssign.jobs.find((job) => job.id === liveJob.id);
  const historicalRow = afterAssign.jobs.find((job) => job.id === historicalJob.id);
  const otherRow = afterAssign.jobs.find((job) => job.id === otherLiveJob.id);
  check(
    "Assigning a location does not change Business.timezone",
    afterAssign.business.timezone === "America/Los_Angeles" &&
      afterAssign.business.timezone === beforeA.business.timezone,
  );
  check(
    "Assigning a location does not change tenant ownership",
    afterAssign.business.id === businessA.id &&
      assignedRow.businessId === businessA.id &&
      assigned.businessId === businessA.id,
  );
  check(
    "Assigning a location does not change the customer property",
    assignedRow.customerId === customerA.id &&
      assignedRow.propertyId === propertyA.id &&
      assigned.customerId === customerA.id &&
      assigned.propertyId === propertyA.id,
  );
  check(
    "Assigning a location does not change the Stripe account",
    afterAssign.payment.id === paymentA.id &&
      afterAssign.payment.stripeAccountId === paymentA.stripeAccountId &&
      afterAssign.payment.stripeAccountId !== paymentB.stripeAccountId,
  );
  check(
    "Historical jobs stay unassigned when another job is assigned",
    historicalRow.businessLocationId === null &&
      historicalRow.status === "COMPLETED" &&
      historicalRow.updatedAt.getTime() === historicalBefore.updatedAt.getTime() &&
      otherRow.businessLocationId === null,
  );
  check("Assigned job status is unchanged", assignedRow.status === "SCHEDULED");
  const assignAudits = await prisma.settingsAuditLog.findMany({
    where: {
      businessId: businessA.id,
      settingArea: "locations",
      settingKey: "job.businessLocation.assign",
    },
  });
  check(
    "Successful assignment writes a locations audit row",
    assignAudits.length === 1 &&
      assignAudits[0].changedByMembershipId === ownerAMem.id &&
      assignAudits[0].newValue?.includes(locationA1.id),
  );

  console.log("\nTEST — Historical / terminal / invoiced jobs are not rewritten");
  const historicalFresh = await prisma.job.findFirstOrThrow({ where: { id: historicalJob.id } });
  await expectError(
    "OWNER cannot assign a location to a completed historical job",
    () =>
      assignJobBusinessLocation(prisma, ownerA, {
        jobId: historicalJob.id,
        locationId: locationA2.id,
        expectedUpdatedAt: historicalFresh.updatedAt.toISOString(),
      }),
    (error) => error instanceof JobLocationError && error.message === JOB_LOCATION_TERMINAL_MESSAGE,
  );
  const historicalAfterReject = await prisma.job.findFirstOrThrow({ where: { id: historicalJob.id } });
  check(
    "Rejected historical assign leaves location, status, and updatedAt unchanged",
    historicalAfterReject.businessLocationId === null &&
      historicalAfterReject.status === "COMPLETED" &&
      historicalAfterReject.updatedAt.getTime() === historicalFresh.updatedAt.getTime() &&
      historicalAfterReject.customerId === customerA.id &&
      historicalAfterReject.propertyId === propertyA.id,
  );
  await expectError(
    "OWNER cannot assign a location to a cancelled job",
    () =>
      assignJobBusinessLocation(prisma, ownerA, {
        jobId: cancelledJob.id,
        locationId: locationA2.id,
        expectedUpdatedAt: cancelledJob.updatedAt.toISOString(),
      }),
    (error) => error instanceof JobLocationError && error.message === JOB_LOCATION_TERMINAL_MESSAGE,
  );
  await expectError(
    "OWNER cannot assign a location to an invoiced job",
    () =>
      assignJobBusinessLocation(prisma, ownerA, {
        jobId: invoicedJob.id,
        locationId: locationA1.id,
        expectedUpdatedAt: invoicedJob.updatedAt.toISOString(),
      }),
    (error) => error instanceof JobLocationError && error.message === JOB_LOCATION_INVOICED_MESSAGE,
  );
  const invoicedAfter = await prisma.job.findFirstOrThrow({ where: { id: invoicedJob.id } });
  check(
    "Rejected invoiced assign leaves location and updatedAt unchanged",
    invoicedAfter.businessLocationId === null &&
      invoicedAfter.updatedAt.getTime() === invoicedJob.updatedAt.getTime(),
  );
  const afterHistorical = await snapshotBoundaries(businessA.id);
  check(
    "Historical reject still leaves timezone and Stripe untouched",
    afterHistorical.business.timezone === "America/Los_Angeles" &&
      afterHistorical.payment.stripeAccountId === paymentA.stripeAccountId,
  );

  const sparksAssigned = await assignJobBusinessLocation(prisma, ownerA, {
    jobId: sparksJob.id,
    locationId: locationA2.id,
    expectedUpdatedAt: sparksJob.updatedAt.toISOString(),
  });
  check("OWNER can assign a second open job to the Sparks location", sparksAssigned.businessLocationId === locationA2.id);

  console.log("\nTEST — Owner schedule filter");
  const scopedA = { businessId: businessA.id };
  const allA = await prisma.job.findMany({
    where: { ...scopedA, ...jobLocationFilterWhere(JOB_LOCATION_FILTER_ALL) },
    select: { id: true, businessLocationId: true },
  });
  const renoOnly = await prisma.job.findMany({
    where: { ...scopedA, ...jobLocationFilterWhere(locationA1.id) },
    select: { id: true },
  });
  const sparksOnly = await prisma.job.findMany({
    where: { ...scopedA, ...jobLocationFilterWhere(locationA2.id) },
    select: { id: true },
  });
  const unassignedOnly = await prisma.job.findMany({
    where: { ...scopedA, ...jobLocationFilterWhere(JOB_LOCATION_FILTER_UNASSIGNED) },
    select: { id: true },
  });
  const foreignFilter = await prisma.job.findMany({
    where: { ...scopedA, ...jobLocationFilterWhere(locationB.id) },
    select: { id: true, businessId: true },
  });
  check("All-locations filter keeps every same-business job", allA.length === 6);
  check(
    "Location filter shows only the Reno job",
    renoOnly.length === 1 && renoOnly[0].id === liveJob.id,
  );
  check(
    "Location filter shows only the Sparks open job",
    sparksOnly.length === 1 && sparksOnly[0].id === sparksJob.id,
  );
  check(
    "Unassigned filter does not invent a location for historical jobs",
    unassignedOnly.some((job) => job.id === historicalJob.id) &&
      unassignedOnly.some((job) => job.id === otherLiveJob.id) &&
      !unassignedOnly.some((job) => job.id === liveJob.id),
  );
  check(
    "Filtering A by B's location id does not leak B jobs",
    foreignFilter.length === 0 && !foreignFilter.some((job) => job.businessId === businessB.id),
  );
  check(
    "Unknown directory id resolves to all instead of an empty schedule",
    resolveOwnerScheduleLocationFilter(locationB.id, [locationA1.id, locationA2.id]) ===
      JOB_LOCATION_FILTER_ALL,
  );

  console.log("\nTEST — Isolation and write-time ownership recheck");
  const liveFresh = await prisma.job.findFirstOrThrow({ where: { id: liveJob.id } });
  await expectError(
    "OWNER A cannot assign B's location to A's job",
    () =>
      assignJobBusinessLocation(prisma, ownerA, {
        jobId: liveJob.id,
        locationId: locationB.id,
        expectedUpdatedAt: liveFresh.updatedAt.toISOString(),
      }),
    (error) => error instanceof JobLocationError && error.message === JOB_LOCATION_NOT_OWNED_MESSAGE,
  );
  const afterCrossLocation = await prisma.job.findFirstOrThrow({ where: { id: liveJob.id } });
  check(
    "Rejected cross-tenant location leaves the job on A's location",
    afterCrossLocation.businessLocationId === locationA1.id,
  );
  await expectError(
    "OWNER A cannot assign a location onto B's job",
    () =>
      assignJobBusinessLocation(prisma, ownerA, {
        jobId: jobB.id,
        locationId: locationA1.id,
        expectedUpdatedAt: jobB.updatedAt.toISOString(),
      }),
    (error) =>
      error instanceof JobLocationError && error.message === JOB_LOCATION_MISSING_JOB_MESSAGE,
  );
  const jobBAfter = await prisma.job.findFirstOrThrow({ where: { id: jobB.id } });
  check("B's job stays unassigned and on tenant B", jobBAfter.businessLocationId === null && jobBAfter.businessId === businessB.id);
  const afterB = await snapshotBoundaries(businessB.id);
  check(
    "B timezone and Stripe stay isolated from A's assignment work",
    afterB.business.timezone === "America/New_York" &&
      afterB.payment.stripeAccountId === paymentB.stripeAccountId,
  );

  const copiedActive = await resolveCopyableBusinessLocationId(prisma, businessA.id, locationA1.id);
  const copiedMissing = await resolveCopyableBusinessLocationId(prisma, businessA.id, locationB.id);
  check(
    "Copyable location helper keeps an ACTIVE same-business location",
    copiedActive === locationA1.id && copiedMissing === null,
  );

  console.log("\nTEST — Stale edits and real concurrent barriers");
  const concurrentJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      status: "SCHEDULED",
      scheduledAt: new Date("2026-09-30T17:00:00.000Z"),
      projectToken: randomUUID(),
    },
  });
  await expectError(
    "Stale expectedUpdatedAt is rejected before write",
    () =>
      assignJobBusinessLocation(prisma, ownerA, {
        jobId: concurrentJob.id,
        locationId: locationA1.id,
        expectedUpdatedAt: new Date("2019-01-01T00:00:00.000Z").toISOString(),
      }),
    (error) => error instanceof JobLocationError && error.message === JOB_LOCATION_STALE_MESSAGE,
  );
  const staleAfter = await prisma.job.findFirstOrThrow({ where: { id: concurrentJob.id } });
  check(
    "Stale write left location, customer, and property unchanged",
    staleAfter.businessLocationId === null &&
      staleAfter.customerId === customerA.id &&
      staleAfter.propertyId === propertyA.id,
  );

  await prisma.job.update({
    where: { id: concurrentJob.id },
    data: { scheduledDurationMinutes: 90 },
  });
  await expectError(
    "A concurrent schedule edit makes the location snapshot stale",
    () =>
      assignJobBusinessLocation(prisma, ownerA, {
        jobId: concurrentJob.id,
        locationId: locationA1.id,
        expectedUpdatedAt: concurrentJob.updatedAt.toISOString(),
      }),
    (error) => error instanceof JobLocationError && error.message === JOB_LOCATION_STALE_MESSAGE,
  );

  const raceJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      status: "UNSCHEDULED",
      projectToken: randomUUID(),
    },
  });
  const raceSnapshot = raceJob.updatedAt.toISOString();
  const raceGate = createDeferred();
  const racerPid = await readBackendPid(racer);
  const assignSettled = startRacerAssign(raceGate, () =>
    assignJobBusinessLocation(racer, ownerA, {
      jobId: raceJob.id,
      locationId: locationA1.id,
      expectedUpdatedAt: raceSnapshot,
    }),
  );
  try {
    await holdRowAndReleaseRacer(raceGate, async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM "Job"
        WHERE id = ${raceJob.id} AND "businessId" = ${businessA.id}
        FOR UPDATE
      `;
      raceGate.resolve();
      await waitUntilPeerLockWait(racerPid);
      await tx.job.update({
        where: { id: raceJob.id },
        data: { scheduledDurationMinutes: 45 },
      });
    });
  } catch (error) {
    console.error("Assign-vs-edit holder barrier failed:", error);
  }
  const assignResult = await assignSettled;
  const raceError = assignResult.ok ? null : assignResult.e;
  const raceFinal = await prisma.job.findFirstOrThrow({ where: { id: raceJob.id } });
  check(
    "Real two-client barrier: waiting assign sees the held-lock edit as stale",
    raceError instanceof JobLocationError &&
      raceError.message === JOB_LOCATION_STALE_MESSAGE &&
      raceFinal.businessLocationId === null &&
      raceFinal.scheduledDurationMinutes === 45 &&
      raceFinal.customerId === customerA.id &&
      raceFinal.propertyId === propertyA.id &&
      raceFinal.businessId === businessA.id,
  );

  const raceAssigned = await assignJobBusinessLocation(prisma, ownerA, {
    jobId: raceJob.id,
    locationId: locationA1.id,
    expectedUpdatedAt: raceFinal.updatedAt.toISOString(),
  });
  const cleared = await assignJobBusinessLocation(prisma, ownerA, {
    jobId: raceJob.id,
    locationId: null,
    expectedUpdatedAt: raceAssigned.updatedAt.toISOString(),
  });
  check(
    "OWNER can clear a location without rewriting tenant or property",
    cleared.businessLocationId === null &&
      cleared.customerId === customerA.id &&
      cleared.propertyId === propertyA.id &&
      cleared.businessId === businessA.id,
  );

  console.log("\nTEST — Archive vs assign barrier");
  const archiveTarget = await prisma.job.create({
    data: {
      businessId: businessA.id,
      status: "UNSCHEDULED",
      projectToken: randomUUID(),
    },
  });
  const archiveGate = createDeferred();
  const archiveRacerPid = await readBackendPid(racer);
  const archiveAssignSettled = startRacerAssign(archiveGate, () =>
    assignJobBusinessLocation(racer, ownerA, {
      jobId: archiveTarget.id,
      locationId: locationA2.id,
      expectedUpdatedAt: archiveTarget.updatedAt.toISOString(),
    }),
  );
  try {
    await holdRowAndReleaseRacer(archiveGate, async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM "BusinessLocation"
        WHERE id = ${locationA2.id} AND "businessId" = ${businessA.id}
        FOR UPDATE
      `;
      archiveGate.resolve();
      await waitUntilPeerLockWait(archiveRacerPid);
      await tx.businessLocation.update({
        where: { id: locationA2.id },
        data: { status: "ARCHIVED" },
      });
    });
  } catch (error) {
    console.error("Archive-vs-assign holder barrier failed:", error);
  }
  const archiveAssignResult = await archiveAssignSettled;
  const archiveAssignError = archiveAssignResult.ok ? null : archiveAssignResult.e;
  const archiveTargetAfter = await prisma.job.findFirstOrThrow({ where: { id: archiveTarget.id } });
  const locationA2After = await prisma.businessLocation.findFirstOrThrow({
    where: { id: locationA2.id },
  });
  check(
    "Archive-vs-assign barrier rejects after FOR SHARE sees ARCHIVED",
    archiveAssignError instanceof JobLocationError &&
      archiveAssignError.message === JOB_LOCATION_INACTIVE_MESSAGE &&
      archiveTargetAfter.businessLocationId === null &&
      locationA2After.status === "ARCHIVED",
  );

  const otherFresh = await prisma.job.findFirstOrThrow({ where: { id: otherLiveJob.id } });
  await expectError(
    "Write-time recheck rejects an already-archived location for a new assignment",
    () =>
      assignJobBusinessLocation(prisma, ownerA, {
        jobId: otherLiveJob.id,
        locationId: locationA2.id,
        expectedUpdatedAt: otherFresh.updatedAt.toISOString(),
      }),
    (error) => error instanceof JobLocationError && error.message === JOB_LOCATION_INACTIVE_MESSAGE,
  );
  const copiedArchived = await resolveCopyableBusinessLocationId(prisma, businessA.id, locationA2.id);
  check("Copyable location helper refuses an archived location", copiedArchived === null);
  const sparksStill = await prisma.job.findFirstOrThrow({ where: { id: sparksJob.id } });
  check(
    "Already-assigned open job keeps the now-archived location",
    sparksStill.businessLocationId === locationA2.id,
  );

  const finalA = await snapshotBoundaries(businessA.id);
  check(
    "Final A timezone, Stripe, and tenant id remain the originals",
    finalA.business.timezone === "America/Los_Angeles" &&
      finalA.business.id === businessA.id &&
      finalA.payment.stripeAccountId === `acct_alpha_jobloc_${suffix}`,
  );
  const historicalFinal = finalA.jobs.find((job) => job.id === historicalJob.id);
  check(
    "Historical completed job never entered this week's completed bucket",
    historicalFinal.businessLocationId === null &&
      historicalFinal.updatedAt.getTime() === historicalBefore.updatedAt.getTime(),
  );

  if (failures > 0) {
    console.error(`\n${failures} job-location assignment check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log("\nJob location assignment checks passed.");
    console.log(
      "SCHEMA OVERLAP REPORT: reused prisma/migrations/20260927190000_add_business_location (Job.businessLocationId). No new migration. No Business/Stripe/Customer/Property schema change.",
    );
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await Promise.allSettled(pendingRacerSettlements);
  await Promise.allSettled([prisma.$disconnect(), holder.$disconnect(), racer.$disconnect()]);
  dropTestDatabase();
}
