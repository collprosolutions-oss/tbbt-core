/**
 * Worker-requested dated availability exceptions / time off.
 *
 * Dedicated database: tbbt_workforce_availability_request_test
 *
 * Proves MEMBER self-scoping, OWNER-only accept/decline, tenant isolation,
 * concurrent decisions, business-timezone civil dates, and that only
 * acceptance writes MembershipAvailabilityException. Decline and stale
 * commits do not. Existing Jobs are never cancelled, reassigned, or
 * messaged.
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
  AVAILABILITY_REQUEST_INACTIVE_MESSAGE,
  AVAILABILITY_REQUEST_PENDING_EXISTS_MESSAGE,
  AVAILABILITY_REQUEST_STALE_MESSAGE,
} = await import("@/lib/workforce");
const { WorkforceError } = await import("@/lib/workforce-ops");
const {
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

const opsSrc = readRepo("src/lib/workforce-availability-request-ops.ts");
const actionSrc = readRepo("src/app/actions/workforce.ts");
const fieldUi = readRepo("src/components/field/availability-exception-request-form.tsx");
const teamUi = readRepo("src/components/team/availability-exception-requests.tsx");
const schema = readRepo("prisma/schema.prisma");
const migration = readRepo(
  "prisma/migrations/20260929010000_workforce_availability_exception_request/migration.sql",
);

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
  const jobStart = new Date("2026-09-18T16:00:00.000Z");
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
        date: "2026-09-17",
        kind: "UNAVAILABLE",
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "ADMIN cannot use the worker request path",
    () =>
      requestMemberAvailabilityExceptionOp(prisma, adminA, {
        membershipId: adminMem.id,
        date: "2026-09-17",
        kind: "UNAVAILABLE",
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot request for another worker",
    () =>
      requestMemberAvailabilityExceptionOp(prisma, memberA, {
        membershipId: helperMem.id,
        date: "2026-09-17",
        kind: "UNAVAILABLE",
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot request against another tenant membership id",
    () =>
      requestMemberAvailabilityExceptionOp(prisma, memberA, {
        membershipId: betaMemberMem.id,
        date: "2026-09-17",
        kind: "UNAVAILABLE",
      }),
    (error) => error instanceof ForbiddenError,
  );

  const requested = await requestMemberAvailabilityExceptionOp(prisma, memberA, {
    membershipId: memberMem.id,
    date: "2026-09-17",
    kind: "UNAVAILABLE",
    note: "Family day",
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
    requested.date === "2026-09-17",
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
        date: "2026-09-17",
        kind: "UNAVAILABLE",
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
      ownerQueue.canDecide === true,
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
    date: "2026-09-21",
    kind: "UNAVAILABLE",
  });
  const declined = await decideMemberAvailabilityExceptionRequestOp(prisma, ownerA, {
    requestId: declinedOther.id,
    decision: "DECLINE",
    expectedUpdatedAt: declinedOther.updatedAt,
  });
  check("OWNER decline marks the request declined", declined.request.status === "DECLINED");
  check(
    "OWNER decline does not write recorded availability",
    (await prisma.membershipAvailabilityException.count({
      where: { membershipId: helperMem.id, date: "2026-09-21" },
    })) === 0,
  );

  const accepted = await decideMemberAvailabilityExceptionRequestOp(prisma, ownerA, {
    requestId: requested.id,
    decision: "ACCEPT",
    expectedUpdatedAt: requested.updatedAt,
  });
  const exception = await prisma.membershipAvailabilityException.findFirst({
    where: { membershipId: memberMem.id, date: "2026-09-17", businessId: businessA.id },
  });
  const jobAfterAccept = await prisma.job.findFirst({
    where: { id: job.id, businessId: businessA.id },
  });
  check("OWNER accept marks the request accepted", accepted.request.status === "ACCEPTED");
  check(
    "OWNER accept writes the recorded exception on the submitted civil date",
    exception?.kind === "UNAVAILABLE" && exception.date === "2026-09-17",
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
      }),
    (error) =>
      error instanceof WorkforceError && error.message === AVAILABILITY_REQUEST_STALE_MESSAGE,
  );

  const nyEveningSep17 = new Date("2026-09-18T00:00:00.000Z");
  const nyMidnightSep18 = new Date("2026-09-18T04:00:00.000Z");
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
    "Accepted NY exception makes 8pm Sep 17 America/New_York unavailable",
    formatISODateInTimeZone(nyEveningSep17, DEFAULT_BUSINESS_TIMEZONE) === "2026-09-17" &&
      memberWindowForDay(
        nyEveningSep17,
        DEFAULT_AVAILABILITY_SETTINGS,
        memberSnapshot,
        DEFAULT_BUSINESS_TIMEZONE,
      ).available === false,
  );

  const pacificRequested = await requestMemberAvailabilityExceptionOp(prisma, memberB, {
    membershipId: betaMemberMem.id,
    date: "2026-09-17",
    kind: "UNAVAILABLE",
    note: "Pacific day off",
  });
  const pacificAccepted = await decideMemberAvailabilityExceptionRequestOp(prisma, ownerB, {
    requestId: pacificRequested.id,
    decision: "ACCEPT",
    expectedUpdatedAt: pacificRequested.updatedAt,
  });
  const pacificException = await prisma.membershipAvailabilityException.findFirst({
    where: { membershipId: betaMemberMem.id, date: "2026-09-17", businessId: businessB.id },
  });
  const laEveningSep17 = new Date("2026-09-18T04:00:00.000Z");
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
    pacificAccepted.request.date === "2026-09-17" && pacificException?.date === "2026-09-17",
  );
  check(
    "Pacific 9pm Sep 17 stays on the requested date, not UTC Sep 18",
    formatISODateInTimeZone(laEveningSep17, "America/Los_Angeles") === "2026-09-17" &&
      formatISODateInTimeZone(laEveningSep17, DEFAULT_BUSINESS_TIMEZONE) === "2026-09-18" &&
      memberWindowForDay(
        laEveningSep17,
        DEFAULT_AVAILABILITY_SETTINGS,
        pacificMember,
        "America/Los_Angeles",
      ).available === false,
  );
  check(
    "Tenant A exception count is unchanged by tenant B accept",
    (await prisma.membershipAvailabilityException.count({
      where: { businessId: businessA.id, membershipId: memberMem.id },
    })) === 1,
  );

  const raceDate = "2026-10-05";
  const raceRequest = await requestMemberAvailabilityExceptionOp(prisma, memberA, {
    membershipId: memberMem.id,
    date: raceDate,
    kind: "UNAVAILABLE",
  });
  const jobBeforeRace = await prisma.job.findFirst({
    where: { id: job.id, businessId: businessA.id },
  });
  const [first, second] = await Promise.allSettled([
    decideMemberAvailabilityExceptionRequestOp(prisma, ownerA, {
      requestId: raceRequest.id,
      decision: "ACCEPT",
      expectedUpdatedAt: raceRequest.updatedAt,
    }),
    decideMemberAvailabilityExceptionRequestOp(prisma, ownerA, {
      requestId: raceRequest.id,
      decision: "DECLINE",
      expectedUpdatedAt: raceRequest.updatedAt,
    }),
  ]);
  const settled = [first, second];
  const won = settled.filter((row) => row.status === "fulfilled");
  const lost = settled.filter(
    (row) =>
      row.status === "rejected" &&
      row.reason instanceof WorkforceError &&
      row.reason.message === AVAILABILITY_REQUEST_STALE_MESSAGE,
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
  check("Exactly one concurrent decision commits", won.length === 1 && lost.length === 1);
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

  const inactiveDate = "2026-10-12";
  const inactiveRequest = await requestMemberAvailabilityExceptionOp(prisma, helperA, {
    membershipId: helperMem.id,
    date: inactiveDate,
    kind: "UNAVAILABLE",
  });
  await prisma.membership.update({
    where: { id: helperMem.id },
    data: { active: false },
  });
  const exceptionsBeforeInactive = await prisma.membershipAvailabilityException.count({
    where: { membershipId: helperMem.id, businessId: businessA.id },
  });
  await expectError(
    "Decide rechecks current membership state and refuses an inactive worker",
    () =>
      decideMemberAvailabilityExceptionRequestOp(prisma, ownerA, {
        requestId: inactiveRequest.id,
        decision: "ACCEPT",
        expectedUpdatedAt: inactiveRequest.updatedAt,
      }),
    (error) =>
      error instanceof WorkforceError && error.message === AVAILABILITY_REQUEST_INACTIVE_MESSAGE,
  );
  check(
    "Inactive-worker accept did not write recorded availability",
    (await prisma.membershipAvailabilityException.count({
      where: { membershipId: helperMem.id, businessId: businessA.id },
    })) === exceptionsBeforeInactive,
  );
  const stillPending = await prisma.membershipAvailabilityExceptionRequest.findFirst({
    where: { id: inactiveRequest.id, businessId: businessA.id },
  });
  check("Inactive-worker accept left the request pending", stillPending?.status === "PENDING");

  const nyWindowAfterMidnight = memberWindowForDay(
    nyMidnightSep18,
    DEFAULT_AVAILABILITY_SETTINGS,
    memberSnapshot,
    DEFAULT_BUSINESS_TIMEZONE,
  );
  check(
    "NY midnight Sep 18 is a different civil date than the accepted exception",
    formatISODateInTimeZone(nyMidnightSep18, DEFAULT_BUSINESS_TIMEZONE) === "2026-09-18" &&
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
