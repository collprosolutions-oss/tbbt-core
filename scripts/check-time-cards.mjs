/**
 * Time Cards domain + authorization verification.
 *
 * Imports the REAL production helpers from src/lib/time-cards.ts and
 * src/lib/time-card-ops.ts (same functions the server actions call).
 * requireBusinessAccess() cannot run here (next/headers), so access is
 * constructed the same way scripts/check-authorization.mjs does.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-time-cards.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  CAPABILITIES,
  ForbiddenError,
  requireBusinessCapability,
  roleHasCapability,
} = await import("@/lib/authorization");
const {
  TIME_ACTIVITY_TYPES,
  canApproveWeek,
  canEditTimeEntry,
  estimateLaborCost,
  formatDateInput,
  formatDurationClock,
  formatTimeInput,
  hasOverlappingEntry,
  hoursBetween,
  intervalsOverlap,
  isPaidActivity,
  paidHours,
  parseDateTimeInput,
  weekRange,
} = await import("@/lib/time-cards");
const {
  approveTimesheetWeek,
  clockInTime,
  clockOutTime,
  correctTimeEntry,
  createManualTimeEntry,
  reopenTimesheetWeek,
  requestTimeCorrection,
  TimeCardError,
  updateMembershipWage,
} = await import("@/lib/time-card-ops");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_time_cards_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for time-cards test database.");
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
  console.log("\nSTATIC — Time Cards domain helpers");
  check("JOB/TRAVEL/MATERIAL_PICKUP/OTHER are paid", ["JOB", "TRAVEL", "MATERIAL_PICKUP", "OTHER"].every(isPaidActivity));
  check("BREAK is unpaid", !isPaidActivity("BREAK"));
  check("Touching intervals are not overlap", !intervalsOverlap(
    { startedAt: new Date("2026-08-30T09:00:00"), endedAt: new Date("2026-08-30T10:00:00") },
    { startedAt: new Date("2026-08-30T10:00:00"), endedAt: new Date("2026-08-30T11:00:00") },
  ));
  check("True overlap is detected", hasOverlappingEntry(
    { startedAt: new Date("2026-08-30T09:30:00"), endedAt: new Date("2026-08-30T10:30:00") },
    [{ startedAt: new Date("2026-08-30T09:00:00"), endedAt: new Date("2026-08-30T10:00:00") }],
  ));
  check("2 hours is 2.00", hoursBetween(new Date("2026-08-30T09:00:00"), new Date("2026-08-30T11:00:00")) === 2);
  const nineToFive = {
    startedAt: parseDateTimeInput("2026-08-24", "09:00"),
    endedAt: parseDateTimeInput("2026-08-24", "17:00"),
  };
  check("9 AM–5 PM parses to the same civil day", nineToFive.startedAt?.toISOString() === "2026-08-24T09:00:00.000Z" && nineToFive.endedAt?.toISOString() === "2026-08-24T17:00:00.000Z");
  check("9 AM–5 PM = 8 hours", hoursBetween(nineToFive.startedAt, nineToFive.endedAt) === 8);
  check("9 AM–5 PM with seconds still 8 hours", hoursBetween(parseDateTimeInput("2026-08-24", "09:00:00"), parseDateTimeInput("2026-08-24", "17:00:00")) === 8);
  check("8 hours × $30 = $240", estimateLaborCost(8, 30) === 240);
  check(
    "ISO date + local 17:00 is not used for form format (would be 32h in US timezones)",
    formatDateInput(nineToFive.endedAt) === "2026-08-24" && formatTimeInput(nineToFive.endedAt) === "17:00",
  );
  const danielHours = hoursBetween(parseDateTimeInput("2026-08-24", "09:00"), parseDateTimeInput("2026-08-24", "17:00"));
  const peterHours = hoursBetween(parseDateTimeInput("2026-08-24", "09:00"), parseDateTimeInput("2026-08-24", "17:00"));
  check("Two 8-hour workers = 16 total hours", danielHours + peterHours === 16);
  check("Labor cost is hours × wage", estimateLaborCost(4, 25) === 100);
  check("Labor cost is null without wage", estimateLaborCost(4, null) === null);
  check("Approved entries cannot be edited", canEditTimeEntry("APPROVED") === false);
  check("Ready entries can be edited", canEditTimeEntry("READY") === true);
  check("Running week cannot be approved", canApproveWeek([{ status: "RUNNING", endedAt: null }]).ok === false);
  check("Duration clock formats 2.5h as 2:30", formatDurationClock(2.5) === "2:30");
  check("OWNER/ADMIN have MANAGE_TIME_CARDS", roleHasCapability("OWNER", CAPABILITIES.MANAGE_TIME_CARDS) && roleHasCapability("ADMIN", CAPABILITIES.MANAGE_TIME_CARDS));
  check("MEMBER does not have MANAGE_TIME_CARDS", !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_TIME_CARDS));
  check("All five activity types exist", TIME_ACTIVITY_TYPES.length === 5);

  const businessA = await prisma.business.create({
    data: { name: "Alpha Time", slug: "alpha-time-cards", tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Time", slug: "beta-time-cards", tradeCode: "HANDYMAN" },
  });

  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: "owner-time@example.com", passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Amir Admin", email: "admin-time@example.com", passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: "member-time@example.com", passwordHash: "x" },
  });
  const helperUser = await prisma.user.create({
    data: { name: "Hank Helper", email: "helper-time@example.com", passwordHash: "x" },
  });
  const betaOwner = await prisma.user.create({
    data: { name: "Bea Owner", email: "beta-owner-time@example.com", passwordHash: "x" },
  });
  const betaMember = await prisma.user.create({
    data: { name: "Ben Member", email: "beta-member-time@example.com", passwordHash: "x" },
  });

  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER", hourlyWage: new Prisma.Decimal(25) },
  });
  const adminMem = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: businessA.id, role: "ADMIN", hourlyWage: new Prisma.Decimal(22) },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER", hourlyWage: new Prisma.Decimal(18) },
  });
  const helperMem = await prisma.membership.create({
    data: { userId: helperUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  await prisma.membership.create({
    data: { userId: betaOwner.id, businessId: businessB.id, role: "OWNER", hourlyWage: new Prisma.Decimal(40) },
  });
  const betaMemberMem = await prisma.membership.create({
    data: { userId: betaMember.id, businessId: businessB.id, role: "MEMBER" },
  });

  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const helperA = makeAccess(businessA.id, "MEMBER", helperMem.id);
  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Alpha Customer" },
  });
  const jobA = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "SCHEDULED",
      projectToken: randomUUID(),
      assignedMembershipId: memberMem.id,
    },
  });
  const jobHelper = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
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

  console.log("\nTEST — Clocking: job / travel / pickup / break / other");
  const jobClock = await clockInTime(prisma, memberA, {
    membershipId: memberMem.id,
    activityType: "JOB",
    jobId: jobA.id,
    startedAt: hoursAgo(5),
  });
  check("MEMBER can clock JOB on assigned job", jobClock.status === "RUNNING" && jobClock.jobId === jobA.id);

  const afterTravel = await clockInTime(prisma, memberA, {
    membershipId: memberMem.id,
    activityType: "TRAVEL",
    startedAt: hoursAgo(4),
  });
  const closedJob = await prisma.timeEntry.findUnique({ where: { id: jobClock.id } });
  check("Starting travel auto-closes the running JOB (no overlap)", closedJob.status === "READY" && closedJob.endedAt != null);
  check("Travel entry is running", afterTravel.status === "RUNNING" && afterTravel.activityType === "TRAVEL");

  await clockInTime(prisma, memberA, { membershipId: memberMem.id, activityType: "MATERIAL_PICKUP", startedAt: hoursAgo(3) });
  await clockInTime(prisma, memberA, { membershipId: memberMem.id, activityType: "BREAK", startedAt: hoursAgo(2) });
  await clockInTime(prisma, memberA, { membershipId: memberMem.id, activityType: "OTHER", startedAt: hoursAgo(1) });
  const otherOut = await clockOutTime(prisma, memberA, { membershipId: memberMem.id, endedAt: new Date() });
  check("Clock out ends OTHER as READY", otherOut.status === "READY" && otherOut.endedAt != null);

  const runningCount = await prisma.timeEntry.count({
    where: { membershipId: memberMem.id, status: "RUNNING" },
  });
  check("Worker has no overlapping active entries", runningCount === 0);

  console.log("\nTEST — Assignment + tenant isolation");
  await expectError(
    "MEMBER cannot clock another worker's assigned job",
    () => clockInTime(prisma, memberA, { membershipId: memberMem.id, activityType: "JOB", jobId: jobHelper.id }),
    (error) => error instanceof TimeCardError,
  );
  await expectError(
    "MEMBER cannot clock on behalf of another worker",
    () => clockInTime(prisma, memberA, { membershipId: helperMem.id, activityType: "TRAVEL" }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot clock a cross-business job",
    () => clockInTime(prisma, memberA, { membershipId: memberMem.id, activityType: "JOB", jobId: jobB.id }),
    (error) => error instanceof TimeCardError,
  );
  await expectError(
    "Business A owner cannot clock a Business B worker using A's access",
    () => clockInTime(prisma, ownerA, { membershipId: betaMemberMem.id, activityType: "TRAVEL" }),
    (error) => error instanceof TimeCardError,
  );

  const scoped = await prisma.timeEntry.findMany({ where: { businessId: businessA.id } });
  check("Scoped A query never returns B entries", scoped.every((entry) => entry.businessId === businessA.id));
  const leaked = await prisma.timeEntry.findFirst({
    where: { id: jobClock.id, businessId: businessB.id },
  });
  check("Business B cannot load Business A's time entry by id", leaked === null);

  console.log("\nTEST — Manual 9 AM–5 PM duration (not 32 hours)");
  const danielUser = await prisma.user.create({
    data: { name: "Daniel Worker", email: "daniel-time@example.com", passwordHash: "x" },
  });
  const peterUser = await prisma.user.create({
    data: { name: "Peter Worker", email: "peter-time@example.com", passwordHash: "x" },
  });
  const danielMem = await prisma.membership.create({
    data: { userId: danielUser.id, businessId: businessA.id, role: "MEMBER", hourlyWage: new Prisma.Decimal(30) },
  });
  const peterMem = await prisma.membership.create({
    data: { userId: peterUser.id, businessId: businessA.id, role: "MEMBER", hourlyWage: new Prisma.Decimal(30) },
  });
  const jobDaniel = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "SCHEDULED",
      projectToken: randomUUID(),
      assignedMembershipId: danielMem.id,
    },
  });
  const jobPeter = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "SCHEDULED",
      projectToken: randomUUID(),
      assignedMembershipId: peterMem.id,
    },
  });
  const dayShiftStart = parseDateTimeInput("2026-08-17", "09:00");
  const dayShiftEnd = parseDateTimeInput("2026-08-17", "17:00");
  const danielEntry = await createManualTimeEntry(prisma, ownerA, {
    membershipId: danielMem.id,
    activityType: "JOB",
    jobId: jobDaniel.id,
    startedAt: dayShiftStart,
    endedAt: dayShiftEnd,
    note: "Daniel 9-5",
  });
  const peterEntry = await createManualTimeEntry(prisma, ownerA, {
    membershipId: peterMem.id,
    activityType: "JOB",
    jobId: jobPeter.id,
    startedAt: dayShiftStart,
    endedAt: dayShiftEnd,
    note: "Peter 9-5",
  });
  const danielStored = await prisma.timeEntry.findUnique({ where: { id: danielEntry.id } });
  const peterStored = await prisma.timeEntry.findUnique({ where: { id: peterEntry.id } });
  const danielStoredHours = hoursBetween(danielStored.startedAt, danielStored.endedAt);
  const peterStoredHours = hoursBetween(peterStored.startedAt, peterStored.endedAt);
  check("Stored Daniel start/end stay 09:00Z–17:00Z", danielStored.startedAt.toISOString() === "2026-08-17T09:00:00.000Z" && danielStored.endedAt.toISOString() === "2026-08-17T17:00:00.000Z");
  check("Stored Daniel 9 AM–5 PM = 8 hours, not 32", danielStoredHours === 8);
  check("Stored Peter 9 AM–5 PM = 8 hours, not 32", peterStoredHours === 8);
  const crewDay = [
    { startedAt: danielStored.startedAt, endedAt: danielStored.endedAt, activityType: danielStored.activityType },
    { startedAt: peterStored.startedAt, endedAt: peterStored.endedAt, activityType: peterStored.activityType },
  ];
  check("Two 8-hour workers aggregate to 16, not 64", paidHours(crewDay) === 16);
  check("Aggregation does not multiply entries", paidHours(crewDay) === danielStoredHours + peterStoredHours);
  check("Daniel 8 hours × $30 = $240, not $960", estimateLaborCost(danielStoredHours, 30) === 240);
  const danielRoundTrip = hoursBetween(
    parseDateTimeInput(formatDateInput(danielStored.startedAt), formatTimeInput(danielStored.startedAt)),
    parseDateTimeInput(formatDateInput(danielStored.endedAt), formatTimeInput(danielStored.endedAt)),
  );
  check("Correction form round-trip stays 8 hours", danielRoundTrip === 8);

  console.log("\nTEST — OWNER/ADMIN manual entry, wage, and MEMBER denial");
  const manual = await createManualTimeEntry(prisma, ownerA, {
    membershipId: helperMem.id,
    activityType: "JOB",
    jobId: jobHelper.id,
    startedAt: hoursAgo(8),
    endedAt: hoursAgo(7),
    note: "Owner correction for helper",
  });
  check("OWNER can create a manual entry", manual.source === "MANUAL" && manual.status === "READY");
  const adminManual = await createManualTimeEntry(prisma, adminA, {
    membershipId: helperMem.id,
    activityType: "TRAVEL",
    startedAt: hoursAgo(6),
    endedAt: hoursAgo(5),
    note: "Admin travel entry",
  });
  check("ADMIN can create a manual entry", adminManual.source === "MANUAL");
  await expectError(
    "MEMBER cannot create a manual entry for anyone",
    () => createManualTimeEntry(prisma, memberA, {
      membershipId: memberMem.id,
      activityType: "OTHER",
      startedAt: hoursAgo(8),
      endedAt: hoursAgo(7),
    }),
    (error) => error instanceof ForbiddenError,
  );

  const wage = await updateMembershipWage(prisma, ownerA, { membershipId: helperMem.id, hourlyWage: "20.00" });
  check("OWNER can set membership wage", Number(wage.hourlyWage.toString()) === 20);
  await expectError(
    "MEMBER cannot set wage",
    () => updateMembershipWage(prisma, memberA, { membershipId: memberMem.id, hourlyWage: "99" }),
    (error) => error instanceof ForbiddenError,
  );
  const memberWageUnchanged = await prisma.membership.findUnique({ where: { id: memberMem.id } });
  check("MEMBER wage is unchanged after rejected edit", Number(memberWageUnchanged.hourlyWage.toString()) === 18);

  console.log("\nTEST — Corrections are audited; approved records stay immutable");
  const corrected = await correctTimeEntry(prisma, ownerA, {
    timeEntryId: manual.id,
    endedAt: hoursAgo(6.5),
    reason: "Adjusted end time after review",
  });
  check("Correction moves entry to NEEDS_REVIEW", corrected.status === "NEEDS_REVIEW");
  const audit = await prisma.timeEntryAdjustment.findMany({
    where: { timeEntryId: manual.id },
    orderBy: { createdAt: "asc" },
  });
  check("Manual create produced a CREATE adjustment", audit.some((row) => row.action === "CREATE"));
  check("Correction produced a CORRECT adjustment with reason", audit.some((row) => row.action === "CORRECT" && row.reason === "Adjusted end time after review"));
  check("Adjustment stores previous and next snapshots", audit.some((row) => row.previousJson && row.nextJson));

  await requestTimeCorrection(prisma, helperA, {
    timeEntryId: adminManual.id,
    reason: "I took a longer drive",
  });
  const flagged = await prisma.timeEntry.findUnique({ where: { id: adminManual.id } });
  check("MEMBER can request correction on own entry", flagged.status === "NEEDS_REVIEW");
  const memberOwned = await prisma.timeEntry.findFirst({
    where: { membershipId: memberMem.id, status: { not: "RUNNING" } },
  });
  await expectError(
    "MEMBER cannot request correction on another worker's entry",
    () => requestTimeCorrection(prisma, helperA, { timeEntryId: memberOwned.id, reason: "nope" }),
    (error) => error instanceof ForbiddenError,
  );

  const weekStart = weekRange(new Date()).start;
  const approved = await approveTimesheetWeek(prisma, ownerA, {
    membershipId: helperMem.id,
    weekStartedAt: weekStart,
  });
  check("Approved week is Payroll Ready", approved.status === "APPROVED");
  check("Approval snapshots hours and wage", approved.approvedHours != null && Number(approved.approvedHourlyWage.toString()) === 20);
  const approvedEntries = await prisma.timeEntry.findMany({
    where: { membershipId: helperMem.id, status: "APPROVED" },
  });
  check("Helper entries are APPROVED and snapshotted", approvedEntries.length >= 2 && approvedEntries.every((entry) => entry.approvedHours != null));

  await expectError(
    "Approved entry cannot be silently edited",
    () => correctTimeEntry(prisma, ownerA, {
      timeEntryId: approvedEntries[0].id,
      reason: "should fail",
      note: "silent edit",
    }),
    (error) => error instanceof TimeCardError,
  );

  const reopened = await reopenTimesheetWeek(prisma, ownerA, {
    membershipId: helperMem.id,
    weekStartedAt: weekStart,
    reason: "Need to fix travel time",
  });
  check("Reopen returns week to OPEN", reopened.status === "OPEN");
  const reopenAudit = await prisma.timeEntryAdjustment.findFirst({
    where: { timeEntryId: approvedEntries[0].id, action: "REOPEN" },
  });
  check("Reopen is audited", Boolean(reopenAudit?.reason));
  const afterReopen = await prisma.timeEntry.findUnique({ where: { id: approvedEntries[0].id } });
  check("Reopened entry is READY again (not silently left approved)", afterReopen.status === "READY");
  check("Historical approved snapshot remains on the entry until next approval", afterReopen.approvedHours != null);

  const reapproved = await approveTimesheetWeek(prisma, adminA, {
    membershipId: helperMem.id,
    weekStartedAt: weekStart,
  });
  check("ADMIN can re-approve after reopen", reapproved.status === "APPROVED");

  console.log("\nTEST — Today / week totals and current clock");
  const memberEntries = await prisma.timeEntry.findMany({ where: { membershipId: memberMem.id } });
  const memberPaid = paidHours(memberEntries);
  check("Week paid hours exclude BREAK", memberPaid > 0);
  const memberBreaks = memberEntries.filter((entry) => entry.activityType === "BREAK");
  check("Break entries exist as their own activity", memberBreaks.length === 1);
  await clockInTime(prisma, memberA, { membershipId: memberMem.id, activityType: "TRAVEL" });
  const current = await prisma.timeEntry.findFirst({
    where: { membershipId: memberMem.id, status: "RUNNING" },
  });
  check("Current-clock status is RUNNING travel", current?.activityType === "TRAVEL");
  await expectError(
    "Cannot approve a week while a clock is running",
    () => approveTimesheetWeek(prisma, ownerA, { membershipId: memberMem.id, weekStartedAt: weekStart }),
    (error) => error instanceof TimeCardError,
  );

  console.log("\nTEST — Capability gate still applies for owner-only paths");
  await expectError(
    "MEMBER cannot approve a week",
    () => approveTimesheetWeek(prisma, memberA, { membershipId: memberMem.id, weekStartedAt: weekStart }),
    (error) => error instanceof ForbiddenError,
  );
  try {
    requireBusinessCapability(memberA, CAPABILITIES.MANAGE_TIME_CARDS);
    check("MEMBER requireBusinessCapability(MANAGE_TIME_CARDS) throws", false);
  } catch (error) {
    check("MEMBER requireBusinessCapability(MANAGE_TIME_CARDS) throws", error instanceof ForbiddenError);
  }

  console.log(
    failures === 0
      ? "\nAll Time Cards checks passed."
      : `\n${failures} Time Cards check(s) failed.`,
  );
} finally {
  await prisma.$disconnect();
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

process.exit(failures === 0 ? 0 : 1);
