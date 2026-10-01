/**
 * Authenticated one-time .ics calendar download proofs.
 *
 * Covers OWNER vs active-worker authorization, tenant isolation,
 * current assignment changes, business-timezone / DST output, cancelled
 * and unscheduled honesty, and date/row bounds on a dedicated local
 * disposable database. Does not create a public subscription URL and
 * does not write schedule fields.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-schedule-calendar-export.mjs
 */
import { register } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  assertLocalDatabaseUrl,
  openDisposableTestDatabase,
} from "./disposable-test-database.mjs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError } = await import("@/lib/authorization");
const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const { zonedCivilToUtc } = await import("@/lib/business-timezone");
const { scheduleWindow } = await import("@/lib/job-schedule");
const {
  SCHEDULE_CALENDAR_EXPORT_CONTRACT,
  SCHEDULE_CALENDAR_EXPORT_EVENT_LIMIT,
  SCHEDULE_CALENDAR_EXPORT_HORIZON_DAYS,
  SCHEDULE_CALENDAR_EXPORT_VERSION,
  boundCalendarRead,
  buildScheduleCalendarExport,
  canDownloadAssignedScheduleCalendar,
  canDownloadBusinessScheduleCalendar,
  formatIcsLocalStamp,
  formatIcsUtcStamp,
  parseScheduleCalendarIcs,
} = await import("@/lib/schedule-calendar-export");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "schedule-calendar-export disposable database");

const session = await openDisposableTestDatabase({
  databaseUrl: baseUrl,
  namePrefix: "tbbt_schedule_calendar_export",
  pushSchema: true,
});
const prisma = session.prisma;

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

function readRepo(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function makeAccess(businessId, role, membershipId, active = true, timezone = null) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId, active },
      business: { id: businessId, name: "Calendar Tenant", timezone },
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

async function expectRejects(label, fn, isExpected) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, isExpected(error));
  }
}

const contractSrc = readRepo("src/lib/schedule-calendar-export/contract.ts");
const buildSrc = readRepo("src/lib/schedule-calendar-export/build.ts");
const accessSrc = readRepo("src/lib/schedule-calendar-export/access.ts");
const icsSrc = readRepo("src/lib/schedule-calendar-export/ics.ts");
const httpSrc = readRepo("src/lib/schedule-calendar-export/http.ts");
const ownerRouteSrc = readRepo("src/app/(app)/jobs/calendar-export/download/route.ts");
const fieldRouteSrc = readRepo("src/app/field/calendar-export/download/route.ts");
const jobsPageSrc = readRepo("src/app/(app)/jobs/page.tsx");
const fieldPageSrc = readRepo("src/app/field/page.tsx");
const navSrc = readRepo("src/lib/nav.ts");
const settingsSrc = readRepo("src/components/settings/settings-workspace.tsx");
const fieldShellSrc = readRepo("src/components/field/field-shell.tsx");
const authSrc = readRepo("src/lib/authorization.ts");
const schemaSrc = readRepo("prisma/schema.prisma");
const packageSrc = readRepo("package.json");
const checkSrc = readRepo("scripts/check-schedule-calendar-export.mjs");
const jobActionSrc = readRepo("src/app/actions/job.ts");

const SECRET_MARKERS = [
  "publicToken",
  "projectToken",
  "propertyAccessInstructions",
  "propertyAccessContactInfo",
  "propertyAccessContactName",
  "appointmentChangeRequestNote",
  "passwordHash",
  "totpSecret",
  "customer:",
  "email:",
  "phone:",
];

console.log("\nSTATIC — inspect existing schedule / timezone / assignment, then add one-time ICS");
check(
  "Existing Job schedule fields and assignment remain the source of truth",
  jobActionSrc.includes("scheduledAt") &&
    jobActionSrc.includes("assignedMembershipId") &&
    schemaSrc.includes("scheduledDurationMinutes") &&
    !schemaSrc.includes("CalendarSubscription") &&
    !schemaSrc.includes("ScheduleCalendarExport"),
);
check(
  "OWNER may download the business calendar; ADMIN and MEMBER cannot",
  canDownloadBusinessScheduleCalendar("OWNER") &&
    !canDownloadBusinessScheduleCalendar("ADMIN") &&
    !canDownloadBusinessScheduleCalendar("MEMBER"),
);
check(
  "Inactive membership cannot download an assigned calendar",
  canDownloadAssignedScheduleCalendar(makeAccess("biz", "MEMBER", "mem", true)) &&
    !canDownloadAssignedScheduleCalendar(makeAccess("biz", "MEMBER", "mem", false)) &&
    !canDownloadAssignedScheduleCalendar(makeAccess("biz", "OWNER", "mem", false)),
);
check(
  "Contract is versioned tbbt.schedule-calendar.v1 with 90-day / 100-row bounds",
  SCHEDULE_CALENDAR_EXPORT_CONTRACT === "tbbt.schedule-calendar.v1" &&
    SCHEDULE_CALENDAR_EXPORT_VERSION === 1 &&
    SCHEDULE_CALENDAR_EXPORT_HORIZON_DAYS === 90 &&
    SCHEDULE_CALENDAR_EXPORT_EVENT_LIMIT === 100 &&
    contractSrc.includes("tbbt.schedule-calendar.v1"),
);
check(
  "Builder scopes loads by access.businessId and asserts ownership",
  buildSrc.includes("where: { id: businessId }") &&
    buildSrc.includes("access.assertOwned({ businessId: business.id })") &&
    buildSrc.includes("access.assertOwned(row)") &&
    buildSrc.includes("assignedMembershipId: membershipId"),
);
check(
  "Secrets, customer contact, access instructions, and notes are never selected",
  SECRET_MARKERS.every((marker) => !buildSrc.includes(marker)) &&
    !buildSrc.includes("prisma.job.update") &&
    !buildSrc.includes("data: {") &&
    !icsSrc.includes("webcal") &&
    !httpSrc.includes("webcal"),
);
check(
  "Dedicated download routes stay authenticated, attachment-only, and uncached",
  ownerRouteSrc.includes('scheduleCalendarDownloadResponse(access, "business")') &&
    fieldRouteSrc.includes('scheduleCalendarDownloadResponse(access, "assigned")') &&
    httpSrc.includes("requireBusinessAccess") === false &&
    ownerRouteSrc.includes("requireBusinessAccess") &&
    fieldRouteSrc.includes("requireBusinessAccess") &&
    httpSrc.includes("text/calendar") &&
    httpSrc.includes("attachment") &&
    httpSrc.includes("no-store") &&
    httpSrc.includes("force-dynamic") === false &&
    ownerRouteSrc.includes('dynamic = "force-dynamic"') &&
    fieldRouteSrc.includes('dynamic = "force-dynamic"'),
);
check(
  "Local page links exist without a new global nav or FieldShell item",
  jobsPageSrc.includes("/jobs/calendar-export/download") &&
    jobsPageSrc.includes("canDownloadBusinessScheduleCalendar") &&
    fieldPageSrc.includes("/field/calendar-export/download") &&
    !navSrc.includes("calendar-export") &&
    !navSrc.includes("Download upcoming calendar") &&
    !settingsSrc.includes("calendar-export") &&
    !fieldShellSrc.includes("calendar-export"),
);
check(
  "No new capability, public feed token, or schedule-field write",
  !authSrc.includes("EXPORT_SCHEDULE_CALENDAR") &&
    !authSrc.includes("DOWNLOAD_CALENDAR") &&
    !contractSrc.includes("publicSubscription: true") &&
    contractSrc.includes("publicSubscription: false") &&
    contractSrc.includes("writesScheduleFields: false") &&
    !buildSrc.includes("liveSynchronization: true") &&
    packageSrc.includes("test:schedule-calendar-export") &&
    checkSrc.includes("openDisposableTestDatabase") &&
    checkSrc.includes("assertLocalDatabaseUrl") &&
    checkSrc.includes('namePrefix: "tbbt_schedule_calendar_export"'),
);
check(
  "boundCalendarRead keeps the cap and marks overflow",
  boundCalendarRead(["a", "b", "c"], 2).truncated === true &&
    boundCalendarRead(["a", "b", "c"], 2).items.join(",") === "a,b" &&
    boundCalendarRead(["a", "b"], 2).truncated === false,
);

const NY = "America/New_York";
const LA = "America/Los_Angeles";
const springEarly = zonedCivilToUtc(2026, 3, 8, 1, 30, 0, NY);
const springLate = zonedCivilToUtc(2026, 3, 8, 3, 30, 0, NY);
const fallEdt = new Date("2026-11-01T05:30:00.000Z");
const fallEst = new Date("2026-11-01T06:30:00.000Z");

console.log("\nUNIT — timezone / DST output without a hard-coded offset");
check(
  "2026-03-08 01:30 America/New_York is EST (UTC-5)",
  springEarly.toISOString() === "2026-03-08T06:30:00.000Z" &&
    formatIcsLocalStamp(springEarly, NY) === "20260308T013000" &&
    formatIcsUtcStamp(springEarly) === "20260308T063000Z",
);
check(
  "2026-03-08 03:30 America/New_York is EDT (UTC-4)",
  springLate.toISOString() === "2026-03-08T07:30:00.000Z" &&
    formatIcsLocalStamp(springLate, NY) === "20260308T033000" &&
    formatIcsUtcStamp(springLate) === "20260308T073000Z",
);
check(
  "Fall-back 01:30 EDT and 01:30 EST stay distinct UTC instants",
  formatIcsLocalStamp(fallEdt, NY) === "20261101T013000" &&
    formatIcsLocalStamp(fallEst, NY) === "20261101T013000" &&
    formatIcsUtcStamp(fallEdt) === "20261101T053000Z" &&
    formatIcsUtcStamp(fallEst) === "20261101T063000Z" &&
    fallEdt.getTime() !== fallEst.getTime(),
);
check(
  "Null duration window stays the existing 1-minute scheduleWindow",
  scheduleWindow(springEarly, null).end.getTime() === springEarly.getTime() + 60 * 1000,
);

try {
  console.log("\nDB — auth, isolation, assignment, timezone, cancelled jobs, bounds");
  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Calendar",
      slug: `alpha-cal-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: NY,
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Calendar",
      slug: `beta-cal-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: LA,
    },
  });

  const ownerA = await prisma.user.create({
    data: {
      name: "Olivia",
      email: `owner-cal-${randomUUID()}@example.com`,
      passwordHash: "hashed-owner-secret",
    },
  });
  const adminA = await prisma.user.create({
    data: {
      name: "Ada",
      email: `admin-cal-${randomUUID()}@example.com`,
      passwordHash: "hashed-admin-secret",
    },
  });
  const memberA = await prisma.user.create({
    data: {
      name: "Mia",
      email: `member-cal-${randomUUID()}@example.com`,
      passwordHash: "hashed-member-secret",
    },
  });
  const memberA2 = await prisma.user.create({
    data: {
      name: "Miles",
      email: `member2-cal-${randomUUID()}@example.com`,
      passwordHash: "hashed-member2-secret",
    },
  });
  const inactiveA = await prisma.user.create({
    data: {
      name: "Ivy",
      email: `inactive-cal-${randomUUID()}@example.com`,
      passwordHash: "hashed-inactive-secret",
    },
  });
  const ownerB = await prisma.user.create({
    data: {
      name: "Bea",
      email: `beta-cal-${randomUUID()}@example.com`,
      passwordHash: "hashed-beta-secret",
    },
  });
  const memberB = await prisma.user.create({
    data: {
      name: "Ben",
      email: `beta-member-cal-${randomUUID()}@example.com`,
      passwordHash: "hashed-beta-member-secret",
    },
  });

  const ownerMemA = await prisma.membership.create({
    data: { userId: ownerA.id, businessId: businessA.id, role: "OWNER" },
  });
  const adminMemA = await prisma.membership.create({
    data: { userId: adminA.id, businessId: businessA.id, role: "ADMIN" },
  });
  const memberMemA = await prisma.membership.create({
    data: { userId: memberA.id, businessId: businessA.id, role: "MEMBER" },
  });
  const memberMemA2 = await prisma.membership.create({
    data: { userId: memberA2.id, businessId: businessA.id, role: "MEMBER" },
  });
  const inactiveMemA = await prisma.membership.create({
    data: { userId: inactiveA.id, businessId: businessA.id, role: "MEMBER", active: false },
  });
  const ownerMemB = await prisma.membership.create({
    data: { userId: ownerB.id, businessId: businessB.id, role: "OWNER" },
  });
  const memberMemB = await prisma.membership.create({
    data: { userId: memberB.id, businessId: businessB.id, role: "MEMBER" },
  });

  const customerA = await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: "Pat Secret",
      email: "pat-secret-calendar@example.com",
      phone: "555-0100",
    },
  });
  const customerB = await prisma.customer.create({
    data: {
      businessId: businessB.id,
      name: "Beta Secret",
      email: "beta-secret-calendar@example.com",
      phone: "555-0199",
    },
  });

  const nowSpring = new Date("2026-03-07T15:00:00.000Z");
  const nowFall = new Date("2026-10-20T15:00:00.000Z");
  const secretNote = "Key under mat. Code 4321. Do not publish.";

  async function createJob(businessId, data) {
    return prisma.job.create({
      data: {
        businessId,
        projectToken: `portal-secret-${randomUUID()}`,
        propertyAccessInstructions: secretNote,
        propertyAccessContactInfo: "Neighbor 555-0111",
        appointmentChangeRequestNote: "Please use the side gate after 5.",
        ...data,
      },
    });
  }

  const assignedUpcoming = await createJob(businessA.id, {
    customerId: customerA.id,
    status: "SCHEDULED",
    scheduledAt: zonedCivilToUtc(2026, 3, 9, 9, 0, 0, NY),
    scheduledDurationMinutes: 120,
    assignedMembershipId: memberMemA.id,
  });
  const unassignedUpcoming = await createJob(businessA.id, {
    customerId: customerA.id,
    status: "SCHEDULED",
    scheduledAt: zonedCivilToUtc(2026, 3, 9, 13, 0, 0, NY),
    scheduledDurationMinutes: 60,
  });
  const inProgressAssigned = await createJob(businessA.id, {
    customerId: customerA.id,
    status: "IN_PROGRESS",
    scheduledAt: zonedCivilToUtc(2026, 3, 7, 8, 0, 0, NY),
    scheduledDurationMinutes: 90,
    assignedMembershipId: memberMemA.id,
  });
  const cancelledAssigned = await createJob(businessA.id, {
    customerId: customerA.id,
    status: "CANCELLED",
    scheduledAt: zonedCivilToUtc(2026, 3, 10, 10, 0, 0, NY),
    scheduledDurationMinutes: 60,
    assignedMembershipId: memberMemA.id,
  });
  const completedAssigned = await createJob(businessA.id, {
    customerId: customerA.id,
    status: "COMPLETED",
    scheduledAt: zonedCivilToUtc(2026, 3, 10, 14, 0, 0, NY),
    scheduledDurationMinutes: 60,
    assignedMembershipId: memberMemA.id,
  });
  const unscheduledAssigned = await createJob(businessA.id, {
    customerId: customerA.id,
    status: "UNSCHEDULED",
    assignedMembershipId: memberMemA.id,
  });
  const pastAssigned = await createJob(businessA.id, {
    customerId: customerA.id,
    status: "SCHEDULED",
    scheduledAt: zonedCivilToUtc(2026, 3, 6, 9, 0, 0, NY),
    scheduledDurationMinutes: 60,
    assignedMembershipId: memberMemA.id,
  });
  const beyondHorizon = await createJob(businessA.id, {
    customerId: customerA.id,
    status: "SCHEDULED",
    scheduledAt: zonedCivilToUtc(2026, 6, 10, 9, 0, 0, NY),
    scheduledDurationMinutes: 60,
    assignedMembershipId: memberMemA.id,
  });
  const springJob = await createJob(businessA.id, {
    customerId: customerA.id,
    status: "SCHEDULED",
    scheduledAt: springEarly,
    scheduledDurationMinutes: 60,
    assignedMembershipId: memberMemA.id,
  });
  const springJobAfter = await createJob(businessA.id, {
    customerId: customerA.id,
    status: "SCHEDULED",
    scheduledAt: springLate,
    scheduledDurationMinutes: 60,
    assignedMembershipId: memberMemA.id,
  });
  const fallJobEdt = await createJob(businessA.id, {
    customerId: customerA.id,
    status: "SCHEDULED",
    scheduledAt: fallEdt,
    scheduledDurationMinutes: 30,
    assignedMembershipId: memberMemA.id,
  });
  const fallJobEst = await createJob(businessA.id, {
    customerId: customerA.id,
    status: "SCHEDULED",
    scheduledAt: fallEst,
    scheduledDurationMinutes: 30,
    assignedMembershipId: memberMemA.id,
  });
  const otherWorkerJob = await createJob(businessA.id, {
    customerId: customerA.id,
    status: "SCHEDULED",
    scheduledAt: zonedCivilToUtc(2026, 3, 11, 9, 0, 0, NY),
    scheduledDurationMinutes: 60,
    assignedMembershipId: memberMemA2.id,
  });
  const reassignJob = await createJob(businessA.id, {
    customerId: customerA.id,
    status: "SCHEDULED",
    scheduledAt: zonedCivilToUtc(2026, 3, 12, 9, 0, 0, NY),
    scheduledDurationMinutes: 60,
    assignedMembershipId: memberMemA.id,
  });
  const betaJob = await createJob(businessB.id, {
    customerId: customerB.id,
    status: "SCHEDULED",
    scheduledAt: new Date("2026-03-09T16:00:00.000Z"),
    scheduledDurationMinutes: 60,
    assignedMembershipId: memberMemB.id,
  });

  const ownerAccessA = makeAccess(businessA.id, "OWNER", ownerMemA.id, true, NY);
  const adminAccessA = makeAccess(businessA.id, "ADMIN", adminMemA.id, true, NY);
  const memberAccessA = makeAccess(businessA.id, "MEMBER", memberMemA.id, true, NY);
  const memberAccessA2 = makeAccess(businessA.id, "MEMBER", memberMemA2.id, true, NY);
  const inactiveAccessA = makeAccess(businessA.id, "MEMBER", inactiveMemA.id, false, NY);
  const ownerAccessB = makeAccess(businessB.id, "OWNER", ownerMemB.id, true, LA);
  const memberAccessB = makeAccess(businessB.id, "MEMBER", memberMemB.id, true, LA);

  await expectRejects(
    "ADMIN cannot download the business calendar",
    () => buildScheduleCalendarExport(prisma, adminAccessA, { scope: "business", now: nowSpring }),
    (error) => error instanceof ForbiddenError,
  );
  await expectRejects(
    "MEMBER cannot download the business calendar",
    () => buildScheduleCalendarExport(prisma, memberAccessA, { scope: "business", now: nowSpring }),
    (error) => error instanceof ForbiddenError,
  );
  await expectRejects(
    "Inactive worker cannot download an assigned calendar",
    () => buildScheduleCalendarExport(prisma, inactiveAccessA, { scope: "assigned", now: nowSpring }),
    (error) => error instanceof ForbiddenError,
  );

  const ownerSpring = await buildScheduleCalendarExport(prisma, ownerAccessA, {
    scope: "business",
    now: nowSpring,
  });
  const workerSpring = await buildScheduleCalendarExport(prisma, memberAccessA, {
    scope: "assigned",
    now: nowSpring,
  });
  const worker2Spring = await buildScheduleCalendarExport(prisma, memberAccessA2, {
    scope: "assigned",
    now: nowSpring,
  });
  const ownerBSpring = await buildScheduleCalendarExport(prisma, ownerAccessB, {
    scope: "business",
    now: nowSpring,
  });
  const workerBSpring = await buildScheduleCalendarExport(prisma, memberAccessB, {
    scope: "assigned",
    now: nowSpring,
  });

  const ownerIds = new Set(ownerSpring.events.map((event) => event.jobId));
  const workerIds = new Set(workerSpring.events.map((event) => event.jobId));
  const worker2Ids = new Set(worker2Spring.events.map((event) => event.jobId));
  const ownerBIds = new Set(ownerBSpring.events.map((event) => event.jobId));

  check(
    "OWNER business calendar includes assigned, unassigned, and in-progress recorded appointments",
    ownerIds.has(assignedUpcoming.id) &&
      ownerIds.has(unassignedUpcoming.id) &&
      ownerIds.has(inProgressAssigned.id) &&
      ownerIds.has(springJob.id) &&
      ownerIds.has(reassignJob.id) &&
      ownerIds.has(otherWorkerJob.id),
  );
  check(
    "Cancelled, completed, unscheduled, past, and beyond-horizon jobs are omitted",
    !ownerIds.has(cancelledAssigned.id) &&
      !ownerIds.has(completedAssigned.id) &&
      !ownerIds.has(unscheduledAssigned.id) &&
      !ownerIds.has(pastAssigned.id) &&
      !ownerIds.has(beyondHorizon.id),
  );
  check(
    "Active worker sees only jobs currently assigned to them",
    workerIds.has(assignedUpcoming.id) &&
      workerIds.has(inProgressAssigned.id) &&
      workerIds.has(reassignJob.id) &&
      !workerIds.has(unassignedUpcoming.id) &&
      !workerIds.has(otherWorkerJob.id) &&
      !workerIds.has(cancelledAssigned.id) &&
      worker2Ids.has(otherWorkerJob.id) &&
      !worker2Ids.has(assignedUpcoming.id),
  );
  check(
    "Tenant isolation: neither side sees the other business's jobs",
    !ownerIds.has(betaJob.id) &&
      ownerBIds.has(betaJob.id) &&
      ownerBIds.size === 1 &&
      workerBSpring.events.every((event) => event.jobId === betaJob.id) &&
      !workerIds.has(betaJob.id),
  );

  const plantedSecrets = [
    "pat-secret-calendar@example.com",
    "555-0100",
    "Pat Secret",
    "Key under mat",
    "4321",
    "Please use the side gate",
    "hashed-owner-secret",
    assignedUpcoming.projectToken,
    "beta-secret-calendar@example.com",
  ];
  check(
    "ICS omits customer contact, access instructions, private notes, and secrets",
    plantedSecrets.every((secret) => !ownerSpring.ics.includes(secret)) &&
      plantedSecrets.every((secret) => !workerSpring.ics.includes(secret)) &&
      ownerSpring.ics.includes(`X-TBBT-JOB-ID:${assignedUpcoming.id}`) &&
      ownerSpring.ics.includes("BEGIN:VCALENDAR") &&
      !ownerSpring.ics.includes("webcal"),
  );

  const parsedOwner = parseScheduleCalendarIcs(ownerSpring.ics);
  const parsedWorker = parseScheduleCalendarIcs(workerSpring.ics);
  const springEvent = parsedOwner.events.find((event) => event.jobId === springJob.id);
  const springAfterEvent = parsedOwner.events.find((event) => event.jobId === springJobAfter.id);
  check(
    "OWNER ICS declares America/New_York and UTC start/end for the spring-forward boundary",
    parsedOwner.timeZone === NY &&
      parsedOwner.scope === "business" &&
      parsedOwner.publicSubscription === false &&
      springEvent?.dtstartUtc === "20260308T063000Z" &&
      springEvent?.localStart === "2026-03-08 01:30 America/New_York" &&
      springAfterEvent?.dtstartUtc === "20260308T073000Z" &&
      springAfterEvent?.localStart === "2026-03-08 03:30 America/New_York",
  );
  check(
    "Worker ICS is assigned-scoped and uses the same business timezone",
    parsedWorker.scope === "assigned" &&
      parsedWorker.timeZone === NY &&
      parsedWorker.events.every((event) => event.assigned),
  );

  const parsedBeta = parseScheduleCalendarIcs(ownerBSpring.ics);
  const betaEvent = parsedBeta.events.find((event) => event.jobId === betaJob.id);
  check(
    "Pacific tenant ICS uses America/Los_Angeles, not the New York default",
    parsedBeta.timeZone === LA &&
      betaEvent?.tzid === LA &&
      betaEvent?.localStart === "2026-03-09 09:00 America/Los_Angeles" &&
      betaEvent?.dtstartUtc === "20260309T160000Z",
  );

  const ownerFall = await buildScheduleCalendarExport(prisma, ownerAccessA, {
    scope: "business",
    now: nowFall,
  });
  const parsedFall = parseScheduleCalendarIcs(ownerFall.ics);
  const fallEdtEvent = parsedFall.events.find((event) => event.jobId === fallJobEdt.id);
  const fallEstEvent = parsedFall.events.find((event) => event.jobId === fallJobEst.id);
  check(
    "Fall-back boundary keeps two 01:30 local appointments as distinct UTC events",
    fallEdtEvent?.localStart === "2026-11-01 01:30 America/New_York" &&
      fallEstEvent?.localStart === "2026-11-01 01:30 America/New_York" &&
      fallEdtEvent?.dtstartUtc === "20261101T053000Z" &&
      fallEstEvent?.dtstartUtc === "20261101T063000Z",
  );

  const beforeReassign = await buildScheduleCalendarExport(prisma, memberAccessA, {
    scope: "assigned",
    now: nowSpring,
  });
  await prisma.job.update({
    where: { id: reassignJob.id },
    data: { assignedMembershipId: memberMemA2.id },
  });
  const afterFromA = await buildScheduleCalendarExport(prisma, memberAccessA, {
    scope: "assigned",
    now: nowSpring,
  });
  const afterFromA2 = await buildScheduleCalendarExport(prisma, memberAccessA2, {
    scope: "assigned",
    now: nowSpring,
  });
  const afterOwner = await buildScheduleCalendarExport(prisma, ownerAccessA, {
    scope: "business",
    now: nowSpring,
  });
  check(
    "Reassignment drops the job from the previous worker and adds it to the current worker",
    beforeReassign.events.some((event) => event.jobId === reassignJob.id) &&
      !afterFromA.events.some((event) => event.jobId === reassignJob.id) &&
      afterFromA2.events.some((event) => event.jobId === reassignJob.id) &&
      afterOwner.events.some((event) => event.jobId === reassignJob.id),
  );

  await prisma.job.update({
    where: { id: assignedUpcoming.id },
    data: { status: "CANCELLED" },
  });
  const afterCancelOwner = await buildScheduleCalendarExport(prisma, ownerAccessA, {
    scope: "business",
    now: nowSpring,
  });
  const afterCancelWorker = await buildScheduleCalendarExport(prisma, memberAccessA, {
    scope: "assigned",
    now: nowSpring,
  });
  check(
    "Cancelling a job removes it from both OWNER and assigned-worker downloads",
    !afterCancelOwner.events.some((event) => event.jobId === assignedUpcoming.id) &&
      !afterCancelWorker.events.some((event) => event.jobId === assignedUpcoming.id),
  );

  const overflowNow = new Date("2026-07-01T15:00:00.000Z");
  for (let i = 0; i < SCHEDULE_CALENDAR_EXPORT_EVENT_LIMIT + 1; i += 1) {
    await createJob(businessA.id, {
      customerId: customerA.id,
      status: "SCHEDULED",
      scheduledAt: new Date(Date.UTC(2026, 6, 2, 14, 0, 0) + i * 60 * 1000),
      scheduledDurationMinutes: 15,
      assignedMembershipId: memberMemA.id,
    });
  }
  const overflow = await buildScheduleCalendarExport(prisma, ownerAccessA, {
    scope: "business",
    now: overflowNow,
  });
  check(
    "Row count is capped at 100 and truncation is declared",
    overflow.events.length === SCHEDULE_CALENDAR_EXPORT_EVENT_LIMIT &&
      overflow.truncated === true &&
      parseScheduleCalendarIcs(overflow.ics).truncated === true &&
      overflow.limits.eventLimit === 100 &&
      overflow.limits.horizonDays === 90 &&
      overflow.limits.publicSubscription === false &&
      overflow.limits.writesScheduleFields === false,
  );
  check(
    "Spring range is 90 America/New_York calendar days and crosses the DST change",
    ownerSpring.rangeStart.toISOString() === "2026-03-07T05:00:00.000Z" &&
      ownerSpring.rangeEnd.toISOString() === "2026-06-05T04:00:00.000Z" &&
      ownerSpring.rangeEnd.getTime() - ownerSpring.rangeStart.getTime() !==
        90 * 24 * 60 * 60 * 1000,
  );
  check(
    "July 1 America/New_York start-of-day is EDT (UTC-4) and the 90-day horizon stays in-zone",
    overflow.rangeStart.toISOString() === "2026-07-01T04:00:00.000Z" &&
      overflow.rangeEnd.toISOString() === "2026-09-29T04:00:00.000Z",
  );
} catch (error) {
  failures += 1;
  console.error("FAIL - unexpected schedule calendar export test error");
  console.error(error);
} finally {
  await session.cleanup();
}

if (failures > 0) {
  console.error(`\nSchedule calendar export check failed: ${failures} issue(s).`);
  process.exit(1);
}

console.log("\nAll schedule calendar export checks passed.");
