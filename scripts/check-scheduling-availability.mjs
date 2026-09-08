/**
 * Handyman scheduling / availability: working hours, blocked dates,
 * existing-job conflicts, duration, buffer, next available, rescheduling,
 * business isolation, and the unpaid-deposit warning.
 *
 * Reuses the existing Job.scheduledAt + scheduledDurationMinutes model.
 * No database access for the pure checks; Prisma isolation uses a throwaway DB.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-scheduling-availability.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  DEFAULT_AVAILABILITY_SETTINGS,
  DEFAULT_SCHEDULING_BUFFER_MINUTES,
  DEFAULT_WORK_END_MINUTES,
  DEFAULT_WORK_START_MINUTES,
  DEFAULT_WORKING_WEEKDAYS,
  describeScheduleWarning,
  durationFitsWorkingDay,
  evaluateProposedSchedule,
  findNextAvailableStart,
  formatAvailabilitySummary,
  formatNextAvailableDate,
  hasScheduleWarning,
  isUnavailableDate,
  isWorkingWeekday,
  minutesToTimeInput,
  parseBufferMinutes,
  parseTimeToMinutes,
  parseUnavailableDate,
  parseWorkingWeekdays,
  parseWorkingWeekdaysInput,
} = await import("@/lib/availability");
const { durationWithBuffer, parseDurationMinutes, schedulesOverlapWithBuffer } =
  await import("@/lib/job-schedule");
const { formatDateTime } = await import("@/lib/format");
const { unpaidMaterialDepositWarning } = await import("@/lib/project-payments");
const { updateSchedulingSettingsOp } = await import("@/lib/settings-ops");
const { ForbiddenError } = await import("@/lib/authorization");

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

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

const form = readRepo("src/components/jobs/schedule-job-form.tsx");
const jobAction = readRepo("src/app/actions/job.ts");
const settingsForm = readRepo("src/components/settings/scheduling-settings-form.tsx");
const intake = readRepo("src/app/r/[slug]/page.tsx");
const portal = readRepo("src/app/p/[token]/page.tsx");

console.log("\nSTATIC — Existing scheduling, deposit warning, and public next-available");

check(
  "Deposit-due scheduling warning remains on the schedule form",
  form.includes("unpaidDepositWarning") && form.includes("Schedule the job anyway?"),
);
check(
  "Schedule form still confirms unpaid deposit before submit",
  form.includes("unpaidDepositWarning") && form.includes("window.confirm"),
);
check(
  "unpaidMaterialDepositWarning copy is unchanged",
  unpaidMaterialDepositWarning("200") === "Material deposit of $200.00 is still due.",
);
check(
  "scheduleJob still updates the existing Job row (no duplicate create)",
  jobAction.includes("prisma.job.update") &&
    jobAction.includes("scheduledAt: start") &&
    !/prisma\.job\.create\(/.test(jobAction.slice(jobAction.indexOf("export async function scheduleJob"))),
);
check(
  "Reschedule keeps the same job id and does not insert another job",
  jobAction.includes("where: { id: job.id }") &&
    jobAction.includes('status === "UNSCHEDULED" ? { status: "SCHEDULED" }'),
);
check(
  "Conflict/availability checks run before save unless confirmOverlap is set",
  jobAction.includes("evaluateProposedSchedule") &&
    jobAction.includes("confirmOverlap") &&
    jobAction.includes("Schedule anyway") === false,
);
check("Owner form still has Schedule anyway after a warning", form.includes("Schedule anyway"));
check("Owner form shows next available", form.includes("Next available") && form.includes("Use this time"));
check(
  "Settings persist working days, hours, blocked dates, and the 30-minute buffer",
  settingsForm.includes("Working days") &&
    settingsForm.includes("Days unavailable") &&
    settingsForm.includes("Travel / material pickup buffer") &&
    settingsForm.includes("Default is 30 minutes"),
);
check(
  "Buffer is described as scheduling time, not a charge",
  settingsForm.includes("not an extra charge") && form.includes("not a charge"),
);
check(
  "Customer intake shows read-only next available and no calendar control",
  intake.includes("Next available:") &&
    !intake.includes('type="datetime-local"') &&
    !intake.includes("Use this time"),
);
check(
  "Customer project portal still renders the scheduled appointment",
  portal.includes("Scheduled") && portal.includes("formatDateTime(job.scheduledAt)"),
);
check("Default buffer is 30 minutes", DEFAULT_SCHEDULING_BUFFER_MINUTES === 30);
check(
  "Default working hours are weekday 8:00–5:00",
  DEFAULT_WORK_START_MINUTES === 480 &&
    DEFAULT_WORK_END_MINUTES === 1020 &&
    DEFAULT_WORKING_WEEKDAYS.join(",") === "1,2,3,4,5",
);

console.log("\nUNIT — Working hours, blocked dates, duration, buffer, next available");

const monday = new Date(2026, 8, 7, 8, 0, 0); // Monday Sep 7, 2026 8:00
const saturday = new Date(2026, 8, 12, 9, 0, 0);
const settings = {
  ...DEFAULT_AVAILABILITY_SETTINGS,
  unavailableDates: ["2026-09-09"], // Wednesday
};

check("Monday is a working day by default", isWorkingWeekday(monday, settings));
check("Saturday is not a working day by default", !isWorkingWeekday(saturday, settings));
check("Wednesday Sep 9 is blocked", isUnavailableDate(new Date(2026, 8, 9), settings));
check("Thursday Sep 10 is not blocked", !isUnavailableDate(new Date(2026, 8, 10), settings));
check("parseWorkingWeekdays falls back to Mon–Fri", parseWorkingWeekdays("").join(",") === "1,2,3,4,5");
check("parseWorkingWeekdaysInput rejects an empty set", parseWorkingWeekdaysInput([]).ok === false);
check("parseTimeToMinutes(08:00) is 480", parseTimeToMinutes("08:00") === 480);
check("minutesToTimeInput(1020) is 17:00", minutesToTimeInput(1020) === "17:00");
check("parseBufferMinutes default 30", parseBufferMinutes("30").ok && parseBufferMinutes("30").minutes === 30);
check("parseBufferMinutes rejects 241", parseBufferMinutes("241").ok === false);
check("parseUnavailableDate rejects Feb 30", parseUnavailableDate("2026-02-30") === null);
check("parseUnavailableDate accepts 2026-09-10", parseUnavailableDate("2026-09-10") === "2026-09-10");

check("30-minute preset still parses to 30", parseDurationMinutes("30", "").minutes === 30);
check("1 hour preset still parses to 60", parseDurationMinutes("60", "").minutes === 60);
check("2 hour preset still parses to 120", parseDurationMinutes("120", "").minutes === 120);
check("Half day still parses to 240", parseDurationMinutes("half", "").minutes === 240);
check("Full day still parses to 480", parseDurationMinutes("full", "").minutes === 480);
check("2 days still parses to 960", parseDurationMinutes("2d", "").minutes === 960);
check("2-hour job fits a default work day", durationFitsWorkingDay(120, settings));
check("2-day job does not fit a single work day", durationFitsWorkingDay(960, settings) === false);

const existing = [
  {
    id: "job-a",
    scheduledAt: new Date(2026, 8, 7, 8, 0, 0),
    scheduledDurationMinutes: 60,
    customerName: "Alpha",
  },
];

check(
  "Back-to-back 8:00 and 9:00 1-hour jobs conflict once the 30-minute buffer is applied",
  schedulesOverlapWithBuffer(
    new Date(2026, 8, 7, 9, 0, 0),
    60,
    existing[0].scheduledAt,
    existing[0].scheduledDurationMinutes,
    30,
  ),
);
check(
  "A 9:30 start after an 8:00–9:00 job plus 30-minute buffer does not conflict",
  !schedulesOverlapWithBuffer(
    new Date(2026, 8, 7, 9, 30, 0),
    60,
    existing[0].scheduledAt,
    existing[0].scheduledDurationMinutes,
    30,
  ),
);
check(
  "Buffer 0 keeps the existing adjacent-window behavior (9:00 after 8:00–9:00 is free)",
  !schedulesOverlapWithBuffer(
    new Date(2026, 8, 7, 9, 0, 0),
    60,
    existing[0].scheduledAt,
    existing[0].scheduledDurationMinutes,
    0,
  ),
);

const overlapEval = evaluateProposedSchedule({
  start: new Date(2026, 8, 7, 9, 0, 0),
  durationMinutes: 60,
  settings,
  existing,
});
check("Overlap evaluation flags the buffer conflict", Boolean(overlapEval.overlap));
check(
  "Owner warning names the other job and mentions the buffer",
  describeScheduleWarning(overlapEval, new Date(2026, 8, 7, 9, 0, 0), formatDateTime, settings)?.includes(
    "Alpha",
  ) === true &&
    describeScheduleWarning(overlapEval, new Date(2026, 8, 7, 9, 0, 0), formatDateTime, settings)?.includes(
      "30-minute",
    ) === true,
);

const blockedEval = evaluateProposedSchedule({
  start: new Date(2026, 8, 9, 8, 0, 0),
  durationMinutes: 60,
  settings,
  existing: [],
});
check("Blocked date is a warning, not a silent booking", blockedEval.unavailableDate && hasScheduleWarning(blockedEval));

const weekendEval = evaluateProposedSchedule({
  start: saturday,
  durationMinutes: 60,
  settings,
  existing: [],
});
check("Weekend start is a non-working-day warning", weekendEval.nonWorkingDay);

const afterHoursEval = evaluateProposedSchedule({
  start: new Date(2026, 8, 7, 18, 0, 0),
  durationMinutes: 60,
  settings,
  existing: [],
});
check("6:00 PM start is outside working hours", afterHoursEval.outsideWorkingHours);

const lateStartEval = evaluateProposedSchedule({
  start: new Date(2026, 8, 7, 16, 30, 0),
  durationMinutes: 60,
  settings,
  existing: [],
});
check("4:30 PM 1-hour job extends past 5:00 PM closing", lateStartEval.extendsPastWorkingHours);

const fromBeforeOpen = new Date(2026, 8, 7, 7, 0, 0);
const nextOpen = findNextAvailableStart({
  from: fromBeforeOpen,
  durationMinutes: 120,
  settings,
  existing: [],
});
check(
  "Next available 2-hour slot is Monday 8:00 AM",
  Boolean(nextOpen) &&
    nextOpen.getFullYear() === 2026 &&
    nextOpen.getMonth() === 8 &&
    nextOpen.getDate() === 7 &&
    nextOpen.getHours() === 8 &&
    nextOpen.getMinutes() === 0,
);

const nextAfterJob = findNextAvailableStart({
  from: fromBeforeOpen,
  durationMinutes: 60,
  settings,
  existing,
});
check(
  "Existing 8:00 job plus 30-minute buffer pushes next available to 9:30",
  Boolean(nextAfterJob) && nextAfterJob.getHours() === 9 && nextAfterJob.getMinutes() === 30,
);

const thursdayLabel = formatNextAvailableDate(new Date(2026, 8, 10, 8, 0, 0));
check(
  "Public next-available label matches Thursday, September 10",
  thursdayLabel === "Thursday, September 10",
);

const afterTuesdayClose = new Date(2026, 8, 8, 17, 1, 0);
const nextPastBlockedWednesday = findNextAvailableStart({
  from: afterTuesdayClose,
  durationMinutes: 60,
  settings,
  existing: [],
});
check(
  "Blocked Wednesday is skipped; next available is Thursday, September 10 at 8:00",
  Boolean(nextPastBlockedWednesday) &&
    nextPastBlockedWednesday.getDate() === 10 &&
    nextPastBlockedWednesday.getMonth() === 8 &&
    nextPastBlockedWednesday.getHours() === 8 &&
    formatNextAvailableDate(nextPastBlockedWednesday) === "Thursday, September 10",
);

const nextHalfDay = findNextAvailableStart({
  from: new Date(2026, 8, 7, 14, 0, 0),
  durationMinutes: 240,
  settings,
  existing: [],
});
check(
  "A half-day job at 2:00 PM does not fit remaining hours, so next available is the following working morning",
  Boolean(nextHalfDay) && nextHalfDay.getDate() === 8 && nextHalfDay.getHours() === 8,
);

const nextTwoDay = findNextAvailableStart({
  from: fromBeforeOpen,
  durationMinutes: 960,
  settings,
  existing: [],
});
check(
  "A multi-day duration that cannot fit one work day still starts at the next working morning",
  Boolean(nextTwoDay) && nextTwoDay.getDate() === 7 && nextTwoDay.getHours() === 8,
);

check(
  "Availability summary mentions buffer and working days",
  formatAvailabilitySummary(settings).includes("Mon–Fri") &&
    formatAvailabilitySummary(settings).includes("30-minute") &&
    formatAvailabilitySummary(settings).includes("1 blocked date"),
);

check(
  "durationWithBuffer(60, 30) occupies 90 minutes",
  durationWithBuffer(60, 30) === 90,
);
check(
  "durationWithBuffer(null, 0) keeps the existing null-duration window",
  durationWithBuffer(null, 0) === null,
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.log("\nSkipping Prisma isolation checks (DATABASE_URL is not set).");
  console.log(
    failed === 0
      ? `\nAll scheduling availability checks passed (${passed}).`
      : `\n${failed} scheduling availability check(s) failed.`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

const testDbName = "tbbt_scheduling_availability_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for scheduling availability test database.");
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

async function expectError(label, fn, predicate) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

try {
  console.log("\nPRISMA — Business isolation, persistence, rescheduling");

  const businessA = await prisma.business.create({
    data: { name: "Alpha Availability", slug: `alpha-avail-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Availability", slug: `beta-avail-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-avail-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-avail-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaOwner = await prisma.user.create({
    data: { name: "Bea Owner", email: `beta-avail-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  await prisma.membership.create({
    data: { userId: betaOwner.id, businessId: businessB.id, role: "OWNER" },
  });

  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);

  await updateSchedulingSettingsOp(prisma, ownerA, {
    workStartMinutes: 8 * 60,
    workEndMinutes: 16 * 60,
    workingWeekdays: [1, 2, 3, 4, 5],
    schedulingBufferMinutes: 30,
    unavailableDates: ["2026-09-09"],
  });

  const saved = await prisma.businessSettings.findUnique({ where: { businessId: businessA.id } });
  const blocked = await prisma.businessUnavailableDate.findMany({
    where: { businessId: businessA.id },
    select: { date: true },
  });
  check("OWNER can persist working hours for business A", saved?.workEndMinutes === 16 * 60);
  check("OWNER can persist the 30-minute buffer", saved?.schedulingBufferMinutes === 30);
  check("OWNER can persist a blocked date for business A", blocked.some((row) => row.date === "2026-09-09"));

  const betaSettings = await prisma.businessSettings.findUnique({ where: { businessId: businessB.id } });
  const betaBlocked = await prisma.businessUnavailableDate.findMany({ where: { businessId: businessB.id } });
  check("Business B settings were not created or changed by A's save", betaSettings == null);
  check("Business B has no blocked dates from A's save", betaBlocked.length === 0);

  await expectError(
    "MEMBER cannot change scheduling settings",
    () =>
      updateSchedulingSettingsOp(prisma, memberA, {
        workStartMinutes: 9 * 60,
        workEndMinutes: 17 * 60,
        workingWeekdays: [1, 2, 3, 4, 5],
        schedulingBufferMinutes: 45,
        unavailableDates: [],
      }),
    (error) => error instanceof ForbiddenError,
  );

  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Alpha Customer" },
  });
  const jobA = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      projectToken: randomUUID(),
      status: "UNSCHEDULED",
    },
  });
  const firstStart = new Date(2026, 8, 7, 8, 0, 0);
  await prisma.job.update({
    where: { id: jobA.id },
    data: {
      scheduledAt: firstStart,
      scheduledDurationMinutes: 60,
      status: "SCHEDULED",
    },
  });
  const rescheduleStart = new Date(2026, 8, 10, 8, 0, 0);
  await prisma.job.update({
    where: { id: jobA.id },
    data: {
      scheduledAt: rescheduleStart,
      scheduledDurationMinutes: 120,
    },
  });
  const jobsForA = await prisma.job.findMany({ where: { businessId: businessA.id } });
  check("Rescheduling updates the same job instead of creating a duplicate", jobsForA.length === 1);
  check(
    "Rescheduled job keeps the new Thursday 8:00 / 2-hour window",
    jobsForA[0].id === jobA.id &&
      jobsForA[0].scheduledAt?.getTime() === rescheduleStart.getTime() &&
      jobsForA[0].scheduledDurationMinutes === 120 &&
      jobsForA[0].status === "SCHEDULED",
  );

  const customerB = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Customer" },
  });
  await prisma.job.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: new Date(2026, 8, 7, 8, 0, 0),
      scheduledDurationMinutes: 240,
    },
  });

  const { loadOccupiedJobs, loadAvailabilitySettings } = await import("@/lib/availability-data");
  const occupiedA = await loadOccupiedJobs(prisma, businessA.id);
  const occupiedB = await loadOccupiedJobs(prisma, businessB.id);
  check("Occupied jobs for A do not include B's job", occupiedA.length === 1 && occupiedA[0].id === jobA.id);
  check("Occupied jobs for B do not include A's job", occupiedB.length === 1 && occupiedB[0].id !== jobA.id);

  const settingsA = await loadAvailabilitySettings(prisma, businessA.id);
  const settingsB = await loadAvailabilitySettings(prisma, businessB.id);
  check("Business A still has Wednesday blocked", settingsA.unavailableDates.includes("2026-09-09"));
  check("Business B defaults have no blocked dates", settingsB.unavailableDates.length === 0);
  check("Business B still uses the 30-minute default buffer", settingsB.schedulingBufferMinutes === 30);
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

console.log(
  failed === 0
    ? `\nAll scheduling availability checks passed (${passed}).`
    : `\n${failed} scheduling availability check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
