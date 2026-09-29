/**
 * Worker time-correction requests + OWNER decisions.
 *
 * Imports the REAL production helpers from src/lib/time-cards.ts and
 * src/lib/time-card-ops.ts (same functions the server actions call).
 * Proves worker scoping, OWNER authorization, tenant isolation,
 * duplicate decisions, approved-week refusal, original-record
 * preservation, payroll snapshot safety, stale-edit refusal, and
 * concurrent accept-versus-approve plus duplicate-create races on a
 * dedicated localhost test DB.
 *
 * Run with:
 *   TZ=UTC node --experimental-strip-types scripts/check-time-correction-requests.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  CAPABILITIES,
  ForbiddenError,
  requireBusinessCapability,
  roleHasCapability,
} = await import("@/lib/authorization");
const {
  canRequestTimeCorrection,
  hoursBetween,
  parseDateTimeInput,
  weekRange,
} = await import("@/lib/time-cards");
const {
  approveTimesheetWeek,
  clockInTime,
  correctTimeEntry,
  createManualTimeEntry,
  decideTimeCorrectionRequest,
  ENTRY_CHANGED_SINCE_REQUEST_ERROR,
  requestTimeCorrection,
  TimeCardError,
  workerTimesheetWeekLockKey,
} = await import("@/lib/time-card-ops");
const {
  authorizePayrollRun,
  createPayrollRun,
  reviewPayrollRun,
} = await import("@/lib/payroll-ops");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const parsed = new URL(baseUrl);
if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
  console.error(
    "Refusing to run: DATABASE_URL host must be localhost or 127.0.0.1 because this script runs prisma db push --accept-data-loss.",
  );
  process.exit(1);
}

const testDbName = "tbbt_time_correction_requests_test";
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");

async function dropTestDatabase() {
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${testDbName}' AND pid <> pg_backend_pid()`,
    );
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for time-correction-requests test database.");
  await dropTestDatabase();
  process.exit(push.status ?? 1);
}

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

async function expectError(label, fn, predicate) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

const NY = "America/New_York";

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: { role, membership: { id: membershipId }, business: { timezone: NY } },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 3_600_000);
}

function rawSqlText(args) {
  if (!args) return "";
  if (typeof args === "string") return args;
  if (Array.isArray(args.strings)) return args.strings.join(" ");
  if (typeof args.sql === "string") return args.sql;
  if (Array.isArray(args.sql?.strings)) return args.sql.strings.join(" ");
  if (Array.isArray(args)) {
    return args.map((part) => rawSqlText(part)).join(" ");
  }
  if (typeof args === "object") {
    if (Array.isArray(args.values) && args.strings == null) {
      return String(args.query ?? args.sql ?? JSON.stringify(args));
    }
    try {
      return JSON.stringify(args);
    } catch {
      return String(args);
    }
  }
  return String(args);
}

function requestCorrection(db, access, input) {
  return requestTimeCorrection(db, access, { ...input, timeZone: NY });
}

function decideCorrection(db, access, input) {
  return decideTimeCorrectionRequest(db, access, { ...input, timeZone: NY });
}

function approveWeek(db, access, input) {
  return approveTimesheetWeek(db, access, { ...input, timeZone: NY });
}

function holdAfterAdvisoryLock(client, { hold, onLocked }) {
  const intercept = async ({ args, query }) => {
    const result = await query(args);
    if (/pg_advisory_xact_lock/i.test(rawSqlText(args))) {
      onLocked();
      await hold;
    }
    return result;
  };
  return client.$extends({
    query: {
      $executeRaw: intercept,
      $executeRawUnsafe: intercept,
      $allOperations: intercept,
    },
  });
}

async function waitUntilAdvisoryLockWaiter(client, { timeoutMs = 4000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await client.$queryRaw`
      SELECT pid
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND wait_event = 'advisory'
    `;
    if (rows.length > 0) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("second transaction never waited on the advisory lock");
}

function capture(promise) {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", reason: error }),
  );
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

try {
  console.log("\nSTATIC — Time correction request domain and UI");
  check(
    "Approved week cannot be requested",
    canRequestTimeCorrection({
      entryStatus: "APPROVED",
      endedAt: new Date(),
      weekStatus: "APPROVED",
    }).ok === false,
  );
  check(
    "Running clock cannot be requested",
    canRequestTimeCorrection({ entryStatus: "RUNNING", endedAt: null }).ok === false,
  );
  check(
    "Ready recorded time can be requested",
    canRequestTimeCorrection({ entryStatus: "READY", endedAt: new Date() }).ok === true,
  );
  check(
    "OWNER has DECIDE_TIME_CORRECTIONS",
    roleHasCapability("OWNER", CAPABILITIES.DECIDE_TIME_CORRECTIONS),
  );
  check(
    "ADMIN and MEMBER do not have DECIDE_TIME_CORRECTIONS",
    !roleHasCapability("ADMIN", CAPABILITIES.DECIDE_TIME_CORRECTIONS) &&
      !roleHasCapability("MEMBER", CAPABILITIES.DECIDE_TIME_CORRECTIONS),
  );

  const opsSrc = readFileSync(new URL("../src/lib/time-card-ops.ts", import.meta.url), "utf8");
  const actionSrc = readFileSync(new URL("../src/app/actions/time-cards.ts", import.meta.url), "utf8");
  const requestActionSrc = actionSrc.slice(
    actionSrc.indexOf("export async function requestTimeCorrectionAction"),
    actionSrc.indexOf("export async function decideTimeCorrectionRequestAction"),
  );
  const decideActionSrc = actionSrc.slice(
    actionSrc.indexOf("export async function decideTimeCorrectionRequestAction"),
    actionSrc.indexOf("export async function updateMembershipWageAction"),
  );
  const approveActionSrc = actionSrc.slice(
    actionSrc.indexOf("export async function approveTimesheetWeekAction"),
    actionSrc.indexOf("export async function reopenTimesheetWeekAction"),
  );
  const clockInActionSrc = actionSrc.slice(
    actionSrc.indexOf("export async function clockInAction"),
    actionSrc.indexOf("export async function clockOutAction"),
  );
  const clockOutActionSrc = actionSrc.slice(
    actionSrc.indexOf("export async function clockOutAction"),
    actionSrc.indexOf("export async function createManualTimeEntryAction"),
  );
  const manualActionSrc = actionSrc.slice(
    actionSrc.indexOf("export async function createManualTimeEntryAction"),
    actionSrc.indexOf("export async function correctTimeEntryAction"),
  );
  const correctActionSrc = actionSrc.slice(
    actionSrc.indexOf("export async function correctTimeEntryAction"),
    actionSrc.indexOf("export async function requestTimeCorrectionAction"),
  );
  const fieldSrc = readFileSync(
    new URL("../src/components/field/field-time-correction-requests.tsx", import.meta.url),
    "utf8",
  );
  const queueSrc = readFileSync(
    new URL("../src/components/time-cards/time-correction-request-queue.tsx", import.meta.url),
    "utf8",
  );
  const timeCardsPageSrc = readFileSync(
    new URL("../src/app/(app)/time-cards/page.tsx", import.meta.url),
    "utf8",
  );
  const fieldPageSrc = readFileSync(
    new URL("../src/app/field/page.tsx", import.meta.url),
    "utf8",
  );
  const migrationSrc = readFileSync(
    new URL("../prisma/migrations/20260929010100_time_correction_requests/migration.sql", import.meta.url),
    "utf8",
  );
  check(
    "Request write does not mutate TimeEntry times",
    opsSrc.includes("export async function requestTimeCorrection") &&
      !/export async function requestTimeCorrection[\s\S]*timeEntry\.update\([\s\S]*status: "NEEDS_REVIEW"/.test(
        opsSrc.slice(opsSrc.indexOf("export async function requestTimeCorrection")),
      ),
  );
  check(
    "Accept and decline lock the tenant-owned request row",
    opsSrc.includes("lockTenantOwnedTimeCorrectionRequest") &&
      opsSrc.includes("FOR UPDATE") &&
      opsSrc.includes("DECIDE_TIME_CORRECTIONS"),
  );
  check(
    "Worker form collects proposed times and a reason",
    fieldSrc.includes('name="proposedStartDate"') &&
      fieldSrc.includes('name="proposedEndDate"') &&
      fieldSrc.includes('name="reason"') &&
      actionSrc.includes("proposedStartedAt") &&
      actionSrc.includes("proposedEndedAt"),
  );
  check(
    "OWNER accept/decline forms exist and ADMIN is told they cannot decide",
    queueSrc.includes('name="decision"') &&
      queueSrc.includes('value="ACCEPTED"') &&
      queueSrc.includes('value="DECLINED"') &&
      queueSrc.includes("Admins cannot decide these requests"),
  );
  check(
    "Accept is disabled when the request week is already approved",
    queueSrc.includes("acceptDisabled={request.weekApproved}") &&
      queueSrc.includes("That week is approved. Reopen it before accepting a time correction."),
  );
  check(
    "Approvals queue loads all PENDING requests with a take limit",
    timeCardsPageSrc.includes('status: "PENDING"') &&
      timeCardsPageSrc.includes("pendingCorrectionRequests") &&
      timeCardsPageSrc.includes("decidedCorrectionRequests") &&
      /status: "PENDING"[\s\S]*take: 80/.test(timeCardsPageSrc),
  );
  check(
    "Field ownWeeks is date-bounded and take-limited",
    fieldPageSrc.includes("weekStartedAt: { gte: recentStart }") &&
      /ownWeeks[\s\S]*take: 12/.test(fieldPageSrc),
  );
  check(
    "Accept and approve share the per-worker-week advisory lock",
    opsSrc.includes("lockWorkerTimesheetWeek") &&
      opsSrc.includes("pg_advisory_xact_lock") &&
      opsSrc.includes("ENTRY_CHANGED_SINCE_REQUEST_ERROR") &&
      opsSrc.includes("entryTimesMatchRequest") &&
      /async function lockWorkerTimesheetWeeks[\s\S]*weekRange\(value, timeZone\)/.test(opsSrc) &&
      /async function loadOpenWeek[\s\S]*timeZone: string[\s\S]*weekRange\(at, timeZone\)/.test(opsSrc) &&
      /async function assertWeekEditable[\s\S]*timeZone: string/.test(opsSrc) &&
      /export async function decideTimeCorrectionRequest[\s\S]*lockWorkerTimesheetWeeks[\s\S]*originalEndedAt[\s\S]*proposedEndedAt/.test(
        opsSrc,
      ) &&
      /export async function approveTimesheetWeek[\s\S]*accessTimeZone\(access, input\.timeZone\)[\s\S]*weekRange\(input\.weekStartedAt, timeZone\)/.test(
        opsSrc,
      ),
  );
  check(
    "Request and decide actions pass the business time zone",
    requestActionSrc.includes("resolveBusinessTimeZone") &&
      requestActionSrc.includes("timeZone") &&
      decideActionSrc.includes("resolveBusinessTimeZone") &&
      decideActionSrc.includes("timeZone") &&
      approveActionSrc.includes("resolveBusinessTimeZone") &&
      approveActionSrc.includes("timeZone"),
  );
  check(
    "Clock, manual, and correct actions pass the business time zone",
    clockInActionSrc.includes("resolveBusinessTimeZone") &&
      clockInActionSrc.includes("timeZone") &&
      clockOutActionSrc.includes("resolveBusinessTimeZone") &&
      clockOutActionSrc.includes("timeZone") &&
      manualActionSrc.includes("resolveBusinessTimeZone") &&
      manualActionSrc.includes("timeZone") &&
      correctActionSrc.includes("resolveBusinessTimeZone") &&
      correctActionSrc.includes("timeZone"),
  );
  check(
    "Manual/correction/request parse civil input after resolving Business timezone",
    requestActionSrc.includes("parseBusinessDateTimeInput") &&
      requestActionSrc.indexOf("resolveBusinessTimeZone") <
        requestActionSrc.indexOf("parseBusinessDateTimeInput") &&
      manualActionSrc.indexOf("resolveBusinessTimeZone") <
        manualActionSrc.indexOf("parseBusinessDateTimeInput") &&
      correctActionSrc.indexOf("resolveBusinessTimeZone") <
        correctActionSrc.indexOf("parseBusinessDateTimeInput"),
  );
  check(
    "Migration is additive, uniquely pending, and uses 20260929010100",
    migrationSrc.includes('CREATE TABLE IF NOT EXISTS "TimeCorrectionRequest"') &&
      migrationSrc.includes('CREATE TABLE IF NOT EXISTS "TimeCorrectionDecision"') &&
      migrationSrc.includes("TimeCorrectionRequest_timeEntryId_pending_key") &&
      migrationSrc.includes("20260929010100") &&
      !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE|UPDATE "/i.test(migrationSrc),
  );

  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "TimeCorrectionRequest_timeEntryId_pending_key"
    ON "TimeCorrectionRequest" ("timeEntryId")
    WHERE status = 'PENDING'
  `);

  const businessA = await prisma.business.create({
    data: { name: "Alpha Corrections", slug: "alpha-time-corrections", tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Corrections", slug: "beta-time-corrections", tradeCode: "HANDYMAN" },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: "owner-time-corr@example.com", passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Amir Admin", email: "admin-time-corr@example.com", passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: "member-time-corr@example.com", passwordHash: "x" },
  });
  const helperUser = await prisma.user.create({
    data: { name: "Hank Helper", email: "helper-time-corr@example.com", passwordHash: "x" },
  });
  const betaOwnerUser = await prisma.user.create({
    data: { name: "Bea Owner", email: "beta-owner-time-corr@example.com", passwordHash: "x" },
  });
  const betaMemberUser = await prisma.user.create({
    data: { name: "Ben Member", email: "beta-member-time-corr@example.com", passwordHash: "x" },
  });

  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER", hourlyWage: new Prisma.Decimal(25) },
  });
  const adminMem = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: businessA.id, role: "ADMIN", hourlyWage: new Prisma.Decimal(22) },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER", hourlyWage: new Prisma.Decimal(20) },
  });
  const helperMem = await prisma.membership.create({
    data: { userId: helperUser.id, businessId: businessA.id, role: "MEMBER", hourlyWage: new Prisma.Decimal(18) },
  });
  const betaOwnerMem = await prisma.membership.create({
    data: { userId: betaOwnerUser.id, businessId: businessB.id, role: "OWNER", hourlyWage: new Prisma.Decimal(40) },
  });
  const betaMemberMem = await prisma.membership.create({
    data: { userId: betaMemberUser.id, businessId: businessB.id, role: "MEMBER", hourlyWage: new Prisma.Decimal(30) },
  });

  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const helperA = makeAccess(businessA.id, "MEMBER", helperMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaOwnerMem.id);
  const memberB = makeAccess(businessB.id, "MEMBER", betaMemberMem.id);

  const jobA = await prisma.job.create({
    data: {
      businessId: businessA.id,
      status: "SCHEDULED",
      projectToken: randomUUID(),
      assignedMembershipId: memberMem.id,
    },
  });
  const jobHelper = await prisma.job.create({
    data: {
      businessId: businessA.id,
      status: "SCHEDULED",
      projectToken: randomUUID(),
      assignedMembershipId: helperMem.id,
    },
  });
  const jobB = await prisma.job.create({
    data: {
      businessId: businessB.id,
      status: "SCHEDULED",
      projectToken: randomUUID(),
      assignedMembershipId: betaMemberMem.id,
    },
  });

  const memberEntry = await createManualTimeEntry(prisma, ownerA, {
    membershipId: memberMem.id,
    activityType: "JOB",
    jobId: jobA.id,
    startedAt: hoursAgo(8),
    endedAt: hoursAgo(6),
    note: "Mia recorded 2h",
  });
  const helperEntry = await createManualTimeEntry(prisma, ownerA, {
    membershipId: helperMem.id,
    activityType: "TRAVEL",
    startedAt: hoursAgo(5),
    endedAt: hoursAgo(4),
    note: "Hank travel",
  });
  const betaEntry = await createManualTimeEntry(prisma, ownerB, {
    membershipId: betaMemberMem.id,
    activityType: "JOB",
    jobId: jobB.id,
    startedAt: hoursAgo(8),
    endedAt: hoursAgo(7),
    note: "Ben recorded 1h",
  });

  console.log("\nTEST — Worker scoping: own recorded time only");
  const proposedStart = hoursAgo(8.5);
  const proposedEnd = hoursAgo(6.5);
  const requested = await requestCorrection(prisma, memberA, {
    timeEntryId: memberEntry.id,
    reason: "Forgot I started earlier",
    proposedStartedAt: proposedStart,
    proposedEndedAt: proposedEnd,
  });
  const afterRequest = await prisma.timeEntry.findUnique({ where: { id: memberEntry.id } });
  check(
    "Worker request stores proposed times and freezes the original clock",
    requested.request.status === "PENDING" &&
      requested.request.reason === "Forgot I started earlier" &&
      requested.request.originalStartedAt.getTime() === memberEntry.startedAt.getTime() &&
      requested.request.originalEndedAt.getTime() === memberEntry.endedAt.getTime() &&
      requested.request.proposedStartedAt.getTime() === proposedStart.getTime() &&
      requested.request.proposedEndedAt.getTime() === proposedEnd.getTime(),
  );
  check(
    "Original TimeEntry is unchanged after the request",
    afterRequest.startedAt.getTime() === memberEntry.startedAt.getTime() &&
      afterRequest.endedAt.getTime() === memberEntry.endedAt.getTime() &&
      afterRequest.note === "Mia recorded 2h" &&
      afterRequest.status === "READY",
  );

  const civilOriginalStart = parseDateTimeInput("2026-09-20", "01:00", NY);
  const civilOriginalEnd = parseDateTimeInput("2026-09-20", "05:00", NY);
  const civilProposedStart = parseDateTimeInput("2026-09-20", "02:00", NY);
  const civilProposedEnd = parseDateTimeInput("2026-09-20", "06:00", NY);
  const civilEntry = await createManualTimeEntry(prisma, ownerA, {
    membershipId: memberMem.id,
    activityType: "JOB",
    jobId: jobA.id,
    startedAt: civilOriginalStart,
    endedAt: civilOriginalEnd,
    note: "Early Sunday NY civil entry",
    timeZone: NY,
  });
  const civilRequested = await requestCorrection(prisma, memberA, {
    timeEntryId: civilEntry.id,
    reason: "Correct 01:00–05:00 to 02:00–06:00 NY",
    proposedStartedAt: civilProposedStart,
    proposedEndedAt: civilProposedEnd,
  });
  const civilStored = await prisma.timeEntry.findUnique({ where: { id: civilEntry.id } });
  check(
    "P1-07 correction request persists America/New_York civil times as UTC instants",
    civilStored.startedAt.toISOString() === "2026-09-20T05:00:00.000Z" &&
      civilStored.endedAt.toISOString() === "2026-09-20T09:00:00.000Z" &&
      civilRequested.request.originalStartedAt.toISOString() === "2026-09-20T05:00:00.000Z" &&
      civilRequested.request.proposedStartedAt.toISOString() === "2026-09-20T06:00:00.000Z" &&
      civilRequested.request.proposedEndedAt.toISOString() === "2026-09-20T10:00:00.000Z" &&
      weekRange(civilStored.startedAt, NY).start.toISOString() === "2026-09-20T04:00:00.000Z",
  );
  await expectError(
    "Worker cannot request a correction on another worker's entry",
    () => requestCorrection(prisma, memberA, {
      timeEntryId: helperEntry.id,
      reason: "not mine",
      proposedStartedAt: hoursAgo(5.5),
      proposedEndedAt: hoursAgo(4.5),
    }),
    (error) => error instanceof ForbiddenError,
  );

  console.log("\nTEST — Duplicate pending request is refused");
  await expectError(
    "Second pending request on the same entry is refused",
    () => requestCorrection(prisma, memberA, {
      timeEntryId: memberEntry.id,
      reason: "duplicate",
      proposedStartedAt: hoursAgo(9),
      proposedEndedAt: hoursAgo(7),
    }),
    (error) => error instanceof TimeCardError && /already waiting/i.test(error.message),
  );

  console.log("\nTEST — OWNER authorization: ADMIN and MEMBER cannot decide");
  try {
    requireBusinessCapability(adminA, CAPABILITIES.DECIDE_TIME_CORRECTIONS);
    check("ADMIN requireBusinessCapability(DECIDE_TIME_CORRECTIONS) throws", false);
  } catch (error) {
    check("ADMIN requireBusinessCapability(DECIDE_TIME_CORRECTIONS) throws", error instanceof ForbiddenError);
  }
  await expectError(
    "ADMIN cannot accept a worker correction",
    () => decideCorrection(prisma, adminA, {
      requestId: requested.request.id,
      decision: "ACCEPTED",
    }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot decide their own request",
    () => decideCorrection(prisma, memberA, {
      requestId: requested.request.id,
      decision: "DECLINED",
    }),
    (error) => error instanceof ForbiddenError,
  );
  const stillPending = await prisma.timeCorrectionRequest.findUnique({
    where: { id: requested.request.id },
  });
  const stillOriginal = await prisma.timeEntry.findUnique({ where: { id: memberEntry.id } });
  check(
    "Unauthorized decide leaves the request pending and the entry unchanged",
    stillPending.status === "PENDING" &&
      stillOriginal.startedAt.getTime() === memberEntry.startedAt.getTime(),
  );

  console.log("\nTEST — Tenant isolation");
  const visibleToA = await prisma.timeCorrectionRequest.findMany({
    where: { businessId: businessA.id },
  });
  const visibleToB = await prisma.timeCorrectionRequest.findFirst({
    where: { id: requested.request.id, businessId: businessB.id },
  });
  check("Tenant A query does not include tenant B entries by businessId", visibleToA.every((row) => row.businessId === businessA.id));
  check("Tenant B cannot load tenant A's request by id + businessId", visibleToB == null);
  await expectError(
    "Tenant B worker cannot request on tenant A's entry",
    () => requestCorrection(prisma, memberB, {
      timeEntryId: memberEntry.id,
      reason: "cross tenant",
      proposedStartedAt: hoursAgo(9),
      proposedEndedAt: hoursAgo(7),
    }),
    (error) => error instanceof TimeCardError || error instanceof ForbiddenError,
  );
  await expectError(
    "Tenant B owner cannot decide tenant A's request",
    () => decideCorrection(prisma, ownerB, {
      requestId: requested.request.id,
      decision: "ACCEPTED",
    }),
    (error) => error instanceof TimeCardError || error instanceof ForbiddenError,
  );

  console.log("\nTEST — OWNER accept applies proposed times and keeps history");
  const accepted = await decideCorrection(prisma, ownerA, {
    requestId: requested.request.id,
    decision: "ACCEPTED",
    reason: "Drive started earlier, approved",
  });
  const acceptedEntry = await prisma.timeEntry.findUnique({ where: { id: memberEntry.id } });
  const acceptedRequest = await prisma.timeCorrectionRequest.findUnique({
    where: { id: requested.request.id },
    include: { decisions: true },
  });
  const acceptAudit = await prisma.timeEntryAdjustment.findMany({
    where: { timeEntryId: memberEntry.id },
    orderBy: { createdAt: "asc" },
  });
  check("OWNER accept marks the request ACCEPTED", accepted.request.status === "ACCEPTED");
  check(
    "Accept writes one decision row",
    acceptedRequest.decisions.length === 1 &&
      acceptedRequest.decisions[0].decision === "ACCEPTED" &&
      acceptedRequest.decisions[0].actorMembershipId === ownerMem.id,
  );
  check(
    "Accept applies proposed times and keeps the original snapshot on the request",
    acceptedEntry.startedAt.getTime() === proposedStart.getTime() &&
      acceptedEntry.endedAt.getTime() === proposedEnd.getTime() &&
      acceptedRequest.originalStartedAt.getTime() === memberEntry.startedAt.getTime() &&
      acceptedRequest.originalEndedAt.getTime() === memberEntry.endedAt.getTime(),
  );
  check(
    "Request and decision history are append-only",
    acceptAudit.some((row) => row.action === "CORRECTION_REQUEST" && row.reason === "Forgot I started earlier") &&
      acceptAudit.some((row) => row.action === "CORRECT" && row.previousJson && row.nextJson),
  );

  console.log("\nTEST — Duplicate decisions are refused");
  await expectError(
    "Second accept is refused",
    () => decideCorrection(prisma, ownerA, {
      requestId: requested.request.id,
      decision: "ACCEPTED",
    }),
    (error) => error instanceof TimeCardError && /already has an owner decision/i.test(error.message),
  );
  await expectError(
    "Decline after accept is refused",
    () => decideCorrection(prisma, ownerA, {
      requestId: requested.request.id,
      decision: "DECLINED",
    }),
    (error) => error instanceof TimeCardError && /already has an owner decision/i.test(error.message),
  );
  const decisionsAfterDup = await prisma.timeCorrectionDecision.count({
    where: { requestId: requested.request.id },
  });
  check("Duplicate decide does not add a second decision row", decisionsAfterDup === 1);

  console.log("\nTEST — OWNER decline leaves the original record");
  const declineSource = await createManualTimeEntry(prisma, ownerA, {
    membershipId: helperMem.id,
    activityType: "OTHER",
    startedAt: hoursAgo(3.5),
    endedAt: hoursAgo(3),
    note: "Keep this clock",
  });
  const declineRequest = await requestCorrection(prisma, helperA, {
    timeEntryId: declineSource.id,
    reason: "I think this was longer",
    proposedStartedAt: hoursAgo(3.75),
    proposedEndedAt: hoursAgo(2.75),
  });
  const declined = await decideCorrection(prisma, ownerA, {
    requestId: declineRequest.request.id,
    decision: "DECLINED",
    reason: "Travel already looks right",
  });
  const declinedEntry = await prisma.timeEntry.findUnique({ where: { id: declineSource.id } });
  const declineHistory = await prisma.timeCorrectionDecision.findMany({
    where: { requestId: declineRequest.request.id },
  });
  check("Decline marks the request DECLINED", declined.request.status === "DECLINED");
  check(
    "Declined entry times and note stay original",
    declinedEntry.startedAt.getTime() === declineSource.startedAt.getTime() &&
      declinedEntry.endedAt.getTime() === declineSource.endedAt.getTime() &&
      declinedEntry.note === "Keep this clock",
  );
  check(
    "Decline writes decision history",
    declineHistory.length === 1 && declineHistory[0].decision === "DECLINED",
  );

  console.log("\nTEST — Accept refuses a newer direct edit");
  const staleEntry = await createManualTimeEntry(prisma, ownerA, {
    membershipId: memberMem.id,
    activityType: "OTHER",
    startedAt: hoursAgo(16),
    endedAt: hoursAgo(15),
    note: "About to be edited",
  });
  const staleRequest = await requestCorrection(prisma, memberA, {
    timeEntryId: staleEntry.id,
    reason: "Need a later stop",
    proposedStartedAt: hoursAgo(16),
    proposedEndedAt: hoursAgo(14.5),
  });
  const laterEdit = await correctTimeEntry(prisma, ownerA, {
    timeEntryId: staleEntry.id,
    startedAt: hoursAgo(16.25),
    endedAt: hoursAgo(15.25),
    reason: "Owner corrected the clock first",
  });
  await expectError(
    "Accept refuses after correctTimeEntry changed the original times",
    () => decideCorrection(prisma, ownerA, {
      requestId: staleRequest.request.id,
      decision: "ACCEPTED",
    }),
    (error) =>
      error instanceof TimeCardError && error.message === ENTRY_CHANGED_SINCE_REQUEST_ERROR,
  );
  const afterStaleAccept = await prisma.timeEntry.findUnique({ where: { id: staleEntry.id } });
  const staleRequestAfter = await prisma.timeCorrectionRequest.findUnique({
    where: { id: staleRequest.request.id },
    include: { decisions: true },
  });
  check(
    "Newer edit is kept and accept does not write a decision",
    afterStaleAccept.startedAt.getTime() === laterEdit.startedAt.getTime() &&
      afterStaleAccept.endedAt.getTime() === laterEdit.endedAt.getTime() &&
      staleRequestAfter.status === "PENDING" &&
      staleRequestAfter.decisions.length === 0,
  );

  console.log("\nTEST — Concurrent duplicate pending create");
  const duplicateEntry = await createManualTimeEntry(prisma, ownerA, {
    membershipId: memberMem.id,
    activityType: "OTHER",
    startedAt: hoursAgo(18),
    endedAt: hoursAgo(17),
    note: "One pending only",
  });
  const [dupLeft, dupRight] = await Promise.allSettled([
    requestCorrection(prisma, memberA, {
      timeEntryId: duplicateEntry.id,
      reason: "First concurrent request",
      proposedStartedAt: hoursAgo(18.25),
      proposedEndedAt: hoursAgo(16.75),
    }),
    requestCorrection(prisma, memberA, {
      timeEntryId: duplicateEntry.id,
      reason: "Second concurrent request",
      proposedStartedAt: hoursAgo(18.5),
      proposedEndedAt: hoursAgo(16.5),
    }),
  ]);
  const dupOk = [dupLeft, dupRight].filter((result) => result.status === "fulfilled");
  const dupRefused = [dupLeft, dupRight].filter(
    (result) =>
      result.status === "rejected" &&
      result.reason instanceof TimeCardError &&
      /already waiting/i.test(result.reason.message),
  );
  const pendingDupCount = await prisma.timeCorrectionRequest.count({
    where: { timeEntryId: duplicateEntry.id, status: "PENDING" },
  });
  check(
    "Exactly one concurrent pending request is created",
    dupOk.length === 1 && dupRefused.length === 1 && pendingDupCount === 1,
  );

  console.log("\nTEST — Accept and approve share the America/New_York week lock");
  const nyUser = await prisma.user.create({
    data: { name: "Nina York", email: "nina-york-time-corr@example.com", passwordHash: "x" },
  });
  const nyMem = await prisma.membership.create({
    data: {
      userId: nyUser.id,
      businessId: businessA.id,
      role: "MEMBER",
      hourlyWage: new Prisma.Decimal(23),
    },
  });
  const nyAccess = makeAccess(businessA.id, "MEMBER", nyMem.id);
  const nyWeek2Start = weekRange(new Date(), NY).start;
  const nyWeek1Start = weekRange(new Date(nyWeek2Start.getTime() - 24 * 60 * 60 * 1000), NY).start;
  const nyW1StartedAt = new Date(nyWeek1Start.getTime() + 2 * 24 * 60 * 60 * 1000 + 10 * 3_600_000);
  const nyW1EndedAt = new Date(nyW1StartedAt.getTime() + 2 * 3_600_000);
  const nyW2ProposedStart = new Date(nyWeek2Start.getTime() + 2 * 24 * 60 * 60 * 1000 + 10 * 3_600_000);
  const nyW2ProposedEnd = new Date(nyW2ProposedStart.getTime() + 2 * 3_600_000);
  const nyW2OtherStart = new Date(nyWeek2Start.getTime() + 3 * 24 * 60 * 60 * 1000 + 9 * 3_600_000);
  const nyW2OtherEnd = new Date(nyW2OtherStart.getTime() + 3_600_000);
  const nyEntry = await createManualTimeEntry(prisma, ownerA, {
    membershipId: nyMem.id,
    activityType: "OTHER",
    startedAt: nyW1StartedAt,
    endedAt: nyW1EndedAt,
    note: "NY week W1 original",
  });
  const nyWeek2Entry = await createManualTimeEntry(prisma, ownerA, {
    membershipId: nyMem.id,
    activityType: "OTHER",
    startedAt: nyW2OtherStart,
    endedAt: nyW2OtherEnd,
    note: "NY week W2 other entry",
  });
  const nyRequest = await requestCorrection(prisma, nyAccess, {
    timeEntryId: nyEntry.id,
    reason: "Move into next New York week",
    proposedStartedAt: nyW2ProposedStart,
    proposedEndedAt: nyW2ProposedEnd,
  });
  const approveWeekStart = weekRange(nyWeek2Entry.startedAt, NY).start;
  const acceptOriginalStart = weekRange(nyEntry.startedAt, NY).start;
  const acceptProposedStart = weekRange(nyW2ProposedStart, NY).start;
  const acceptProposedEnd = weekRange(nyW2ProposedEnd, NY).start;
  const approveLockKey = workerTimesheetWeekLockKey(businessA.id, nyMem.id, approveWeekStart);
  const acceptLockKey = workerTimesheetWeekLockKey(businessA.id, nyMem.id, acceptProposedStart);
  check(
    "Accept proposed week and approve share the same New York lock key",
    approveLockKey === acceptLockKey &&
      acceptLockKey === workerTimesheetWeekLockKey(businessA.id, nyMem.id, acceptProposedEnd) &&
      acceptLockKey !== workerTimesheetWeekLockKey(businessA.id, nyMem.id, acceptOriginalStart) &&
      approveWeekStart.getTime() === nyWeek2Start.getTime() &&
      acceptOriginalStart.getTime() === nyWeek1Start.getTime() &&
      approveWeekStart.getTime() !== weekRange(nyWeek2Entry.startedAt).start.getTime(),
  );
  await approveWeek(prisma, ownerA, {
    membershipId: nyMem.id,
    weekStartedAt: nyWeek2Entry.startedAt,
  });
  await expectError(
    "Accept into a New York approved week is refused",
    () => decideCorrection(prisma, ownerA, {
      requestId: nyRequest.request.id,
      decision: "ACCEPTED",
    }),
    (error) => error instanceof TimeCardError && /approved/i.test(error.message),
  );
  const nyEntryAfter = await prisma.timeEntry.findUnique({ where: { id: nyEntry.id } });
  const nyWeek2After = await prisma.timesheetWeek.findUnique({
    where: {
      businessId_membershipId_weekStartedAt: {
        businessId: businessA.id,
        membershipId: nyMem.id,
        weekStartedAt: approveWeekStart,
      },
    },
  });
  check(
    "Refused New York accept leaves the W1 entry unchanged and not APPROVED",
    nyEntryAfter.status === "READY" &&
      nyEntryAfter.status !== "APPROVED" &&
      nyEntryAfter.startedAt.getTime() === nyEntry.startedAt.getTime() &&
      nyEntryAfter.endedAt.getTime() === nyEntry.endedAt.getTime() &&
      nyWeek2After.status === "APPROVED",
  );

  console.log("\nTEST — Clock-in and correctTimeEntry refuse an approved New York week");
  await expectError(
    "clockInTime into an approved New York week is refused",
    () =>
      clockInTime(prisma, ownerA, {
        membershipId: nyMem.id,
        activityType: "OTHER",
        startedAt: new Date(nyWeek2Start.getTime() + 4 * 24 * 60 * 60 * 1000 + 14 * 3_600_000),
        timeZone: NY,
      }),
    (error) => error instanceof TimeCardError && /approved/i.test(error.message),
  );
  await expectError(
    "correctTimeEntry into an approved New York week is refused",
    () =>
      correctTimeEntry(prisma, ownerA, {
        timeEntryId: nyEntry.id,
        startedAt: nyW2ProposedStart,
        endedAt: nyW2ProposedEnd,
        reason: "Move into the approved New York week",
        timeZone: NY,
      }),
    (error) => error instanceof TimeCardError && /approved/i.test(error.message),
  );
  const nyClockAfter = await prisma.timeEntry.findUnique({ where: { id: nyEntry.id } });
  check(
    "Refused New York clock and correction leave the W1 entry READY",
    nyClockAfter.status === "READY" &&
      nyClockAfter.startedAt.getTime() === nyEntry.startedAt.getTime() &&
      nyClockAfter.endedAt.getTime() === nyEntry.endedAt.getTime(),
  );

  console.log("\nTEST — Concurrent accept versus week approval");
  const racerOneUser = await prisma.user.create({
    data: { name: "Riley Racer", email: "racer-one-time-corr@example.com", passwordHash: "x" },
  });
  const racerTwoUser = await prisma.user.create({
    data: { name: "Rene Racer", email: "racer-two-time-corr@example.com", passwordHash: "x" },
  });
  const racerOneMem = await prisma.membership.create({
    data: {
      userId: racerOneUser.id,
      businessId: businessA.id,
      role: "MEMBER",
      hourlyWage: new Prisma.Decimal(19),
    },
  });
  const racerTwoMem = await prisma.membership.create({
    data: {
      userId: racerTwoUser.id,
      businessId: businessA.id,
      role: "MEMBER",
      hourlyWage: new Prisma.Decimal(21),
    },
  });
  const racerOneA = makeAccess(businessA.id, "MEMBER", racerOneMem.id);
  const racerTwoA = makeAccess(businessA.id, "MEMBER", racerTwoMem.id);

  async function raceAcceptAgainstApprove({ holdAccept, membershipId, workerAccess }) {
    const originalStartedAt = hoursAgo(holdAccept ? 20 : 22);
    const originalEndedAt = hoursAgo(holdAccept ? 19 : 21);
    const proposedStartedAt = hoursAgo(holdAccept ? 20.5 : 22.5);
    const proposedEndedAt = hoursAgo(holdAccept ? 18.5 : 20.5);
    const localWeekStart = weekRange(originalStartedAt, NY).start;
    const entry = await createManualTimeEntry(prisma, ownerA, {
      membershipId,
      activityType: "OTHER",
      startedAt: originalStartedAt,
      endedAt: originalEndedAt,
      note: holdAccept ? "Approve first" : "Accept first",
    });
    const requestedRace = await requestCorrection(prisma, workerAccess, {
      timeEntryId: entry.id,
      reason: "Race the week approval",
      proposedStartedAt,
      proposedEndedAt,
    });
    const delayedClient = new PrismaClient({ datasourceUrl: testUrl });
    let releaseHold = () => {};
    let delayedSettled;
    let firstSettled;
    try {
      const hold = new Promise((resolve) => {
        releaseHold = resolve;
      });
      let notifyLocked;
      const locked = new Promise((resolve) => {
        notifyLocked = resolve;
      });
      const delayedDb = holdAfterAdvisoryLock(delayedClient, {
        hold,
        onLocked: notifyLocked,
      });
      const delayedPromise = holdAccept
        ? decideCorrection(delayedDb, ownerA, {
            requestId: requestedRace.request.id,
            decision: "ACCEPTED",
          })
        : approveWeek(delayedDb, ownerA, {
            membershipId,
            weekStartedAt: originalStartedAt,
          });
      delayedSettled = capture(delayedPromise);
      try {
        await withTimeout(locked, 4000, "first transaction never took the advisory lock");
      } catch (error) {
        releaseHold();
        await delayedSettled;
        throw error;
      }
      const firstPromise = holdAccept
        ? approveWeek(prisma, ownerA, {
            membershipId,
            weekStartedAt: originalStartedAt,
          })
        : decideCorrection(prisma, ownerA, {
            requestId: requestedRace.request.id,
            decision: "ACCEPTED",
          });
      firstSettled = capture(firstPromise);
      let waiterRows;
      try {
        waiterRows = await withTimeout(
          waitUntilAdvisoryLockWaiter(prisma),
          4000,
          "second transaction never waited on the advisory lock",
        );
      } catch (error) {
        releaseHold();
        await Promise.all([delayedSettled, firstSettled]);
        throw error;
      }
      releaseHold();
      const delayedResult = await withTimeout(
        delayedSettled,
        8000,
        "holder transaction did not finish",
      );
      const firstResult = await withTimeout(
        firstSettled,
        8000,
        "waiter transaction did not finish",
      );
      const holderError = delayedResult.status === "rejected" ? delayedResult.reason : null;
      const holder = delayedResult.status === "fulfilled" ? delayedResult.value : null;
      const waiterError = firstResult.status === "rejected" ? firstResult.reason : null;
      const waiter = firstResult.status === "fulfilled" ? firstResult.value : null;
      const nextEntry = await prisma.timeEntry.findUnique({ where: { id: entry.id } });
      const nextWeek = await prisma.timesheetWeek.findUnique({
        where: {
          businessId_membershipId_weekStartedAt: {
            businessId: businessA.id,
            membershipId,
            weekStartedAt: localWeekStart,
          },
        },
      });
      const nextRequest = await prisma.timeCorrectionRequest.findUnique({
        where: { id: requestedRace.request.id },
      });
      const expectedHours = hoursBetween(nextEntry.startedAt, nextEntry.endedAt);
      return {
        holder,
        holderError,
        waiter,
        waiterError,
        waiterRows,
        entry: nextEntry,
        week: nextWeek,
        request: nextRequest,
        originalStartedAt,
        originalEndedAt,
        proposedStartedAt,
        proposedEndedAt,
        expectedHours,
      };
    } finally {
      releaseHold();
      if (delayedSettled) await delayedSettled;
      if (firstSettled) await firstSettled;
      await delayedClient.$disconnect();
    }
  }

  const approveFirst = await raceAcceptAgainstApprove({
    holdAccept: false,
    membershipId: racerOneMem.id,
    workerAccess: racerOneA,
  });
  check(
    "Approval that holds the advisory lock first freezes original times and refuses accept",
    approveFirst.waiterRows.length > 0 &&
      approveFirst.holder?.status === "APPROVED" &&
      approveFirst.holderError == null &&
      approveFirst.waiterError instanceof TimeCardError &&
      /approved/i.test(approveFirst.waiterError.message) &&
      approveFirst.entry.status === "APPROVED" &&
      approveFirst.entry.startedAt.getTime() === approveFirst.originalStartedAt.getTime() &&
      approveFirst.entry.endedAt.getTime() === approveFirst.originalEndedAt.getTime() &&
      approveFirst.week.status === "APPROVED" &&
      Number(approveFirst.entry.approvedHours) === approveFirst.expectedHours &&
      Number(approveFirst.week.approvedHours) === approveFirst.expectedHours &&
      approveFirst.request.status === "PENDING",
  );

  const acceptFirst = await raceAcceptAgainstApprove({
    holdAccept: true,
    membershipId: racerTwoMem.id,
    workerAccess: racerTwoA,
  });
  check(
    "Accept that holds the advisory lock first is included in the approval snapshot",
    acceptFirst.waiterRows.length > 0 &&
      acceptFirst.holder?.request.status === "ACCEPTED" &&
      acceptFirst.holderError == null &&
      acceptFirst.waiter?.status === "APPROVED" &&
      acceptFirst.waiterError == null &&
      acceptFirst.entry.status === "APPROVED" &&
      acceptFirst.entry.startedAt.getTime() === acceptFirst.proposedStartedAt.getTime() &&
      acceptFirst.entry.endedAt.getTime() === acceptFirst.proposedEndedAt.getTime() &&
      acceptFirst.week.status === "APPROVED" &&
      Number(acceptFirst.entry.approvedHours) === acceptFirst.expectedHours &&
      Number(acceptFirst.week.approvedHours) === acceptFirst.expectedHours &&
      acceptFirst.request.status === "ACCEPTED",
  );

  console.log("\nTEST — Approved-week refusal and payroll snapshot safety");
  const payrollEntry = await createManualTimeEntry(prisma, ownerA, {
    membershipId: helperMem.id,
    activityType: "JOB",
    jobId: jobHelper.id,
    startedAt: hoursAgo(2.5),
    endedAt: hoursAgo(1.5),
    note: "Payroll week job",
  });
  const weekStart = weekRange(payrollEntry.startedAt, NY).start;
  const approvedWeek = await approveWeek(prisma, ownerA, {
    membershipId: helperMem.id,
    weekStartedAt: weekStart,
  });
  check("Helper week approved before payroll", approvedWeek.status === "APPROVED");
  const approvedEntry = await prisma.timeEntry.findUnique({ where: { id: payrollEntry.id } });
  const period = {
    payPeriodStart: weekStart,
    payPeriodEnd: new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000),
  };
  const draft = await createPayrollRun(prisma, adminA, period);
  if (draft.status !== "READY_FOR_REVIEW" && draft.status !== "REVIEWED") {
    check("Payroll run assembled from the approved week", draft.items.some((item) => item.timesheetWeekId === approvedWeek.id));
  }
  const reviewed = draft.status === "REVIEWED"
    ? draft
    : await reviewPayrollRun(prisma, adminA, { payrollRunId: draft.id });
  const authorized = await authorizePayrollRun(prisma, ownerA, {
    payrollRunId: reviewed.id,
    confirmed: true,
  });
  const frozenHours = Number(authorized.authorizedApprovedHours);
  const frozenGross = Number(authorized.authorizedGrossLaborAmount);
  check("Payroll AUTHORIZED with frozen snapshots", authorized.status === "AUTHORIZED" && frozenHours > 0);

  await expectError(
    "Worker cannot request a correction on an approved week",
    () => requestCorrection(prisma, helperA, {
      timeEntryId: payrollEntry.id,
      reason: "too late",
      proposedStartedAt: hoursAgo(3),
      proposedEndedAt: hoursAgo(1),
    }),
    (error) => error instanceof TimeCardError && /approved/i.test(error.message),
  );
  const afterApprovedRequest = await prisma.timeEntry.findUnique({ where: { id: payrollEntry.id } });
  check(
    "Approved-week request refusal leaves the recorded time and snapshots",
    afterApprovedRequest.startedAt.getTime() === payrollEntry.startedAt.getTime() &&
      afterApprovedRequest.endedAt.getTime() === payrollEntry.endedAt.getTime() &&
      Number(afterApprovedRequest.approvedHours) === Number(approvedEntry.approvedHours) &&
      afterApprovedRequest.status === "APPROVED",
  );

  const pendingThenApprove = await createManualTimeEntry(prisma, ownerA, {
    membershipId: memberMem.id,
    activityType: "OTHER",
    startedAt: hoursAgo(0.9),
    endedAt: hoursAgo(0.4),
    note: "Open then approve",
  });
  const pendingRequest = await requestCorrection(prisma, memberA, {
    timeEntryId: pendingThenApprove.id,
    reason: "Need 15 more minutes",
    proposedStartedAt: hoursAgo(1),
    proposedEndedAt: hoursAgo(0.25),
  });
  await approveWeek(prisma, ownerA, {
    membershipId: memberMem.id,
    weekStartedAt: pendingThenApprove.startedAt,
  });
  const beforeAcceptRefuse = await prisma.timeEntry.findUnique({
    where: { id: pendingThenApprove.id },
  });
  await expectError(
    "OWNER accept is refused after the week is approved",
    () => decideCorrection(prisma, ownerA, {
      requestId: pendingRequest.request.id,
      decision: "ACCEPTED",
    }),
    (error) => error instanceof TimeCardError && /approved/i.test(error.message),
  );
  const afterAcceptRefuse = await prisma.timeEntry.findUnique({
    where: { id: pendingThenApprove.id },
  });
  const refusedRequest = await prisma.timeCorrectionRequest.findUnique({
    where: { id: pendingRequest.request.id },
    include: { decisions: true },
  });
  check(
    "Approved-week accept refusal does not apply proposed times",
    afterAcceptRefuse.startedAt.getTime() === beforeAcceptRefuse.startedAt.getTime() &&
      afterAcceptRefuse.endedAt.getTime() === beforeAcceptRefuse.endedAt.getTime() &&
      afterAcceptRefuse.status === "APPROVED",
  );
  check(
    "Approved-week accept refusal does not write a decision",
    refusedRequest.status === "PENDING" && refusedRequest.decisions.length === 0,
  );

  const payrollAfter = await prisma.payrollRun.findUnique({ where: { id: authorized.id } });
  const payrollItemsAfter = await prisma.payrollRunItem.findMany({
    where: { payrollRunId: authorized.id },
  });
  check(
    "Authorized payroll hours and gross stay frozen",
    payrollAfter.status === "AUTHORIZED" &&
      Number(payrollAfter.authorizedApprovedHours) === frozenHours &&
      Number(payrollAfter.authorizedGrossLaborAmount) === frozenGross,
  );
  check(
    "Authorized payroll item snapshots are not rewritten",
    payrollItemsAfter.every((item) => Number(item.approvedHours) > 0) &&
      payrollItemsAfter.some((item) => item.timesheetWeekId === approvedWeek.id),
  );

  if (failures === 0) {
    console.log("\nTime-correction request checks passed.");
  } else {
    console.error(`\n${failures} time-correction request check(s) failed.`);
  }
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
  await dropTestDatabase();
}

process.exit(failures === 0 ? 0 : 1);
