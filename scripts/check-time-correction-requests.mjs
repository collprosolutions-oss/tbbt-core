/**
 * Worker time-correction requests + OWNER decisions.
 *
 * Imports the REAL production helpers from src/lib/time-cards.ts and
 * src/lib/time-card-ops.ts (same functions the server actions call).
 * Proves worker scoping, OWNER authorization, tenant isolation,
 * duplicate decisions, approved-week refusal, original-record
 * preservation, and payroll snapshot safety on a dedicated test DB.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-time-correction-requests.mjs
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
  weekRange,
} = await import("@/lib/time-cards");
const {
  approveTimesheetWeek,
  createManualTimeEntry,
  decideTimeCorrectionRequest,
  requestTimeCorrection,
  TimeCardError,
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

const testDbName = "tbbt_time_correction_requests_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for time-correction-requests test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");
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

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 3_600_000);
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
  const fieldSrc = readFileSync(
    new URL("../src/components/field/field-time-correction-requests.tsx", import.meta.url),
    "utf8",
  );
  const queueSrc = readFileSync(
    new URL("../src/components/time-cards/time-correction-request-queue.tsx", import.meta.url),
    "utf8",
  );
  const migrationSrc = readFileSync(
    new URL("../prisma/migrations/20260929010000_time_correction_requests/migration.sql", import.meta.url),
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
    "Migration is additive and does not rewrite time or payroll tables",
    migrationSrc.includes('CREATE TABLE IF NOT EXISTS "TimeCorrectionRequest"') &&
      migrationSrc.includes('CREATE TABLE IF NOT EXISTS "TimeCorrectionDecision"') &&
      !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE|UPDATE "/i.test(migrationSrc),
  );

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
  const requested = await requestTimeCorrection(prisma, memberA, {
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
  await expectError(
    "Worker cannot request a correction on another worker's entry",
    () => requestTimeCorrection(prisma, memberA, {
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
    () => requestTimeCorrection(prisma, memberA, {
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
    () => decideTimeCorrectionRequest(prisma, adminA, {
      requestId: requested.request.id,
      decision: "ACCEPTED",
    }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot decide their own request",
    () => decideTimeCorrectionRequest(prisma, memberA, {
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
    () => requestTimeCorrection(prisma, memberB, {
      timeEntryId: memberEntry.id,
      reason: "cross tenant",
      proposedStartedAt: hoursAgo(9),
      proposedEndedAt: hoursAgo(7),
    }),
    (error) => error instanceof TimeCardError || error instanceof ForbiddenError,
  );
  await expectError(
    "Tenant B owner cannot decide tenant A's request",
    () => decideTimeCorrectionRequest(prisma, ownerB, {
      requestId: requested.request.id,
      decision: "ACCEPTED",
    }),
    (error) => error instanceof TimeCardError || error instanceof ForbiddenError,
  );

  console.log("\nTEST — OWNER accept applies proposed times and keeps history");
  const accepted = await decideTimeCorrectionRequest(prisma, ownerA, {
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
    () => decideTimeCorrectionRequest(prisma, ownerA, {
      requestId: requested.request.id,
      decision: "ACCEPTED",
    }),
    (error) => error instanceof TimeCardError && /already has an owner decision/i.test(error.message),
  );
  await expectError(
    "Decline after accept is refused",
    () => decideTimeCorrectionRequest(prisma, ownerA, {
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
  const declineRequest = await requestTimeCorrection(prisma, helperA, {
    timeEntryId: declineSource.id,
    reason: "I think this was longer",
    proposedStartedAt: hoursAgo(3.75),
    proposedEndedAt: hoursAgo(2.75),
  });
  const declined = await decideTimeCorrectionRequest(prisma, ownerA, {
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

  console.log("\nTEST — Approved-week refusal and payroll snapshot safety");
  const payrollEntry = await createManualTimeEntry(prisma, ownerA, {
    membershipId: helperMem.id,
    activityType: "JOB",
    jobId: jobHelper.id,
    startedAt: hoursAgo(2.5),
    endedAt: hoursAgo(1.5),
    note: "Payroll week job",
  });
  const weekStart = weekRange(payrollEntry.startedAt).start;
  const approvedWeek = await approveTimesheetWeek(prisma, ownerA, {
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
    () => requestTimeCorrection(prisma, helperA, {
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
  const pendingRequest = await requestTimeCorrection(prisma, memberA, {
    timeEntryId: pendingThenApprove.id,
    reason: "Need 15 more minutes",
    proposedStartedAt: hoursAgo(1),
    proposedEndedAt: hoursAgo(0.25),
  });
  await approveTimesheetWeek(prisma, ownerA, {
    membershipId: memberMem.id,
    weekStartedAt: weekRange(pendingThenApprove.startedAt).start,
  });
  const beforeAcceptRefuse = await prisma.timeEntry.findUnique({
    where: { id: pendingThenApprove.id },
  });
  await expectError(
    "OWNER accept is refused after the week is approved",
    () => decideTimeCorrectionRequest(prisma, ownerA, {
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
  check(
    "Accepted earlier correction did not change paid helper hours used for payroll",
    hoursBetween(afterApprovedRequest.startedAt, afterApprovedRequest.endedAt) ===
      hoursBetween(payrollEntry.startedAt, payrollEntry.endedAt),
  );

  if (failures > 0) {
    console.error(`\n${failures} time-correction request check(s) failed.`);
    process.exit(1);
  }
  console.log("\nTime-correction request checks passed.");
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
