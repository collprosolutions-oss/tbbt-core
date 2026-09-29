/**
 * OWNER Job location assignment and owner-schedule location filter.
 *
 * Dedicated test database: tbbt_job_location_assignment_test
 *
 * Proves authorization, isolation, historical-job behavior, and
 * stale/concurrent edits. Assignment writes only Job.businessLocationId
 * on the existing BusinessLocation migration column.
 *
 * Run with:
 *   npm run test:job-location-assignment
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError } = await import("@/lib/authorization");
const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const {
  JOB_LOCATION_ADDITIVE_MESSAGE,
  JOB_LOCATION_FILTER_ALL,
  JOB_LOCATION_FILTER_UNASSIGNED,
  JOB_LOCATION_INACTIVE_MESSAGE,
  JOB_LOCATION_MISSING_JOB_MESSAGE,
  JOB_LOCATION_NOT_OWNED_MESSAGE,
  JOB_LOCATION_OWNER_ONLY_MESSAGE,
  JOB_LOCATION_STALE_MESSAGE,
  jobLocationFilterWhere,
  jobLocationSnapshotsEqual,
  parseOwnerScheduleLocationFilter,
} = await import("@/lib/job-location");
const {
  JobLocationError,
  assignJobBusinessLocation,
} = await import("@/lib/job-location-ops");
const { createBusinessLocation, setBusinessLocationStatus } = await import(
  "@/lib/business-location-ops"
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_job_location_assignment_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;

const adminUrl = new URL(baseUrl);
adminUrl.search = "";
const createDb = spawnSync("psql", [adminUrl.toString(), "-c", `CREATE DATABASE "${testDbName}"`], {
  encoding: "utf8",
});
if (createDb.status !== 0 && !/already exists/i.test(`${createDb.stderr}${createDb.stdout}`)) {
  console.warn(createDb.stderr || createDb.stdout);
}

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for job-location assignment test database.");
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
  !migrationNames.some((name) => /job.location|location.assignment/i.test(name)),
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
    jobsPage.includes("parseOwnerScheduleLocationFilter") &&
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
check("Additive copy is present", /does not change timezone, Stripe/.test(JOB_LOCATION_ADDITIVE_MESSAGE));
check(
  "Invalid schedule location query fails closed to all",
  parseOwnerScheduleLocationFilter("not a location") === JOB_LOCATION_FILTER_ALL &&
    parseOwnerScheduleLocationFilter(undefined) === JOB_LOCATION_FILTER_ALL &&
    parseOwnerScheduleLocationFilter("unassigned") === JOB_LOCATION_FILTER_UNASSIGNED,
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
  const otherLiveJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      status: "UNSCHEDULED",
      projectToken: randomUUID(),
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
      },
      orderBy: { id: "asc" },
    });
    return { business, payment, jobs };
  }

  const beforeA = await snapshotBoundaries(businessA.id);
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
      otherRow.businessLocationId === null,
  );
  check("Assigned job status is unchanged", assignedRow.status === "SCHEDULED");

  console.log("\nTEST — Historical job remains valid, then can be assigned");
  const historicalFresh = await prisma.job.findFirstOrThrow({ where: { id: historicalJob.id } });
  const historicalAssigned = await assignJobBusinessLocation(prisma, ownerA, {
    jobId: historicalJob.id,
    locationId: locationA2.id,
    expectedUpdatedAt: historicalFresh.updatedAt.toISOString(),
  });
  check(
    "OWNER can assign a location to a historical completed job",
    historicalAssigned.businessLocationId === locationA2.id &&
      historicalAssigned.status === "COMPLETED" &&
      historicalAssigned.customerId === customerA.id &&
      historicalAssigned.propertyId === propertyA.id,
  );
  const afterHistorical = await snapshotBoundaries(businessA.id);
  check(
    "Historical assignment still leaves timezone and Stripe untouched",
    afterHistorical.business.timezone === "America/Los_Angeles" &&
      afterHistorical.payment.stripeAccountId === paymentA.stripeAccountId,
  );

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
  check("All-locations filter keeps every same-business job", allA.length === 3);
  check(
    "Location filter shows only the Reno job",
    renoOnly.length === 1 && renoOnly[0].id === liveJob.id,
  );
  check(
    "Location filter shows only the Sparks historical job",
    sparksOnly.length === 1 && sparksOnly[0].id === historicalJob.id,
  );
  check(
    "Unassigned filter shows the remaining same-business job",
    unassignedOnly.length === 1 && unassignedOnly[0].id === otherLiveJob.id,
  );
  check(
    "Filtering A by B's location id does not leak B jobs",
    foreignFilter.length === 0 && !foreignFilter.some((job) => job.businessId === businessB.id),
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

  const archived = await setBusinessLocationStatus(prisma, ownerA, {
    locationId: locationA2.id,
    status: "ARCHIVED",
  });
  check("OWNER archived the second location for the write-time check", archived.status === "ARCHIVED");
  const otherFresh = await prisma.job.findFirstOrThrow({ where: { id: otherLiveJob.id } });
  await expectError(
    "Write-time recheck rejects an archived location for a new assignment",
    () =>
      assignJobBusinessLocation(prisma, ownerA, {
        jobId: otherLiveJob.id,
        locationId: locationA2.id,
        expectedUpdatedAt: otherFresh.updatedAt.toISOString(),
      }),
    (error) => error instanceof JobLocationError && error.message === JOB_LOCATION_INACTIVE_MESSAGE,
  );
  const otherAfterArchive = await prisma.job.findFirstOrThrow({ where: { id: otherLiveJob.id } });
  check("Archived-location reject left the unassigned job unassigned", otherAfterArchive.businessLocationId === null);
  const historicalStill = await prisma.job.findFirstOrThrow({ where: { id: historicalJob.id } });
  check(
    "Already-assigned historical job keeps the now-archived location",
    historicalStill.businessLocationId === locationA2.id,
  );

  console.log("\nTEST — Stale and concurrent edits");
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
  const raceResults = await Promise.allSettled([
    assignJobBusinessLocation(prisma, ownerA, {
      jobId: raceJob.id,
      locationId: locationA1.id,
      expectedUpdatedAt: raceSnapshot,
    }),
    assignJobBusinessLocation(prisma, ownerA, {
      jobId: raceJob.id,
      locationId: locationA1.id,
      expectedUpdatedAt: raceSnapshot,
    }),
  ]);
  const raceFulfilled = raceResults.filter((result) => result.status === "fulfilled");
  const raceRejected = raceResults.filter(
    (result) =>
      result.status === "rejected" &&
      result.reason instanceof JobLocationError &&
      result.reason.message === JOB_LOCATION_STALE_MESSAGE,
  );
  const raceFinal = await prisma.job.findFirstOrThrow({ where: { id: raceJob.id } });
  check(
    "Concurrent assigns: one write wins and the other is stale",
    raceFulfilled.length === 1 &&
      raceRejected.length === 1 &&
      raceFinal.businessLocationId === locationA1.id &&
      raceFinal.customerId === customerA.id &&
      raceFinal.propertyId === propertyA.id &&
      raceFinal.businessId === businessA.id,
  );

  const cleared = await assignJobBusinessLocation(prisma, ownerA, {
    jobId: raceJob.id,
    locationId: null,
    expectedUpdatedAt: raceFinal.updatedAt.toISOString(),
  });
  check(
    "OWNER can clear a location without rewriting tenant or property",
    cleared.businessLocationId === null &&
      cleared.customerId === customerA.id &&
      cleared.propertyId === propertyA.id &&
      cleared.businessId === businessA.id,
  );

  const finalA = await snapshotBoundaries(businessA.id);
  check(
    "Final A timezone, Stripe, and tenant id remain the originals",
    finalA.business.timezone === "America/Los_Angeles" &&
      finalA.business.id === businessA.id &&
      finalA.payment.stripeAccountId === `acct_alpha_jobloc_${suffix}`,
  );

  if (failures > 0) {
    console.error(`\n${failures} job-location assignment check(s) failed.`);
    process.exit(1);
  }
  console.log("\nJob location assignment checks passed.");
  console.log(
    "SCHEMA OVERLAP REPORT: reused prisma/migrations/20260927190000_add_business_location (Job.businessLocationId). No new migration. No Business/Stripe/Customer/Property schema change.",
  );
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
