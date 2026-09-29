/**
 * Worker-requested dated availability exceptions / time off.
 *
 * Dedicated database: tbbt_workforce_availability_request_test
 *
 * Refuses unless DATABASE_URL is localhost / 127.0.0.1. Preview shares
 * DATABASE_URL with live Production. Drops the dedicated DB on finish.
 *
 * Proves MEMBER self-scoping, OWNER-only accept/decline, tenant isolation,
 * real concurrent decisions, date bounds in business timezones, replace
 * confirmation for an existing recorded exception, and that only
 * acceptance writes MembershipAvailabilityException.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-workforce-availability-request.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for availability-request checks.");
  process.exit(generateEarly.status ?? 1);
}

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { DEFAULT_AVAILABILITY_SETTINGS } = await import("@/lib/availability");
const { DEFAULT_BUSINESS_TIMEZONE, formatISODateInTimeZone } = await import(
  "@/lib/business-timezone"
);
const { CAPABILITIES, ForbiddenError, roleHasCapability } = await import("@/lib/authorization");
const { memberWindowForDay } = await import("@/lib/workforce-capacity");
const {
  AVAILABILITY_REQUEST_AVAILABLE_HOURS_MESSAGE,
  AVAILABILITY_REQUEST_DECIDE_CONFLICT_MESSAGE,
  AVAILABILITY_REQUEST_FAR_FUTURE_MESSAGE,
  AVAILABILITY_REQUEST_INACTIVE_MESSAGE,
  AVAILABILITY_REQUEST_PAST_ACCEPT_MESSAGE,
  AVAILABILITY_REQUEST_PAST_DATE_MESSAGE,
  AVAILABILITY_REQUEST_PENDING_EXISTS_MESSAGE,
  AVAILABILITY_REQUEST_PENDING_LIST_LIMIT,
  AVAILABILITY_REQUEST_RECENT_LIST_LIMIT,
  AVAILABILITY_REQUEST_REPLACE_REQUIRED_MESSAGE,
  AVAILABILITY_REQUEST_SELF_LIST_LIMIT,
  AVAILABILITY_REQUEST_STALE_MESSAGE,
} = await import("@/lib/workforce");
const { WorkforceError } = await import("@/lib/workforce-ops");
const {
  availabilityRequestTestHooks,
  decideMemberAvailabilityExceptionRequestOp,
  loadOwnedAvailabilityExceptionRequests,
  loadSelfAvailabilityExceptionRequests,
  requestMemberAvailabilityExceptionOp,
} = await import("@/lib/workforce-availability-request-ops");

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

async function expectError(label, fn, predicate) {
  try {
    await fn();
    failed += 1;
    console.error(`FAIL - ${label} (no error thrown)`);
  } catch (error) {
    if (predicate(error)) {
      passed += 1;
      console.log(`  ok  - ${label}`);
    } else {
      failed += 1;
      console.error(`FAIL - ${label}`, error);
    }
  }
}

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

function isLocalDatabaseHost(urlString) {
  try {
    const host = new URL(urlString).hostname;
    return host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}

function createCountBarrier(count) {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let arrivedCount = 0;
  let allArrived;
  const waiting = new Promise((resolve) => {
    allArrived = resolve;
  });
  return {
    wait: async () => {
      arrivedCount += 1;
      if (arrivedCount >= count) allArrived();
      await held;
    },
    arrived: waiting,
    release: () => release(),
  };
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const opsSrc = readRepo("src/lib/workforce-availability-request-ops.ts");
const actionSrc = readRepo("src/app/actions/workforce.ts");
const fieldUi = readRepo("src/components/field/availability-exception-request-form.tsx");
const teamUi = readRepo("src/components/team/availability-exception-requests.tsx");
const schema = readRepo("prisma/schema.prisma");
const migration = readRepo(
  "prisma/migrations/20260929010300_workforce_availability_exception_request/migration.sql",
);
const checkSrc = readRepo("scripts/check-workforce-availability-request.mjs");

console.log("\nSTATIC — Request is not a recorded exception, no Job mutation");

check(
  "Request model is separate from MembershipAvailabilityException",
  schema.includes("model MembershipAvailabilityExceptionRequest") &&
    schema.includes("model MembershipAvailabilityException") &&
    schema.includes("Only ACCEPT writes"),
);
check(
  "Migration is additive and pending-unique on membership+date",
  migration.includes("CREATE TABLE IF NOT EXISTS \"MembershipAvailabilityExceptionRequest\"") &&
    migration.includes("WHERE \"status\" = 'PENDING'"),
);
check(
  "Ops never assign, reschedule, cancel, or message Jobs",
  !opsSrc.includes("assignedMembershipId:") &&
    !opsSrc.includes("scheduledAt:") &&
    !opsSrc.includes("status: \"CANCELLED\"") &&
    !opsSrc.includes("sendMessage") &&
    !opsSrc.includes("createWorkforceOutreachTask") &&
    opsSrc.includes("never cancel, reassign, or message"),
);
check(
  "OWNER accept is the only path that upserts recorded availability",
  opsSrc.includes("membershipAvailabilityException.upsert") &&
    opsSrc.includes('decision === "ACCEPT"') &&
    actionSrc.includes("Recorded availability now includes that date") &&
    actionSrc.includes("Recorded availability is unchanged"),
);
check(
  "AVAILABLE override collects and validates start/end hours",
  fieldUi.includes('name="start"') &&
    fieldUi.includes('name="end"') &&
    actionSrc.includes("startMinutes") &&
    actionSrc.includes("endMinutes") &&
    opsSrc.includes("AVAILABILITY_REQUEST_AVAILABLE_HOURS_MESSAGE"),
);
check(
  "Owner queue shows a recorded exception and requires explicit replace",
  teamUi.includes("Recorded:") &&
    teamUi.includes("replaceExisting") &&
    teamUi.includes("Accept and replace recorded exception") &&
    opsSrc.includes("AVAILABILITY_REQUEST_REPLACE_REQUIRED_MESSAGE"),
);
check(
  "Owner and self lists are bounded in the query, not sliced in memory",
  opsSrc.includes("take: AVAILABILITY_REQUEST_PENDING_LIST_LIMIT") &&
    opsSrc.includes("take: AVAILABILITY_REQUEST_RECENT_LIST_LIMIT") &&
    opsSrc.includes("take: AVAILABILITY_REQUEST_SELF_LIST_LIMIT") &&
    AVAILABILITY_REQUEST_PENDING_LIST_LIMIT === 100 &&
    AVAILABILITY_REQUEST_RECENT_LIST_LIMIT === 20 &&
    AVAILABILITY_REQUEST_SELF_LIST_LIMIT === 50 &&
    !opsSrc.includes(".slice(0, 20)"),
);
check(
  "Decide P2002 uses the decide conflict message, not the pending-request message",
  opsSrc.includes("asDecideWriteError") &&
    opsSrc.includes("AVAILABILITY_REQUEST_DECIDE_CONFLICT_MESSAGE") &&
    AVAILABILITY_REQUEST_DECIDE_CONFLICT_MESSAGE !== AVAILABILITY_REQUEST_PENDING_EXISTS_MESSAGE,
);
check(
  "Test harness refuses a non-localhost DATABASE_URL before connecting",
  checkSrc.includes("isLocalDatabaseHost") &&
    checkSrc.includes('host === "localhost"') &&
    checkSrc.includes('host === "127.0.0.1"') &&
    checkSrc.includes("Preview shares DATABASE_URL with live Production"),
);
check(
  "UI states that existing jobs are not cancelled, reassigned, or messaged",
  fieldUi.includes("Existing jobs are not cancelled, reassigned") &&
    teamUi.includes("does not cancel, reassign, or message") &&
    actionSrc.includes("Existing jobs were not cancelled, reassigned, or messaged"),
);
check(
  "MEMBER still cannot manage members or jobs",
  !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_MEMBERS) &&
    !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_JOBS),
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run workforce availability-request Prisma checks.");
  process.exit(1);
}
if (!isLocalDatabaseHost(baseUrl)) {
  console.error(
    "Refusing to run: DATABASE_URL host must be localhost or 127.0.0.1. Preview shares DATABASE_URL with live Production.",
  );
  process.exit(1);
}

const testDbName = "tbbt_workforce_availability_request_test";
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
  await admin.$disconnect();
}

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for availability-request test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

const pendingUniqueSql = [
  `CREATE UNIQUE INDEX IF NOT EXISTS "MembershipAvailabilityExceptionRequest_pending_membership_date_key"`,
  `  ON "MembershipAvailabilityExceptionRequest"("membershipId", "date")`,
  `  WHERE "status" = 'PENDING'`,
].join("\n");
await prisma.$executeRawUnsafe(pendingUniqueSql);
check(
  "Applied the migration pending-unique index after db push",
  migration.includes(pendingUniqueSql.split("\n")[0]),
);

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

const NOW = new Date("2026-09-29T16:00:00.000Z");

try {
  console.log("\nPRISMA — MEMBER request, OWNER decide, isolation, concurrency, timezone");

  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Availability",
      slug: `alpha-avl-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: DEFAULT_BUSINESS_TIMEZONE,
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Availability",
      slug: `beta-avl-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: "America/Los_Angeles",
    },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-avl-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Ada Admin", email: `admin-avl-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-avl-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const helperUser = await prisma.user.create({
    data: { name: "Ned Helper", email: `helper-avl-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaOwner = await prisma.user.create({
    data: { name: "Bea Owner", email: `beta-avl-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaMember = await prisma.user.create({
    data: { name: "Ben Member", email: `beta-mem-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const adminMem = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: businessA.id, role: "ADMIN" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER", schedulingActive: true },
  });
  const helperMem = await prisma.membership.create({
    data: { userId: helperUser.id, businessId: businessA.id, role: "MEMBER", schedulingActive: true },
  });
  const betaOwnerMem = await prisma.membership.create({
    data: { userId: betaOwner.id, businessId: businessB.id, role: "OWNER" },
  });
  const betaMemberMem = await prisma.membership.create({
    data: { userId: betaMember.id, businessId: businessB.id, role: "MEMBER", schedulingActive: true },
  });
  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const helperA = makeAccess(businessA.id, "MEMBER", helperMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaOwnerMem.id);
  const memberB = makeAccess(businessB.id, "MEMBER", betaMemberMem.id);

  await prisma.businessSaasSubscription.create({
    data: { businessId: businessA.id, status: "active", planCode: "FOUNDER", legacyExempt: true },
  });
  await prisma.businessSaasSubscription.create({
    data: { businessId: businessB.id, status: "active", planCode: "FOUNDER", legacyExempt: true },
  });

  const customer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Alpha Customer" },
  });
  const jobStart = new Date("2026-10-05T16:00:00.000Z");
  const job = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: jobStart,
      scheduledDurationMinutes: 120,
      assignedMembershipId: memberMem.id,
    },
  });

  await expectError(
    "OWNER cannot use the worker request path",
    () =>
      requestMemberAvailabilityExceptionOp(prisma, ownerA, {
        membershipId: ownerMem.id,
        date: "2026-10-05",
        kind: "UNAVAILABLE",
        now: NOW,
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "ADMIN cannot use the worker request path",
    () =>
      requestMemberAvailabilityExceptionOp(prisma, adminA, {
        membershipId: adminMem.id,
        date: "2026-10-05",
        kind: "UNAVAILABLE",
        now: NOW,
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot request for another worker",
    () =>
      requestMemberAvailabilityExceptionOp(prisma, memberA, {
        membershipId: helperMem.id,
        date: "2026-10-05",
        kind: "UNAVAILABLE",
        now: NOW,
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot request against another tenant membership id",
    () =>
      requestMemberAvailabilityExceptionOp(prisma, memberA, {
        membershipId: betaMemberMem.id,
        date: "2026-10-05",
        kind: "UNAVAILABLE",
        now: NOW,
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "AVAILABLE override without hours is rejected",
    () =>
      requestMemberAvailabilityExceptionOp(prisma, memberA, {
        membershipId: memberMem.id,
        date: "2026-10-05",
        kind: "AVAILABLE",
        now: NOW,
      }),
    (error) =>
      error instanceof WorkforceError && error.message === AVAILABILITY_REQUEST_AVAILABLE_HOURS_MESSAGE,
  );
  await expectError(
    "Past date is rejected in the business timezone",
    () =>
      requestMemberAvailabilityExceptionOp(prisma, memberA, {
        membershipId: memberMem.id,
        date: "2026-09-28",
        kind: "UNAVAILABLE",
        now: NOW,
      }),
    (error) =>
      error instanceof WorkforceError && error.message === AVAILABILITY_REQUEST_PAST_DATE_MESSAGE,
  );
  await expectError(
    "Far-future date more than 12 months out is rejected",
    () =>
      requestMemberAvailabilityExceptionOp(prisma, memberA, {
        membershipId: memberMem.id,
        date: "2027-10-01",
        kind: "UNAVAILABLE",
        now: NOW,
      }),
    (error) =>
      error instanceof WorkforceError && error.message === AVAILABILITY_REQUEST_FAR_FUTURE_MESSAGE,
  );

  const requested = await requestMemberAvailabilityExceptionOp(prisma, memberA, {
    membershipId: memberMem.id,
    date: "2026-10-05",
    kind: "UNAVAILABLE",
    note: "Family day",
    now: NOW,
  });
  const exceptionsAfterRequest = await prisma.membershipAvailabilityException.count({
    where: { businessId: businessA.id },
  });
  const jobAfterRequest = await prisma.job.findFirst({
    where: { id: job.id, businessId: businessA.id },
  });
  check("MEMBER can request time off for themselves", requested.status === "PENDING");
  check(
    "Pending request stores the submitted business-timezone civil date",
    requested.date === "2026-10-05",
  );
  check("Pending request does not write recorded availability", exceptionsAfterRequest === 0);
  check(
    "Pending request does not cancel or reassign the existing job",
    jobAfterRequest?.assignedMembershipId === memberMem.id &&
      jobAfterRequest?.status === "SCHEDULED" &&
      jobAfterRequest?.scheduledAt?.getTime() === jobStart.getTime(),
  );

  await expectError(
    "Duplicate pending request for the same date is rejected",
    () =>
      requestMemberAvailabilityExceptionOp(prisma, memberA, {
        membershipId: memberMem.id,
        date: "2026-10-05",
        kind: "UNAVAILABLE",
        now: NOW,
      }),
    (error) =>
      error instanceof WorkforceError && error.message === AVAILABILITY_REQUEST_PENDING_EXISTS_MESSAGE,
  );

  const selfLoaded = await loadSelfAvailabilityExceptionRequests(prisma, {
    businessId: businessA.id,
    membershipId: memberMem.id,
  });
  const helperLoaded = await loadSelfAvailabilityExceptionRequests(prisma, {
    businessId: businessA.id,
    membershipId: helperMem.id,
  });
  check(
    "Self loader only returns the worker's own requests",
    selfLoaded.length === 1 &&
      selfLoaded[0].id === requested.id &&
      helperLoaded.length === 0,
  );

  const ownerQueue = await loadOwnedAvailabilityExceptionRequests(prisma, ownerA);
  check(
    "OWNER sees the pending request for this tenant only",
    ownerQueue.pending.length === 1 &&
      ownerQueue.pending[0].id === requested.id &&
      ownerQueue.canDecide === true &&
      ownerQueue.pending[0].existingException == null,
  );
  const adminQueue = await loadOwnedAvailabilityExceptionRequests(prisma, adminA);
  check(
    "ADMIN can read pending requests but cannot decide",
    adminQueue.pending.length === 1 && adminQueue.canDecide === false,
  );
  await expectError(
    "MEMBER cannot load the owner request queue",
    () => loadOwnedAvailabilityExceptionRequests(prisma, memberA),
    (error) => error instanceof ForbiddenError,
  );

  await expectError(
    "ADMIN cannot accept or decline",
    () =>
      decideMemberAvailabilityExceptionRequestOp(prisma, adminA, {
        requestId: requested.id,
        decision: "ACCEPT",
        expectedUpdatedAt: requested.updatedAt,
        now: NOW,
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot accept or decline",
    () =>
      decideMemberAvailabilityExceptionRequestOp(prisma, memberA, {
        requestId: requested.id,
        decision: "ACCEPT",
        expectedUpdatedAt: requested.updatedAt,
        now: NOW,
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "Foreign OWNER cannot decide tenant A's request",
    () =>
      decideMemberAvailabilityExceptionRequestOp(prisma, ownerB, {
        requestId: requested.id,
        decision: "ACCEPT",
        expectedUpdatedAt: requested.updatedAt,
        now: NOW,
      }),
    (error) => error instanceof ForbiddenError,
  );
  check(
    "Foreign decide left tenant A without an exception or job change",
    (await prisma.membershipAvailabilityException.count({ where: { businessId: businessA.id } })) ===
      0 &&
      (await prisma.job.findFirst({ where: { id: job.id, businessId: businessA.id } }))
        ?.assignedMembershipId === memberMem.id,
  );
  check(
    "Foreign decide wrote no request rows on tenant B",
    (await prisma.membershipAvailabilityExceptionRequest.count({
      where: { businessId: businessB.id },
    })) === 0,
  );

  await expectError(
    "Stale expectedUpdatedAt is rejected before any write",
    () =>
      decideMemberAvailabilityExceptionRequestOp(prisma, ownerA, {
        requestId: requested.id,
        decision: "ACCEPT",
        expectedUpdatedAt: new Date(requested.updatedAt.getTime() - 1000),
        now: NOW,
      }),
    (error) =>
      error instanceof WorkforceError && error.message === AVAILABILITY_REQUEST_STALE_MESSAGE,
  );
  check(
    "Stale accept did not write recorded availability",
    (await prisma.membershipAvailabilityException.count({ where: { businessId: businessA.id } })) ===
      0,
  );

  const declinedOther = await requestMemberAvailabilityExceptionOp(prisma, helperA, {
    membershipId: helperMem.id,
    date: "2026-10-06",
    kind: "UNAVAILABLE",
    now: NOW,
  });
  const declined = await decideMemberAvailabilityExceptionRequestOp(prisma, ownerA, {
    requestId: declinedOther.id,
    decision: "DECLINE",
    expectedUpdatedAt: declinedOther.updatedAt,
    now: NOW,
  });
  check("OWNER decline marks the request declined", declined.request.status === "DECLINED");
  check(
    "OWNER decline does not write recorded availability",
    (await prisma.membershipAvailabilityException.count({
      where: { membershipId: helperMem.id, date: "2026-10-06" },
    })) === 0,
  );

  const accepted = await decideMemberAvailabilityExceptionRequestOp(prisma, ownerA, {
    requestId: requested.id,
    decision: "ACCEPT",
    expectedUpdatedAt: requested.updatedAt,
    now: NOW,
  });
  const exception = await prisma.membershipAvailabilityException.findFirst({
    where: { membershipId: memberMem.id, date: "2026-10-05", businessId: businessA.id },
  });
  const jobAfterAccept = await prisma.job.findFirst({
    where: { id: job.id, businessId: businessA.id },
  });
  check("OWNER accept marks the request accepted", accepted.request.status === "ACCEPTED");
  check(
    "OWNER accept writes the recorded exception on the submitted civil date",
    exception?.kind === "UNAVAILABLE" && exception.date === "2026-10-05",
  );
  check(
    "OWNER accept does not cancel, reassign, or reschedule the existing job",
    jobAfterAccept?.assignedMembershipId === memberMem.id &&
      jobAfterAccept?.status === "SCHEDULED" &&
      jobAfterAccept?.scheduledAt?.getTime() === jobStart.getTime(),
  );
  await expectError(
    "Second decide on an already-decided request is rejected",
    () =>
      decideMemberAvailabilityExceptionRequestOp(prisma, ownerA, {
        requestId: requested.id,
        decision: "DECLINE",
        expectedUpdatedAt: accepted.request.updatedAt,
        now: NOW,
      }),
    (error) =>
      error instanceof WorkforceError && error.message === AVAILABILITY_REQUEST_STALE_MESSAGE,
  );

  const nyEveningOct5 = new Date("2026-10-06T00:00:00.000Z");
  const nyMidnightOct6 = new Date("2026-10-06T04:00:00.000Z");
  const memberSnapshot = {
    membershipId: memberMem.id,
    name: "Mia Member",
    role: "MEMBER",
    active: true,
    schedulingActive: true,
    progression: "CAPABLE",
    maxDailyJobMinutes: null,
    preferredJobTypes: [],
    allowedJobTypes: [],
    workforceNotes: "",
    skills: [],
    weeklyAvailability: [],
    exceptions: [
      { date: exception.date, kind: exception.kind, startMinutes: null, endMinutes: null },
    ],
  };
  check(
    "Accepted NY exception makes 8pm Oct 5 America/New_York unavailable",
    formatISODateInTimeZone(nyEveningOct5, DEFAULT_BUSINESS_TIMEZONE) === "2026-10-05" &&
      memberWindowForDay(
        nyEveningOct5,
        DEFAULT_AVAILABILITY_SETTINGS,
        memberSnapshot,
        DEFAULT_BUSINESS_TIMEZONE,
      ).available === false,
  );

  const availableRequested = await requestMemberAvailabilityExceptionOp(prisma, helperA, {
    membershipId: helperMem.id,
    date: "2026-10-07",
    kind: "AVAILABLE",
    startMinutes: 9 * 60,
    endMinutes: 15 * 60,
    now: NOW,
  });
  const availableAccepted = await decideMemberAvailabilityExceptionRequestOp(prisma, ownerA, {
    requestId: availableRequested.id,
    decision: "ACCEPT",
    expectedUpdatedAt: availableRequested.updatedAt,
    now: NOW,
  });
  const availableException = await prisma.membershipAvailabilityException.findFirst({
    where: { membershipId: helperMem.id, date: "2026-10-07", businessId: businessA.id },
  });
  check(
    "AVAILABLE accept stores the requested hours",
    availableAccepted.request.status === "ACCEPTED" &&
      availableException?.kind === "AVAILABLE" &&
      availableException.startMinutes === 9 * 60 &&
      availableException.endMinutes === 15 * 60,
  );

  await prisma.membershipAvailabilityException.create({
    data: {
      businessId: businessA.id,
      membershipId: memberMem.id,
      date: "2026-10-09",
      kind: "UNAVAILABLE",
      note: "Owner-entered day off",
    },
  });
  const replaceRequest = await requestMemberAvailabilityExceptionOp(prisma, memberA, {
    membershipId: memberMem.id,
    date: "2026-10-09",
    kind: "AVAILABLE",
    startMinutes: 10 * 60,
    endMinutes: 14 * 60,
    note: "Can work a short window",
    now: NOW,
  });
  const replaceQueue = await loadOwnedAvailabilityExceptionRequests(prisma, ownerA);
  const replaceCard = replaceQueue.pending.find((row) => row.id === replaceRequest.id);
  check(
    "Owner queue shows the existing recorded exception for that date",
    replaceCard?.existingException?.kind === "UNAVAILABLE" &&
      replaceCard.existingException.note === "Owner-entered day off",
  );
  await expectError(
    "Accept without replace confirmation refuses to overwrite the recorded exception",
    () =>
      decideMemberAvailabilityExceptionRequestOp(prisma, ownerA, {
        requestId: replaceRequest.id,
        decision: "ACCEPT",
        expectedUpdatedAt: replaceRequest.updatedAt,
        now: NOW,
      }),
    (error) =>
      error instanceof WorkforceError && error.message === AVAILABILITY_REQUEST_REPLACE_REQUIRED_MESSAGE,
  );
  const stillOwnerException = await prisma.membershipAvailabilityException.findFirst({
    where: { membershipId: memberMem.id, date: "2026-10-09", businessId: businessA.id },
  });
  check(
    "Refused overwrite left the owner-entered exception unchanged",
    stillOwnerException?.kind === "UNAVAILABLE" &&
      stillOwnerException.note === "Owner-entered day off" &&
      (await prisma.membershipAvailabilityExceptionRequest.findFirst({
        where: { id: replaceRequest.id, businessId: businessA.id },
      }))?.status === "PENDING",
  );
  const replaced = await decideMemberAvailabilityExceptionRequestOp(prisma, ownerA, {
    requestId: replaceRequest.id,
    decision: "ACCEPT",
    expectedUpdatedAt: replaceRequest.updatedAt,
    replaceExisting: true,
    now: NOW,
  });
  const replacedException = await prisma.membershipAvailabilityException.findFirst({
    where: { membershipId: memberMem.id, date: "2026-10-09", businessId: businessA.id },
  });
  check(
    "Explicit replace confirmation overwrites the recorded exception",
    replaced.request.status === "ACCEPTED" &&
      replacedException?.kind === "AVAILABLE" &&
      replacedException.startMinutes === 10 * 60 &&
      replacedException.endMinutes === 14 * 60,
  );

  const pastAcceptRequest = await requestMemberAvailabilityExceptionOp(prisma, helperA, {
    membershipId: helperMem.id,
    date: "2026-10-08",
    kind: "UNAVAILABLE",
    now: NOW,
  });
  await expectError(
    "Accept refuses a request whose date is already past in the business timezone",
    () =>
      decideMemberAvailabilityExceptionRequestOp(prisma, ownerA, {
        requestId: pastAcceptRequest.id,
        decision: "ACCEPT",
        expectedUpdatedAt: pastAcceptRequest.updatedAt,
        now: new Date("2026-10-09T16:00:00.000Z"),
      }),
    (error) =>
      error instanceof WorkforceError && error.message === AVAILABILITY_REQUEST_PAST_ACCEPT_MESSAGE,
  );
  check(
    "Past-dated accept left the request pending and wrote no exception",
    (await prisma.membershipAvailabilityExceptionRequest.findFirst({
      where: { id: pastAcceptRequest.id, businessId: businessA.id },
    }))?.status === "PENDING" &&
      (await prisma.membershipAvailabilityException.count({
        where: { membershipId: helperMem.id, date: "2026-10-08", businessId: businessA.id },
      })) === 0,
  );

  const nyBeforeMidnight = new Date("2026-09-30T03:59:59.000Z");
  const nyAfterMidnight = new Date("2026-09-30T04:00:01.000Z");
  const todayNy = await requestMemberAvailabilityExceptionOp(prisma, helperA, {
    membershipId: helperMem.id,
    date: "2026-09-29",
    kind: "UNAVAILABLE",
    now: nyBeforeMidnight,
  });
  check(
    "NY just before midnight still treats Sep 29 as today",
    todayNy.date === "2026-09-29" &&
      formatISODateInTimeZone(nyBeforeMidnight, DEFAULT_BUSINESS_TIMEZONE) === "2026-09-29",
  );
  await expectError(
    "NY just after midnight treats Sep 29 as past",
    () =>
      requestMemberAvailabilityExceptionOp(prisma, helperA, {
        membershipId: helperMem.id,
        date: "2026-09-29",
        kind: "UNAVAILABLE",
        now: nyAfterMidnight,
      }),
    (error) =>
      error instanceof WorkforceError && error.message === AVAILABILITY_REQUEST_PAST_DATE_MESSAGE,
  );

  const laBeforeMidnight = new Date("2026-09-30T06:59:59.000Z");
  const laAfterMidnight = new Date("2026-09-30T07:00:01.000Z");
  const todayLa = await requestMemberAvailabilityExceptionOp(prisma, memberB, {
    membershipId: betaMemberMem.id,
    date: "2026-09-29",
    kind: "UNAVAILABLE",
    now: laBeforeMidnight,
  });
  check(
    "LA just before midnight still treats Sep 29 as today",
    todayLa.date === "2026-09-29" &&
      formatISODateInTimeZone(laBeforeMidnight, "America/Los_Angeles") === "2026-09-29",
  );
  await expectError(
    "LA just after midnight treats Sep 29 as past",
    () =>
      requestMemberAvailabilityExceptionOp(prisma, memberB, {
        membershipId: betaMemberMem.id,
        date: "2026-09-29",
        kind: "UNAVAILABLE",
        now: laAfterMidnight,
      }),
    (error) =>
      error instanceof WorkforceError && error.message === AVAILABILITY_REQUEST_PAST_DATE_MESSAGE,
  );

  const pacificRequested = await requestMemberAvailabilityExceptionOp(prisma, memberB, {
    membershipId: betaMemberMem.id,
    date: "2026-10-05",
    kind: "UNAVAILABLE",
    note: "Pacific day off",
    now: NOW,
  });
  const pacificAccepted = await decideMemberAvailabilityExceptionRequestOp(prisma, ownerB, {
    requestId: pacificRequested.id,
    decision: "ACCEPT",
    expectedUpdatedAt: pacificRequested.updatedAt,
    now: NOW,
  });
  const pacificException = await prisma.membershipAvailabilityException.findFirst({
    where: { membershipId: betaMemberMem.id, date: "2026-10-05", businessId: businessB.id },
  });
  const laEveningOct5 = new Date("2026-10-06T04:00:00.000Z");
  const pacificMember = {
    ...memberSnapshot,
    membershipId: betaMemberMem.id,
    name: "Ben Member",
    exceptions: [
      {
        date: pacificException.date,
        kind: pacificException.kind,
        startMinutes: null,
        endMinutes: null,
      },
    ],
  };
  check(
    "Pacific tenant stores the same civil date without UTC rewrite",
    pacificAccepted.request.date === "2026-10-05" && pacificException?.date === "2026-10-05",
  );
  check(
    "Pacific 9pm Oct 5 stays on the requested date, not UTC Oct 6",
    formatISODateInTimeZone(laEveningOct5, "America/Los_Angeles") === "2026-10-05" &&
      formatISODateInTimeZone(laEveningOct5, DEFAULT_BUSINESS_TIMEZONE) === "2026-10-06" &&
      memberWindowForDay(
        laEveningOct5,
        DEFAULT_AVAILABILITY_SETTINGS,
        pacificMember,
        "America/Los_Angeles",
      ).available === false,
  );
  check(
    "Tenant A exception count is unchanged by tenant B accept",
    (await prisma.membershipAvailabilityException.count({
      where: { businessId: businessA.id, membershipId: memberMem.id, date: "2026-10-05" },
    })) === 1,
  );

  const raceDate = "2026-10-13";
  const raceRequest = await requestMemberAvailabilityExceptionOp(prisma, memberA, {
    membershipId: memberMem.id,
    date: raceDate,
    kind: "UNAVAILABLE",
    now: NOW,
  });
  const jobBeforeRace = await prisma.job.findFirst({
    where: { id: job.id, businessId: businessA.id },
  });
  const decideBarrier = createCountBarrier(2);
  availabilityRequestTestHooks.beforeDecideClaims = decideBarrier.wait;
  const acceptClient = new PrismaClient({ datasourceUrl: testUrl });
  const declineClient = new PrismaClient({ datasourceUrl: testUrl });
  let decideRace;
  try {
    const acceptHeld = decideMemberAvailabilityExceptionRequestOp(acceptClient, ownerA, {
      requestId: raceRequest.id,
      decision: "ACCEPT",
      expectedUpdatedAt: raceRequest.updatedAt,
      now: NOW,
    });
    const declineHeld = decideMemberAvailabilityExceptionRequestOp(declineClient, ownerA, {
      requestId: raceRequest.id,
      decision: "DECLINE",
      expectedUpdatedAt: raceRequest.updatedAt,
      now: NOW,
    });
    await withTimeout(decideBarrier.arrived, 4000, "both decide transactions read PENDING");
    decideBarrier.release();
    decideRace = await Promise.allSettled([acceptHeld, declineHeld]);
  } finally {
    availabilityRequestTestHooks.beforeDecideClaims = undefined;
    await acceptClient.$disconnect();
    await declineClient.$disconnect();
  }
  const won = decideRace.filter((row) => row.status === "fulfilled");
  const lost = decideRace.filter(
    (row) =>
      row.status === "rejected" &&
      row.reason instanceof WorkforceError &&
      (row.reason.message === AVAILABILITY_REQUEST_STALE_MESSAGE ||
        row.reason.message === AVAILABILITY_REQUEST_DECIDE_CONFLICT_MESSAGE),
  );
  const raceRow = await prisma.membershipAvailabilityExceptionRequest.findFirst({
    where: { id: raceRequest.id, businessId: businessA.id },
  });
  const raceException = await prisma.membershipAvailabilityException.findFirst({
    where: { membershipId: memberMem.id, date: raceDate, businessId: businessA.id },
  });
  const jobAfterRace = await prisma.job.findFirst({
    where: { id: job.id, businessId: businessA.id },
  });
  check(
    "Exactly one concurrent decision commits after both read PENDING",
    won.length === 1 && lost.length === 1,
  );
  check(
    "Loser concurrent decision does not write a second status",
    raceRow?.status === (won[0].value.decision === "ACCEPT" ? "ACCEPTED" : "DECLINED"),
  );
  check(
    "Recorded availability matches only the winning decision",
    won[0].value.decision === "ACCEPT" ? Boolean(raceException) : raceException == null,
  );
  check(
    "Concurrent decisions do not cancel or reassign the existing job",
    jobAfterRace?.assignedMembershipId === jobBeforeRace?.assignedMembershipId &&
      jobAfterRace?.status === "SCHEDULED" &&
      jobAfterRace?.scheduledAt?.getTime() === jobBeforeRace?.scheduledAt?.getTime(),
  );

  const deactivateDate = "2026-10-14";
  const deactivateRequest = await requestMemberAvailabilityExceptionOp(prisma, helperA, {
    membershipId: helperMem.id,
    date: deactivateDate,
    kind: "UNAVAILABLE",
    now: NOW,
  });
  const deactivateBarrier = createCountBarrier(1);
  availabilityRequestTestHooks.beforeDecideClaims = deactivateBarrier.wait;
  const deactivateClient = new PrismaClient({ datasourceUrl: testUrl });
  let deactivateResult;
  try {
    const acceptHeld = decideMemberAvailabilityExceptionRequestOp(prisma, ownerA, {
      requestId: deactivateRequest.id,
      decision: "ACCEPT",
      expectedUpdatedAt: deactivateRequest.updatedAt,
      now: NOW,
    });
    await withTimeout(deactivateBarrier.arrived, 4000, "deactivate-during-accept entered write");
    await deactivateClient.membership.update({
      where: { id: helperMem.id },
      data: { active: false },
    });
    deactivateBarrier.release();
    deactivateResult = await Promise.allSettled([acceptHeld]);
  } finally {
    availabilityRequestTestHooks.beforeDecideClaims = undefined;
    await deactivateClient.$disconnect();
  }
  const deactivateError = deactivateResult[0];
  check(
    "Deactivate-during-accept refuses after both sides have entered the commit",
    deactivateError.status === "rejected" &&
      deactivateError.reason instanceof WorkforceError &&
      deactivateError.reason.message === AVAILABILITY_REQUEST_INACTIVE_MESSAGE,
  );
  check(
    "Deactivate-during-accept did not write recorded availability",
    (await prisma.membershipAvailabilityException.count({
      where: { membershipId: helperMem.id, date: deactivateDate, businessId: businessA.id },
    })) === 0,
  );
  check(
    "Deactivate-during-accept left the request pending",
    (await prisma.membershipAvailabilityExceptionRequest.findFirst({
      where: { id: deactivateRequest.id, businessId: businessA.id },
    }))?.status === "PENDING",
  );

  await prisma.membership.update({
    where: { id: helperMem.id },
    data: { active: true },
  });
  const createDate = "2026-10-15";
  const createBarrier = createCountBarrier(2);
  availabilityRequestTestHooks.beforeRequestCreate = createBarrier.wait;
  const createA = new PrismaClient({ datasourceUrl: testUrl });
  const createB = new PrismaClient({ datasourceUrl: testUrl });
  let createRace;
  try {
    const first = requestMemberAvailabilityExceptionOp(createA, helperA, {
      membershipId: helperMem.id,
      date: createDate,
      kind: "UNAVAILABLE",
      now: NOW,
    });
    const second = requestMemberAvailabilityExceptionOp(createB, helperA, {
      membershipId: helperMem.id,
      date: createDate,
      kind: "UNAVAILABLE",
      now: NOW,
    });
    await withTimeout(createBarrier.arrived, 4000, "both creates passed the pending lookup");
    createBarrier.release();
    createRace = await Promise.allSettled([first, second]);
  } finally {
    availabilityRequestTestHooks.beforeRequestCreate = undefined;
    await createA.$disconnect();
    await createB.$disconnect();
  }
  const createWon = createRace.filter((row) => row.status === "fulfilled");
  const createLost = createRace.filter(
    (row) =>
      row.status === "rejected" &&
      row.reason instanceof WorkforceError &&
      row.reason.message === AVAILABILITY_REQUEST_PENDING_EXISTS_MESSAGE,
  );
  const createRows = await prisma.membershipAvailabilityExceptionRequest.findMany({
    where: { membershipId: helperMem.id, date: createDate, businessId: businessA.id, status: "PENDING" },
  });
  check(
    "Exactly one concurrent duplicate create wins against the pending-unique index",
    createWon.length === 1 && createLost.length === 1 && createRows.length === 1,
  );

  const nyWindowAfterMidnight = memberWindowForDay(
    nyMidnightOct6,
    DEFAULT_AVAILABILITY_SETTINGS,
    memberSnapshot,
    DEFAULT_BUSINESS_TIMEZONE,
  );
  check(
    "NY midnight Oct 6 is a different civil date than the accepted exception",
    formatISODateInTimeZone(nyMidnightOct6, DEFAULT_BUSINESS_TIMEZONE) === "2026-10-06" &&
      nyWindowAfterMidnight.available === true,
  );

  console.log(
    failed === 0
      ? `\nAll workforce availability-request checks passed (${passed}).`
      : `\n${failed} workforce availability-request check(s) failed.`,
  );
} catch (error) {
  failed += 1;
  console.error("FAIL - workforce availability-request Prisma harness threw", error);
} finally {
  availabilityRequestTestHooks.beforeDecideClaims = undefined;
  availabilityRequestTestHooks.beforeRequestCreate = undefined;
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${testDbName}' AND pid <> pg_backend_pid()`,
    );
  } catch {
    /* ignore */
  }
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

process.exit(failed === 0 ? 0 : 1);
