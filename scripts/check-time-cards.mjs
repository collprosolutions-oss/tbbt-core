/**
 * Time Cards domain + authorization verification.
 *
 * Imports the REAL production helpers from src/lib/time-cards.ts and
 * src/lib/time-card-ops.ts (same functions the server actions call).
 * requireBusinessAccess() cannot run here (next/headers), so access is
 * constructed the same way scripts/check-authorization.mjs does.
 *
 * Run with:
 *   TZ=UTC node --experimental-strip-types scripts/check-time-cards.mjs
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
  TIME_ACTIVITY_TYPES,
  approvalSnapshot,
  canApproveWeek,
  canEditTimeEntry,
  canRequestTimeCorrection,
  coerceHourlyWage,
  estimateLaborCost,
  ALREADY_CREDITED_CROSSING_ERROR = "An approved time entry already credited in another week crosses this week. Reopen and correct it into one-week entries before approving.",
  WEEK_BOUNDARY_CROSSING_ERROR,
  WEEK_BOUNDARY_CROSSING_POLICY,
  MISSING_APPROVAL_TIMEZONE_ERROR = "canApproveWeek requires the business timezone.",
  businessWeekStartsTouchedByEntry,
  entryCrossesBusinessWeekBoundary,
  entryOverlapsWeek,
  formatDateInput,
  formatDurationClock,
  formatTimeInput,
  hasOverlappingEntry,
  hoursBetween,
  intervalsOverlap,
  isPaidActivity,
  missingApprovalSnapshotPatch,
  NONEXISTENT_CIVIL_TIME_ERROR,
  paidHours,
  parseBusinessDateTimeInput,
  parseDateTimeInput,
  parseHourlyWage,
  resolveWeekBoundaryCrossingPolicy,
  weekRange,
} = await import("@/lib/time-cards");
const {
  approveTimesheetWeek,
  clockInTime,
  clockOutTime,
  closeRunningJobTimeForCompletion,
  completeJobWithRunningTimeSafety,
  correctTimeEntry,
  createManualTimeEntry,
  decideTimeCorrectionRequest,
  JOB_COMPLETION_TIME_CLOSED_REASON,
  JOB_STOP_TIME_CLOSED_REASON,
  reopenTimesheetWeek,
  startAssignedActivityTime,
  startJobWithRunningTimeSafety,
  stopAssignedActivityTime,
  stopRunningAssignedJobTime,
  requestTimeCorrection,
  TimeCardError,
  updateMembershipWage,
} = await import("@/lib/time-card-ops");
const { createExpense } = await import("@/lib/expense-ops");
const { buildReport, resolveReportRange } = await import("@/lib/reports");
const { loadReportSource } = await import("@/lib/reports-data");

const NY = "America/New_York";

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

const testDbName = "tbbt_time_cards_test";
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

await dropTestDatabase();

const adminUrl = new URL(baseUrl);
adminUrl.search = "";
const createDb = spawnSync("psql", [adminUrl.toString(), "-c", `CREATE DATABASE "${testDbName}"`], {
  encoding: "utf8",
});
if (createDb.status !== 0 && !/already exists/i.test(`${createDb.stderr}${createDb.stdout}`)) {
  console.error(createDb.stderr || createDb.stdout);
  await dropTestDatabase();
  process.exit(createDb.status ?? 1);
}

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for time-cards test database.");
  await dropTestDatabase();
  process.exit(push.status ?? 1);
}

const prisma = new PrismaClient({ datasourceUrl: testUrl });

function civil(date, time) {
  return parseDateTimeInput(date, time, NY);
}

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

function makeAccess(businessId, role, membershipId, timezone = NY) {
  return {
    businessId,
    workspace: { role, membership: { id: membershipId }, business: { timezone } },
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
    startedAt: civil("2026-08-24", "09:00"),
    endedAt: civil("2026-08-24", "17:00"),
  };
  check("9 AM–5 PM America/New_York persists 13:00Z–21:00Z (EDT)", nineToFive.startedAt?.toISOString() === "2026-08-24T13:00:00.000Z" && nineToFive.endedAt?.toISOString() === "2026-08-24T21:00:00.000Z");
  check("9 AM–5 PM = 8 hours", hoursBetween(nineToFive.startedAt, nineToFive.endedAt) === 8);
  check("9 AM–5 PM with seconds still 8 hours", hoursBetween(civil("2026-08-24", "09:00:00"), civil("2026-08-24", "17:00:00")) === 8);
  check(
    "Winter EST 09:00 America/New_York persists 14:00Z",
    civil("2026-01-15", "09:00")?.toISOString() === "2026-01-15T14:00:00.000Z",
  );
  check(
    "Host timezone cannot hide the NY offset (09:00 is not 09:00Z)",
    civil("2026-08-24", "09:00")?.toISOString() !== "2026-08-24T09:00:00.000Z",
  );
  const sundayEarly = civil("2026-09-20", "01:00");
  const sundayWeek = weekRange(sundayEarly, NY);
  check(
    "Early Sunday 01:00 America/New_York classifies into the Sep 20 week, not Sep 13",
    sundayEarly?.toISOString() === "2026-09-20T05:00:00.000Z" &&
      sundayWeek.start.toISOString() === "2026-09-20T04:00:00.000Z",
  );
  check("DST-gap 2026-03-08 02:30 America/New_York is rejected", civil("2026-03-08", "02:30") === null);
  const dstGap = parseBusinessDateTimeInput("2026-03-08", "02:30", NY);
  check(
    "DST-gap parse reports the nonexistent civil-time error",
    !dstGap.ok && dstGap.error === NONEXISTENT_CIVIL_TIME_ERROR,
  );
  const editRoundTrip = parseDateTimeInput(
    formatDateInput(nineToFive.startedAt, NY),
    formatTimeInput(nineToFive.startedAt, NY),
    NY,
  );
  check(
    "UI/edit round-trip keeps the same UTC instant",
    editRoundTrip?.toISOString() === nineToFive.startedAt.toISOString(),
  );
  check("parseDateTimeInput requires a resolved IANA timezone", parseDateTimeInput("2026-08-24", "09:00", "Not/AZone") === null);
  const crossing = {
    startedAt: civil("2026-09-19", "22:00"),
    endedAt: civil("2026-09-20", "02:00"),
    activityType: "JOB",
  };
  const weekA = weekRange(civil("2026-09-19", "12:00"), NY);
  const weekB = weekRange(civil("2026-09-20", "12:00"), NY);
  check(
    "P1-08 fixture: Sat 22:00–Sun 02:00 America/New_York is 4 hours and crosses the week",
    crossing.startedAt?.toISOString() === "2026-09-20T02:00:00.000Z" &&
      crossing.endedAt?.toISOString() === "2026-09-20T06:00:00.000Z" &&
      hoursBetween(crossing.startedAt, crossing.endedAt) === 4 &&
      entryCrossesBusinessWeekBoundary(crossing, NY) &&
      businessWeekStartsTouchedByEntry(crossing, NY).length === 2 &&
      entryOverlapsWeek(crossing, weekA.start, weekA.end) &&
      entryOverlapsWeek(crossing, weekB.start, weekB.end),
  );
  const boundaryTouch = {
    startedAt: civil("2026-09-19", "22:00"),
    endedAt: civil("2026-09-20", "00:00"),
  };
  check(
    "Ending exactly at Sunday 00:00 America/New_York is a touch, not a crossing",
    boundaryTouch.endedAt?.toISOString() === "2026-09-20T04:00:00.000Z" &&
      entryCrossesBusinessWeekBoundary(boundaryTouch, NY) === false &&
      businessWeekStartsTouchedByEntry(boundaryTouch, NY).length === 1,
  );
  const sameWeekNight = {
    startedAt: civil("2026-09-19", "20:00"),
    endedAt: civil("2026-09-19", "23:00"),
  };
  check(
    "Same-week Saturday night does not cross the Sunday boundary",
    entryCrossesBusinessWeekBoundary(sameWeekNight, NY) === false,
  );
  check(
    "P1-08 policy B rejects approval of a crossing entry",
    WEEK_BOUNDARY_CROSSING_POLICY === "reject" &&
      resolveWeekBoundaryCrossingPolicy() === "reject" &&
      canApproveWeek(
        [{ status: "READY", startedAt: crossing.startedAt, endedAt: crossing.endedAt }],
        NY,
      ).error === WEEK_BOUNDARY_CROSSING_ERROR,
  );
  check(
    "Already-APPROVED historical crossing entries are not blocked by the gate",
    canApproveWeek(
      [{ status: "APPROVED", startedAt: crossing.startedAt, endedAt: crossing.endedAt }],
      NY,
    ).ok === true,
  );
  check(
    "Approving another week is refused when an APPROVED crossing was already credited elsewhere",
    canApproveWeek(
      [{ status: "APPROVED", startedAt: crossing.startedAt, endedAt: crossing.endedAt }],
      NY,
      { weekStartedAt: weekB.start, alreadyApprovedWeekStarts: [weekA.start] },
    ).error === ALREADY_CREDITED_CROSSING_ERROR,
  );
  try {
    canApproveWeek(
      [{ status: "READY", startedAt: crossing.startedAt, endedAt: crossing.endedAt }],
    );
    check("canApproveWeek without a timezone throws", false);
  } catch (error) {
    check(
      "canApproveWeek without a timezone throws",
      error instanceof Error && error.message === MISSING_APPROVAL_TIMEZONE_ERROR,
    );
  }
  const fallbackSecond = new Date("2026-11-01T06:30:00.000Z");
  const fallbackFirst = parseDateTimeInput("2026-11-01", "01:30", NY);
  const fallbackKept = parseBusinessDateTimeInput("2026-11-01", "01:30", NY, fallbackSecond);
  check(
    "DST fall-back 01:30 America/New_York is ambiguous; first occurrence is 05:30Z",
    fallbackFirst?.toISOString() === "2026-11-01T05:30:00.000Z" &&
      formatDateInput(fallbackSecond, NY) === "2026-11-01" &&
      formatTimeInput(fallbackSecond, NY) === "01:30",
  );
  check(
    "Resubmitting the formatted civil time of an existing fall-back instant keeps that instant",
    fallbackKept.ok === true &&
      fallbackKept.value.toISOString() === "2026-11-01T06:30:00.000Z" &&
      fallbackKept.value.getTime() === fallbackSecond.getTime(),
  );
  check("8 hours × $30 = $240", estimateLaborCost(8, 30) === 240);
  check("Labor cost is hours × wage", estimateLaborCost(4, 25) === 100);
  check("Labor cost is null without wage", estimateLaborCost(4, null) === null);
  check("Labor cost is not invented from a placeholder", coerceHourlyWage("") === null && coerceHourlyWage(undefined) === null);
  check("Prisma Decimal $25 is a usable wage", coerceHourlyWage(new Prisma.Decimal(25)) === 25);
  const oneHourJob = approvalSnapshot({
    startedAt: civil("2026-09-19", "09:00"),
    endedAt: civil("2026-09-19", "10:00"),
    activityType: "JOB",
    hourlyWage: new Prisma.Decimal("25.00"),
  });
  check(
    "1 hour × $25 snapshots $25 labor",
    oneHourJob.approvedHours === 1 &&
      oneHourJob.approvedHourlyWage === 25 &&
      oneHourJob.approvedLaborCost === 25,
  );
  const noWageSnap = approvalSnapshot({
    startedAt: civil("2026-09-19", "09:00"),
    endedAt: civil("2026-09-19", "10:00"),
    activityType: "JOB",
    hourlyWage: null,
  });
  check(
    "Hours still snapshot when no wage is on file",
    noWageSnap.approvedHours === 1 &&
      noWageSnap.approvedHourlyWage === null &&
      noWageSnap.approvedLaborCost === null,
  );
  const repairExact = missingApprovalSnapshotPatch({
    startedAt: civil("2026-09-19", "09:00"),
    endedAt: civil("2026-09-19", "10:00"),
    activityType: "JOB",
    approvedHours: 1,
    approvedHourlyWage: null,
    approvedLaborCost: null,
    hourlyWage: new Prisma.Decimal("25.00"),
  });
  check(
    "Already-approved 1h with null wage/cost patches 1.0 × $25 = $25",
    repairExact.changed &&
      repairExact.patch.approvedHours === undefined &&
      repairExact.patch.approvedHourlyWage === 25 &&
      repairExact.patch.approvedLaborCost === 25,
  );
  const keepExisting = missingApprovalSnapshotPatch({
    startedAt: civil("2026-09-19", "09:00"),
    endedAt: civil("2026-09-19", "10:00"),
    activityType: "JOB",
    approvedHours: 1,
    approvedHourlyWage: 25,
    approvedLaborCost: 25,
    hourlyWage: 40,
  });
  check(
    "Existing $25 snapshot is not overwritten by a later $40 wage",
    !keepExisting.changed && keepExisting.wage === 25 && keepExisting.cost === 25,
  );
  const noWageRepair = missingApprovalSnapshotPatch({
    startedAt: civil("2026-09-19", "09:00"),
    endedAt: civil("2026-09-19", "10:00"),
    activityType: "JOB",
    approvedHours: 1,
    approvedHourlyWage: null,
    approvedLaborCost: null,
    hourlyWage: null,
  });
  check(
    "Re-approval without a membership wage leaves snapshot missing",
    !noWageRepair.changed && noWageRepair.wage == null && noWageRepair.cost == null,
  );
  check(
    "Empty wage form is not a stored $25 (placeholder is not submitted)",
    parseHourlyWage("")?.error === "Enter a valid hourly wage." && parseHourlyWage("25.00") === 25,
  );
  const wageUiSrc = readFileSync(new URL("../src/components/time-cards/time-cards-workspace.tsx", import.meta.url), "utf8");
  const wagePageSrc = readFileSync(new URL("../src/app/(app)/time-cards/page.tsx", import.meta.url), "utf8");
  check(
    "Time Cards wage input does not use placeholder 25.00 as a fake stored wage",
    !wageUiSrc.includes('placeholder="25.00"') &&
      wageUiSrc.includes("{worker.hourlyWageLabel ?? \"No wage on file\"}") &&
      wagePageSrc.includes("membership.hourlyWage") &&
      wagePageSrc.includes("hourlyWageInput"),
  );
  check(
    "ISO date + local 17:00 is not used for form format (would be 32h in US timezones)",
    formatDateInput(nineToFive.endedAt, NY) === "2026-08-24" && formatTimeInput(nineToFive.endedAt, NY) === "17:00",
  );
  const danielHours = hoursBetween(civil("2026-08-24", "09:00"), civil("2026-08-24", "17:00"));
  const peterHours = hoursBetween(civil("2026-08-24", "09:00"), civil("2026-08-24", "17:00"));
  check("Two 8-hour workers = 16 total hours", danielHours + peterHours === 16);
  check("Labor cost is hours × wage", estimateLaborCost(4, 25) === 100);
  check("Labor cost is null without wage", estimateLaborCost(4, null) === null);
  check("Approved entries cannot be edited", canEditTimeEntry("APPROVED") === false);
  check("Ready entries can be edited", canEditTimeEntry("READY") === true);
  check(
    "Running week cannot be approved",
    canApproveWeek([{ status: "RUNNING", startedAt: civil("2026-08-24", "09:00"), endedAt: null }], NY).ok === false,
  );
  check("Duration clock formats 2.5h as 2:30", formatDurationClock(2.5) === "2:30");
  check("OWNER/ADMIN have MANAGE_TIME_CARDS", roleHasCapability("OWNER", CAPABILITIES.MANAGE_TIME_CARDS) && roleHasCapability("ADMIN", CAPABILITIES.MANAGE_TIME_CARDS));
  check("MEMBER does not have MANAGE_TIME_CARDS", !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_TIME_CARDS));
  check("All five activity types exist", TIME_ACTIVITY_TYPES.length === 5);
  const timeCardOpsSrc = readFileSync(new URL("../src/lib/time-card-ops.ts", import.meta.url), "utf8");
  const completeInvoiceSrc = readFileSync(new URL("../src/lib/complete-job-invoice.ts", import.meta.url), "utf8");
  const markJobSrc = readFileSync(new URL("../src/app/actions/job.ts", import.meta.url), "utf8");
  check(
    "Canonical closeRunningJobTimeForCompletion locks the tenant-owned Job row",
    timeCardOpsSrc.includes("export async function closeRunningJobTimeForCompletion") &&
      timeCardOpsSrc.includes("FOR UPDATE") &&
      timeCardOpsSrc.includes('activityType: "JOB"') &&
      timeCardOpsSrc.includes("JOB_COMPLETION_TIME_CLOSED_REASON"),
  );
  check(
    "Canonical stopRunningAssignedJobTime locks the tenant-owned Job and does not complete it",
    timeCardOpsSrc.includes("export async function stopRunningAssignedJobTime") &&
      timeCardOpsSrc.includes("stopRunningAssignedJobTimeInTransaction") &&
      timeCardOpsSrc.includes("JOB_STOP_TIME_CLOSED_REASON") &&
      timeCardOpsSrc.includes("alreadyStopped") &&
      !/stopRunningAssignedJobTime[\s\S]*status: lifecycle.nextStatus/.test(timeCardOpsSrc),
  );
  check(
    "clockInTime refuses JOB time on a persisted COMPLETED Job",
    timeCardOpsSrc.includes("COMPLETED_JOB_CLOCK_IN_ERROR") &&
      timeCardOpsSrc.includes('locked.status === "COMPLETED"'),
  );
  const clockInFnSrc = timeCardOpsSrc.slice(
    timeCardOpsSrc.indexOf("export async function clockInTime"),
    timeCardOpsSrc.indexOf("export async function clockOutTime"),
  );
  const clockOutFnSrc = timeCardOpsSrc.slice(
    timeCardOpsSrc.indexOf("export async function clockOutTime"),
    timeCardOpsSrc.indexOf("export async function createManualTimeEntry") !== -1
      ? timeCardOpsSrc.indexOf("export async function createManualTimeEntry")
      : timeCardOpsSrc.length,
  );
  const completeInTxSrc = timeCardOpsSrc.slice(
    timeCardOpsSrc.indexOf("export async function completeJobWithRunningTimeSafetyInTransaction"),
    timeCardOpsSrc.indexOf("export async function completeJobWithRunningTimeSafety("),
  );
  check(
    "Clock and completion writes recheck exact active membership in the write transaction",
    clockInFnSrc.includes("afterInitialRead") &&
      clockInFnSrc.includes("exactActiveMembershipHeld") &&
      clockOutFnSrc.includes("afterInitialRead") &&
      clockOutFnSrc.includes("exactActiveMembershipHeld") &&
      completeInTxSrc.includes("exactActiveMembershipHeld") &&
      completeInTxSrc.indexOf("lockTenantOwnedJob") <
        completeInTxSrc.indexOf("exactActiveMembershipHeld"),
  );
  check(
    "Clock-in transition checks every running entry's week before the automatic close",
    timeCardOpsSrc.includes("assertRunningEntriesEditable") &&
      /await assertRunningEntriesEditable[\s\S]*for \(const current of running\)/.test(
        timeCardOpsSrc.slice(timeCardOpsSrc.indexOf("export async function clockInTime")),
      ) &&
      /await assertRunningEntriesEditable[\s\S]*for \(const current of running\)/.test(
        timeCardOpsSrc.slice(
          timeCardOpsSrc.indexOf("async function ensureRunningAssignedActivityTimeInTransaction"),
        ),
      ),
  );
  check(
    "Owner completion uses the shared time-safety helper and passes the actor membership",
    completeInvoiceSrc.includes("completeJobWithRunningTimeSafety") &&
      /actorMembershipId:\s*access\.workspace\.membership\.id/.test(markJobSrc),
  );
  const timeCardsLibSrc = readFileSync(new URL("../src/lib/time-cards.ts", import.meta.url), "utf8");
  const timeCardActionSrc = readFileSync(new URL("../src/app/actions/time-cards.ts", import.meta.url), "utf8");
  const fieldPageSrc = readFileSync(new URL("../src/app/field/page.tsx", import.meta.url), "utf8");
  function actionResolvesZoneBeforeParse(src, fnName) {
    const slice = src.slice(src.indexOf(`export async function ${fnName}`));
    const zoneAt = slice.indexOf("resolveBusinessTimeZone");
    const parseAt = slice.indexOf("parseBusinessDateTimeInput");
    return zoneAt >= 0 && parseAt >= 0 && zoneAt < parseAt;
  }
  check(
    "parseDateTimeInput converts through zonedCivilToUtc and rejects DST gaps",
    timeCardsLibSrc.includes("zonedCivilToUtc") &&
      timeCardsLibSrc.includes("zonedDateParts") &&
      timeCardsLibSrc.includes("NONEXISTENT_CIVIL_TIME_ERROR") &&
      !/new Date\(Date\.UTC\(year, month - 1, day, hour/.test(timeCardsLibSrc),
  );
  check(
    "Manual/correction/request actions resolve Business timezone before parsing civil input",
    actionResolvesZoneBeforeParse(timeCardActionSrc, "createManualTimeEntryAction") &&
      actionResolvesZoneBeforeParse(timeCardActionSrc, "correctTimeEntryAction") &&
      actionResolvesZoneBeforeParse(timeCardActionSrc, "requestTimeCorrectionAction"),
  );
  check(
    "Editable values round-trip through the same business timezone",
    wagePageSrc.includes("toEntryDateInput(entry.startedAt, timeZone)") &&
      wagePageSrc.includes("toEntryTimeInput(entry.startedAt, timeZone)") &&
      fieldPageSrc.includes("formatDateInput(entry.startedAt, timeZone)") &&
      fieldPageSrc.includes("formatTimeInput(entry.startedAt, timeZone)"),
  );
  check(
    "P1-08 approve path rejects boundary-crossing entries using Business timezone",
    WEEK_BOUNDARY_CROSSING_POLICY === "reject" &&
      timeCardOpsSrc.includes("canApproveWeek(entries, timeZone") &&
      timeCardOpsSrc.includes("alreadyApprovedWeekStarts") &&
      timeCardOpsSrc.includes("accessTimeZone(access, input.timeZone)") &&
      !timeCardOpsSrc.includes("split") &&
      !/hoursBetween\([\s\S]*weekStart/.test(
        timeCardOpsSrc.slice(timeCardOpsSrc.indexOf("export async function approveTimesheetWeek")),
      ),
  );
  check(
    "Write paths assert every business-local week touched by an interval",
    timeCardOpsSrc.includes("businessWeekStartsTouchedByEntry") &&
      timeCardOpsSrc.includes("collectTouchedWeekStarts") &&
      timeCardOpsSrc.includes("assertIntervalWeeksEditable") &&
      /async function assertCorrectionWeeksEditable[\s\S]*collectTouchedWeekStarts/.test(timeCardOpsSrc) &&
      /export async function createManualTimeEntry[\s\S]*assertIntervalWeeksEditable/.test(timeCardOpsSrc) &&
      /export async function correctTimeEntry[\s\S]*assertCorrectionWeeksEditable/.test(timeCardOpsSrc) &&
      /export async function clockOutTime[\s\S]*assertIntervalWeeksEditable/.test(timeCardOpsSrc) &&
      /export async function requestTimeCorrection[\s\S]*assertCorrectionWeeksEditable/.test(timeCardOpsSrc) &&
      /export async function decideTimeCorrectionRequest[\s\S]*assertCorrectionWeeksEditable/.test(timeCardOpsSrc) &&
      /async function closeLockedJobRunningTime[\s\S]*assertIntervalWeeksEditable/.test(timeCardOpsSrc) &&
      /async function ensureRunningAssignedActivityTimeInTransaction[\s\S]*assertIntervalWeeksEditable/.test(
        timeCardOpsSrc,
      ),
  );
  check(
    "Correction and request actions keep an existing instant when civil fields are unchanged",
    /export async function correctTimeEntryAction[\s\S]*parseBusinessDateTimeInput\([\s\S]*existing\?\.startedAt/.test(
      timeCardActionSrc,
    ) &&
      /export async function requestTimeCorrectionAction[\s\S]*parseBusinessDateTimeInput\([\s\S]*existing\?\.startedAt/.test(
        timeCardActionSrc,
      ),
  );

  const businessA = await prisma.business.create({
    data: { name: "Alpha Time", slug: "alpha-time-cards", tradeCode: "HANDYMAN", timezone: NY },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Time", slug: "beta-time-cards", tradeCode: "HANDYMAN", timezone: NY },
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
  const betaOwnerMem = await prisma.membership.create({
    data: { userId: betaOwner.id, businessId: businessB.id, role: "OWNER", hourlyWage: new Prisma.Decimal(40) },
  });
  const betaMemberMem = await prisma.membership.create({
    data: { userId: betaMember.id, businessId: businessB.id, role: "MEMBER" },
  });

  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const helperA = makeAccess(businessA.id, "MEMBER", helperMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaOwnerMem.id);
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

  console.log("\nTEST — Self-assigned OWNER/ADMIN can use the existing Field clock");
  const ownerJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "SCHEDULED",
      projectToken: randomUUID(),
      assignedMembershipId: ownerMem.id,
    },
  });
  const ownerSelfClock = await clockInTime(prisma, ownerA, {
    membershipId: ownerMem.id,
    activityType: "JOB",
    jobId: ownerJob.id,
  });
  check(
    "OWNER can clock JOB on a self-assigned job",
    ownerSelfClock.status === "RUNNING" &&
      ownerSelfClock.jobId === ownerJob.id &&
      ownerSelfClock.membershipId === ownerMem.id,
  );
  const ownerRunning = await prisma.timeEntry.findMany({
    where: { businessId: businessA.id, membershipId: ownerMem.id, status: "RUNNING" },
  });
  check("OWNER has exactly one RUNNING TimeEntry on their own membership", ownerRunning.length === 1);
  const ownerOut = await clockOutTime(prisma, ownerA, { membershipId: ownerMem.id });
  check("OWNER can clock out of that self-assigned job", ownerOut.status === "READY" && ownerOut.endedAt != null);
  const ownerRunningAfter = await prisma.timeEntry.count({
    where: { businessId: businessA.id, membershipId: ownerMem.id, status: "RUNNING" },
  });
  check("OWNER has no parallel clock after clock-out", ownerRunningAfter === 0);
  const ownerClockLeak = await prisma.timeEntry.findFirst({
    where: { id: ownerSelfClock.id, businessId: businessB.id },
  });
  check("OWNER self-clock does not leak to the foreign tenant", ownerClockLeak === null);

  const adminJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "SCHEDULED",
      projectToken: randomUUID(),
      assignedMembershipId: adminMem.id,
    },
  });
  const adminSelfClock = await clockInTime(prisma, adminA, {
    membershipId: adminMem.id,
    activityType: "JOB",
    jobId: adminJob.id,
  });
  check(
    "ADMIN can clock JOB on a self-assigned job",
    adminSelfClock.status === "RUNNING" &&
      adminSelfClock.membershipId === adminMem.id &&
      adminSelfClock.jobId === adminJob.id,
  );
  await clockOutTime(prisma, adminA, { membershipId: adminMem.id });

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
  const dayShiftStart = civil("2026-08-17", "09:00");
  const dayShiftEnd = civil("2026-08-17", "17:00");
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
  check("Stored Daniel start/end stay 13:00Z–21:00Z for 09:00–17:00 America/New_York", danielStored.startedAt.toISOString() === "2026-08-17T13:00:00.000Z" && danielStored.endedAt.toISOString() === "2026-08-17T21:00:00.000Z");
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
    parseDateTimeInput(formatDateInput(danielStored.startedAt, NY), formatTimeInput(danielStored.startedAt, NY), NY),
    parseDateTimeInput(formatDateInput(danielStored.endedAt, NY), formatTimeInput(danielStored.endedAt, NY), NY),
  );
  check("Correction form round-trip stays 8 hours", danielRoundTrip === 8);
  check(
    "Persisted Daniel UTC instant is 13:00Z–21:00Z, not UTC wall-clock 09:00Z–17:00Z",
    danielStored.startedAt.toISOString() === "2026-08-17T13:00:00.000Z" &&
      peterStored.startedAt.toISOString() === "2026-08-17T13:00:00.000Z",
  );

  console.log("\nTEST — P1-07 manual entry, correction, week class, DST gap");
  const tzUser = await prisma.user.create({
    data: { name: "Tess Timezone", email: "tz-time@example.com", passwordHash: "x" },
  });
  const tzMem = await prisma.membership.create({
    data: { userId: tzUser.id, businessId: businessA.id, role: "MEMBER", hourlyWage: new Prisma.Decimal(20) },
  });
  const tzJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "SCHEDULED",
      projectToken: randomUUID(),
      assignedMembershipId: tzMem.id,
    },
  });
  const tzManual = await createManualTimeEntry(prisma, ownerA, {
    membershipId: tzMem.id,
    activityType: "JOB",
    jobId: tzJob.id,
    startedAt: civil("2026-09-20", "01:00"),
    endedAt: civil("2026-09-20", "05:00"),
    note: "Early Sunday NY",
    timeZone: NY,
  });
  const tzStored = await prisma.timeEntry.findUnique({ where: { id: tzManual.id } });
  check(
    "Manual early-Sunday 01:00–05:00 America/New_York persists 05:00Z–09:00Z",
    tzStored.startedAt.toISOString() === "2026-09-20T05:00:00.000Z" &&
      tzStored.endedAt.toISOString() === "2026-09-20T09:00:00.000Z",
  );
  check(
    "Persisted early Sunday belongs to the Sep 20 business week",
    weekRange(tzStored.startedAt, NY).start.toISOString() === "2026-09-20T04:00:00.000Z",
  );
  check(
    "Edit fields round-trip the persisted Sunday instant back to 01:00",
    formatDateInput(tzStored.startedAt, NY) === "2026-09-20" &&
      formatTimeInput(tzStored.startedAt, NY) === "01:00" &&
      parseDateTimeInput(formatDateInput(tzStored.startedAt, NY), formatTimeInput(tzStored.startedAt, NY), NY)
        ?.toISOString() === tzStored.startedAt.toISOString(),
  );
  const tzCorrected = await correctTimeEntry(prisma, ownerA, {
    timeEntryId: tzManual.id,
    startedAt: civil("2026-09-20", "02:00"),
    endedAt: civil("2026-09-20", "06:00"),
    reason: "Corrected to 02:00–06:00 NY",
    timeZone: NY,
  });
  const tzCorrectedStored = await prisma.timeEntry.findUnique({ where: { id: tzCorrected.id } });
  check(
    "Correction 02:00–06:00 America/New_York persists 06:00Z–10:00Z",
    tzCorrectedStored.startedAt.toISOString() === "2026-09-20T06:00:00.000Z" &&
      tzCorrectedStored.endedAt.toISOString() === "2026-09-20T10:00:00.000Z" &&
      hoursBetween(tzCorrectedStored.startedAt, tzCorrectedStored.endedAt) === 4,
  );
  check(
    "Correction edit round-trip stays 02:00–06:00 America/New_York",
    formatDateInput(tzCorrectedStored.startedAt, NY) === "2026-09-20" &&
      formatTimeInput(tzCorrectedStored.startedAt, NY) === "02:00" &&
      formatDateInput(tzCorrectedStored.endedAt, NY) === "2026-09-20" &&
      formatTimeInput(tzCorrectedStored.endedAt, NY) === "06:00",
  );
  const dstReject = parseBusinessDateTimeInput("2026-03-08", "02:30", NY);
  check(
    "Manual/correction civil parser rejects the America/New_York DST gap",
    !dstReject.ok && dstReject.error === NONEXISTENT_CIVIL_TIME_ERROR && civil("2026-03-08", "02:30") === null,
  );

  console.log("\nTEST — P1-08 reject boundary-crossing approval (policy B)");
  const crossUser = await prisma.user.create({
    data: { name: "Casey Cross", email: "cross-time@example.com", passwordHash: "x" },
  });
  const sameWeekUser = await prisma.user.create({
    data: { name: "Sam Sameweek", email: "sameweek-time@example.com", passwordHash: "x" },
  });
  const histUser = await prisma.user.create({
    data: { name: "Holly History", email: "hist-time@example.com", passwordHash: "x" },
  });
  const crossMem = await prisma.membership.create({
    data: { userId: crossUser.id, businessId: businessA.id, role: "MEMBER", hourlyWage: new Prisma.Decimal(25) },
  });
  const sameWeekMem = await prisma.membership.create({
    data: { userId: sameWeekUser.id, businessId: businessA.id, role: "MEMBER", hourlyWage: new Prisma.Decimal(20) },
  });
  const histMem = await prisma.membership.create({
    data: { userId: histUser.id, businessId: businessA.id, role: "MEMBER", hourlyWage: new Prisma.Decimal(25) },
  });
  const crossJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "SCHEDULED",
      projectToken: randomUUID(),
      assignedMembershipId: crossMem.id,
    },
  });
  const sameWeekJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "SCHEDULED",
      projectToken: randomUUID(),
      assignedMembershipId: sameWeekMem.id,
    },
  });
  const histJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "SCHEDULED",
      projectToken: randomUUID(),
      assignedMembershipId: histMem.id,
    },
  });
  const crossEntry = await createManualTimeEntry(prisma, ownerA, {
    membershipId: crossMem.id,
    activityType: "JOB",
    jobId: crossJob.id,
    startedAt: civil("2026-09-19", "22:00"),
    endedAt: civil("2026-09-20", "02:00"),
    note: "Overnight across the Sunday week boundary",
    timeZone: NY,
  });
  const sameWeekEntry = await createManualTimeEntry(prisma, ownerA, {
    membershipId: sameWeekMem.id,
    activityType: "JOB",
    jobId: sameWeekJob.id,
    startedAt: civil("2026-09-19", "09:00"),
    endedAt: civil("2026-09-19", "17:00"),
    note: "Same-week Saturday shift",
    timeZone: NY,
  });
  const histEntry = await createManualTimeEntry(prisma, ownerA, {
    membershipId: histMem.id,
    activityType: "JOB",
    jobId: histJob.id,
    startedAt: civil("2026-09-19", "22:00"),
    endedAt: civil("2026-09-20", "02:00"),
    note: "Historical approved crossing",
    timeZone: NY,
  });
  await prisma.timeEntry.update({
    where: { id: histEntry.id },
    data: {
      status: "APPROVED",
      approvedHours: new Prisma.Decimal(4),
      approvedHourlyWage: new Prisma.Decimal(25),
      approvedLaborCost: new Prisma.Decimal(100),
    },
  });
  const crossStored = await prisma.timeEntry.findUnique({ where: { id: crossEntry.id } });
  const priorWeek = weekRange(civil("2026-09-19", "12:00"), NY);
  const nextWeek = weekRange(civil("2026-09-20", "12:00"), NY);
  check(
    "Boundary-crossing entry persists Sat 22:00–Sun 02:00 America/New_York (02:00Z–06:00Z)",
    crossStored.startedAt.toISOString() === "2026-09-20T02:00:00.000Z" &&
      crossStored.endedAt.toISOString() === "2026-09-20T06:00:00.000Z" &&
      hoursBetween(crossStored.startedAt, crossStored.endedAt) === 4 &&
      entryCrossesBusinessWeekBoundary(crossStored, NY),
  );
  await expectError(
    "Approval of the Saturday week is refused while the crossing entry remains",
    () => approveTimesheetWeek(prisma, ownerA, {
      membershipId: crossMem.id,
      weekStartedAt: priorWeek.start,
      timeZone: NY,
    }),
    (error) => error instanceof TimeCardError && error.message === WEEK_BOUNDARY_CROSSING_ERROR,
  );
  await expectError(
    "Approval of the Sunday week is refused while the crossing entry remains",
    () => approveTimesheetWeek(prisma, ownerA, {
      membershipId: crossMem.id,
      weekStartedAt: nextWeek.start,
      timeZone: NY,
    }),
    (error) => error instanceof TimeCardError && error.message === WEEK_BOUNDARY_CROSSING_ERROR,
  );
  const stillCrossing = await prisma.timeEntry.findUnique({ where: { id: crossEntry.id } });
  check(
    "Refused approval does not split, truncate, or approve the crossing entry",
    stillCrossing.status === "READY" &&
      stillCrossing.startedAt.toISOString() === "2026-09-20T02:00:00.000Z" &&
      stillCrossing.endedAt.toISOString() === "2026-09-20T06:00:00.000Z" &&
      stillCrossing.approvedHours == null &&
      hoursBetween(stillCrossing.startedAt, stillCrossing.endedAt) === 4,
  );
  const sameWeekApproved = await approveTimesheetWeek(prisma, ownerA, {
    membershipId: sameWeekMem.id,
    weekStartedAt: priorWeek.start,
    timeZone: NY,
  });
  check(
    "Normal same-week Saturday 09:00–17:00 still approves as 8 hours",
    sameWeekApproved.status === "APPROVED" && Number(sameWeekApproved.approvedHours) === 8,
  );
  const histApproved = await approveTimesheetWeek(prisma, ownerA, {
    membershipId: histMem.id,
    weekStartedAt: priorWeek.start,
    timeZone: NY,
  });
  const histAfter = await prisma.timeEntry.findUnique({ where: { id: histEntry.id } });
  check(
    "Already-approved historical crossing record is not rewritten",
    histApproved.status === "APPROVED" &&
      histAfter.status === "APPROVED" &&
      Number(histAfter.approvedHours) === 4 &&
      Number(histAfter.approvedLaborCost) === 100 &&
      histAfter.startedAt.toISOString() === "2026-09-20T02:00:00.000Z" &&
      histAfter.endedAt.toISOString() === "2026-09-20T06:00:00.000Z",
  );
  const histSunday = await createManualTimeEntry(prisma, ownerA, {
    membershipId: histMem.id,
    activityType: "JOB",
    jobId: histJob.id,
    startedAt: civil("2026-09-20", "09:00"),
    endedAt: civil("2026-09-20", "17:00"),
    note: "Sunday-only after historical crossing",
    timeZone: NY,
  });
  const histWeekABeforeB = await prisma.timesheetWeek.findUnique({
    where: {
      businessId_membershipId_weekStartedAt: {
        businessId: businessA.id,
        membershipId: histMem.id,
        weekStartedAt: priorWeek.start,
      },
    },
  });
  const histEntryCountBeforeB = await prisma.timeEntry.count({ where: { membershipId: histMem.id } });
  await expectError(
    "Historical APPROVED crossing credited in week A cannot be credited again in week B",
    () => approveTimesheetWeek(prisma, ownerA, {
      membershipId: histMem.id,
      weekStartedAt: nextWeek.start,
      timeZone: NY,
    }),
    (error) => error instanceof TimeCardError && error.message === ALREADY_CREDITED_CROSSING_ERROR,
  );
  const histWeekAAfterB = await prisma.timesheetWeek.findUnique({
    where: {
      businessId_membershipId_weekStartedAt: {
        businessId: businessA.id,
        membershipId: histMem.id,
        weekStartedAt: priorWeek.start,
      },
    },
  });
  const histWeekBAfter = await prisma.timesheetWeek.findUnique({
    where: {
      businessId_membershipId_weekStartedAt: {
        businessId: businessA.id,
        membershipId: histMem.id,
        weekStartedAt: nextWeek.start,
      },
    },
  });
  const histAfterWeekB = await prisma.timeEntry.findUnique({ where: { id: histEntry.id } });
  const histSundayAfter = await prisma.timeEntry.findUnique({ where: { id: histSunday.id } });
  check(
    "Refused week B approval leaves week A hours/cost and the historical crossing unchanged",
    Number(histWeekABeforeB.approvedHours) === 4 &&
      Number(histWeekABeforeB.approvedLaborCost) === 100 &&
      Number(histWeekAAfterB.approvedHours) === Number(histWeekABeforeB.approvedHours) &&
      Number(histWeekAAfterB.approvedLaborCost) === Number(histWeekABeforeB.approvedLaborCost) &&
      histWeekAAfterB.status === "APPROVED" &&
      (histWeekBAfter == null || histWeekBAfter.status !== "APPROVED") &&
      histAfterWeekB.status === "APPROVED" &&
      Number(histAfterWeekB.approvedHours) === 4 &&
      Number(histAfterWeekB.approvedLaborCost) === 100 &&
      histAfterWeekB.startedAt.toISOString() === "2026-09-20T02:00:00.000Z" &&
      histAfterWeekB.endedAt.toISOString() === "2026-09-20T06:00:00.000Z" &&
      histSundayAfter.status === "READY" &&
      histSundayAfter.approvedHours == null &&
      (await prisma.timeEntry.count({ where: { membershipId: histMem.id } })) === histEntryCountBeforeB,
  );
  const saturdayOnly = await correctTimeEntry(prisma, ownerA, {
    timeEntryId: crossEntry.id,
    startedAt: civil("2026-09-19", "22:00"),
    endedAt: civil("2026-09-20", "00:00"),
    reason: "Keep Saturday hours in the first business week",
    timeZone: NY,
  });
  const sundayOnly = await createManualTimeEntry(prisma, ownerA, {
    membershipId: crossMem.id,
    activityType: "JOB",
    jobId: crossJob.id,
    startedAt: civil("2026-09-20", "00:00"),
    endedAt: civil("2026-09-20", "02:00"),
    note: "Sunday hours after the week boundary",
    timeZone: NY,
  });
  check(
    "Correction yields two valid one-week entries that touch at Sunday 00:00",
    saturdayOnly.endedAt.toISOString() === "2026-09-20T04:00:00.000Z" &&
      sundayOnly.startedAt.toISOString() === "2026-09-20T04:00:00.000Z" &&
      hoursBetween(saturdayOnly.startedAt, saturdayOnly.endedAt) === 2 &&
      hoursBetween(sundayOnly.startedAt, sundayOnly.endedAt) === 2 &&
      entryCrossesBusinessWeekBoundary(saturdayOnly, NY) === false &&
      entryCrossesBusinessWeekBoundary(sundayOnly, NY) === false &&
      !intervalsOverlap(saturdayOnly, sundayOnly),
  );
  const weekAApproved = await approveTimesheetWeek(prisma, ownerA, {
    membershipId: crossMem.id,
    weekStartedAt: priorWeek.start,
    timeZone: NY,
  });
  const weekBApproved = await approveTimesheetWeek(prisma, ownerA, {
    membershipId: crossMem.id,
    weekStartedAt: nextWeek.start,
    timeZone: NY,
  });
  const saturdayApproved = await prisma.timeEntry.findUnique({ where: { id: saturdayOnly.id } });
  const sundayApproved = await prisma.timeEntry.findUnique({ where: { id: sundayOnly.id } });
  check(
    "After correction, each business-local week approves its own 2 hours",
    Number(weekAApproved.approvedHours) === 2 &&
      Number(weekBApproved.approvedHours) === 2 &&
      saturdayApproved.status === "APPROVED" &&
      sundayApproved.status === "APPROVED" &&
      Number(saturdayApproved.approvedHours) === 2 &&
      Number(sundayApproved.approvedHours) === 2,
  );
  check(
    "Combined credited hours equal the original 4 worked hours exactly once",
    Number(weekAApproved.approvedHours) + Number(weekBApproved.approvedHours) === 4 &&
      Number(saturdayApproved.approvedHours) + Number(sundayApproved.approvedHours) ===
        hoursBetween(civil("2026-09-19", "22:00"), civil("2026-09-20", "02:00")),
  );

  console.log("\nTEST — P1-08 intermediate approved week blocks A→C writes");
  const spanStart = civil("2026-09-12", "10:00");
  const spanEnd = civil("2026-09-21", "10:00");
  const weekAStart = weekRange(spanStart, NY).start;
  const weekBStart = weekRange(civil("2026-09-19", "12:00"), NY).start;
  const weekCStart = weekRange(spanEnd, NY).start;
  check(
    "A→C fixture touches three Sunday weeks with B in the middle",
    businessWeekStartsTouchedByEntry({ startedAt: spanStart, endedAt: spanEnd }, NY)
      .map((start) => start.toISOString())
      .join(",") === [weekAStart, weekBStart, weekCStart].map((start) => start.toISOString()).join(",") &&
      weekAStart.toISOString() === "2026-09-06T04:00:00.000Z" &&
      weekBStart.toISOString() === "2026-09-13T04:00:00.000Z" &&
      weekCStart.toISOString() === "2026-09-20T04:00:00.000Z",
  );
  const spanUser = await prisma.user.create({
    data: { name: "Ava Arc", email: "span-time@example.com", passwordHash: "x" },
  });
  const spanMem = await prisma.membership.create({
    data: { userId: spanUser.id, businessId: businessA.id, role: "MEMBER", hourlyWage: new Prisma.Decimal(22) },
  });
  const spanAccess = makeAccess(businessA.id, "MEMBER", spanMem.id);
  async function spanJob() {
    return prisma.job.create({
      data: {
        businessId: businessA.id,
        customerId: customerA.id,
        status: "IN_PROGRESS",
        projectToken: randomUUID(),
        assignedMembershipId: spanMem.id,
      },
    });
  }
  const spanManualJob = await spanJob();
  const spanCorrectJob = await spanJob();
  const spanRequestJob = await spanJob();
  const spanDecideJob = await spanJob();
  const spanClockJob = await spanJob();
  const spanCompleteJob = await spanJob();
  const spanStartJob = await spanJob();
  const spanTravelJob = await spanJob();
  const spanStopJob = await spanJob();
  const spanStopTravelJob = await spanJob();
  const weekAOnlyCorrect = await createManualTimeEntry(prisma, ownerA, {
    membershipId: spanMem.id,
    activityType: "JOB",
    jobId: spanCorrectJob.id,
    startedAt: civil("2026-09-11", "09:00"),
    endedAt: civil("2026-09-11", "11:00"),
    note: "Week A only before spanning correction",
    timeZone: NY,
  });
  const weekAOnlyRequest = await createManualTimeEntry(prisma, ownerA, {
    membershipId: spanMem.id,
    activityType: "JOB",
    jobId: spanRequestJob.id,
    startedAt: civil("2026-09-11", "12:00"),
    endedAt: civil("2026-09-11", "14:00"),
    note: "Week A only before spanning request",
    timeZone: NY,
  });
  const weekAOnlyDecide = await createManualTimeEntry(prisma, ownerA, {
    membershipId: spanMem.id,
    activityType: "JOB",
    jobId: spanDecideJob.id,
    startedAt: civil("2026-09-11", "15:00"),
    endedAt: civil("2026-09-11", "17:00"),
    note: "Week A only before spanning accept",
    timeZone: NY,
  });
  const pendingSpanRequestRow = await prisma.timeCorrectionRequest.create({
    data: {
      businessId: businessA.id,
      timeEntryId: weekAOnlyDecide.id,
      requestedByMembershipId: spanMem.id,
      status: "PENDING",
      reason: "Move the end into week C",
      originalStartedAt: weekAOnlyDecide.startedAt,
      originalEndedAt: weekAOnlyDecide.endedAt,
      proposedStartedAt: spanStart,
      proposedEndedAt: spanEnd,
    },
  });
  const pendingSpanRequest = { request: pendingSpanRequestRow };
  await prisma.timesheetWeek.create({
    data: {
      businessId: businessA.id,
      membershipId: spanMem.id,
      weekStartedAt: weekBStart,
      status: "APPROVED",
      approvedAt: new Date(),
      approvedByMembershipId: ownerMem.id,
      approvedHours: new Prisma.Decimal(0),
      approvedHourlyWage: new Prisma.Decimal(22),
      approvedLaborCost: new Prisma.Decimal(0),
    },
  });
  const approvedMiddleWeek = await prisma.timesheetWeek.findUnique({
    where: {
      businessId_membershipId_weekStartedAt: {
        businessId: businessA.id,
        membershipId: spanMem.id,
        weekStartedAt: weekBStart,
      },
    },
  });
  const spanEntryCountBefore = await prisma.timeEntry.count({ where: { membershipId: spanMem.id } });
  const spanRequestCountBefore = await prisma.timeCorrectionRequest.count({
    where: { requestedByMembershipId: spanMem.id },
  });
  const spanAdjustmentCountBefore = await prisma.timeEntryAdjustment.count({
    where: { timeEntry: { membershipId: spanMem.id } },
  });
  function unchangedSpanLedger() {
    return Promise.all([
      prisma.timeEntry.count({ where: { membershipId: spanMem.id } }),
      prisma.timeCorrectionRequest.count({ where: { requestedByMembershipId: spanMem.id } }),
      prisma.timeEntryAdjustment.count({ where: { timeEntry: { membershipId: spanMem.id } } }),
      prisma.timesheetWeek.findUnique({
        where: {
          businessId_membershipId_weekStartedAt: {
            businessId: businessA.id,
            membershipId: spanMem.id,
            weekStartedAt: weekBStart,
          },
        },
      }),
    ]);
  }
  async function expectUnchanged(label, before) {
    const [entries, requests, adjustments, week] = await unchangedSpanLedger();
    check(
      label,
      entries === before.entries &&
        requests === before.requests &&
        adjustments === before.adjustments &&
        week.status === "APPROVED" &&
        Number(week.approvedHours) === Number(before.week.approvedHours) &&
        Number(week.approvedLaborCost) === Number(before.week.approvedLaborCost),
    );
  }
  const spanLedgerBefore = {
    entries: spanEntryCountBefore,
    requests: spanRequestCountBefore,
    adjustments: spanAdjustmentCountBefore,
    week: approvedMiddleWeek,
  };
  await expectError(
    "Manual A→C entry is rejected when week B is approved",
    () => createManualTimeEntry(prisma, ownerA, {
      membershipId: spanMem.id,
      activityType: "JOB",
      jobId: spanManualJob.id,
      startedAt: spanStart,
      endedAt: spanEnd,
      note: "Would cross approved week B",
      timeZone: NY,
    }),
    (error) => error instanceof TimeCardError && /approved/i.test(error.message),
  );
  await expectUnchanged("Manual A→C refusal mutates nothing", spanLedgerBefore);
  const correctBefore = await prisma.timeEntry.findUnique({ where: { id: weekAOnlyCorrect.id } });
  await expectError(
    "Owner correction that spans A→C is rejected when week B is approved",
    () => correctTimeEntry(prisma, ownerA, {
      timeEntryId: weekAOnlyCorrect.id,
      startedAt: spanStart,
      endedAt: spanEnd,
      reason: "Would cross approved week B",
      timeZone: NY,
    }),
    (error) => error instanceof TimeCardError && /approved/i.test(error.message),
  );
  const correctAfter = await prisma.timeEntry.findUnique({ where: { id: weekAOnlyCorrect.id } });
  check(
    "Rejected spanning correction leaves the week A entry unchanged",
    correctAfter.startedAt.getTime() === correctBefore.startedAt.getTime() &&
      correctAfter.endedAt.getTime() === correctBefore.endedAt.getTime() &&
      correctAfter.status === correctBefore.status &&
      correctAfter.note === correctBefore.note,
  );
  await expectUnchanged("Correction A→C refusal mutates nothing", spanLedgerBefore);
  const requestBefore = await prisma.timeEntry.findUnique({ where: { id: weekAOnlyRequest.id } });
  await expectError(
    "Worker correction request that spans A→C is rejected when week B is approved",
    () => requestTimeCorrection(prisma, spanAccess, {
      timeEntryId: weekAOnlyRequest.id,
      reason: "Would cross approved week B",
      proposedStartedAt: civil("2026-09-12", "18:00"),
      proposedEndedAt: civil("2026-09-13", "10:00"),
      timeZone: NY,
    }),
    (error) => error instanceof TimeCardError && /approved/i.test(error.message),
  );
  const requestAfter = await prisma.timeEntry.findUnique({ where: { id: weekAOnlyRequest.id } });
  check(
    "Rejected spanning request leaves the original entry and request count unchanged",
    requestAfter.startedAt.getTime() === requestBefore.startedAt.getTime() &&
      requestAfter.endedAt.getTime() === requestBefore.endedAt.getTime() &&
      requestAfter.status === requestBefore.status,
  );
  await expectUnchanged("Correction-request A→C refusal mutates nothing", spanLedgerBefore);
  const decideEntryBefore = await prisma.timeEntry.findUnique({ where: { id: weekAOnlyDecide.id } });
  const decideRequestBefore = await prisma.timeCorrectionRequest.findUnique({
    where: { id: pendingSpanRequest.request.id },
  });
  await expectError(
    "Accepting an A→C correction is rejected when week B is approved",
    () => decideTimeCorrectionRequest(prisma, ownerA, {
      requestId: pendingSpanRequest.request.id,
      decision: "ACCEPTED",
      timeZone: NY,
    }),
    (error) => error instanceof TimeCardError && /approved/i.test(error.message),
  );
  const decideEntryAfter = await prisma.timeEntry.findUnique({ where: { id: weekAOnlyDecide.id } });
  const decideRequestAfter = await prisma.timeCorrectionRequest.findUnique({
    where: { id: pendingSpanRequest.request.id },
  });
  const decideDecisionAfter = await prisma.timeCorrectionDecision.findUnique({
    where: { requestId: pendingSpanRequest.request.id },
  });
  check(
    "Rejected spanning accept leaves the entry, pending request, and decision table unchanged",
    decideEntryAfter.startedAt.getTime() === decideEntryBefore.startedAt.getTime() &&
      decideEntryAfter.endedAt.getTime() === decideEntryBefore.endedAt.getTime() &&
      decideRequestAfter.status === "PENDING" &&
      decideRequestBefore.status === "PENDING" &&
      decideDecisionAfter == null,
  );
  await expectUnchanged("Decide/accept A→C refusal mutates nothing", spanLedgerBefore);

  async function insertRunning(jobId, activityType, startedAt) {
    return prisma.timeEntry.create({
      data: {
        businessId: businessA.id,
        membershipId: spanMem.id,
        jobId,
        activityType,
        status: "RUNNING",
        startedAt,
        endedAt: null,
        source: "CLOCK",
      },
    });
  }
  const clockRunning = await insertRunning(spanClockJob.id, "JOB", spanStart);
  await expectError(
    "Clock-out spanning A→C is rejected when week B is approved",
    () => clockOutTime(prisma, ownerA, {
      membershipId: spanMem.id,
      endedAt: spanEnd,
      timeZone: NY,
    }),
    (error) => error instanceof TimeCardError && /approved/i.test(error.message),
  );
  const clockRunningAfter = await prisma.timeEntry.findUnique({ where: { id: clockRunning.id } });
  check(
    "Rejected A→C clock-out leaves the running entry open",
    clockRunningAfter.status === "RUNNING" && clockRunningAfter.endedAt == null,
  );
  await expectError(
    "Clock-in that would close an A→C interval is rejected when week B is approved",
    () => clockInTime(prisma, ownerA, {
      membershipId: spanMem.id,
      activityType: "TRAVEL",
      startedAt: spanEnd,
      timeZone: NY,
    }),
    (error) => error instanceof TimeCardError && /approved/i.test(error.message),
  );
  const clockAfterIn = await prisma.timeEntry.findUnique({ where: { id: clockRunning.id } });
  check(
    "Rejected A→C clock-in leaves the long-running entry open and writes no new clock",
    clockAfterIn.status === "RUNNING" &&
      clockAfterIn.endedAt == null &&
      (await prisma.timeEntry.count({
        where: { membershipId: spanMem.id, startedAt: spanEnd },
      })) === 0,
  );
  const completeRunning = await insertRunning(spanCompleteJob.id, "JOB", spanStart);
  const completeResult = await completeJobWithRunningTimeSafety(prisma, {
    businessId: businessA.id,
    jobId: spanCompleteJob.id,
    actorMembershipId: ownerMem.id,
    endedAt: spanEnd,
    timeZone: NY,
  });
  const completeRunningAfter = await prisma.timeEntry.findUnique({ where: { id: completeRunning.id } });
  const completeJobAfter = await prisma.job.findUnique({ where: { id: spanCompleteJob.id } });
  check(
    "Job complete that would close A→C is rejected when week B is approved",
    completeResult.ok === false &&
      /approved/i.test(completeResult.error ?? "") &&
      completeRunningAfter.status === "RUNNING" &&
      completeRunningAfter.endedAt == null &&
      completeJobAfter.status === "IN_PROGRESS",
  );
  const startOtherJob = await spanJob();
  const startRunning = await insertRunning(startOtherJob.id, "JOB", spanStart);
  const startResult = await startJobWithRunningTimeSafety(prisma, {
    businessId: businessA.id,
    jobId: spanStartJob.id,
    actorMembershipId: spanMem.id,
    startedAt: spanEnd,
  });
  const startRunningAfter = await prisma.timeEntry.findUnique({ where: { id: startRunning.id } });
  check(
    "Job start that would close A→C is rejected when week B is approved",
    startResult.ok === false &&
      /approved/i.test(startResult.error ?? "") &&
      startRunningAfter.status === "RUNNING" &&
      startRunningAfter.endedAt == null,
  );
  const travelRunning = await insertRunning(spanTravelJob.id, "JOB", spanStart);
  const travelStart = await startAssignedActivityTime(prisma, {
    businessId: businessA.id,
    jobId: spanTravelJob.id,
    activityType: "TRAVEL",
    actorMembershipId: spanMem.id,
    startedAt: spanEnd,
  });
  const travelRunningAfter = await prisma.timeEntry.findUnique({ where: { id: travelRunning.id } });
  check(
    "Native travel start that would close A→C is rejected when week B is approved",
    travelStart.ok === false &&
      /approved/i.test(travelStart.error ?? "") &&
      travelRunningAfter.status === "RUNNING" &&
      travelRunningAfter.endedAt == null,
  );
  const stopRunning = await insertRunning(spanStopJob.id, "JOB", spanStart);
  const stopResult = await stopRunningAssignedJobTime(prisma, {
    businessId: businessA.id,
    jobId: spanStopJob.id,
    actorMembershipId: spanMem.id,
    endedAt: spanEnd,
  });
  const stopRunningAfter = await prisma.timeEntry.findUnique({ where: { id: stopRunning.id } });
  check(
    "Native job-stop that would close A→C is rejected when week B is approved",
    stopResult.ok === false &&
      /approved/i.test(stopResult.error ?? "") &&
      stopRunningAfter.status === "RUNNING" &&
      stopRunningAfter.endedAt == null,
  );
  const stopTravelRunning = await insertRunning(spanStopTravelJob.id, "TRAVEL", spanStart);
  const stopTravel = await stopAssignedActivityTime(prisma, {
    businessId: businessA.id,
    jobId: spanStopTravelJob.id,
    activityType: "TRAVEL",
    actorMembershipId: spanMem.id,
    endedAt: spanEnd,
  });
  const stopTravelAfter = await prisma.timeEntry.findUnique({ where: { id: stopTravelRunning.id } });
  check(
    "Native travel-stop that would close A→C is rejected when week B is approved",
    stopTravel.ok === false &&
      /approved/i.test(stopTravel.error ?? "") &&
      stopTravelAfter.status === "RUNNING" &&
      stopTravelAfter.endedAt == null,
  );

  const fallbackExisting = await createManualTimeEntry(prisma, ownerA, {
    membershipId: helperMem.id,
    activityType: "OTHER",
    startedAt: new Date("2026-11-01T06:30:00.000Z"),
    endedAt: new Date("2026-11-01T08:30:00.000Z"),
    note: "Second 01:30 fall-back occurrence",
    timeZone: NY,
  });
  const fallbackParsedStart = parseBusinessDateTimeInput(
    formatDateInput(fallbackExisting.startedAt, NY),
    formatTimeInput(fallbackExisting.startedAt, NY),
    NY,
    fallbackExisting.startedAt,
  );
  const fallbackParsedEnd = parseBusinessDateTimeInput(
    formatDateInput(fallbackExisting.endedAt, NY),
    formatTimeInput(fallbackExisting.endedAt, NY),
    NY,
    fallbackExisting.endedAt,
  );
  const fallbackCorrected = await correctTimeEntry(prisma, ownerA, {
    timeEntryId: fallbackExisting.id,
    startedAt: fallbackParsedStart.ok ? fallbackParsedStart.value : null,
    endedAt: fallbackParsedEnd.ok ? fallbackParsedEnd.value : null,
    reason: "Resubmit displayed fall-back civil times",
    timeZone: NY,
  });
  check(
    "Correcting with the displayed fall-back civil strings does not move the stored instant",
    fallbackCorrected.startedAt.toISOString() === "2026-11-01T06:30:00.000Z" &&
      fallbackCorrected.endedAt.toISOString() === "2026-11-01T08:30:00.000Z",
  );

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

  const helperOriginalStart = adminManual.startedAt;
  const helperOriginalEnd = adminManual.endedAt;
  const helperRequest = await requestTimeCorrection(prisma, helperA, {
    timeEntryId: adminManual.id,
    reason: "I took a longer drive",
    proposedStartedAt: hoursAgo(6.25),
    proposedEndedAt: hoursAgo(5.25),
    timeZone: "America/New_York",
  });
  const flagged = await prisma.timeEntry.findUnique({ where: { id: adminManual.id } });
  check(
    "MEMBER can request correction on own entry without rewriting it",
    helperRequest.request.status === "PENDING" &&
      flagged.status === adminManual.status &&
      flagged.startedAt.getTime() === helperOriginalStart.getTime() &&
      flagged.endedAt.getTime() === helperOriginalEnd.getTime() &&
      flagged.note === adminManual.note,
  );
  const memberOwned = await prisma.timeEntry.findFirst({
    where: { membershipId: memberMem.id, status: { not: "RUNNING" } },
  });
  await expectError(
    "MEMBER cannot request correction on another worker's entry",
    () => requestTimeCorrection(prisma, helperA, {
      timeEntryId: memberOwned.id,
      reason: "nope",
      proposedStartedAt: hoursAgo(4),
      proposedEndedAt: hoursAgo(3),
      timeZone: "America/New_York",
    }),
    (error) => error instanceof ForbiddenError,
  );
  check(
    "Approved week cannot be requested as a worker correction",
    canRequestTimeCorrection({ entryStatus: "APPROVED", endedAt: new Date(), weekStatus: "APPROVED" }).ok === false,
  );

  const helperSample = await prisma.timeEntry.findFirst({
    where: { membershipId: helperMem.id },
    orderBy: { startedAt: "asc" },
  });
  const weekStart = weekRange(helperSample?.startedAt ?? new Date(), NY).start;
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
  const paidHelper = approvedEntries.filter((entry) => isPaidActivity(entry.activityType));
  check(
    "Paid helper entries snapshot the live $20 wage onto hourly wage and labor cost",
    paidHelper.length > 0 &&
      paidHelper.every(
        (entry) =>
          Number(entry.approvedHourlyWage) === 20 &&
          entry.approvedLaborCost != null &&
          Number(entry.approvedLaborCost) === Number(entry.approvedHours) * 20,
      ),
  );

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
  const runningWeekStart = weekRange(current?.startedAt ?? new Date(), NY).start;
  await expectError(
    "Cannot approve a week while a clock is running",
    () => approveTimesheetWeek(prisma, ownerA, { membershipId: memberMem.id, weekStartedAt: runningWeekStart }),
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

  console.log("\nTEST — $25 wage snapshot, immutable history, job profitability");
  const handy = await prisma.business.create({
    data: { name: "Handy Handyman Services", slug: "handy-wage-snapshot", tradeCode: "HANDYMAN" },
  });
  const joeUser = await prisma.user.create({
    data: { name: "Joe LeBlanc", email: "joe-wage-snapshot@example.com", passwordHash: "x" },
  });
  const joeMem = await prisma.membership.create({
    data: {
      userId: joeUser.id,
      businessId: handy.id,
      role: "OWNER",
      hourlyWage: new Prisma.Decimal("25.00"),
    },
  });
  const joeAccess = makeAccess(handy.id, "OWNER", joeMem.id);
  const handyCustomer = await prisma.customer.create({
    data: { businessId: handy.id, name: "Test Homeowner" },
  });
  const handyJob = await prisma.job.create({
    data: {
      businessId: handy.id,
      customerId: handyCustomer.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  await prisma.invoice.create({
    data: {
      businessId: handy.id,
      customerId: handyCustomer.id,
      jobId: handyJob.id,
      status: "PAID",
      total: new Prisma.Decimal("125.00"),
      paidAt: new Date(),
      paymentMethod: "CASH",
    },
  });
  const hourStart = civil("2026-09-19", "09:00");
  const hourEnd = civil("2026-09-19", "10:00");
  check("Acceptance-test hour timestamps parsed", Boolean(hourStart && hourEnd));
  const joeEntry = await createManualTimeEntry(prisma, joeAccess, {
    membershipId: joeMem.id,
    activityType: "JOB",
    jobId: handyJob.id,
    startedAt: hourStart,
    endedAt: hourEnd,
    note: "Acceptance test hour",
  });
  const handyWeek = weekRange(hourStart, NY).start;
  await approveTimesheetWeek(prisma, joeAccess, {
    membershipId: joeMem.id,
    weekStartedAt: handyWeek,
  });
  const approvedJoe = await prisma.timeEntry.findUnique({ where: { id: joeEntry.id } });
  check(
    "Approved 1-hour entry snapshots $25/hour and $25 labor",
    approvedJoe?.status === "APPROVED" &&
      Number(approvedJoe.approvedHours) === 1 &&
      Number(approvedJoe.approvedHourlyWage) === 25 &&
      Number(approvedJoe.approvedLaborCost) === 25,
  );

  await updateMembershipWage(prisma, joeAccess, { membershipId: joeMem.id, hourlyWage: "40.00" });
  const afterWageChange = await prisma.timeEntry.findUnique({ where: { id: joeEntry.id } });
  const liveWage = await prisma.membership.findUnique({ where: { id: joeMem.id } });
  check("Live membership wage can change after approval", Number(liveWage.hourlyWage) === 40);
  check(
    "Approved wage snapshot stays $25 after a later wage change",
    Number(afterWageChange.approvedHourlyWage) === 25 &&
      Number(afterWageChange.approvedLaborCost) === 25,
  );
  await approveTimesheetWeek(prisma, joeAccess, {
    membershipId: joeMem.id,
    weekStartedAt: handyWeek,
  });
  const afterExplicitReapprove = await prisma.timeEntry.findUnique({ where: { id: joeEntry.id } });
  check(
    "Explicit re-approval does not overwrite an existing $25 snapshot",
    Number(afterExplicitReapprove.approvedHourlyWage) === 25 &&
      Number(afterExplicitReapprove.approvedLaborCost) === 25,
  );

  await createExpense(prisma, joeAccess, {
    occurredOn: "2026-09-19",
    description: "Test job materials",
    amount: "25.00",
    category: "MATERIALS",
    vendor: "Test Vendor",
    jobId: handyJob.id,
  });
  const handySource = await loadReportSource(prisma, handy.id);
  const handyReport = buildReport(handySource, resolveReportRange("all"));
  const profit = handyReport.jobProfitability.find((row) => row.jobId === handyJob.id);
  check("Job paid revenue is $125", profit?.paidRevenue === 125);
  check("Approved labor is $25, not incomplete", profit?.laborCost === 25 && profit?.laborCostIncomplete === false);
  check("Approved hours are 1:00", profit?.approvedHours === 1);
  check("Job expenses are $25", profit?.recordedJobExpense === 25);
  check("Recorded job margin is $125 − $25 − $25 = $75", profit?.recordedMargin === 75);
  check(
    "Needs attention does not claim a missing wage snapshot for Joe",
    !handyReport.attention.some((item) => item.detail.includes("no wage snapshot")),
  );

  const foreignSource = await loadReportSource(prisma, businessB.id);
  check(
    "Other tenant report source does not include Handy job labor",
    foreignSource.approvedTimeEntries.every((entry) => entry.id !== joeEntry.id) &&
      foreignSource.invoices.every((invoice) => invoice.jobId !== handyJob.id),
  );

  console.log("\nTEST — Explicit re-approval repairs already-APPROVED missing snapshots");
  const legacyStart = civil("2026-09-19", "13:00");
  const legacyEnd = civil("2026-09-19", "14:00");
  const legacyEntry = await prisma.timeEntry.create({
    data: {
      businessId: handy.id,
      membershipId: joeMem.id,
      jobId: handyJob.id,
      activityType: "JOB",
      status: "APPROVED",
      source: "MANUAL",
      startedAt: legacyStart,
      endedAt: legacyEnd,
      approvedHours: new Prisma.Decimal("1.0"),
      approvedHourlyWage: null,
      approvedLaborCost: null,
      note: "Pre-snapshot approved hour",
    },
  });
  await prisma.membership.update({
    where: { id: joeMem.id },
    data: { hourlyWage: new Prisma.Decimal("25.00") },
  });
  await approveTimesheetWeek(prisma, joeAccess, {
    membershipId: joeMem.id,
    weekStartedAt: handyWeek,
  });
  const repairedLegacy = await prisma.timeEntry.findUnique({ where: { id: legacyEntry.id } });
  check(
    "Already APPROVED entry + null wage/cost + $25 membership → explicit re-approval snapshots $25",
    repairedLegacy?.status === "APPROVED" &&
      Number(repairedLegacy.approvedHours) === 1 &&
      Number(repairedLegacy.approvedHourlyWage) === 25 &&
      Number(repairedLegacy.approvedLaborCost) === 25,
  );
  const originalJoeAfterRepair = await prisma.timeEntry.findUnique({ where: { id: joeEntry.id } });
  check(
    "Repairing a missing snapshot does not rewrite a sibling entry's existing snapshot",
    Number(originalJoeAfterRepair.approvedHourlyWage) === 25 &&
      Number(originalJoeAfterRepair.approvedLaborCost) === 25,
  );

  const nowageUser = await prisma.user.create({
    data: { name: "No Wage Worker", email: `nowage-${randomUUID().slice(0, 8)}@example.com`, passwordHash: "x" },
  });
  const nowageMem = await prisma.membership.create({
    data: { userId: nowageUser.id, businessId: handy.id, role: "MEMBER", hourlyWage: null },
  });
  const nowageEntry = await prisma.timeEntry.create({
    data: {
      businessId: handy.id,
      membershipId: nowageMem.id,
      activityType: "JOB",
      status: "APPROVED",
      source: "MANUAL",
      startedAt: legacyStart,
      endedAt: legacyEnd,
      approvedHours: new Prisma.Decimal("1.0"),
      approvedHourlyWage: null,
      approvedLaborCost: null,
    },
  });
  await approveTimesheetWeek(prisma, joeAccess, {
    membershipId: nowageMem.id,
    weekStartedAt: handyWeek,
  });
  const stillMissing = await prisma.timeEntry.findUnique({ where: { id: nowageEntry.id } });
  check(
    "Re-approval with no membership wage leaves wage/cost snapshot missing",
    stillMissing?.status === "APPROVED" &&
      stillMissing.approvedHourlyWage == null &&
      stillMissing.approvedLaborCost == null,
  );

  await expectError(
    "Business B cannot re-approve / repair Business A's timesheet week",
    () =>
      approveTimesheetWeek(prisma, ownerB, {
        membershipId: joeMem.id,
        weekStartedAt: handyWeek,
      }),
    (error) => error instanceof TimeCardError,
  );
  const afterIsolation = await prisma.timeEntry.findUnique({ where: { id: legacyEntry.id } });
  check(
    "Failed cross-tenant re-approval did not change A's repaired snapshot",
    Number(afterIsolation.approvedHourlyWage) === 25 &&
      Number(afterIsolation.approvedLaborCost) === 25,
  );
  const repairedSource = await loadReportSource(prisma, handy.id);
  const repairedReport = buildReport(repairedSource, resolveReportRange("all"));
  check(
    "Reports stop flagging the repaired approved hour as missing a wage snapshot",
    !repairedReport.attention.some((item) => item.key === `wage:${legacyEntry.id}`),
  );
  check(
    "Reports still flag approved time when no membership wage exists",
    repairedReport.attention.some((item) => item.key === `wage:${nowageEntry.id}`),
  );

  console.log("\nTEST — Production path: missing snapshot, stored $25, reopen, READY → APPROVE, DB row");
  const persistBiz = await prisma.business.create({
    data: { name: "Handy Persist Wage", slug: `handy-persist-wage-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const persistUser = await prisma.user.create({
    data: { name: "Joe Persist", email: `joe-persist-${randomUUID().slice(0, 8)}@example.com`, passwordHash: "x" },
  });
  const persistMem = await prisma.membership.create({
    data: { userId: persistUser.id, businessId: persistBiz.id, role: "OWNER", hourlyWage: null },
  });
  const persistAccess = makeAccess(persistBiz.id, "OWNER", persistMem.id);
  const persistCustomer = await prisma.customer.create({
    data: { businessId: persistBiz.id, name: "Persist Homeowner" },
  });
  const persistJob = await prisma.job.create({
    data: {
      businessId: persistBiz.id,
      customerId: persistCustomer.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  await prisma.invoice.create({
    data: {
      businessId: persistBiz.id,
      customerId: persistCustomer.id,
      jobId: persistJob.id,
      status: "PAID",
      total: new Prisma.Decimal("125.00"),
      paidAt: new Date(),
      paymentMethod: "CASH",
    },
  });
  const persistStart = civil("2026-09-19", "09:00");
  const persistEnd = civil("2026-09-19", "10:00");
  const persistEntry = await createManualTimeEntry(prisma, persistAccess, {
    membershipId: persistMem.id,
    activityType: "JOB",
    jobId: persistJob.id,
    startedAt: persistStart,
    endedAt: persistEnd,
    note: "Persist hour",
  });
  const persistWeek = weekRange(persistStart, NY).start;
  await approveTimesheetWeek(prisma, persistAccess, {
    membershipId: persistMem.id,
    weekStartedAt: persistWeek,
  });
  const originallyApproved = await prisma.timeEntry.findUnique({ where: { id: persistEntry.id } });
  check(
    "Original approval with no membership wage leaves wage/cost null on the row",
    originallyApproved?.status === "APPROVED" &&
      Number(originallyApproved.approvedHours) === 1 &&
      originallyApproved.approvedHourlyWage == null &&
      originallyApproved.approvedLaborCost == null,
  );

  await expectError(
    "Empty wage submit cannot persist a placeholder 25.00",
    () => updateMembershipWage(prisma, persistAccess, { membershipId: persistMem.id, hourlyWage: "" }),
    (error) => error instanceof TimeCardError,
  );
  const stillNoWage = await prisma.membership.findUnique({ where: { id: persistMem.id } });
  check("Empty wage submit leaves Membership.hourlyWage null", stillNoWage.hourlyWage == null);

  await updateMembershipWage(prisma, persistAccess, {
    membershipId: persistMem.id,
    hourlyWage: "25.00",
  });
  const storedMembership = await prisma.membership.findUnique({ where: { id: persistMem.id } });
  const pageWage =
    storedMembership.hourlyWage != null ? Number(storedMembership.hourlyWage.toString()) : null;
  check(
    "Approval reads the same Membership.hourlyWage the Time Cards page uses",
    coerceHourlyWage(storedMembership.hourlyWage) === 25 &&
      pageWage === 25 &&
      pageWage.toFixed(2) === "25.00",
  );

  await reopenTimesheetWeek(prisma, persistAccess, {
    membershipId: persistMem.id,
    weekStartedAt: persistWeek,
    reason: "Repair missing wage snapshot",
  });
  const persistAfterReopen = await prisma.timeEntry.findUnique({ where: { id: persistEntry.id } });
  check(
    "Reopen moves the entry to READY and does not invent a snapshot",
    persistAfterReopen.status === "READY" &&
      persistAfterReopen.approvedHourlyWage == null &&
      persistAfterReopen.approvedLaborCost == null,
  );

  await approveTimesheetWeek(prisma, persistAccess, {
    membershipId: persistMem.id,
    weekStartedAt: persistWeek,
  });
  const dbRow = await prisma.timeEntry.findUnique({ where: { id: persistEntry.id } });
  check(
    "DATABASE ROW after reopen→approve: hours=1.0 wage=25.00 cost=25.00",
    dbRow?.status === "APPROVED" &&
      Number(dbRow.approvedHours) === 1 &&
      Number(dbRow.approvedHourlyWage) === 25 &&
      Number(dbRow.approvedLaborCost) === 25,
  );

  await createExpense(prisma, persistAccess, {
    occurredOn: "2026-09-19",
    description: "Persist job materials",
    amount: "25.00",
    category: "MATERIALS",
    vendor: "Test Vendor",
    jobId: persistJob.id,
  });
  const persistReport = buildReport(
    await loadReportSource(prisma, persistBiz.id),
    resolveReportRange("all"),
  );
  const persistProfit = persistReport.jobProfitability.find((row) => row.jobId === persistJob.id);
  check("Paid revenue = $125", persistProfit?.paidRevenue === 125);
  check("Approved labor = $25", persistProfit?.laborCost === 25 && persistProfit?.laborCostIncomplete === false);
  check("Job expenses = $25", persistProfit?.recordedJobExpense === 25);
  check("Recorded job margin = $75", persistProfit?.recordedMargin === 75);
  check(
    "Reports no longer flag this persisted snapshot as missing",
    !persistReport.attention.some((item) => item.key === `wage:${persistEntry.id}`),
  );

  await expectError(
    "Business B cannot approve the persist-wage worker's week",
    () =>
      approveTimesheetWeek(prisma, ownerB, {
        membershipId: persistMem.id,
        weekStartedAt: persistWeek,
      }),
    (error) => error instanceof TimeCardError,
  );
  const persistAfterIsolation = await prisma.timeEntry.findUnique({ where: { id: persistEntry.id } });
  check(
    "Cross-tenant approve did not change the persisted $25 snapshot",
    Number(persistAfterIsolation.approvedHourlyWage) === 25 &&
      Number(persistAfterIsolation.approvedLaborCost) === 25,
  );

  console.log("\nTEST — Job completion cannot leave RUNNING JOB time");
  const closerUser = await prisma.user.create({
    data: { name: "Cara Closer", email: "closer-time@example.com", passwordHash: "x" },
  });
  const otherUser = await prisma.user.create({
    data: { name: "Omar Other", email: "other-time@example.com", passwordHash: "x" },
  });
  const raceUser = await prisma.user.create({
    data: { name: "Riley Race", email: "race-time@example.com", passwordHash: "x" },
  });
  const closerMem = await prisma.membership.create({
    data: { userId: closerUser.id, businessId: businessA.id, role: "MEMBER", hourlyWage: new Prisma.Decimal(19) },
  });
  const otherMem = await prisma.membership.create({
    data: { userId: otherUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const raceMem = await prisma.membership.create({
    data: { userId: raceUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const closerA = makeAccess(businessA.id, "MEMBER", closerMem.id);
  const raceA = makeAccess(businessA.id, "MEMBER", raceMem.id);
  const completionJobA = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "IN_PROGRESS",
      projectToken: randomUUID(),
      assignedMembershipId: closerMem.id,
    },
  });
  const completionJobB = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "IN_PROGRESS",
      projectToken: randomUUID(),
      assignedMembershipId: otherMem.id,
    },
  });
  const betaCompletionJob = await prisma.job.create({
    data: {
      businessId: businessB.id,
      status: "IN_PROGRESS",
      projectToken: randomUUID(),
      assignedMembershipId: betaMemberMem.id,
    },
  });

  const jobAStartedAt = hoursAgo(2);
  const jobAClock = await clockInTime(prisma, closerA, {
    membershipId: closerMem.id,
    activityType: "JOB",
    jobId: completionJobA.id,
    startedAt: jobAStartedAt,
    note: "Finishing Job A labor",
  });
  const jobBClock = await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: otherMem.id,
      jobId: completionJobB.id,
      activityType: "JOB",
      status: "RUNNING",
      startedAt: hoursAgo(3),
      endedAt: null,
      source: "CLOCK",
      note: "Job B still on site",
    },
  });
  const breakClock = await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: adminMem.id,
      activityType: "BREAK",
      status: "RUNNING",
      startedAt: hoursAgo(1),
      endedAt: null,
      source: "CLOCK",
    },
  });
  const travelClock = await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: ownerMem.id,
      activityType: "TRAVEL",
      status: "RUNNING",
      startedAt: hoursAgo(1),
      endedAt: null,
      source: "CLOCK",
      jobId: completionJobA.id,
    },
  });
  const pickupClock = await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: helperMem.id,
      activityType: "MATERIAL_PICKUP",
      status: "RUNNING",
      startedAt: hoursAgo(1),
      endedAt: null,
      source: "CLOCK",
    },
  });
  const otherClock = await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: danielMem.id,
      activityType: "OTHER",
      status: "RUNNING",
      startedAt: hoursAgo(1),
      endedAt: null,
      source: "CLOCK",
    },
  });
  const betaClock = await prisma.timeEntry.create({
    data: {
      businessId: businessB.id,
      membershipId: betaMemberMem.id,
      jobId: betaCompletionJob.id,
      activityType: "JOB",
      status: "RUNNING",
      startedAt: hoursAgo(1),
      endedAt: null,
      source: "CLOCK",
    },
  });

  const completedA = await completeJobWithRunningTimeSafety(prisma, {
    businessId: businessA.id,
    jobId: completionJobA.id,
    actorMembershipId: ownerMem.id,
  });
  const closedA = await prisma.timeEntry.findUnique({ where: { id: jobAClock.id } });
  const jobAAdjustments = await prisma.timeEntryAdjustment.findMany({
    where: { timeEntryId: jobAClock.id, action: "UPDATE", reason: JOB_COMPLETION_TIME_CLOSED_REASON },
  });
  check("Completing Job A succeeds", completedA.ok === true && completedA.jobCompleted === true);
  check("Job A is COMPLETED", (await prisma.job.findUnique({ where: { id: completionJobA.id } })).status === "COMPLETED");
  check(
    "Job A RUNNING JOB entry is READY with preserved startedAt and note",
    closedA.status === "READY" &&
      closedA.endedAt != null &&
      closedA.startedAt.getTime() === jobAStartedAt.getTime() &&
      closedA.note === "Finishing Job A labor",
  );
  check("Completion wrote exactly one close adjustment", jobAAdjustments.length === 1);
  check(
    "Job B running JOB entry is untouched",
    (await prisma.timeEntry.findUnique({ where: { id: jobBClock.id } })).status === "RUNNING" &&
      (await prisma.timeEntry.findUnique({ where: { id: jobBClock.id } })).endedAt == null,
  );
  check(
    "Unrelated BREAK / TRAVEL / MATERIAL_PICKUP / OTHER stay running",
    (await prisma.timeEntry.findUnique({ where: { id: breakClock.id } })).status === "RUNNING" &&
      (await prisma.timeEntry.findUnique({ where: { id: travelClock.id } })).status === "RUNNING" &&
      (await prisma.timeEntry.findUnique({ where: { id: pickupClock.id } })).status === "RUNNING" &&
      (await prisma.timeEntry.findUnique({ where: { id: otherClock.id } })).status === "RUNNING",
  );
  check(
    "Tenant B running JOB time is untouched by Tenant A completion",
    (await prisma.timeEntry.findUnique({ where: { id: betaClock.id } })).status === "RUNNING" &&
      (await prisma.job.findUnique({ where: { id: betaCompletionJob.id } })).status === "IN_PROGRESS",
  );

  await expectError(
    "Tenant B cannot close Tenant A running JOB time",
    () =>
      closeRunningJobTimeForCompletion(prisma, {
        businessId: businessB.id,
        jobId: completionJobA.id,
        actorMembershipId: betaOwnerMem.id,
      }),
    (error) => error instanceof TimeCardError,
  );
  check(
    "Cross-tenant close left Job A entry READY (not reopened or rewritten)",
    (await prisma.timeEntry.findUnique({ where: { id: jobAClock.id } })).status === "READY" &&
      (await prisma.timeEntryAdjustment.count({
        where: { timeEntryId: jobAClock.id, reason: JOB_COMPLETION_TIME_CLOSED_REASON },
      })) === 1,
  );

  const repeatA = await completeJobWithRunningTimeSafety(prisma, {
    businessId: businessA.id,
    jobId: completionJobA.id,
    actorMembershipId: ownerMem.id,
  });
  check("Repeated completion is idempotent", repeatA.ok === true && repeatA.alreadyCompleted === true);
  check(
    "Repeated completion does not double-adjust",
    (await prisma.timeEntryAdjustment.count({
      where: { timeEntryId: jobAClock.id, reason: JOB_COMPLETION_TIME_CLOSED_REASON },
    })) === 1,
  );
  const closedAAfterRepeat = await prisma.timeEntry.findUnique({ where: { id: jobAClock.id } });
  check(
    "Repeated completion does not alter the already-closed entry",
    closedAAfterRepeat.endedAt.getTime() === closedA.endedAt.getTime() &&
      closedAAfterRepeat.status === "READY",
  );

  await expectError(
    "Completed Job rejects a new JOB clock-in",
    () =>
      clockInTime(prisma, closerA, {
        membershipId: closerMem.id,
        activityType: "JOB",
        jobId: completionJobA.id,
      }),
    (error) => error instanceof TimeCardError && /completed/i.test(error.message),
  );
  check(
    "Rejected JOB clock-in created no new RUNNING JOB entry",
    (await prisma.timeEntry.count({
      where: {
        businessId: businessA.id,
        jobId: completionJobA.id,
        activityType: "JOB",
        status: "RUNNING",
        endedAt: null,
      },
    })) === 0,
  );

  const approvedBlockJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "IN_PROGRESS",
      projectToken: randomUUID(),
      assignedMembershipId: closerMem.id,
    },
  });
  const approvedRunning = await clockInTime(prisma, closerA, {
    membershipId: closerMem.id,
    activityType: "JOB",
    jobId: approvedBlockJob.id,
  });
  await prisma.timesheetWeek.create({
    data: {
      businessId: businessA.id,
      membershipId: closerMem.id,
      weekStartedAt: weekRange(approvedRunning.startedAt, "America/New_York").start,
      status: "APPROVED",
      approvedAt: new Date(),
      approvedByMembershipId: ownerMem.id,
    },
  });
  const blockedComplete = await completeJobWithRunningTimeSafety(prisma, {
    businessId: businessA.id,
    jobId: approvedBlockJob.id,
    actorMembershipId: ownerMem.id,
  });
  check("Approved week blocks completion", blockedComplete.ok === false);
  check(
    "Approved-week block leaves Job IN_PROGRESS",
    (await prisma.job.findUnique({ where: { id: approvedBlockJob.id } })).status === "IN_PROGRESS",
  );
  const stillRunningApproved = await prisma.timeEntry.findUnique({ where: { id: approvedRunning.id } });
  check(
    "Approved-week block does not silently close or mutate the running entry",
    stillRunningApproved.status === "RUNNING" && stillRunningApproved.endedAt == null,
  );
  check(
    "Approved-week block wrote no completion adjustment",
    (await prisma.timeEntryAdjustment.count({
      where: { timeEntryId: approvedRunning.id, reason: JOB_COMPLETION_TIME_CLOSED_REASON },
    })) === 0,
  );

  const raceJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "IN_PROGRESS",
      projectToken: randomUUID(),
      assignedMembershipId: raceMem.id,
    },
  });
  const [raceClock, raceComplete] = await Promise.allSettled([
    clockInTime(prisma, raceA, {
      membershipId: raceMem.id,
      activityType: "JOB",
      jobId: raceJob.id,
    }),
    completeJobWithRunningTimeSafety(prisma, {
      businessId: businessA.id,
      jobId: raceJob.id,
      actorMembershipId: ownerMem.id,
    }),
  ]);
  const raceJobRow = await prisma.job.findUnique({ where: { id: raceJob.id } });
  const raceRunning = await prisma.timeEntry.findMany({
    where: {
      businessId: businessA.id,
      jobId: raceJob.id,
      activityType: "JOB",
      status: "RUNNING",
      endedAt: null,
    },
  });
  check(
    "Completion vs JOB clock-in never leaves COMPLETED + RUNNING JOB time",
    !(raceJobRow.status === "COMPLETED" && raceRunning.length > 0),
  );
  check(
    "Race settled without an uncaught rejection",
    (raceClock.status === "fulfilled" || raceClock.status === "rejected") &&
      (raceComplete.status === "fulfilled" || raceComplete.status === "rejected"),
  );

  const stopWorkerUser = await prisma.user.create({
    data: { name: "Sid Stopper", email: "stop-time@example.com", passwordHash: "x" },
  });
  const stopWorkerMem = await prisma.membership.create({
    data: { userId: stopWorkerUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const stopOtherUser = await prisma.user.create({
    data: { name: "Otis Other", email: "stop-other-time@example.com", passwordHash: "x" },
  });
  const stopOtherMem = await prisma.membership.create({
    data: { userId: stopOtherUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const stopJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "IN_PROGRESS",
      projectToken: randomUUID(),
      assignedMembershipId: stopWorkerMem.id,
    },
  });
  const stopOtherJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "IN_PROGRESS",
      projectToken: randomUUID(),
      assignedMembershipId: stopOtherMem.id,
    },
  });
  const stopBetaJob = await prisma.job.create({
    data: {
      businessId: businessB.id,
      status: "IN_PROGRESS",
      projectToken: randomUUID(),
      assignedMembershipId: betaMemberMem.id,
    },
  });
  const stopJobStartedAt = hoursAgo(2);
  const stopJobClock = await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: stopWorkerMem.id,
      jobId: stopJob.id,
      activityType: "JOB",
      status: "RUNNING",
      startedAt: stopJobStartedAt,
      source: "CLOCK",
    },
  });
  const stopTravelClock = await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: stopWorkerMem.id,
      activityType: "TRAVEL",
      status: "RUNNING",
      startedAt: hoursAgo(1),
      source: "CLOCK",
    },
  });
  const stopOtherClock = await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: stopOtherMem.id,
      jobId: stopOtherJob.id,
      activityType: "JOB",
      status: "RUNNING",
      startedAt: hoursAgo(1),
      source: "CLOCK",
    },
  });
  const stopBetaClock = await prisma.timeEntry.create({
    data: {
      businessId: businessB.id,
      membershipId: betaMemberMem.id,
      jobId: stopBetaJob.id,
      activityType: "JOB",
      status: "RUNNING",
      startedAt: hoursAgo(1),
      source: "CLOCK",
    },
  });

  const stopped = await stopRunningAssignedJobTime(prisma, {
    businessId: businessA.id,
    jobId: stopJob.id,
    actorMembershipId: stopWorkerMem.id,
  });
  const stoppedRow = await prisma.timeEntry.findUnique({ where: { id: stopJobClock.id } });
  const stoppedJobRow = await prisma.job.findUnique({ where: { id: stopJob.id } });
  const stopAdjustments = await prisma.timeEntryAdjustment.findMany({
    where: { timeEntryId: stopJobClock.id, reason: JOB_STOP_TIME_CLOSED_REASON },
  });
  check("Stopping assigned RUNNING JOB time succeeds", stopped.ok === true && stopped.alreadyStopped === false);
  check("Stop does not complete the Job", stoppedJobRow.status === "IN_PROGRESS");
  check(
    "Stopped JOB entry is READY with preserved startedAt",
    stoppedRow.status === "READY" &&
      stoppedRow.endedAt != null &&
      stoppedRow.startedAt.getTime() === stopJobStartedAt.getTime(),
  );
  check("Stop wrote exactly one close adjustment", stopAdjustments.length === 1);
  check(
    "Stop leaves TRAVEL, other-job JOB time, and tenant B JOB time running",
    (await prisma.timeEntry.findUnique({ where: { id: stopTravelClock.id } })).status === "RUNNING" &&
      (await prisma.timeEntry.findUnique({ where: { id: stopOtherClock.id } })).status === "RUNNING" &&
      (await prisma.timeEntry.findUnique({ where: { id: stopBetaClock.id } })).status === "RUNNING" &&
      (await prisma.job.findUnique({ where: { id: stopOtherJob.id } })).status === "IN_PROGRESS" &&
      (await prisma.job.findUnique({ where: { id: stopBetaJob.id } })).status === "IN_PROGRESS",
  );

  const repeatStop = await stopRunningAssignedJobTime(prisma, {
    businessId: businessA.id,
    jobId: stopJob.id,
    actorMembershipId: stopWorkerMem.id,
  });
  check("Repeated stop is idempotent", repeatStop.ok === true && repeatStop.alreadyStopped === true);
  check(
    "Repeated stop does not double-adjust",
    (await prisma.timeEntryAdjustment.count({
      where: { timeEntryId: stopJobClock.id, reason: JOB_STOP_TIME_CLOSED_REASON },
    })) === 1,
  );

  const crossTenantStop = await stopRunningAssignedJobTime(prisma, {
    businessId: businessB.id,
    jobId: stopJob.id,
    actorMembershipId: betaOwnerMem.id,
  });
  check(
    "Tenant B cannot stop Tenant A running JOB time",
    crossTenantStop.ok === false,
  );
  check(
    "Cross-tenant stop left the Tenant A entry READY",
    (await prisma.timeEntry.findUnique({ where: { id: stopJobClock.id } })).status === "READY" &&
      (await prisma.timeEntryAdjustment.count({
        where: { timeEntryId: stopJobClock.id, reason: JOB_STOP_TIME_CLOSED_REASON },
      })) === 1,
  );

  const approvedStopJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "IN_PROGRESS",
      projectToken: randomUUID(),
      assignedMembershipId: stopWorkerMem.id,
    },
  });
  const approvedStopClock = await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: stopWorkerMem.id,
      jobId: approvedStopJob.id,
      activityType: "JOB",
      status: "RUNNING",
      startedAt: hoursAgo(1),
      source: "CLOCK",
    },
  });
  await prisma.timesheetWeek.create({
    data: {
      businessId: businessA.id,
      membershipId: stopWorkerMem.id,
      weekStartedAt: weekRange(approvedStopClock.startedAt, "America/New_York").start,
      status: "APPROVED",
      approvedAt: new Date(),
      approvedByMembershipId: ownerMem.id,
    },
  });
  const blockedStop = await stopRunningAssignedJobTime(prisma, {
    businessId: businessA.id,
    jobId: approvedStopJob.id,
    actorMembershipId: stopWorkerMem.id,
  });
  check("Approved week blocks stop", blockedStop.ok === false && /approved/i.test(blockedStop.error ?? ""));
  check(
    "Approved-week stop leaves Job IN_PROGRESS",
    (await prisma.job.findUnique({ where: { id: approvedStopJob.id } })).status === "IN_PROGRESS",
  );
  const stillRunningStop = await prisma.timeEntry.findUnique({ where: { id: approvedStopClock.id } });
  check(
    "Approved-week stop does not silently close or mutate the running entry",
    stillRunningStop.status === "RUNNING" && stillRunningStop.endedAt == null,
  );
  check(
    "Approved-week stop wrote no stop adjustment",
    (await prisma.timeEntryAdjustment.count({
      where: { timeEntryId: approvedStopClock.id, reason: JOB_STOP_TIME_CLOSED_REASON },
    })) === 0,
  );

  const priorWeekWorkerUser = await prisma.user.create({
    data: {
      name: "Prior Week Worker",
      email: `prior-week-${randomUUID()}@example.com`,
      passwordHash: "x",
    },
  });
  const priorWeekMem = await prisma.membership.create({
    data: { userId: priorWeekWorkerUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const priorWeekA = makeAccess(businessA.id, "MEMBER", priorWeekMem.id);
  const transitionNow = new Date();
  const currentWeekStart = weekRange(transitionNow, "America/New_York").start;
  const priorStartedAt = new Date(currentWeekStart.getTime() - 24 * 60 * 60 * 1000);
  const priorWeekStart = weekRange(priorStartedAt, "America/New_York").start;
  const priorWeekJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "IN_PROGRESS",
      projectToken: randomUUID(),
      assignedMembershipId: priorWeekMem.id,
    },
  });
  const currentWeekJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "SCHEDULED",
      projectToken: randomUUID(),
      assignedMembershipId: priorWeekMem.id,
    },
  });
  const priorWeekRunning = await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: priorWeekMem.id,
      jobId: priorWeekJob.id,
      activityType: "TRAVEL",
      status: "RUNNING",
      startedAt: priorStartedAt,
      source: "CLOCK",
    },
  });
  await prisma.timesheetWeek.create({
    data: {
      businessId: businessA.id,
      membershipId: priorWeekMem.id,
      weekStartedAt: priorWeekStart,
      status: "APPROVED",
      approvedAt: new Date(),
      approvedByMembershipId: ownerMem.id,
    },
  });
  await prisma.timesheetWeek.create({
    data: {
      businessId: businessA.id,
      membershipId: priorWeekMem.id,
      weekStartedAt: currentWeekStart,
      status: "OPEN",
    },
  });
  check(
    "Approved prior week and open current week are distinct fixtures",
    priorWeekStart.getTime() < currentWeekStart.getTime(),
  );
  await expectError(
    "clockInTime refuses to close a running entry from an approved prior week",
    () =>
      clockInTime(prisma, priorWeekA, {
        membershipId: priorWeekMem.id,
        activityType: "MATERIAL_PICKUP",
        startedAt: transitionNow,
      }),
    (error) => error instanceof TimeCardError && /approved/i.test(error.message),
  );
  const priorWeekActivityStart = await startAssignedActivityTime(prisma, {
    businessId: businessA.id,
    jobId: currentWeekJob.id,
    activityType: "MATERIAL_PICKUP",
    actorMembershipId: priorWeekMem.id,
    startedAt: transitionNow,
  });
  const priorWeekRunningAfter = await prisma.timeEntry.findUnique({
    where: { id: priorWeekRunning.id },
  });
  const currentWeekPickupAfter = await prisma.timeEntry.findFirst({
    where: {
      jobId: currentWeekJob.id,
      membershipId: priorWeekMem.id,
    },
  });
  check(
    "startAssignedActivityTime refuses to close approved prior-week time in an open current week",
    priorWeekActivityStart.ok === false && /approved/i.test(priorWeekActivityStart.error ?? ""),
  );
  check(
    "Refused prior-week clock transition leaves the running entry and writes no new time",
    priorWeekRunningAfter?.status === "RUNNING" &&
      priorWeekRunningAfter?.endedAt == null &&
      priorWeekRunningAfter?.startedAt.getTime() === priorStartedAt.getTime() &&
      currentWeekPickupAfter == null &&
      (await prisma.timeEntryAdjustment.count({ where: { timeEntryId: priorWeekRunning.id } })) === 0 &&
      (await prisma.job.findUnique({ where: { id: priorWeekJob.id } })).status === "IN_PROGRESS" &&
      (await prisma.job.findUnique({ where: { id: currentWeekJob.id } })).status === "SCHEDULED",
  );

  const deactivateUser = await prisma.user.create({
    data: {
      name: "Deactivate Clock",
      email: `deactivate-time-${randomUUID()}@example.com`,
      passwordHash: "x",
    },
  });
  const deactivateMem = await prisma.membership.create({
    data: {
      userId: deactivateUser.id,
      businessId: businessA.id,
      role: "MEMBER",
      hourlyWage: new Prisma.Decimal(18),
    },
  });
  const deactivateAccess = makeAccess(businessA.id, "MEMBER", deactivateMem.id);
  const deactivateJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "IN_PROGRESS",
      projectToken: randomUUID(),
      assignedMembershipId: deactivateMem.id,
    },
  });
  async function deactivateExactMembership() {
    const otherClient = new PrismaClient({ datasourceUrl: testUrl });
    try {
      await otherClient.membership.update({
        where: { id: deactivateMem.id },
        data: { active: false },
      });
    } finally {
      await otherClient.$disconnect();
    }
  }
  await expectError(
    "MEMBER clock-in after membership deactivation is refused",
    () =>
      clockInTime(
        prisma,
        deactivateAccess,
        {
          membershipId: deactivateMem.id,
          activityType: "JOB",
          jobId: deactivateJob.id,
        },
        { afterInitialRead: deactivateExactMembership },
      ),
    (error) => error instanceof ForbiddenError,
  );
  check(
    "Refused deactivated clock-in writes no TimeEntry",
    (await prisma.timeEntry.count({
      where: { jobId: deactivateJob.id, businessId: businessA.id },
    })) === 0,
  );

  await prisma.membership.update({
    where: { id: deactivateMem.id },
    data: { active: true },
  });
  const deactivateRunning = await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: deactivateMem.id,
      jobId: deactivateJob.id,
      activityType: "JOB",
      status: "RUNNING",
      source: "CLOCK",
      startedAt: hoursAgo(1),
      endedAt: null,
    },
  });
  await expectError(
    "MEMBER clock-out after membership deactivation is refused",
    () =>
      clockOutTime(
        prisma,
        deactivateAccess,
        { membershipId: deactivateMem.id },
        { afterInitialRead: deactivateExactMembership },
      ),
    (error) => error instanceof ForbiddenError,
  );
  const deactivateRunningAfter = await prisma.timeEntry.findFirst({
    where: { id: deactivateRunning.id, businessId: businessA.id },
  });
  check(
    "Refused deactivated clock-out leaves RUNNING time open",
    deactivateRunningAfter?.status === "RUNNING" && deactivateRunningAfter?.endedAt === null,
  );

  await prisma.membership.update({
    where: { id: deactivateMem.id },
    data: { active: true },
  });
  const deactivateComplete = await completeJobWithRunningTimeSafety(
    prisma,
    {
      businessId: businessA.id,
      jobId: deactivateJob.id,
      actorMembershipId: deactivateMem.id,
    },
    { afterInitialRead: deactivateExactMembership },
  );
  const deactivateJobAfterComplete = await prisma.job.findFirst({
    where: { id: deactivateJob.id, businessId: businessA.id },
  });
  const deactivateTimeAfterComplete = await prisma.timeEntry.findFirst({
    where: { id: deactivateRunning.id, businessId: businessA.id },
  });
  check(
    "MEMBER complete after membership deactivation is refused",
    deactivateComplete.ok === false &&
      deactivateComplete.error === "That job could not be completed." &&
      deactivateJobAfterComplete?.status === "IN_PROGRESS" &&
      deactivateTimeAfterComplete?.status === "RUNNING",
  );

  const ownerCompletesInactiveJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "IN_PROGRESS",
      projectToken: randomUUID(),
      assignedMembershipId: deactivateMem.id,
    },
  });
  const ownerCompletesInactive = await completeJobWithRunningTimeSafety(prisma, {
    businessId: businessA.id,
    jobId: ownerCompletesInactiveJob.id,
    actorMembershipId: ownerMem.id,
  });
  check(
    "OWNER can still complete a Job whose assigned MEMBER is inactive",
    ownerCompletesInactive.ok === true &&
      (await prisma.job.findFirst({ where: { id: ownerCompletesInactiveJob.id } }))?.status ===
        "COMPLETED",
  );

  await clockOutTime(prisma, memberA, { membershipId: memberMem.id }).catch(() => null);
  const normalIn = await clockInTime(prisma, memberA, {
    membershipId: memberMem.id,
    activityType: "TRAVEL",
  });
  const normalOut = await clockOutTime(prisma, memberA, { membershipId: memberMem.id });
  check(
    "Existing clockIn / clockOut path is unchanged",
    normalIn.status === "RUNNING" &&
      normalIn.activityType === "TRAVEL" &&
      normalOut.status === "READY" &&
      normalOut.endedAt != null,
  );

  const stillSelfAssigned = await prisma.job.findUnique({ where: { id: ownerJob.id } });
  const ownerSelfAgain = await clockInTime(prisma, ownerA, {
    membershipId: ownerMem.id,
    activityType: "JOB",
    jobId: ownerJob.id,
  });
  check(
    "#144 owner self-assignment Field clock still works",
    stillSelfAssigned.assignedMembershipId === ownerMem.id &&
      stillSelfAssigned.status !== "COMPLETED" &&
      ownerSelfAgain.status === "RUNNING" &&
      ownerSelfAgain.jobId === ownerJob.id,
  );
  await clockOutTime(prisma, ownerA, { membershipId: ownerMem.id });

  console.log(
    failures === 0
      ? "\nAll Time Cards checks passed."
      : `\n${failures} Time Cards check(s) failed.`,
  );
} finally {
  await prisma.$disconnect();
  await dropTestDatabase();
}

process.exit(failures === 0 ? 0 : 1);
