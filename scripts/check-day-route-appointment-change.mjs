/**
 * OWNER day-route appointment-window change.
 *
 * Proves authorization, tenant isolation, conflict handling, concurrent
 * stale writes, recorded-order refresh, and no automatic customer message.
 * Page load stays read-only. Does not claim traffic optimization.
 *
 * Run with:
 *   npm run test:day-route-appointment-change
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for owner day-route appointment checks.");
  process.exit(generateEarly.status ?? 1);
}

const { ForbiddenError } = await import("@/lib/authorization");
const { businessScope, assertBusinessRecord } = await import("@/lib/access-scope");
const { zonedCivilToUtc } = await import("@/lib/business-timezone");
const {
  OWNER_DAY_ROUTE_CHANGE_NO_CUSTOMER_MESSAGE,
  OWNER_DAY_ROUTE_CHANGE_OWNER_ONLY_MESSAGE,
  OWNER_DAY_ROUTE_CHANGE_STALE_MESSAGE,
  OWNER_DAY_ROUTE_MUTATIONS_ON_LOAD,
  changeOwnerDayRouteAppointment,
  loadOwnerDayRoute,
  ownerDayRouteTextHasForbiddenClaim,
} = await import("@/lib/owner-day-route");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function readSrc(relative) {
  return readFileSync(join(root, relative), "utf8");
}

const changeSrc = readSrc("src/lib/owner-day-route/change-appointment.ts");
const loadSrc = readSrc("src/lib/owner-day-route/load.ts");
const pageSrc = readSrc("src/app/(app)/today/day-route/page.tsx");
const uiSrc = readSrc("src/components/today/owner-day-route.tsx");
const formSrc = readSrc("src/components/today/owner-day-route-reschedule.tsx");
const actionSrc = readSrc("src/app/actions/owner-day-route.ts");
const navSrc = readSrc("src/lib/nav.ts");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_owner_day_route_appointment_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

{
  const { PrismaClient: AdminPrisma } = createRequire(import.meta.url)("@prisma/client");
  const admin = new AdminPrisma({ datasourceUrl: baseUrl });
  await admin.$queryRawUnsafe(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    testDbName,
  );
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${testDbName}"`);
  await admin.$disconnect();
}

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for owner day-route appointment test database.");
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

async function expectError(label, run, predicate) {
  try {
    await run();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: { role, membership: { id: membershipId }, business: { name: "Day Route Co" } },
    scope: businessScope(businessId),
    assertOwned(record) {
      return assertBusinessRecord(record, businessId);
    },
  };
}

const NY = "America/New_York";

try {
  console.log("\nSTATIC — Day-route change stays explicit and silent");
  check("Page load stays read-only", OWNER_DAY_ROUTE_MUTATIONS_ON_LOAD === false);
  check(
    "Loader does not write jobs",
    !/\.(create|update|delete|upsert|updateMany)\(/.test(loadSrc),
  );
  check(
    "Page does not call scheduleJob or change global nav",
    !pageSrc.includes("scheduleJob") &&
      !navSrc.includes("day-route") &&
      pageSrc.includes("viewerRole"),
  );
  check(
    "Write path reuses schedule gates and never notifies customers",
    changeSrc.includes("evaluateProposedSchedule") &&
      changeSrc.includes("detectScheduleConflicts") &&
      changeSrc.includes("shouldAcceptConflictAcknowledgement") &&
      changeSrc.includes("parseScheduleStart") &&
      changeSrc.includes("pickupDurationMinutes") &&
      !changeSrc.includes("notifyCustomer") &&
      !changeSrc.includes("attemptAppointment") &&
      !changeSrc.includes("emitAndProcessBusinessEvent"),
  );
  check(
    "UI does not claim traffic optimization",
    !ownerDayRouteTextHasForbiddenClaim(uiSrc) &&
      !ownerDayRouteTextHasForbiddenClaim(formSrc) &&
      formSrc.includes("OWNER_DAY_ROUTE_CHANGE_NO_CUSTOMER_MESSAGE"),
  );
  check(
    "Action revalidates the day-route path",
    actionSrc.includes("revalidatePath(OWNER_DAY_ROUTE_PATH)") &&
      actionSrc.includes("changeOwnerDayRouteAppointment"),
  );

  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Route",
      slug: `alpha-route-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: NY,
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Route",
      slug: `beta-route-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: NY,
    },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-route-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Amir Admin", email: `admin-route-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-route-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaOwner = await prisma.user.create({
    data: { name: "Bea Owner", email: `beta-route-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const adminMem = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: businessA.id, role: "ADMIN" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const betaMem = await prisma.membership.create({
    data: { userId: betaOwner.id, businessId: businessB.id, role: "OWNER" },
  });
  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaMem.id);

  const day = zonedCivilToUtc(2026, 11, 2, 9, 0, 0, NY);
  const later = zonedCivilToUtc(2026, 11, 2, 11, 0, 0, NY);
  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Ada Homeowner", phone: "2395550111" },
  });
  const customerB = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Secret", phone: "2395550222" },
  });
  const propertyA = await prisma.property.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      addressLine1: "10 Maple St",
      city: "Austin",
      region: "TX",
      postalCode: "78701",
    },
  });
  const propertyLate = await prisma.property.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      addressLine1: "500 Oak Blvd",
      city: "Austin",
      region: "TX",
      postalCode: "78704",
    },
  });
  const propertyB = await prisma.property.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      addressLine1: "77 Foreign Ave",
      city: "Dallas",
      region: "TX",
      postalCode: "75002",
    },
  });
  const earlyJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      status: "SCHEDULED",
      scheduledAt: day,
      scheduledDurationMinutes: 60,
      pickupDurationMinutes: 30,
      projectToken: randomUUID(),
    },
  });
  const lateJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyLate.id,
      status: "SCHEDULED",
      scheduledAt: later,
      scheduledDurationMinutes: 60,
      projectToken: randomUUID(),
    },
  });
  const foreignJob = await prisma.job.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      propertyId: propertyB.id,
      status: "SCHEDULED",
      scheduledAt: day,
      scheduledDurationMinutes: 60,
      projectToken: randomUUID(),
    },
  });

  console.log("\nTEST — Authorization");
  await expectError(
    "MEMBER cannot change a day-route appointment",
    () =>
      changeOwnerDayRouteAppointment(prisma, memberA, {
        jobId: earlyJob.id,
        date: "2026-11-02",
        time: "16:00",
        expectedScheduledAt: day.toISOString(),
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "ADMIN cannot change a day-route appointment",
    () =>
      changeOwnerDayRouteAppointment(prisma, adminA, {
        jobId: earlyJob.id,
        date: "2026-11-02",
        time: "16:00",
        expectedScheduledAt: day.toISOString(),
      }),
    (error) =>
      error instanceof Error && error.message === OWNER_DAY_ROUTE_CHANGE_OWNER_ONLY_MESSAGE,
  );
  const deniedForeign = await changeOwnerDayRouteAppointment(prisma, ownerA, {
    jobId: foreignJob.id,
    date: "2026-11-02",
    time: "16:00",
    expectedScheduledAt: day.toISOString(),
  }).catch((error) => error);
  check(
    "OWNER A cannot change a job in business B",
    deniedForeign instanceof Error || deniedForeign.ok === false,
  );
  const foreignUnchanged = await prisma.job.findFirst({
    where: { id: foreignJob.id, businessId: businessB.id },
    select: { scheduledAt: true },
  });
  check("Foreign job schedule is unchanged", foreignUnchanged?.scheduledAt.getTime() === day.getTime());

  console.log("\nTEST — OWNER change refreshes recorded order");
  const moved = await changeOwnerDayRouteAppointment(prisma, ownerA, {
    jobId: earlyJob.id,
    date: "2026-11-02",
    time: "14:00",
    durationPreset: "60",
    pickupDurationMinutes: 30,
    expectedScheduledAt: day.toISOString(),
  });
  check(
    "OWNER change succeeds without a customer-message claim",
    moved.ok === true && moved.message === OWNER_DAY_ROUTE_CHANGE_NO_CUSTOMER_MESSAGE,
  );
  const afterMove = await loadOwnerDayRoute(prisma, {
    businessId: businessA.id,
    role: "OWNER",
    date: "2026-11-02",
    timeZone: NY,
  });
  check(
    "Recorded-order route lists the moved window first",
    afterMove.stops.map((stop) => stop.jobId).join(",") === `${lateJob.id},${earlyJob.id}`,
  );
  check(
    "Unmoved stop keeps pickup minutes",
    afterMove.stops.find((stop) => stop.jobId === earlyJob.id)?.pickupDurationMinutes === 30,
  );
  check(
    "No customer communication was written",
    (await prisma.customerCommunication.count({ where: { businessId: businessA.id } })) === 0,
  );

  console.log("\nTEST — Conflict handling");
  const earlyAfterMove = await prisma.job.findFirst({
    where: { id: earlyJob.id, businessId: businessA.id },
    select: { scheduledAt: true },
  });
  const overlap = await changeOwnerDayRouteAppointment(prisma, ownerA, {
    jobId: earlyJob.id,
    date: "2026-11-02",
    time: "11:00",
    durationPreset: "60",
    pickupDurationMinutes: 30,
    expectedScheduledAt: earlyAfterMove.scheduledAt.toISOString(),
  });
  const earlyStill = await prisma.job.findFirst({
    where: { id: earlyJob.id, businessId: businessA.id },
    select: { scheduledAt: true },
  });
  check(
    "Overlapping window without acknowledgement does not write",
    overlap.ok === false &&
      Boolean(overlap.warning) &&
      Boolean(overlap.conflictAck) &&
      earlyStill?.scheduledAt.getTime() === earlyAfterMove.scheduledAt.getTime(),
  );
  const accepted = await changeOwnerDayRouteAppointment(prisma, ownerA, {
    jobId: earlyJob.id,
    date: "2026-11-02",
    time: "11:00",
    durationPreset: "60",
    pickupDurationMinutes: 30,
    expectedScheduledAt: earlyAfterMove.scheduledAt.toISOString(),
    confirmOverlapAck: overlap.conflictAck,
  });
  check("Acknowledged conflict can be saved", accepted.ok === true);

  console.log("\nTEST — Concurrent stale submission");
  const current = await prisma.job.findFirst({
    where: { id: earlyJob.id, businessId: businessA.id },
    select: { scheduledAt: true },
  });
  const first = await changeOwnerDayRouteAppointment(prisma, ownerA, {
    jobId: earlyJob.id,
    date: "2026-11-02",
    time: "14:00",
    durationPreset: "60",
    pickupDurationMinutes: 30,
    expectedScheduledAt: current.scheduledAt.toISOString(),
  });
  const second = await changeOwnerDayRouteAppointment(prisma, ownerA, {
    jobId: earlyJob.id,
    date: "2026-11-02",
    time: "15:00",
    durationPreset: "60",
    pickupDurationMinutes: 30,
    expectedScheduledAt: current.scheduledAt.toISOString(),
  });
  check("First concurrent write wins", first.ok === true);
  check(
    "Stale concurrent write is rejected",
    second.ok === false && second.error === OWNER_DAY_ROUTE_CHANGE_STALE_MESSAGE,
  );
  const afterRace = await prisma.job.findFirst({
    where: { id: earlyJob.id, businessId: businessA.id },
    select: { scheduledAt: true },
  });
  check(
    "Winning write is the recorded window",
    afterRace?.scheduledAt.toISOString() === first.scheduledAt,
  );

  const betaTry = await changeOwnerDayRouteAppointment(prisma, ownerB, {
    jobId: earlyJob.id,
    date: "2026-11-02",
    time: "08:00",
    expectedScheduledAt: afterRace.scheduledAt.toISOString(),
  }).catch((error) => error);
  check(
    "Owner B cannot mutate A's job",
    betaTry instanceof Error || betaTry.ok === false,
  );
} finally {
  await prisma.$disconnect();
}

console.log(
  failures === 0
    ? "\nAll owner day-route appointment checks passed."
    : `\n${failures} owner day-route appointment check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
