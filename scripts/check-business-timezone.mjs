/**
 * Business calendar-day timezone.
 *
 * Proves TBBT does not advance the business date at UTC midnight, that
 * America/New_York is the Fort Myers default, DST uses IANA (not an hour
 * offset), and a Pacific tenant's stored timezone stays isolated.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-business-timezone.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  DEFAULT_BUSINESS_TIMEZONE,
  addZonedCalendarDays,
  formatISODateInTimeZone,
  isValidIanaTimeZone,
  resolveBusinessTimeZone,
  zonedCivilToUtc,
} = await import("@/lib/business-timezone");
const {
  addDays,
  dayRange,
  formatISODate,
  groupJobsByDay,
  parseScheduleDate,
  startOfDay,
} = await import("@/lib/schedule");
const { parseDateTimeInput, hoursBetween, weekRange } = await import("@/lib/time-cards");
const { resolveReportRange } = await import("@/lib/reports");
const { expenseRangeBounds } = await import("@/lib/expenses");
const { defaultPayPeriod } = await import("@/lib/payroll");

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

const NY = "America/New_York";
const LA = "America/Los_Angeles";
const eightPmSep19Ny = new Date("2026-09-20T00:00:00.000Z");
const utcMidnightSep20 = eightPmSep19Ny;
const justBeforeNyMidnight = new Date("2026-09-20T03:59:59.000Z");
const nyMidnightSep20 = new Date("2026-09-20T04:00:00.000Z");
const justAfterNyMidnight = new Date("2026-09-20T04:00:01.000Z");

console.log("\nUNIT — Fort Myers / America/New_York calendar day");
check("Default business timezone is America/New_York", DEFAULT_BUSINESS_TIMEZONE === NY);
check(
  "Null/missing stored timezone resolves to America/New_York",
  resolveBusinessTimeZone(null) === NY &&
    resolveBusinessTimeZone({}) === NY &&
    resolveBusinessTimeZone({ timezone: "  " }) === NY,
);
check(
  "Invalid IANA value falls back to America/New_York (not an offset)",
  resolveBusinessTimeZone({ timezone: "UTC-4" }) === NY &&
    resolveBusinessTimeZone({ timezone: "Eastern" }) === NY &&
    !isValidIanaTimeZone("UTC-4"),
);
check(
  "Sep 19 8 PM America/New_York remains Sep 19",
  formatISODate(eightPmSep19Ny, NY) === "2026-09-19" &&
    formatISODateInTimeZone(eightPmSep19Ny, NY) === "2026-09-19" &&
    formatISODate(startOfDay(eightPmSep19Ny, NY), NY) === "2026-09-19",
);
check(
  "UTC midnight does NOT prematurely advance the New York business date",
  formatISODate(utcMidnightSep20, NY) === "2026-09-19" &&
    formatISODate(justBeforeNyMidnight, NY) === "2026-09-19",
);
check(
  "Crossing local midnight changes to Sep 20",
  formatISODate(nyMidnightSep20, NY) === "2026-09-20" &&
    formatISODate(justAfterNyMidnight, NY) === "2026-09-20",
);
check(
  "toISOString().slice(0,10) is the UTC bug (still Sep 20) while business date is Sep 19",
  utcMidnightSep20.toISOString().slice(0, 10) === "2026-09-20" &&
    formatISODate(utcMidnightSep20, NY) === "2026-09-19",
);

console.log("\nUNIT — Time Cards / timesheets day + week");
const timeCardsToday = startOfDay(eightPmSep19Ny, NY);
const timeCardsDay = dayRange(timeCardsToday, NY);
const timeCardsWeek = weekRange(timeCardsToday, NY);
check(
  "Time Cards selected date at 8 PM NY is 2026-09-19",
  formatISODate(timeCardsToday, NY) === "2026-09-19" &&
    formatISODate(parseScheduleDate(undefined, NY), NY) ===
      formatISODate(startOfDay(new Date(), NY), NY),
);
check(
  "Time Cards today range includes 8 PM NY and excludes next NY midnight",
  eightPmSep19Ny >= timeCardsDay.start &&
    eightPmSep19Ny < timeCardsDay.end &&
    nyMidnightSep20.getTime() === timeCardsDay.end.getTime(),
);
check(
  "Time Cards week containing Sep 19 NY starts Sunday Sep 13 NY",
  formatISODate(timeCardsWeek.start, NY) === "2026-09-13" &&
    formatISODate(addDays(timeCardsWeek.start, 7, NY), NY) === "2026-09-20" &&
    eightPmSep19Ny >= timeCardsWeek.start &&
    eightPmSep19Ny < timeCardsWeek.end,
);
const nineToFiveStart = parseDateTimeInput("2026-09-19", "09:00");
const nineToFiveEnd = parseDateTimeInput("2026-09-19", "17:00");
check(
  "parseDateTimeInput wall-clock storage is unchanged (9–17 is 8 hours)",
  nineToFiveStart instanceof Date &&
    nineToFiveEnd instanceof Date &&
    hoursBetween(nineToFiveStart, nineToFiveEnd) === 8,
);

console.log("\nUNIT — Schedule / Jobs grouping");
const eveningJob = { id: "ny-evening", scheduledAt: eightPmSep19Ny };
const nextMorningJob = { id: "ny-morning", scheduledAt: nyMidnightSep20 };
const byNyDay = groupJobsByDay([eveningJob, nextMorningJob], NY);
check(
  "A job at 8 PM NY groups onto Sep 19, not the UTC date",
  (byNyDay.get("2026-09-19") ?? []).some((job) => job.id === "ny-evening") &&
    !(byNyDay.get("2026-09-20") ?? []).some((job) => job.id === "ny-evening"),
);
check(
  "A job at NY midnight Sep 20 groups onto Sep 20",
  (byNyDay.get("2026-09-20") ?? []).some((job) => job.id === "ny-morning"),
);
check(
  "parseScheduleDate('2026-09-19', NY) is NY midnight, not UTC midnight",
  formatISODate(parseScheduleDate("2026-09-19", NY), NY) === "2026-09-19" &&
    parseScheduleDate("2026-09-19", NY).toISOString() === "2026-09-19T04:00:00.000Z",
);

console.log("\nUNIT — Reports date ranges");
const reportRange = resolveReportRange("month", undefined, undefined, eightPmSep19Ny, NY);
check(
  "Reports 'this month' at 8 PM Sep 19 NY is still September 2026",
  reportRange.label.startsWith("2026-09-01") &&
    reportRange.start != null &&
    reportRange.end != null &&
    formatISODate(reportRange.start, NY) === "2026-09-01" &&
    formatISODate(reportRange.end, NY) === "2026-10-01" &&
    eightPmSep19Ny >= reportRange.start &&
    eightPmSep19Ny < reportRange.end,
);
check(
  "Reports month range does not start at UTC Sep 20 because of 8 PM NY",
  formatISODate(startOfDay(eightPmSep19Ny, NY), NY) === "2026-09-19",
);

console.log("\nUNIT — Expenses date ranges");
const expenseMonth = expenseRangeBounds("month", eightPmSep19Ny, NY);
const expenseWeek = expenseRangeBounds("week", eightPmSep19Ny, NY);
check(
  "Expense 'this month' at 8 PM Sep 19 NY stays in September",
  expenseMonth != null &&
    formatISODate(expenseMonth.start, NY) === "2026-09-01" &&
    formatISODate(expenseMonth.end, NY) === "2026-10-01",
);
check(
  "Expense 'this week' includes Sep 19 NY and starts Sunday Sep 13",
  expenseWeek != null &&
    formatISODate(expenseWeek.start, NY) === "2026-09-13" &&
    eightPmSep19Ny >= expenseWeek.start &&
    eightPmSep19Ny < expenseWeek.end,
);

console.log("\nUNIT — Payroll / Dashboard today");
const payPeriod = defaultPayPeriod(eightPmSep19Ny, NY);
const dashboardToday = startOfDay(eightPmSep19Ny, NY);
check(
  "Dashboard today at 8 PM NY is Sep 19",
  formatISODate(dashboardToday, NY) === "2026-09-19",
);
check(
  "Payroll default period is the NY week containing Sep 19, not the UTC Sunday",
  formatISODate(payPeriod.start, NY) === "2026-09-13" &&
    eightPmSep19Ny >= payPeriod.start &&
    eightPmSep19Ny < payPeriod.end,
);

console.log("\nUNIT — DST-safe conversion (no hard-coded offset)");
const beforeSpring = zonedCivilToUtc(2026, 3, 8, 0, 0, 0, NY);
const afterSpring = addZonedCalendarDays(beforeSpring, 1, NY);
const beforeFall = zonedCivilToUtc(2026, 11, 1, 0, 0, 0, NY);
const afterFall = addZonedCalendarDays(beforeFall, 1, NY);
check(
  "2026-03-08 00:00 America/New_York is EST (UTC-5)",
  beforeSpring.toISOString() === "2026-03-08T05:00:00.000Z",
);
check(
  "Adding one calendar day across spring-forward lands on EDT midnight, not +24h",
  afterSpring.toISOString() === "2026-03-09T04:00:00.000Z" &&
    formatISODate(afterSpring, NY) === "2026-03-09" &&
    afterSpring.getTime() - beforeSpring.getTime() !== 24 * 60 * 60 * 1000,
);
check(
  "2026-11-01 00:00 America/New_York is EDT (UTC-4)",
  beforeFall.toISOString() === "2026-11-01T04:00:00.000Z",
);
check(
  "Adding one calendar day across fall-back lands on EST midnight, not +24h",
  afterFall.toISOString() === "2026-11-02T05:00:00.000Z" &&
    formatISODate(afterFall, NY) === "2026-11-02" &&
    afterFall.getTime() - beforeFall.getTime() !== 24 * 60 * 60 * 1000,
);
check(
  "Pacific offset is not a hard-coded hours subtraction from Eastern",
  formatISODate(new Date("2026-09-20T04:30:00.000Z"), NY) === "2026-09-20" &&
    formatISODate(new Date("2026-09-20T04:30:00.000Z"), LA) === "2026-09-19",
);

console.log("\nUNIT — Tenant isolation (stored timezone is per business)");
const handy = { timezone: null };
const pacificTenant = { timezone: "America/Los_Angeles" };
const sharedInstant = new Date("2026-09-20T04:30:00.000Z");
check(
  "Fort Myers / Handy tenant (no stored zone) stays America/New_York",
  resolveBusinessTimeZone(handy) === NY &&
    formatISODate(sharedInstant, resolveBusinessTimeZone(handy)) === "2026-09-20",
);
check(
  "A Pacific tenant's stored zone is used and does not change the NY tenant",
  resolveBusinessTimeZone(pacificTenant) === LA &&
    formatISODate(sharedInstant, resolveBusinessTimeZone(pacificTenant)) === "2026-09-19" &&
    formatISODate(sharedInstant, resolveBusinessTimeZone(handy)) === "2026-09-20",
);
check(
  "Stored timezone is not leaked across tenants via the default",
  resolveBusinessTimeZone({ timezone: "America/Chicago" }) === "America/Chicago" &&
    resolveBusinessTimeZone({ timezone: null }) === NY,
);

const src = readFileSync(new URL("../src/lib/business-timezone.ts", import.meta.url), "utf8");
check(
  "Implementation uses Intl/IANA, not a hard-coded hour offset",
  src.includes("Intl.DateTimeFormat") &&
    src.includes("America/New_York") &&
    !src.includes("UTC-4") &&
    !src.includes("* 60 * 60 * 1000) - 4") &&
    !src.includes("getTimezoneOffset"),
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run the isolation database check.");
  process.exit(1);
}

const testDbName = "tbbt_business_timezone_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for business-timezone test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasources: { db: { url: testUrl } } });

console.log("\nDB — Tenant isolation of stored timezone");
try {
  const businessNy = await prisma.business.create({
    data: {
      name: "Handy Fort Myers",
      slug: `handy-fort-myers-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
    },
  });
  const businessLa = await prisma.business.create({
    data: {
      name: "Pacific Crew",
      slug: `pacific-crew-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: LA,
    },
  });

  const nyRow = await prisma.business.findUnique({ where: { id: businessNy.id } });
  const laRow = await prisma.business.findUnique({ where: { id: businessLa.id } });
  check(
    "NY tenant stores null timezone (defaults to America/New_York)",
    nyRow?.timezone == null && resolveBusinessTimeZone(nyRow) === NY,
  );
  check(
    "Pacific tenant stores America/Los_Angeles and does not overwrite the NY tenant",
    laRow?.timezone === LA &&
      resolveBusinessTimeZone(laRow) === LA &&
      resolveBusinessTimeZone(nyRow) === NY,
  );

  const nyDate = formatISODate(sharedInstant, resolveBusinessTimeZone(nyRow));
  const laDate = formatISODate(sharedInstant, resolveBusinessTimeZone(laRow));
  check(
    "Same UTC instant is a different business date for isolated tenants",
    nyDate === "2026-09-20" && laDate === "2026-09-19",
  );

  const nyJobs = groupJobsByDay(
    [{ id: "shared", scheduledAt: sharedInstant, businessId: businessNy.id }],
    resolveBusinessTimeZone(nyRow),
  );
  const laJobs = groupJobsByDay(
    [{ id: "shared", scheduledAt: sharedInstant, businessId: businessLa.id }],
    resolveBusinessTimeZone(laRow),
  );
  check(
    "Schedule grouping keys stay tenant-scoped by timezone",
    nyJobs.has("2026-09-20") &&
      !nyJobs.has("2026-09-19") &&
      laJobs.has("2026-09-19") &&
      !laJobs.has("2026-09-20"),
  );
} finally {
  await prisma.$disconnect();
}

console.log(
  failures === 0
    ? "\nAll business-timezone checks passed."
    : `\n${failures} business-timezone check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
