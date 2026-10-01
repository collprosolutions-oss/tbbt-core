/**
 * Optional revocable calendar-subscription proofs.
 *
 * Covers hashed tokens, rotate/revoke, live membership/business/assignment
 * rechecks, timezone/DST, cancellation STATUS, cache control, token
 * leakage, and concurrent revoke/read on a dedicated local disposable
 * database. Does not write schedule fields or change global nav.
 *
 * Chat 4 overlap: worker job reassignment may add a Job-assignment
 * migration. This check only reads Job.assignedMembershipId and uses a
 * uniquely named additive ScheduleCalendarSubscription migration.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-schedule-calendar-subscription.mjs
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
const { createSecureToken, hashToken } = await import("@/lib/auth-crypto");
const { parseScheduleCalendarIcs } = await import("@/lib/schedule-calendar-export");
const {
  SCHEDULE_CALENDAR_FEED_CACHE_CONTROL,
  SCHEDULE_CALENDAR_FEED_HEADERS,
  SCHEDULE_CALENDAR_FEED_NOT_FOUND_MESSAGE,
  SCHEDULE_CALENDAR_FEED_PATH_PREFIX,
  SCHEDULE_CALENDAR_SUBSCRIPTION_CONTRACT,
  SCHEDULE_CALENDAR_SUBSCRIPTION_VERSION,
  ScheduleCalendarSubscriptionError,
  canManageAssignedScheduleCalendarSubscription,
  canManageBusinessScheduleCalendarSubscription,
  createScheduleCalendarSubscription,
  isScheduleCalendarFeedPath,
  isScheduleCalendarFeedToken,
  liveScheduleCalendarAccessAllowed,
  loadScheduleCalendarSubscriptionStatus,
  missingScheduleCalendarSubscriptionSchema,
  readScheduleCalendarFeed,
  rotateScheduleCalendarSubscription,
  revokeScheduleCalendarSubscription,
  scheduleCalendarFeedPath,
  scheduleCalendarSubscriptionTestHooks,
} = await import("@/lib/schedule-calendar-subscription");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "schedule-calendar-subscription disposable database");

const session = await openDisposableTestDatabase({
  databaseUrl: baseUrl,
  namePrefix: "tbbt_schedule_cal_sub",
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

const contractSrc = readRepo("src/lib/schedule-calendar-subscription/contract.ts");
const accessSrc = readRepo("src/lib/schedule-calendar-subscription/access.ts");
const opsSrc = readRepo("src/lib/schedule-calendar-subscription/ops.ts");
const feedSrc = readRepo("src/lib/schedule-calendar-subscription/feed.ts");
const httpSrc = readRepo("src/lib/schedule-calendar-subscription/http.ts");
const pathSrc = readRepo("src/lib/schedule-calendar-subscription/path.ts");
const actionSrc = readRepo("src/app/actions/schedule-calendar-subscription.ts");
const routeSrc = readRepo("src/app/calendar/feed/[token]/route.ts");
const jobsPageSrc = readRepo("src/app/(app)/jobs/page.tsx");
const fieldPageSrc = readRepo("src/app/field/page.tsx");
const navSrc = readRepo("src/lib/nav.ts");
const settingsSrc = readRepo("src/components/settings/settings-workspace.tsx");
const fieldShellSrc = readRepo("src/components/field/field-shell.tsx");
const proxySrc = readRepo("src/proxy.ts");
const robotsSrc = readRepo("src/app/robots.ts");
const schemaSrc = readRepo("prisma/schema.prisma");
const migrationSrc = readRepo(
  "prisma/migrations/20261001194722_schedule_calendar_feed_subscription/migration.sql",
);
const packageSrc = readRepo("package.json");
const checkSrc = readRepo("scripts/check-schedule-calendar-subscription.mjs");
const jobActionSrc = readRepo("src/app/actions/job.ts");
const exportBuildSrc = readRepo("src/lib/schedule-calendar-export/build.ts");
const exportHttpSrc = readRepo("src/lib/schedule-calendar-export/http.ts");

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

console.log("\nSTATIC — inspect #260 one-time ICS, then add hashed subscription");
check(
  "One-time download module still requires a session and is not the public feed",
  exportHttpSrc.includes("scheduleCalendarDownloadResponse") &&
    exportBuildSrc.includes("assertScheduleCalendarExportScope") &&
    !exportHttpSrc.includes("/calendar/feed") &&
    !exportBuildSrc.includes("createSecureToken"),
);
check(
  "Uniquely named additive migration creates only ScheduleCalendarSubscription",
  migrationSrc.includes('CREATE TABLE IF NOT EXISTS "ScheduleCalendarSubscription"') &&
    migrationSrc.includes('CREATE UNIQUE INDEX IF NOT EXISTS "ScheduleCalendarSubscription_tokenHash_key"') &&
    migrationSrc.includes("Chat 4") &&
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE|ALTER TABLE "Job"/i.test(migrationSrc) &&
    !schemaSrc.includes("scheduledAt") === false &&
    schemaSrc.includes("model ScheduleCalendarSubscription") &&
    schemaSrc.includes("tokenHash") &&
    !jobActionSrc.includes("scheduleCalendarSubscription"),
);
check(
  "OWNER manages the business feed; an active worker manages the assigned feed",
  canManageBusinessScheduleCalendarSubscription("OWNER") &&
    !canManageBusinessScheduleCalendarSubscription("ADMIN") &&
    !canManageBusinessScheduleCalendarSubscription("MEMBER") &&
    canManageAssignedScheduleCalendarSubscription(makeAccess("biz", "MEMBER", "mem", true)) &&
    !canManageAssignedScheduleCalendarSubscription(makeAccess("biz", "MEMBER", "mem", false)),
);
check(
  "Contract is versioned and the raw token is 64 hex chars stored hashed",
  SCHEDULE_CALENDAR_SUBSCRIPTION_CONTRACT === "tbbt.schedule-calendar-subscription.v1" &&
    SCHEDULE_CALENDAR_SUBSCRIPTION_VERSION === 1 &&
    isScheduleCalendarFeedToken(createSecureToken()) &&
    !isScheduleCalendarFeedToken("short") &&
    hashToken("abc").length === 64 &&
    opsSrc.includes("hashToken") &&
    opsSrc.includes("createSecureToken") &&
    !opsSrc.includes("rawToken:") === false,
);
check(
  "Every feed read rechecks membership, business, assignment, then re-reads the token row",
  feedSrc.includes("loadLiveMembership") &&
    feedSrc.includes("liveScheduleCalendarAccessAllowed") &&
    feedSrc.includes("assignedMembershipId: membership.id") &&
    feedSrc.includes("scheduleCalendarSubscriptionTestHooks.afterLookup") &&
    feedSrc.includes("latest.tokenHash === input.tokenHash") &&
    feedSrc.includes("membershipAgain") &&
    accessSrc.includes("membershipBusinessId !== input.subscriptionBusinessId"),
);
check(
  "Secrets, customer contact, access instructions, and notes are never selected",
  SECRET_MARKERS.every((marker) => !feedSrc.includes(marker)) &&
    !feedSrc.includes("prisma.job.update") &&
    !opsSrc.includes("scheduledAt") &&
    !actionSrc.includes("console.log") &&
    !routeSrc.includes("console.log") &&
    !httpSrc.includes("webcal"),
);
check(
  "Public feed is uncached, no-referrer, and allowed through the auth proxy without a session",
  routeSrc.includes("scheduleCalendarFeedResponse") &&
    routeSrc.includes('dynamic = "force-dynamic"') &&
    httpSrc.includes(SCHEDULE_CALENDAR_FEED_CACHE_CONTROL) &&
    SCHEDULE_CALENDAR_FEED_HEADERS["Cache-Control"] === SCHEDULE_CALENDAR_FEED_CACHE_CONTROL &&
    httpSrc.includes("Referrer-Policy") &&
    httpSrc.includes("noindex") &&
    httpSrc.includes("inline") &&
    isScheduleCalendarFeedPath(`${SCHEDULE_CALENDAR_FEED_PATH_PREFIX}/abc`) &&
    !isScheduleCalendarFeedPath("/jobs") &&
    proxySrc.includes("isScheduleCalendarFeedPath") &&
    robotsSrc.includes("/calendar/feed/") &&
    pathSrc.includes("isScheduleCalendarFeedPath"),
);
check(
  "Local page controls exist without a new global nav, settings, or FieldShell item",
  jobsPageSrc.includes("ScheduleCalendarSubscriptionPanel") &&
    jobsPageSrc.includes('scope: "business"') === false &&
    jobsPageSrc.includes('"business"') &&
    fieldPageSrc.includes("ScheduleCalendarSubscriptionPanel") &&
    fieldPageSrc.includes('"assigned"') &&
    !navSrc.includes("calendar/feed") &&
    !navSrc.includes("Calendar subscription") &&
    !settingsSrc.includes("calendar/feed") &&
    !fieldShellSrc.includes("calendar/feed") &&
    !fieldShellSrc.includes("ScheduleCalendarSubscription"),
);
check(
  "Preview-missing table degrades; writes fail closed; no request-path DDL",
  missingScheduleCalendarSubscriptionSchema({ code: "P2021" }) &&
    missingScheduleCalendarSubscriptionSchema({ code: "P2022" }) &&
    !missingScheduleCalendarSubscriptionSchema({ code: "P2002" }) &&
    opsSrc.includes("missingScheduleCalendarSubscriptionSchema") &&
    feedSrc.includes("missingScheduleCalendarSubscriptionSchema") &&
    !feedSrc.includes("CREATE TABLE") &&
    !opsSrc.includes("CREATE TABLE") &&
    packageSrc.includes("test:schedule-calendar-subscription") &&
    checkSrc.includes("openDisposableTestDatabase") &&
    checkSrc.includes("Chat 4") &&
    checkSrc.includes('namePrefix: "tbbt_schedule_cal_sub"'),
);
check(
  "Live access helper treats deactivation, other-business membership, and lost OWNER role as denied",
  liveScheduleCalendarAccessAllowed({
    role: "OWNER",
    active: true,
    scope: "business",
    membershipBusinessId: "a",
    subscriptionBusinessId: "a",
  }) &&
    !liveScheduleCalendarAccessAllowed({
      role: "OWNER",
      active: false,
      scope: "business",
      membershipBusinessId: "a",
      subscriptionBusinessId: "a",
    }) &&
    !liveScheduleCalendarAccessAllowed({
      role: "MEMBER",
      active: true,
      scope: "business",
      membershipBusinessId: "a",
      subscriptionBusinessId: "a",
    }) &&
    !liveScheduleCalendarAccessAllowed({
      role: "MEMBER",
      active: true,
      scope: "assigned",
      membershipBusinessId: "a",
      subscriptionBusinessId: "b",
    }),
);

const NY = "America/New_York";
const LA = "America/Los_Angeles";
const springEarly = zonedCivilToUtc(2026, 3, 8, 1, 30, 0, NY);
const springLate = zonedCivilToUtc(2026, 3, 8, 3, 30, 0, NY);
const fallEdt = new Date("2026-11-01T05:30:00.000Z");
const fallEst = new Date("2026-11-01T06:30:00.000Z");

try {
  console.log("\nDB — create/rotate/revoke, live recheck, DST, cancel, leak, concurrency");
  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Sub",
      slug: `alpha-sub-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: NY,
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Sub",
      slug: `beta-sub-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: LA,
    },
  });

  const ownerA = await prisma.user.create({
    data: {
      name: "Olivia",
      email: `owner-sub-${randomUUID()}@example.com`,
      passwordHash: "hashed-owner-secret",
    },
  });
  const adminA = await prisma.user.create({
    data: {
      name: "Ada",
      email: `admin-sub-${randomUUID()}@example.com`,
      passwordHash: "hashed-admin-secret",
    },
  });
  const memberA = await prisma.user.create({
    data: {
      name: "Mia",
      email: `member-sub-${randomUUID()}@example.com`,
      passwordHash: "hashed-member-secret",
    },
  });
  const memberA2 = await prisma.user.create({
    data: {
      name: "Miles",
      email: `member2-sub-${randomUUID()}@example.com`,
      passwordHash: "hashed-member2-secret",
    },
  });
  const ownerB = await prisma.user.create({
    data: {
      name: "Bea",
      email: `beta-sub-${randomUUID()}@example.com`,
      passwordHash: "hashed-beta-secret",
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
  const ownerMemB = await prisma.membership.create({
    data: { userId: ownerB.id, businessId: businessB.id, role: "OWNER" },
  });

  const customerA = await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: "Pat Secret",
      email: "pat-secret-sub@example.com",
      phone: "555-0100",
    },
  });
  const customerB = await prisma.customer.create({
    data: {
      businessId: businessB.id,
      name: "Beta Secret",
      email: "beta-secret-sub@example.com",
      phone: "555-0199",
    },
  });

  const nowSpring = new Date("2026-03-07T15:00:00.000Z");
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
  const cancelledAssigned = await createJob(businessA.id, {
    customerId: customerA.id,
    status: "CANCELLED",
    scheduledAt: zonedCivilToUtc(2026, 3, 10, 10, 0, 0, NY),
    scheduledDurationMinutes: 60,
    assignedMembershipId: memberMemA.id,
  });
  const reassignJob = await createJob(businessA.id, {
    customerId: customerA.id,
    status: "SCHEDULED",
    scheduledAt: zonedCivilToUtc(2026, 3, 12, 9, 0, 0, NY),
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
  const betaJob = await createJob(businessB.id, {
    customerId: customerB.id,
    status: "SCHEDULED",
    scheduledAt: new Date("2026-03-09T16:00:00.000Z"),
    scheduledDurationMinutes: 60,
  });

  const ownerAccessA = makeAccess(businessA.id, "OWNER", ownerMemA.id, true, NY);
  const adminAccessA = makeAccess(businessA.id, "ADMIN", adminMemA.id, true, NY);
  const memberAccessA = makeAccess(businessA.id, "MEMBER", memberMemA.id, true, NY);
  const memberAccessA2 = makeAccess(businessA.id, "MEMBER", memberMemA2.id, true, NY);
  const ownerAccessB = makeAccess(businessB.id, "OWNER", ownerMemB.id, true, LA);

  await expectRejects(
    "ADMIN cannot create a business-schedule subscription",
    () => createScheduleCalendarSubscription(prisma, adminAccessA, "business"),
    (error) => error instanceof ForbiddenError,
  );
  await expectRejects(
    "MEMBER cannot create a business-schedule subscription",
    () => createScheduleCalendarSubscription(prisma, memberAccessA, "business"),
    (error) => error instanceof ForbiddenError,
  );

  const ownerIssued = await createScheduleCalendarSubscription(prisma, ownerAccessA, "business");
  const workerIssued = await createScheduleCalendarSubscription(prisma, memberAccessA, "assigned");
  const worker2Issued = await createScheduleCalendarSubscription(prisma, memberAccessA2, "assigned");
  const ownerBIssued = await createScheduleCalendarSubscription(prisma, ownerAccessB, "business");

  check(
    "Create returns a 64-hex token and a /calendar/feed URL; only the hash is stored",
    isScheduleCalendarFeedToken(ownerIssued.rawToken) &&
      ownerIssued.feedUrl.endsWith(scheduleCalendarFeedPath(ownerIssued.rawToken)) &&
      (await prisma.scheduleCalendarSubscription.count({
        where: { tokenHash: hashToken(ownerIssued.rawToken) },
      })) === 1 &&
      !(await prisma.scheduleCalendarSubscription.findFirst({
        where: { tokenHash: ownerIssued.rawToken },
      })),
  );

  const stored = await prisma.scheduleCalendarSubscription.findFirst({
    where: { membershipId: ownerMemA.id, scope: "business" },
  });
  check(
    "Persisted row never contains the raw token",
    stored != null &&
      stored.tokenHash === hashToken(ownerIssued.rawToken) &&
      !JSON.stringify(stored).includes(ownerIssued.rawToken),
  );

  await expectRejects(
    "Creating a second active business subscription is rejected",
    () => createScheduleCalendarSubscription(prisma, ownerAccessA, "business"),
    (error) =>
      error instanceof ScheduleCalendarSubscriptionError && error.code === "INVALID",
  );

  const ownerFeed = await readScheduleCalendarFeed(prisma, ownerIssued.rawToken, {
    now: nowSpring,
  });
  const workerFeed = await readScheduleCalendarFeed(prisma, workerIssued.rawToken, {
    now: nowSpring,
  });
  const worker2Feed = await readScheduleCalendarFeed(prisma, worker2Issued.rawToken, {
    now: nowSpring,
  });
  const ownerBFeed = await readScheduleCalendarFeed(prisma, ownerBIssued.rawToken, {
    now: nowSpring,
  });

  const ownerIds = new Set(ownerFeed.events.map((event) => event.jobId));
  const workerIds = new Set(workerFeed.events.map((event) => event.jobId));
  const worker2Ids = new Set(worker2Feed.events.map((event) => event.jobId));

  check(
    "OWNER feed includes assigned, unassigned, and currently cancelled recorded windows",
    ownerIds.has(assignedUpcoming.id) &&
      ownerIds.has(unassignedUpcoming.id) &&
      ownerIds.has(cancelledAssigned.id) &&
      ownerIds.has(reassignJob.id) &&
      ownerIds.has(otherWorkerJob.id) &&
      ownerFeed.limits.liveSynchronization === true &&
      ownerFeed.limits.publicSubscription === false,
  );
  check(
    "Active worker feed is assignment-scoped and still includes that worker's cancelled job",
    workerIds.has(assignedUpcoming.id) &&
      workerIds.has(cancelledAssigned.id) &&
      workerIds.has(reassignJob.id) &&
      !workerIds.has(unassignedUpcoming.id) &&
      !workerIds.has(otherWorkerJob.id) &&
      worker2Ids.has(otherWorkerJob.id) &&
      !worker2Ids.has(assignedUpcoming.id),
  );
  check(
    "Tenant isolation: neither feed sees the other business",
    !ownerIds.has(betaJob.id) &&
      ownerBFeed.events.every((event) => event.jobId === betaJob.id) &&
      !workerIds.has(betaJob.id),
  );

  const plantedSecrets = [
    "pat-secret-sub@example.com",
    "555-0100",
    "Pat Secret",
    "Key under mat",
    "4321",
    "Please use the side gate",
    "hashed-owner-secret",
    assignedUpcoming.projectToken,
    ownerIssued.rawToken,
    workerIssued.rawToken,
    "beta-secret-sub@example.com",
  ];
  check(
    "ICS omits customer contact, notes, secrets, and the raw feed token",
    plantedSecrets.every((secret) => !ownerFeed.ics.includes(secret)) &&
      plantedSecrets.every((secret) => !workerFeed.ics.includes(secret)) &&
      ownerFeed.ics.includes(`X-TBBT-JOB-ID:${assignedUpcoming.id}`) &&
      !ownerFeed.ics.includes("webcal"),
  );

  const parsedOwner = parseScheduleCalendarIcs(ownerFeed.ics);
  const cancelledEvent = parsedOwner.events.find((event) => event.jobId === cancelledAssigned.id);
  const springEvent = parsedOwner.events.find((event) => event.jobId === springJob.id);
  const springAfterEvent = parsedOwner.events.find((event) => event.jobId === springJobAfter.id);
  check(
    "Cancelled job stays in the live feed as STATUS:CANCELLED with the same UID",
    cancelledEvent?.icsStatus === "CANCELLED" &&
      cancelledEvent?.status === "CANCELLED" &&
      cancelledEvent?.uid === `tbbt-job-${cancelledAssigned.id}@tbbt` &&
      parsedOwner.liveFeed === true &&
      parsedOwner.publicSubscription === false,
  );
  check(
    "Spring-forward DST uses IANA local stamps and distinct UTC instants",
    parsedOwner.timeZone === NY &&
      springEvent?.dtstartUtc === "20260308T063000Z" &&
      springEvent?.localStart === "2026-03-08 01:30 America/New_York" &&
      springAfterEvent?.dtstartUtc === "20260308T073000Z" &&
      springAfterEvent?.localStart === "2026-03-08 03:30 America/New_York",
  );

  const ownerFall = await readScheduleCalendarFeed(prisma, ownerIssued.rawToken, {
    now: new Date("2026-10-20T15:00:00.000Z"),
  });
  const parsedFall = parseScheduleCalendarIcs(ownerFall.ics);
  const fallEdtEvent = parsedFall.events.find((event) => event.jobId === fallJobEdt.id);
  const fallEstEvent = parsedFall.events.find((event) => event.jobId === fallJobEst.id);
  check(
    "Fall-back 01:30 EDT and 01:30 EST stay distinct UTC events",
    fallEdtEvent?.localStart === "2026-11-01 01:30 America/New_York" &&
      fallEstEvent?.localStart === "2026-11-01 01:30 America/New_York" &&
      fallEdtEvent?.dtstartUtc === "20261101T053000Z" &&
      fallEstEvent?.dtstartUtc === "20261101T063000Z",
  );

  const parsedBeta = parseScheduleCalendarIcs(ownerBFeed.ics);
  const betaEvent = parsedBeta.events.find((event) => event.jobId === betaJob.id);
  check(
    "Pacific tenant feed uses America/Los_Angeles, not the New York default",
    parsedBeta.timeZone === LA &&
      betaEvent?.localStart === "2026-03-09 09:00 America/Los_Angeles" &&
      betaEvent?.dtstartUtc === "20260309T160000Z",
  );

  await prisma.job.update({
    where: { id: reassignJob.id },
    data: { assignedMembershipId: memberMemA2.id },
  });
  const afterReassignA = await readScheduleCalendarFeed(prisma, workerIssued.rawToken, {
    now: nowSpring,
  });
  const afterReassignA2 = await readScheduleCalendarFeed(prisma, worker2Issued.rawToken, {
    now: nowSpring,
  });
  check(
    "Chat 4-style reassignment drops the job from the previous worker feed immediately",
    !afterReassignA.events.some((event) => event.jobId === reassignJob.id) &&
      afterReassignA2.events.some((event) => event.jobId === reassignJob.id),
  );

  await prisma.membership.update({
    where: { id: memberMemA.id },
    data: { active: false },
  });
  await expectRejects(
    "Deactivated worker token is denied on the next feed read",
    () => readScheduleCalendarFeed(prisma, workerIssued.rawToken, { now: nowSpring }),
    (error) =>
      error instanceof ScheduleCalendarSubscriptionError &&
      error.status === 404 &&
      error.message === SCHEDULE_CALENDAR_FEED_NOT_FOUND_MESSAGE,
  );
  await prisma.membership.update({
    where: { id: memberMemA.id },
    data: { active: true },
  });
  const afterReactivate = await readScheduleCalendarFeed(prisma, workerIssued.rawToken, {
    now: nowSpring,
  });
  check(
    "Reactivated worker can read the assigned feed again",
    afterReactivate.events.some((event) => event.jobId === assignedUpcoming.id),
  );

  await prisma.membership.update({
    where: { id: ownerMemA.id },
    data: { role: "MEMBER" },
  });
  await expectRejects(
    "Business feed is denied as soon as the holder is no longer OWNER",
    () => readScheduleCalendarFeed(prisma, ownerIssued.rawToken, { now: nowSpring }),
    (error) =>
      error instanceof ScheduleCalendarSubscriptionError && error.status === 404,
  );
  await prisma.membership.update({
    where: { id: ownerMemA.id },
    data: { role: "OWNER" },
  });

  await expectRejects(
    "Malformed and unknown tokens return the same not-found error",
    () => readScheduleCalendarFeed(prisma, "not-a-token", { now: nowSpring }),
    (error) =>
      error instanceof ScheduleCalendarSubscriptionError &&
      error.message === SCHEDULE_CALENDAR_FEED_NOT_FOUND_MESSAGE,
  );
  await expectRejects(
    "Well-formed unknown token does not leak existence",
    () => readScheduleCalendarFeed(prisma, createSecureToken(), { now: nowSpring }),
    (error) =>
      error instanceof ScheduleCalendarSubscriptionError &&
      error.message === SCHEDULE_CALENDAR_FEED_NOT_FOUND_MESSAGE,
  );

  const rotated = await rotateScheduleCalendarSubscription(prisma, ownerAccessA, "business");
  await expectRejects(
    "Rotated token invalidates the previous URL immediately",
    () => readScheduleCalendarFeed(prisma, ownerIssued.rawToken, { now: nowSpring }),
    (error) =>
      error instanceof ScheduleCalendarSubscriptionError && error.status === 404,
  );
  const afterRotate = await readScheduleCalendarFeed(prisma, rotated.rawToken, {
    now: nowSpring,
  });
  check(
    "New rotated token serves the current business schedule",
    afterRotate.events.some((event) => event.jobId === assignedUpcoming.id) &&
      rotated.rawToken !== ownerIssued.rawToken,
  );

  scheduleCalendarSubscriptionTestHooks.afterLookup = async ({ subscriptionId }) => {
    await prisma.scheduleCalendarSubscription.update({
      where: { id: subscriptionId },
      data: {
        revokedAt: new Date(),
        tokenHash: hashToken(createSecureToken()),
      },
    });
  };
  await expectRejects(
    "Concurrent revoke during read is denied by the final token recheck",
    () => readScheduleCalendarFeed(prisma, rotated.rawToken, { now: nowSpring }),
    (error) =>
      error instanceof ScheduleCalendarSubscriptionError &&
      error.status === 404 &&
      error.message === SCHEDULE_CALENDAR_FEED_NOT_FOUND_MESSAGE,
  );
  scheduleCalendarSubscriptionTestHooks.afterLookup = undefined;

  const ownerStatusAfterConcurrent = await loadScheduleCalendarSubscriptionStatus(
    prisma,
    ownerAccessA,
    "business",
  );
  check(
    "Concurrent revoke left the row revoked; recreate issues a new token",
    ownerStatusAfterConcurrent.active === false && ownerStatusAfterConcurrent.revokedAt != null,
  );
  const recreated = await createScheduleCalendarSubscription(prisma, ownerAccessA, "business");
  await revokeScheduleCalendarSubscription(prisma, ownerAccessA, "business");
  await expectRejects(
    "Explicit revoke denies the burned token",
    () => readScheduleCalendarFeed(prisma, recreated.rawToken, { now: nowSpring }),
    (error) =>
      error instanceof ScheduleCalendarSubscriptionError && error.status === 404,
  );

  scheduleCalendarSubscriptionTestHooks.afterLookup = async ({ subscriptionId }) => {
    await prisma.membership.update({
      where: { id: memberMemA.id },
      data: { active: false },
    });
    void subscriptionId;
  };
  await expectRejects(
    "Concurrent deactivation during read is denied by the membership recheck",
    () => readScheduleCalendarFeed(prisma, workerIssued.rawToken, { now: nowSpring }),
    (error) =>
      error instanceof ScheduleCalendarSubscriptionError && error.status === 404,
  );
  scheduleCalendarSubscriptionTestHooks.afterLookup = undefined;
  await prisma.membership.update({
    where: { id: memberMemA.id },
    data: { active: true },
  });

  check(
    "HTTP cache headers refuse shared caches and referrers",
    SCHEDULE_CALENDAR_FEED_CACHE_CONTROL.includes("no-store") &&
      SCHEDULE_CALENDAR_FEED_CACHE_CONTROL.includes("private") &&
      SCHEDULE_CALENDAR_FEED_HEADERS["Referrer-Policy"] === "no-referrer" &&
      SCHEDULE_CALENDAR_FEED_HEADERS["X-Robots-Tag"].includes("noindex"),
  );

  const status = await loadScheduleCalendarSubscriptionStatus(prisma, memberAccessA, "assigned");
  check(
    "Status loader never returns a token or hash",
    status.available &&
      status.active &&
      !("rawToken" in status) &&
      !("tokenHash" in status) &&
      !("feedUrl" in status),
  );
} catch (error) {
  failures += 1;
  console.error("FAIL - unexpected schedule calendar subscription test error");
  console.error(error);
} finally {
  scheduleCalendarSubscriptionTestHooks.afterLookup = undefined;
  await session.cleanup();
}

if (failures > 0) {
  console.error(`\nSchedule calendar subscription check failed: ${failures} issue(s).`);
  process.exit(1);
}

console.log("\nAll schedule calendar subscription checks passed.");
