/**
 * OWNER day-route appointment change proofs.
 *
 * Dedicated database: tbbt_day_route_appointment_test
 *
 * Proves OWNER authorization, tenant isolation, conflict rejection,
 * stale/concurrent edits, business timezone, buffers, and material
 * pickup. Does not send a customer message or claim traffic optimization.
 *
 * Run with:
 *   npm run test:day-route-appointment
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for day-route appointment checks.");
  process.exit(generateEarly.status ?? 1);
}

const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const { ForbiddenError } = await import("@/lib/authorization");
const { parseScheduleStart } = await import("@/lib/job-schedule");
const {
  FORBIDDEN_DAY_ROUTE_CLAIM_PATTERNS,
  OWNER_DAY_ROUTE_PATH,
  extractOwnerDayRouteMapsAddresses,
  loadOwnerDayRoute,
  ownerDayRouteMapsFollowsAppointmentOrder,
  ownerDayRouteTextHasForbiddenClaim,
  readOwnerDayRouteScheduleSnapshots,
  scheduleSnapshotFromJob,
} = await import("@/lib/owner-day-route");
const {
  DAY_ROUTE_APPOINTMENT_CHANGED_MESSAGE,
  DAY_ROUTE_APPOINTMENT_COMPLETED_MESSAGE,
  DAY_ROUTE_APPOINTMENT_FORM_NOTE,
  DAY_ROUTE_APPOINTMENT_OWNER_ONLY_MESSAGE,
  DAY_ROUTE_APPOINTMENT_SCHEMA_UNAVAILABLE_MESSAGE,
  DAY_ROUTE_APPOINTMENT_STALE_MESSAGE,
  DAY_ROUTE_APPOINTMENT_UNSCHEDULED_MESSAGE,
} = await import("@/lib/owner-day-route-appointment");
const {
  changeOwnerDayRouteAppointment,
  dayRouteAppointmentErrorMessage,
  missingDayRouteAppointmentSchema,
} = await import("@/lib/owner-day-route-appointment-ops");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run the day-route appointment check.");
  process.exit(1);
}

const testDbName = "tbbt_day_route_appointment_test";
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
  console.error("Failed to push schema for day-route appointment test database.");
  process.exit(push.status ?? 1);
}

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

async function expectThrow(label, fn, predicate) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

function makeAccess(businessId, role, membershipId, userId, timezone, name) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      user: { id: userId, email: `${role.toLowerCase()}@example.com`, name: role },
      business: { id: businessId, name: name ?? "Day Route Co", timezone },
    },
    scope: businessScope(businessId),
    assertOwned(record) {
      return assertBusinessRecord(record, businessId);
    },
    assertAttachable(record) {
      return assertBusinessRecord(record, businessId);
    },
  };
}

const featureFiles = [
  "src/lib/owner-day-route-appointment.ts",
  "src/lib/owner-day-route-appointment-ops.ts",
  "src/app/actions/owner-day-route.ts",
  "src/components/today/owner-day-route-appointment-form.tsx",
  "src/components/today/owner-day-route.tsx",
  "src/app/(app)/today/day-route/page.tsx",
];
const featureSrc = featureFiles.map(read).join("\n");
const opsSrc = read("src/lib/owner-day-route-appointment-ops.ts");
const actionSrc = read("src/app/actions/owner-day-route.ts");
const formSrc = read("src/components/today/owner-day-route-appointment-form.tsx");
const pageSrc = read("src/app/(app)/today/day-route/page.tsx");
const viewSrc = read("src/components/today/owner-day-route.tsx");
const navSrc = read("src/lib/nav.ts");
const appShellSrc = read("src/components/app-shell.tsx");
const packageSrc = read("package.json");

const NY = "America/New_York";
const LA = "America/Los_Angeles";
const dayIso = "2026-09-28";
const morning = new Date("2026-09-28T13:00:00.000Z"); // 9:00 AM ET
const afternoon = new Date("2026-09-28T15:00:00.000Z"); // 11:00 AM ET
const laterStart = parseScheduleStart(dayIso, "16:00", NY);
const overlapStart = parseScheduleStart(dayIso, "09:30", NY);
const pickupOverlapStart = parseScheduleStart(dayIso, "09:00", NY);
const bufferStart = parseScheduleStart(dayIso, "10:15", NY);

console.log("\nSTATIC — OWNER change, existing gates, no message, no overclaim");
check(
  "Day-route path and OWNER-only copy stay in place",
  OWNER_DAY_ROUTE_PATH === "/today/day-route" &&
    pageSrc.includes("canChangeAppointment={access.workspace.role === \"OWNER\"}") &&
    viewSrc.includes("OwnerDayRouteAppointmentForm") &&
    DAY_ROUTE_APPOINTMENT_OWNER_ONLY_MESSAGE.includes("business owner") &&
    DAY_ROUTE_APPOINTMENT_FORM_NOTE.includes("does not send a customer message"),
);
check(
  "Shared nav was not given a Day route link",
  !navSrc.includes("day-route") && !appShellSrc.includes("day-route"),
);
check(
  "Package script is named without the read-only check filename",
  packageSrc.includes("test:day-route-appointment") &&
    !packageSrc.includes("check-owner-day-route"),
);
check(
  "Mutation uses existing scheduling gates and business timezone",
  opsSrc.includes("requireBusinessRole(access, \"OWNER\")") &&
    opsSrc.includes("parseScheduleStart") &&
    opsSrc.includes("loadWorkforceTimeZone") &&
    opsSrc.includes("evaluateProposedSchedule") &&
    opsSrc.includes("detectScheduleConflicts") &&
    opsSrc.includes("loadOccupiedJobs") &&
    opsSrc.includes("pickupDurationMinutes") &&
    actionSrc.includes("revalidatePath(OWNER_DAY_ROUTE_PATH)"),
);
check(
  "Request path never creates appointment schema",
  !opsSrc.includes("ensureAppointmentConfirmationSchema") &&
    !opsSrc.includes("$executeRawUnsafe") &&
    !opsSrc.includes("ALTER TABLE") &&
    !opsSrc.includes("CREATE TABLE") &&
    opsSrc.includes("missingDayRouteAppointmentSchema") &&
    opsSrc.includes("DAY_ROUTE_APPOINTMENT_SCHEMA_UNAVAILABLE_MESSAGE") &&
    missingDayRouteAppointmentSchema({ code: "P2022", message: "appointmentProposalId does not exist" }) === true,
);
const transactionSrc = opsSrc.slice(opsSrc.indexOf("$transaction"));
check(
  "Competing day-route changes serialize and recheck conflicts inside the transaction",
  transactionSrc.includes("pg_advisory_xact_lock") &&
    transactionSrc.includes("lockBusinessScheduleReservation") &&
    transactionSrc.includes("rejectIfScheduleBlocked") &&
    transactionSrc.includes("lockTenantOwnedJob") &&
    opsSrc.indexOf("lockBusinessScheduleReservation") <
      opsSrc.lastIndexOf("rejectIfScheduleBlocked") &&
    opsSrc.indexOf("pg_advisory_xact_lock") < opsSrc.lastIndexOf("rejectIfScheduleBlocked"),
);
check(
  "Conflicts and stale snapshots are rejected; no schedule-anyway override",
  opsSrc.includes("DAY_ROUTE_APPOINTMENT_STALE_MESSAGE") &&
    opsSrc.includes("updateMany") &&
    opsSrc.includes("ownerDayRouteScheduleSnapshotWhere") &&
    opsSrc.includes("updated.count !== 1") &&
    !opsSrc.includes("shouldAcceptConflictAcknowledgement") &&
    !opsSrc.includes("confirmOverlapAck") &&
    !opsSrc.includes("You can schedule anyway") &&
    !formSrc.includes("Schedule anyway"),
);
check(
  "Write path does not notify the customer or emit a message automation",
  !opsSrc.includes("notifyCustomerAppointmentProposed") &&
    !opsSrc.includes("notifyCustomer") &&
    !opsSrc.includes("emitAndProcessBusinessEvent") &&
    !actionSrc.includes("notifyCustomer") &&
    !actionSrc.includes("emitAndProcessBusinessEvent") &&
    opsSrc.includes("recordAppointmentEvent") &&
    DAY_ROUTE_APPOINTMENT_CHANGED_MESSAGE.includes("was not messaged"),
);
check(
  "Feature copy does not claim traffic optimization or automatic ETA",
  !ownerDayRouteTextHasForbiddenClaim(featureSrc) &&
    !FORBIDDEN_DAY_ROUTE_CLAIM_PATTERNS.some((pattern) => pattern.test(featureSrc)),
);

try {
  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Appointment",
      slug: `alpha-appt-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: NY,
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Appointment",
      slug: `beta-appt-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: LA,
    },
  });
  await prisma.businessSettings.create({
    data: {
      businessId: businessA.id,
      workingWeekdays: "1,2,3,4,5",
      workStartMinutes: 8 * 60,
      workEndMinutes: 17 * 60,
      schedulingBufferMinutes: 30,
      defaultPickupMinutes: 0,
    },
  });
  await prisma.businessSettings.create({
    data: {
      businessId: businessB.id,
      workingWeekdays: "1,2,3,4,5",
      workStartMinutes: 8 * 60,
      workEndMinutes: 17 * 60,
      schedulingBufferMinutes: 30,
    },
  });

  const ownerUser = await prisma.user.create({
    data: { name: "Olivia", email: `owner-appt-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Avery", email: `admin-appt-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia", email: `member-appt-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerBUser = await prisma.user.create({
    data: { name: "Bea", email: `owner-b-appt-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerMembership = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const adminMembership = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: businessA.id, role: "ADMIN" },
  });
  const memberMembership = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const ownerBMembership = await prisma.membership.create({
    data: { userId: ownerBUser.id, businessId: businessB.id, role: "OWNER" },
  });

  const ownerAccess = makeAccess(businessA.id, "OWNER", ownerMembership.id, ownerUser.id, NY, "Alpha");
  const adminAccess = makeAccess(businessA.id, "ADMIN", adminMembership.id, adminUser.id, NY, "Alpha");
  const memberAccess = makeAccess(businessA.id, "MEMBER", memberMembership.id, memberUser.id, NY, "Alpha");
  const ownerBAccess = makeAccess(businessB.id, "OWNER", ownerBMembership.id, ownerBUser.id, LA, "Beta");

  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Ada Homeowner" },
  });
  const customerB = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Secret" },
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
  const propertyA2 = await prisma.property.create({
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
      addressLine1: "77 Foreign Secret Ave",
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
      scheduledAt: morning,
      scheduledDurationMinutes: 60,
      pickupDurationMinutes: 45,
      arrivalWindowMinutes: null,
      projectToken: randomUUID(),
      appointmentProposalId: 3,
      appointmentConfirmationStatus: "CONFIRMED",
    },
  });
  const lateJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA2.id,
      status: "SCHEDULED",
      scheduledAt: afternoon,
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
      scheduledAt: morning,
      scheduledDurationMinutes: 60,
      pickupDurationMinutes: 20,
      projectToken: randomUUID(),
    },
  });
  const completedJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      status: "COMPLETED",
      scheduledAt: new Date("2026-09-28T12:00:00.000Z"),
      scheduledDurationMinutes: 30,
      projectToken: randomUUID(),
    },
  });

  const earlySnapshot = scheduleSnapshotFromJob(earlyJob);
  const lateSnapshot = scheduleSnapshotFromJob(lateJob);
  const foreignSnapshot = scheduleSnapshotFromJob(foreignJob);
  const completedSnapshot = scheduleSnapshotFromJob(completedJob);
  const beforeForeign = await readOwnerDayRouteScheduleSnapshots(prisma, businessB.id, [foreignJob.id]);

  console.log("\nTEST — authorization");
  await expectThrow(
    "MEMBER cannot change a day-route appointment",
    () =>
      changeOwnerDayRouteAppointment(prisma, memberAccess, {
        jobId: earlyJob.id,
        date: dayIso,
        time: "16:00",
        snapshot: earlySnapshot,
      }),
    (error) =>
      error instanceof ForbiddenError &&
      error.message === DAY_ROUTE_APPOINTMENT_OWNER_ONLY_MESSAGE,
  );
  await expectThrow(
    "ADMIN cannot change a day-route appointment",
    () =>
      changeOwnerDayRouteAppointment(prisma, adminAccess, {
        jobId: earlyJob.id,
        date: dayIso,
        time: "16:00",
        snapshot: earlySnapshot,
      }),
    (error) =>
      error instanceof ForbiddenError &&
      error.message === DAY_ROUTE_APPOINTMENT_OWNER_ONLY_MESSAGE,
  );
  const afterDenied = await prisma.job.findFirst({ where: { id: earlyJob.id } });
  check(
    "Denied roles leave the recorded appointment unchanged",
    afterDenied?.scheduledAt?.toISOString() === morning.toISOString(),
  );

  console.log("\nTEST — tenant isolation");
  await expectThrow(
    "Foreign OWNER cannot change another business job",
    () =>
      changeOwnerDayRouteAppointment(prisma, ownerBAccess, {
        jobId: earlyJob.id,
        date: dayIso,
        time: "16:00",
        snapshot: earlySnapshot,
      }),
    (error) =>
      error instanceof Error &&
      error.message === "Record is not in the authorized business workspace.",
  );
  await expectThrow(
    "Local OWNER cannot change a foreign job id",
    () =>
      changeOwnerDayRouteAppointment(prisma, ownerAccess, {
        jobId: foreignJob.id,
        date: dayIso,
        time: "16:00",
        snapshot: foreignSnapshot,
      }),
    (error) =>
      error instanceof Error &&
      error.message === "Record is not in the authorized business workspace.",
  );
  const afterIsolation = await readOwnerDayRouteScheduleSnapshots(prisma, businessB.id, [foreignJob.id]);
  check(
    "Foreign job snapshot is untouched by isolation failures",
    JSON.stringify(beforeForeign) === JSON.stringify(afterIsolation),
  );

  console.log("\nTEST — completed and conflict rejection");
  await expectThrow(
    "Completed job cannot be rescheduled",
    () =>
      changeOwnerDayRouteAppointment(prisma, ownerAccess, {
        jobId: completedJob.id,
        date: dayIso,
        time: "16:00",
        snapshot: completedSnapshot,
      }),
    (error) =>
      dayRouteAppointmentErrorMessage(error, "") === DAY_ROUTE_APPOINTMENT_COMPLETED_MESSAGE,
  );
  await expectThrow(
    "Overlapping work window is rejected",
    () =>
      changeOwnerDayRouteAppointment(prisma, ownerAccess, {
        jobId: lateJob.id,
        date: dayIso,
        time: "09:30",
        snapshot: lateSnapshot,
      }),
    (error) => /overlap/i.test(dayRouteAppointmentErrorMessage(error, "")),
  );
  await expectThrow(
    "Material-pickup occupancy is rejected",
    () =>
      changeOwnerDayRouteAppointment(prisma, ownerAccess, {
        jobId: lateJob.id,
        date: dayIso,
        time: "09:00",
        snapshot: lateSnapshot,
      }),
    (error) => /overlap|pickup|buffer/i.test(dayRouteAppointmentErrorMessage(error, "")),
  );
  await expectThrow(
    "Configured buffer occupancy is rejected",
    () =>
      changeOwnerDayRouteAppointment(prisma, ownerAccess, {
        jobId: lateJob.id,
        date: dayIso,
        time: "10:15",
        snapshot: lateSnapshot,
      }),
    (error) => /overlap|buffer/i.test(dayRouteAppointmentErrorMessage(error, "")),
  );
  const lateAfterConflicts = await prisma.job.findFirst({ where: { id: lateJob.id } });
  const earlyAfterConflicts = await prisma.job.findFirst({ where: { id: earlyJob.id } });
  check(
    "Rejected conflicts write no appointment fields",
    lateAfterConflicts?.scheduledAt?.toISOString() === afternoon.toISOString() &&
      earlyAfterConflicts?.scheduledAt?.toISOString() === morning.toISOString() &&
      overlapStart?.toISOString() === "2026-09-28T13:30:00.000Z" &&
      pickupOverlapStart?.toISOString() === "2026-09-28T13:00:00.000Z" &&
      bufferStart?.toISOString() === "2026-09-28T14:15:00.000Z",
  );

  console.log("\nTEST — successful change refreshes recorded order");
  const changed = await changeOwnerDayRouteAppointment(prisma, ownerAccess, {
    jobId: earlyJob.id,
    date: dayIso,
    time: "16:00",
    snapshot: earlySnapshot,
  });
  const earlyAfter = await prisma.job.findFirst({
    where: { id: earlyJob.id, businessId: businessA.id },
  });
  const lateAfterMove = await prisma.job.findFirst({ where: { id: lateJob.id } });
  const foreignAfterMove = await prisma.job.findFirst({ where: { id: foreignJob.id } });
  const events = await prisma.jobAppointmentEvent.findMany({
    where: { jobId: earlyJob.id, businessId: businessA.id },
  });
  const refreshed = await loadOwnerDayRoute(prisma, {
    businessId: businessA.id,
    role: "OWNER",
    date: dayIso,
    timeZone: NY,
  });
  check(
    "OWNER change stores the business-timezone instant",
    changed.scheduledAt.toISOString() === laterStart?.toISOString() &&
      earlyAfter?.scheduledAt?.toISOString() === "2026-09-28T20:00:00.000Z" &&
      earlyAfter?.scheduledDurationMinutes === 60 &&
      earlyAfter?.pickupDurationMinutes === 45,
  );
  const lateStop = refreshed.stops.find((stop) => stop.jobId === lateJob.id);
  const earlyStop = refreshed.stops.find((stop) => stop.jobId === earlyJob.id);
  check(
    "Recorded-order route puts the moved stop after the afternoon job",
    Boolean(lateStop && earlyStop) &&
      (lateStop?.sequence ?? 0) < (earlyStop?.sequence ?? 0) &&
      lateStop?.appointmentWindowLabel?.includes("11:00") === true &&
      earlyStop?.appointmentWindowLabel?.includes("4:00") === true,
  );
  const refreshedAddresses = extractOwnerDayRouteMapsAddresses(refreshed.maps.href);
  const oakIndex = refreshedAddresses.findIndex((address) => address.includes("500 Oak Blvd"));
  const mapleAfterMove = refreshedAddresses.findLastIndex((address) => address.includes("10 Maple St"));
  check(
    "Maps link follows the new recorded appointment order",
    ownerDayRouteMapsFollowsAppointmentOrder(refreshed.maps.href, refreshed.stops) &&
      oakIndex >= 0 &&
      mapleAfterMove > oakIndex,
  );
  check(
    "Confirmation is reset and no customer notification is recorded",
    earlyAfter?.appointmentProposalId === 4 &&
      earlyAfter?.appointmentConfirmationStatus === "AWAITING_CUSTOMER" &&
      earlyAfter?.appointmentNotifiedAt == null &&
      earlyAfter?.appointmentNotificationStatus == null &&
      events.every((event) => event.eventType !== "APPOINTMENT_NOTIFICATION_SENT") &&
      events.some((event) => event.eventType === "APPOINTMENT_RESCHEDULED") &&
      lateAfterMove?.scheduledAt?.toISOString() === afternoon.toISOString() &&
      foreignAfterMove?.scheduledAt?.toISOString() === morning.toISOString(),
  );

  console.log("\nTEST — stale submission and concurrent edits");
  const staleSnapshot = earlySnapshot;
  await expectThrow(
    "Stale snapshot after a successful change is rejected",
    () =>
      changeOwnerDayRouteAppointment(prisma, ownerAccess, {
        jobId: earlyJob.id,
        date: dayIso,
        time: "11:00",
        snapshot: staleSnapshot,
      }),
    (error) =>
      dayRouteAppointmentErrorMessage(error, "") === DAY_ROUTE_APPOINTMENT_STALE_MESSAGE,
  );
  const afterStale = await prisma.job.findFirst({ where: { id: earlyJob.id } });
  check(
    "Stale retry leaves the successful 4:00 PM appointment in place",
    afterStale?.scheduledAt?.toISOString() === "2026-09-28T20:00:00.000Z",
  );

  const currentEarly = await prisma.job.findFirst({ where: { id: earlyJob.id } });
  const concurrentSnapshot = scheduleSnapshotFromJob(currentEarly);
  // 14:00 / 15:00 stay clear of the 11:00 afternoon stop: that job occupies
  // 11:00-12:00, plus the 30-minute buffer, and this stop still carries a
  // 45-minute pickup. 11:00/12:00 would both be occupancy rejections.
  const [first, second] = await Promise.allSettled([
    changeOwnerDayRouteAppointment(prisma, ownerAccess, {
      jobId: earlyJob.id,
      date: dayIso,
      time: "14:00",
      snapshot: concurrentSnapshot,
    }),
    changeOwnerDayRouteAppointment(prisma, ownerAccess, {
      jobId: earlyJob.id,
      date: dayIso,
      time: "15:00",
      snapshot: concurrentSnapshot,
    }),
  ]);
  const concurrentWins = [first, second].filter((result) => result.status === "fulfilled");
  const concurrentLosses = [first, second].filter((result) => result.status === "rejected");
  const afterConcurrent = await prisma.job.findFirst({ where: { id: earlyJob.id } });
  const winnerIso = afterConcurrent?.scheduledAt?.toISOString();
  check(
    "Exactly one concurrent edit of the same job wins",
    concurrentWins.length === 1 &&
      concurrentLosses.length === 1 &&
      concurrentLosses[0]?.reason instanceof Error &&
      dayRouteAppointmentErrorMessage(concurrentLosses[0].reason, "") ===
        DAY_ROUTE_APPOINTMENT_STALE_MESSAGE &&
      (winnerIso === "2026-09-28T18:00:00.000Z" || winnerIso === "2026-09-28T19:00:00.000Z"),
  );
  const lateAfterConcurrent = await prisma.job.findFirst({ where: { id: lateJob.id } });
  check(
    "Concurrent same-job race does not rewrite the other stop",
    lateAfterConcurrent?.scheduledAt?.toISOString() === afternoon.toISOString(),
  );

  console.log("\nTEST — two jobs racing into the same free slot");
  const raceMorning = new Date("2026-09-29T13:00:00.000Z"); // 9:00 AM ET Tuesday
  const raceAfternoon = new Date("2026-09-29T18:00:00.000Z"); // 2:00 PM ET Tuesday
  const raceA = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      status: "SCHEDULED",
      scheduledAt: raceMorning,
      scheduledDurationMinutes: 60,
      projectToken: randomUUID(),
    },
  });
  const raceB = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA2.id,
      status: "SCHEDULED",
      scheduledAt: raceAfternoon,
      scheduledDurationMinutes: 60,
      projectToken: randomUUID(),
    },
  });
  const [raceFirst, raceSecond] = await Promise.allSettled([
    changeOwnerDayRouteAppointment(prisma, ownerAccess, {
      jobId: raceA.id,
      date: "2026-09-29",
      time: "11:00",
      snapshot: scheduleSnapshotFromJob(raceA),
    }),
    changeOwnerDayRouteAppointment(prisma, ownerAccess, {
      jobId: raceB.id,
      date: "2026-09-29",
      time: "11:00",
      snapshot: scheduleSnapshotFromJob(raceB),
    }),
  ]);
  const raceWins = [raceFirst, raceSecond].filter((result) => result.status === "fulfilled");
  const raceLosses = [raceFirst, raceSecond].filter((result) => result.status === "rejected");
  const raceAAfter = await prisma.job.findFirst({ where: { id: raceA.id } });
  const raceBAfter = await prisma.job.findFirst({ where: { id: raceB.id } });
  const raceSlotIso = "2026-09-29T15:00:00.000Z"; // 11:00 AM ET
  const raceWinnerIsA = raceAAfter?.scheduledAt?.toISOString() === raceSlotIso;
  const raceWinnerIsB = raceBAfter?.scheduledAt?.toISOString() === raceSlotIso;
  check(
    "Exactly one of two jobs wins the shared free slot",
    raceWins.length === 1 &&
      raceLosses.length === 1 &&
      ((raceWinnerIsA && raceBAfter?.scheduledAt?.toISOString() === raceAfternoon.toISOString()) ||
        (raceWinnerIsB && raceAAfter?.scheduledAt?.toISOString() === raceMorning.toISOString())),
  );
  const raceLoserMessage =
    raceLosses[0]?.status === "rejected"
      ? dayRouteAppointmentErrorMessage(raceLosses[0].reason, "")
      : "";
  check(
    "The losing two-job racer is rejected as a conflict and left unchanged",
    raceLosses[0]?.status === "rejected" &&
      (/overlap|conflict|buffer|pickup/i.test(raceLoserMessage) ||
        raceLoserMessage === DAY_ROUTE_APPOINTMENT_STALE_MESSAGE) &&
      (raceWinnerIsA
        ? raceBAfter?.scheduledAt?.toISOString() === raceAfternoon.toISOString()
        : raceAAfter?.scheduledAt?.toISOString() === raceMorning.toISOString()),
  );

  console.log("\nTEST — business timezone on a second tenant");
  const laJob = await prisma.job.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      propertyId: propertyB.id,
      status: "SCHEDULED",
      scheduledAt: new Date("2026-09-28T16:00:00.000Z"),
      scheduledDurationMinutes: 60,
      projectToken: randomUUID(),
    },
  });
  const laChanged = await changeOwnerDayRouteAppointment(prisma, ownerBAccess, {
    jobId: laJob.id,
    date: dayIso,
    time: "11:00",
    snapshot: scheduleSnapshotFromJob(laJob),
  });
  check(
    "Los Angeles civil time is stored as the correct UTC instant",
    laChanged.scheduledAt.toISOString() === "2026-09-28T18:00:00.000Z" &&
      parseScheduleStart(dayIso, "11:00", LA)?.toISOString() === "2026-09-28T18:00:00.000Z",
  );
  const alphaAfterLa = await prisma.job.findFirst({ where: { id: lateJob.id } });
  check(
    "Second-tenant change does not rewrite the first tenant",
    alphaAfterLa?.scheduledAt?.toISOString() === afternoon.toISOString(),
  );

  const unscheduled = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "UNSCHEDULED",
      projectToken: randomUUID(),
    },
  });
  await expectThrow(
    "Unscheduled jobs are not changed from the day route",
    () =>
      changeOwnerDayRouteAppointment(prisma, ownerAccess, {
        jobId: unscheduled.id,
        date: dayIso,
        time: "16:00",
        snapshot: scheduleSnapshotFromJob(unscheduled),
      }),
    (error) =>
      dayRouteAppointmentErrorMessage(error, "") === DAY_ROUTE_APPOINTMENT_UNSCHEDULED_MESSAGE,
  );

  console.log("\nTEST — missing appointment schema fails closed");
  const schemaJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      status: "SCHEDULED",
      scheduledAt: new Date("2026-09-30T13:00:00.000Z"),
      scheduledDurationMinutes: 60,
      projectToken: randomUUID(),
    },
  });
  const schemaSnapshot = scheduleSnapshotFromJob(schemaJob);
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "JobAppointmentEvent"`);
  await expectThrow(
    "Missing JobAppointmentEvent fails closed instead of creating the table",
    () =>
      changeOwnerDayRouteAppointment(prisma, ownerAccess, {
        jobId: schemaJob.id,
        date: "2026-09-30",
        time: "11:00",
        snapshot: schemaSnapshot,
      }),
    (error) =>
      dayRouteAppointmentErrorMessage(error, "") ===
      DAY_ROUTE_APPOINTMENT_SCHEMA_UNAVAILABLE_MESSAGE,
  );
  const schemaTables = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables WHERE tablename = 'JobAppointmentEvent'
  `;
  const schemaJobAfter = await prisma.job.findFirst({ where: { id: schemaJob.id } });
  check(
    "Fail-closed path does not create JobAppointmentEvent or move the job",
    Array.isArray(schemaTables) &&
      schemaTables.length === 0 &&
      schemaJobAfter?.scheduledAt?.toISOString() === "2026-09-30T13:00:00.000Z",
  );

  if (failed > 0) {
    console.error(`\n${failed} day-route appointment check(s) failed; ${passed} passed.`);
    process.exit(1);
  }
  console.log(`\nDay-route appointment checks passed (${passed}).`);
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
