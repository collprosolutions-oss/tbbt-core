/**
 * Focused verification for Phase 3 / Step 3: the business-wide Schedule /
 * Jobs calendar built on top of the EXISTING Job scheduling fields
 * (scheduledAt, scheduledDurationMinutes, status) -- see src/lib/schedule.ts
 * and src/app/(app)/jobs/page.tsx. No second scheduling data source was
 * introduced, so this script proves the calendar layer (range math,
 * grouping, conflict detection, view/date parsing) and its wiring into the
 * real Job record, not a duplicate model.
 *
 * Combines:
 *   1. Pure-function checks against src/lib/schedule.ts (mirrors the
 *      scripts/check-estimate-versions.mjs pattern) -- no database needed.
 *   2. Prisma-level checks that mirror the exact scheduleJob() transition
 *      logic in src/app/actions/job.ts (mirrors the "simulate*" pattern in
 *      scripts/check-work-order-portal.mjs, since that action needs
 *      next/headers request context a plain script doesn't have).
 *   3. A real HTTP round-trip against the BUILT app (mirrors
 *      scripts/check-management-console-access.mjs) for authorization,
 *      tenant isolation, and each calendar view's actual rendered content.
 *
 * Run with:
 *   npm run build && node --experimental-strip-types scripts/check-schedule-calendar.mjs
 */
import { createRequire } from "node:module";
import { register } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

// src/lib/schedule.ts imports src/lib/job-schedule.ts via this repo's
// "@/lib/job-schedule" TypeScript path alias (deliberately, so the
// calendar's conflict detection reuses the exact same schedulesOverlap()
// scheduleJob() already uses -- see src/lib/schedule.ts's own header
// comment). A plain Node script has no bundler to resolve that alias, so
// register a tiny loader hook for it before importing anything from src/.
register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  addDays,
  addMonths,
  dayRange,
  dayTone,
  findScheduleConflicts,
  formatISODate,
  groupJobsByDay,
  monthGridRange,
  parseScheduleDate,
  parseScheduleView,
  startOfDay,
  startOfWeek,
  weekRange,
} = await import("../src/lib/schedule.ts");
const { formatDateTime } = await import("../src/lib/format.ts");

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

// --- 1. Pure-function checks (no database) -----------------------------

console.log("\nTEST 16 (parsing) — Invalid view/date query params fail safely to sensible defaults");
check('parseScheduleView("month") === "month"', parseScheduleView("month") === "month");
check('parseScheduleView("week") === "week"', parseScheduleView("week") === "week");
check('parseScheduleView("crew") === "crew"', parseScheduleView("crew") === "crew");
check(
  'parseScheduleView("not-a-real-view") defaults to "month"',
  parseScheduleView("not-a-real-view") === "month",
);
check(
  "parseScheduleView(undefined) defaults to \"month\"",
  parseScheduleView(undefined) === "month",
);
check(
  'parseScheduleView(["week", "day"]) (duplicate query param) takes the first value',
  parseScheduleView(["week", "day"]) === "week",
);

const today = startOfDay(new Date());
check(
  "parseScheduleDate(undefined) defaults to today",
  parseScheduleDate(undefined).getTime() === today.getTime(),
);
check(
  'parseScheduleDate("garbage") defaults to today, does not throw',
  parseScheduleDate("garbage").getTime() === today.getTime(),
);
check(
  'parseScheduleDate("2026-02-30") (a real string, not a real calendar date) defaults to today, not a silently-normalized March date',
  parseScheduleDate("2026-02-30").getTime() === today.getTime(),
);
const parsed = parseScheduleDate("2026-08-15");
check(
  'parseScheduleDate("2026-08-15") resolves to exactly Aug 15, 2026',
  parsed.getFullYear() === 2026 && parsed.getMonth() === 7 && parsed.getDate() === 15,
);

console.log("\nEXTRA — Date range math used by every calendar view");
const augAnchor = new Date(2026, 7, 15); // Aug 15, 2026 (mid-month, arbitrary day)
const monthRange = monthGridRange(augAnchor);
check("Month grid's monthStart is exactly Aug 1, 2026", formatISODate(monthRange.monthStart) === "2026-08-01");
check("Month grid's monthEnd is exactly Sep 1, 2026 (exclusive)", formatISODate(monthRange.monthEnd) === "2026-09-01");
check("Month grid start is a Sunday", monthRange.start.getDay() === 0);
check("Month grid is made of complete weeks", monthRange.days.length % 7 === 0);
check(
  "Month grid includes every real day of August",
  monthRange.days.some((d) => formatISODate(d) === "2026-08-01") &&
    monthRange.days.some((d) => formatISODate(d) === "2026-08-31"),
);
check(
  "Month grid query range is bounded (not the entire Job history) -- only the visible weeks",
  (monthRange.end.getTime() - monthRange.start.getTime()) / (24 * 60 * 60 * 1000) <= 42,
);

const wkRange = weekRange(augAnchor);
check("Week range is exactly 7 days", wkRange.days.length === 7);
check("Week range starts on a Sunday", wkRange.start.getDay() === 0);
check(
  "Week range contains the anchor date",
  wkRange.days.some((d) => formatISODate(d) === formatISODate(augAnchor)),
);

const dRange = dayRange(augAnchor);
check(
  "Day range is exactly 24 hours starting at the anchor day",
  dRange.end.getTime() - dRange.start.getTime() === 24 * 60 * 60 * 1000,
);
check(
  "Day range starts at local midnight of the anchor date",
  formatISODate(dRange.start) === formatISODate(augAnchor),
);

console.log("\nEXTRA — TIME VISUAL RULES: past/today/future classification");
const refToday = new Date(2026, 7, 15);
check("A day before today is 'past'", dayTone(addDays(refToday, -1), refToday) === "past");
check("Today itself is 'today'", dayTone(refToday, refToday) === "today");
check("A day after today is 'future'", dayTone(addDays(refToday, 1), refToday) === "future");
check(
  "A day next month is 'future'",
  dayTone(addMonths(refToday, 1), refToday) === "future",
);
check(
  "startOfWeek() always lands on a Sunday, any day of the week given",
  [0, 1, 2, 3, 4, 5, 6].every((offset) => startOfWeek(addDays(refToday, offset)).getDay() === 0),
);

console.log(
  "\nTEST 17 (pure) — Conflict detection only claims conflicts the schedule data actually supports",
);
const baseTime = new Date(2026, 7, 15, 9, 0, 0);
const jobA = { id: "a", status: "SCHEDULED", scheduledAt: baseTime, scheduledDurationMinutes: 60 };
const jobB = {
  // Starts 30 minutes into Job A's 60-minute window -- a real overlap.
  id: "b",
  status: "SCHEDULED",
  scheduledAt: new Date(baseTime.getTime() + 30 * 60 * 1000),
  scheduledDurationMinutes: 60,
};
const jobC = {
  // Starts exactly when Job B's window ends -- adjacent to both A and B,
  // not overlapping either.
  id: "c",
  status: "SCHEDULED",
  scheduledAt: new Date(baseTime.getTime() + 90 * 60 * 1000),
  scheduledDurationMinutes: 30,
};
const jobDNoDuration1 = {
  id: "d",
  status: "SCHEDULED",
  scheduledAt: new Date(2026, 7, 15, 14, 0, 0),
  scheduledDurationMinutes: null,
};
const jobDNoDuration2 = {
  // A different instant, 30 minutes later, with no duration on either side
  // -- must NOT be fabricated into a conflict.
  id: "e",
  status: "SCHEDULED",
  scheduledAt: new Date(2026, 7, 15, 14, 30, 0),
  scheduledDurationMinutes: null,
};
const jobSameInstantNoDuration = {
  // The exact same instant as jobDNoDuration1, still with no duration --
  // this one legitimately IS a real, known conflict (two jobs literally at
  // the same minute), so it must still be flagged.
  id: "f",
  status: "SCHEDULED",
  scheduledAt: new Date(2026, 7, 15, 14, 0, 0),
  scheduledDurationMinutes: null,
};
const jobCompletedOverlap = {
  // Would overlap Job A's window, but is COMPLETED -- a finished job cannot
  // be "in conflict" with anything.
  id: "g",
  status: "COMPLETED",
  scheduledAt: new Date(baseTime.getTime() + 15 * 60 * 1000),
  scheduledDurationMinutes: 30,
};

const conflicts = findScheduleConflicts([
  jobA,
  jobB,
  jobC,
  jobDNoDuration1,
  jobDNoDuration2,
  jobSameInstantNoDuration,
  jobCompletedOverlap,
]);
check("Job A (9:00-10:00) and Job B (9:30-10:30) really do overlap -> flagged", conflicts.has("a") && conflicts.has("b"));
check(
  "Job C starts exactly when Job B's window ends (10:30) -> adjacent, correctly NOT flagged",
  !conflicts.has("c"),
);
check(
  "Two duration-less jobs at DIFFERENT instants (2:00 vs 2:30) are NOT fabricated into a conflict",
  !conflicts.has("d") || !(conflicts.get("d") ?? []).some((j) => j.id === "e"),
);
check(
  "Two duration-less jobs at the SAME instant (both 2:00) are still correctly flagged -- a real, known conflict",
  conflicts.has("d") && conflicts.has("f"),
);
check(
  "A COMPLETED job is never flagged as conflicting, even when its window truly overlaps an active job",
  !conflicts.has("g"),
);

console.log("\nEXTRA — groupJobsByDay() buckets only Jobs with a real scheduledAt");
const grouped = groupJobsByDay([
  { id: "x", scheduledAt: new Date(2026, 7, 1, 9, 0) },
  { id: "y", scheduledAt: new Date(2026, 7, 1, 14, 0) },
  { id: "z", scheduledAt: new Date(2026, 7, 2, 9, 0) },
  { id: "w", scheduledAt: null },
]);
check("Aug 1 bucket has both jobs scheduled that day", (grouped.get("2026-08-01") ?? []).length === 2);
check("Aug 2 bucket has exactly the one job scheduled that day", (grouped.get("2026-08-02") ?? []).length === 1);
check(
  "A Job with no scheduledAt is never placed in any day bucket (not fabricated)",
  ![...grouped.values()].some((jobs) => jobs.some((j) => j.id === "w")),
);

// --- 2. Prisma-level + HTTP checks (requires the built app) -------------

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error(
    "\nDATABASE_URL must be set (pointing at a reachable Postgres server) to run the rest of this check.",
  );
  process.exit(failures === 0 ? 1 : 1);
}

const repoRoot = new URL("..", import.meta.url).pathname;

if (!existsSync(`${repoRoot}.next`)) {
  console.error(
    "\nNo .next build output found. Run `npm run build` before this check (see script header).",
  );
  process.exit(1);
}

const testDbName = "tbbt_schedule_calendar_test";
const dbUrl = new URL(baseUrl);
dbUrl.pathname = `/${testDbName}`;
const testUrl = dbUrl.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for schedule-calendar test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

/** Mirrors the guarded transition inside scheduleJob() in src/app/actions/job.ts (excluding the overlap-warning short-circuit, already covered by test:authorization / the schedule form's own confirmOverlap flow). */
async function simulateScheduleJob(jobId, businessId, scheduledAt, durationMinutes) {
  const job = await prisma.job.findFirst({ where: { id: jobId, businessId } });
  if (job.status === "COMPLETED") {
    return { ok: false, reason: "completed" };
  }
  await prisma.job.update({
    where: { id: job.id },
    data: {
      scheduledAt,
      scheduledDurationMinutes: durationMinutes,
      ...(job.status === "UNSCHEDULED" ? { status: "SCHEDULED" } : {}),
    },
  });
  return { ok: true, job: await prisma.job.findUnique({ where: { id: job.id } }) };
}

const PORT = 43823;
const APP_URL = `http://127.0.0.1:${PORT}`;

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${APP_URL}/sign-in`, { redirect: "manual" });
      if (res.status < 500) {
        return true;
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

function cookieHeader(session) {
  return `tbbt_session=${session.token}; tbbt_workspace=${session.businessId}`;
}

async function fetchRaw(session, path) {
  const res = await fetch(`${APP_URL}${path}`, {
    redirect: "manual",
    headers: { cookie: cookieHeader(session) },
  });
  const body = await res.text().catch(() => "");
  return { status: res.status, location: res.headers.get("location"), body };
}

let serverProcess;

try {
  const businessA = await prisma.business.create({
    data: { name: "Alpha Handyman", slug: "alpha-handyman-schedule", tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Handyman", slug: "beta-handyman-schedule", tradeCode: "HANDYMAN" },
  });

  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: "owner@schedule-test.example", passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Amir Admin", email: "admin@schedule-test.example", passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: "member@schedule-test.example", passwordHash: "x" },
  });
  const betaOwnerUser = await prisma.user.create({
    data: { name: "Beto Owner", email: "owner@beta-schedule-test.example", passwordHash: "x" },
  });

  await prisma.membership.create({ data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" } });
  await prisma.membership.create({ data: { userId: adminUser.id, businessId: businessA.id, role: "ADMIN" } });
  await prisma.membership.create({ data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" } });
  await prisma.membership.create({ data: { userId: betaOwnerUser.id, businessId: businessB.id, role: "OWNER" } });

  const farFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  async function makeSession(user, businessId) {
    const sessionToken = randomUUID();
    await prisma.session.create({
      data: { userId: user.id, tokenHash: hashToken(sessionToken), expiresAt: farFuture },
    });
    return { token: sessionToken, businessId };
  }
  const ownerSession = await makeSession(ownerUser, businessA.id);
  const adminSession = await makeSession(adminUser, businessA.id);
  const memberSession = await makeSession(memberUser, businessA.id);
  const betaOwnerSession = await makeSession(betaOwnerUser, businessB.id);

  // A fixed "current month" anchor so this test is deterministic regardless
  // of the real calendar date it happens to run on.
  const anchor = new Date(2026, 7, 15); // Aug 15, 2026
  const anchorIso = formatISODate(anchor);
  const dayInMonth = new Date(2026, 7, 10, 9, 0, 0); // Aug 10, 2026, 9:00 AM
  const dayInMonthIso = formatISODate(dayInMonth);

  const CANARY_A = "Cara Alpha Canary Q9x";
  const CANARY_B = "Beta Canary Customer P4z";

  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: CANARY_A, email: "alpha@example.com" },
  });
  const propertyA = await prisma.property.create({
    data: { businessId: businessA.id, customerId: customerA.id, addressLine1: "1 Alpha St" },
  });

  console.log("\nTEST 1/2/3 — OWNER and ADMIN can access Schedule; MEMBER cannot");
  serverProcess = spawn(
    "node_modules/.bin/next",
    ["start", "--hostname", "127.0.0.1", "--port", String(PORT)],
    {
      cwd: repoRoot.replace(/\/$/, ""),
      env: { ...process.env, DATABASE_URL: testUrl, NODE_ENV: "production" },
      stdio: "pipe",
    },
  );
  let serverOutput = "";
  serverProcess.stdout.on("data", (chunk) => (serverOutput += chunk.toString()));
  serverProcess.stderr.on("data", (chunk) => (serverOutput += chunk.toString()));

  const up = await waitForServer(30_000);
  if (!up) {
    console.error("Server did not start in time. Output so far:\n" + serverOutput);
    process.exit(1);
  }

  const ownerMonth = await fetchRaw(ownerSession, `/jobs?view=month&date=${anchorIso}`);
  check("TEST 1 - OWNER GET /jobs?view=month returns 200 (no redirect)", ownerMonth.status === 200);
  check("TEST 1 - OWNER sees the real Schedule page (nav present)", ownerMonth.body.includes("Unscheduled Jobs"));

  const adminMonth = await fetchRaw(adminSession, `/jobs?view=month&date=${anchorIso}`);
  check("TEST 2 - ADMIN GET /jobs?view=month returns 200 (no redirect)", adminMonth.status === 200);
  check("TEST 2 - ADMIN sees the real Schedule page (nav present)", adminMonth.body.includes("Unscheduled Jobs"));

  const memberMonth = await fetchRaw(memberSession, `/jobs?view=month&date=${anchorIso}`);
  check(
    "TEST 3 - MEMBER GET /jobs?view=month is redirected server-side (307 -> /access-restricted), not rendered",
    memberMonth.status === 307 && memberMonth.location === "/access-restricted",
  );
  check("TEST 3 - MEMBER never receives any Schedule content", !memberMonth.body.includes("Unscheduled Jobs"));
  for (const view of ["week", "day", "crew", "list"]) {
    const memberView = await fetchRaw(memberSession, `/jobs?view=${view}&date=${anchorIso}`);
    check(
      `TEST 3 - MEMBER GET /jobs?view=${view} is also redirected server-side, not rendered`,
      memberView.status === 307 && memberView.location === "/access-restricted",
    );
  }

  console.log("\nTEST 9 — UNSCHEDULED Jobs appear in the Unscheduled Jobs area, with a way to schedule them directly");
  const unscheduledJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      projectToken: randomUUID(),
      status: "UNSCHEDULED",
    },
  });
  const monthWithUnscheduled = await fetchRaw(ownerSession, `/jobs?view=month&date=${anchorIso}`);
  check(
    "Unscheduled job's customer name appears on the Month view page (in the Unscheduled Jobs panel)",
    monthWithUnscheduled.body.includes(CANARY_A),
  );
  check(
    "The Unscheduled Jobs panel reuses the real Schedule Job form/action (same jobId hidden field), not a second scheduling UI",
    monthWithUnscheduled.body.includes(`name="jobId" value="${unscheduledJob.id}"`) &&
      monthWithUnscheduled.body.includes("Schedule Job"),
  );
  check(
    "Unscheduled Job's Work Order is reachable directly from the panel",
    monthWithUnscheduled.body.includes(`/jobs/${unscheduledJob.id}`),
  );

  console.log("\nTEST 10 — Scheduling an UNSCHEDULED Job updates the existing Job correctly (no second record created)");
  const beforeCount = await prisma.job.count({ where: { businessId: businessA.id } });
  const scheduleResult = await simulateScheduleJob(unscheduledJob.id, businessA.id, dayInMonth, 60);
  check("Scheduling an UNSCHEDULED job succeeds", scheduleResult.ok === true);
  check("Job flips UNSCHEDULED -> SCHEDULED", scheduleResult.job.status === "SCHEDULED");
  check("Job's scheduledAt is set to the chosen time", scheduleResult.job.scheduledAt.getTime() === dayInMonth.getTime());
  const afterCount = await prisma.job.count({ where: { businessId: businessA.id } });
  check("No second Job/appointment record was created by scheduling", afterCount === beforeCount);

  console.log("\nTEST 4/5/13 — Month view shows Jobs scheduled within the selected month, opens the correct Work Order, and excludes jobs outside the month");
  const nextMonthJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      // Sept 15, 2026 -- well into the following month, safely outside any
      // trailing-week padding the Aug 2026 month grid might include.
      scheduledAt: new Date(2026, 8, 15, 9, 0, 0),
      scheduledDurationMinutes: 60,
    },
  });
  const monthAfterSchedule = await fetchRaw(ownerSession, `/jobs?view=month&date=${anchorIso}`);
  check("TEST 4 - Month view (Aug 2026) shows the job now scheduled inside August", monthAfterSchedule.body.includes(`/jobs/${unscheduledJob.id}`));
  check(
    "TEST 13 - The Month view's Job link points at that exact Job's Work Order",
    monthAfterSchedule.body.includes(`href="/jobs/${unscheduledJob.id}"`),
  );
  check(
    "TEST 5 - Month view (Aug 2026) does NOT include a Job scheduled in September",
    !monthAfterSchedule.body.includes(`/jobs/${nextMonthJob.id}`),
  );
  const workOrderPage = await fetchRaw(ownerSession, `/jobs/${unscheduledJob.id}`);
  check("Clicking through actually opens the correct Job's own Work Order", workOrderPage.body.includes(CANARY_A));

  console.log("\nTEST 11 — Rescheduling a Job updates the calendar AND the Work Order from the same record");
  const rescheduledTime = new Date(2026, 7, 20, 13, 0, 0); // Aug 20, 2026, 1:00 PM
  const rescheduledIso = formatISODate(rescheduledTime);
  const rescheduleResult = await simulateScheduleJob(unscheduledJob.id, businessA.id, rescheduledTime, 90);
  check("Reschedule succeeds", rescheduleResult.ok === true);
  check("Job status stays SCHEDULED (not reverted to UNSCHEDULED)", rescheduleResult.job.status === "SCHEDULED");
  const newDayView = await fetchRaw(ownerSession, `/jobs?view=day&date=${rescheduledIso}`);
  check("Day view for the NEW date shows the rescheduled job", newDayView.body.includes(`/jobs/${unscheduledJob.id}`));
  const oldDayView = await fetchRaw(ownerSession, `/jobs?view=day&date=${dayInMonthIso}`);
  check("Day view for the OLD date no longer shows it (moved, not duplicated)", !oldDayView.body.includes(`/jobs/${unscheduledJob.id}`));
  const workOrderAfterReschedule = await fetchRaw(ownerSession, `/jobs/${unscheduledJob.id}`);
  check(
    "The Work Order page reflects the new appointment time, same underlying record",
    workOrderAfterReschedule.body.includes(formatDateTime(rescheduledTime).split(",")[0]),
  );

  console.log("\nTEST 12 — Scheduling/rescheduling never corrupts IN_PROGRESS or COMPLETED lifecycle");
  const inProgressJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      projectToken: randomUUID(),
      status: "IN_PROGRESS",
      scheduledAt: new Date(2026, 7, 5, 9, 0, 0),
      scheduledDurationMinutes: 60,
    },
  });
  const inProgressResult = await simulateScheduleJob(
    inProgressJob.id,
    businessA.id,
    new Date(2026, 7, 6, 9, 0, 0),
    60,
  );
  check("Rescheduling an IN_PROGRESS job succeeds", inProgressResult.ok === true);
  check(
    "...and its status is NOT moved backward to SCHEDULED or UNSCHEDULED just because the schedule changed",
    inProgressResult.job.status === "IN_PROGRESS",
  );

  const completedJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      projectToken: randomUUID(),
      status: "COMPLETED",
      scheduledAt: new Date(2026, 7, 3, 9, 0, 0),
      scheduledDurationMinutes: 60,
    },
  });
  const completedResult = await simulateScheduleJob(
    completedJob.id,
    businessA.id,
    new Date(2026, 7, 25, 9, 0, 0),
    60,
  );
  check("Attempting to reschedule a COMPLETED job is refused", completedResult.ok === false);
  const completedAfter = await prisma.job.findUnique({ where: { id: completedJob.id } });
  check(
    "...and its original scheduledAt is completely untouched by the refused attempt",
    completedAfter.scheduledAt.getTime() === new Date(2026, 7, 3, 9, 0, 0).getTime(),
  );
  check("...and its status remains COMPLETED", completedAfter.status === "COMPLETED");

  console.log("\nTEST 6 — Week view shows exactly the selected week's Jobs");
  const weekAnchor = new Date(2026, 7, 10); // a Monday inside the week containing Aug 10
  const weekRangeResult = weekRange(weekAnchor);
  const weekJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: new Date(weekRangeResult.start.getTime() + 2 * 24 * 60 * 60 * 1000 + 9 * 60 * 60 * 1000),
      scheduledDurationMinutes: 60,
    },
  });
  const outOfWeekJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: addDays(weekRangeResult.end, 3),
      scheduledDurationMinutes: 60,
    },
  });
  const weekViewPage = await fetchRaw(ownerSession, `/jobs?view=week&date=${formatISODate(weekAnchor)}`);
  check("Week view includes a job scheduled inside that week", weekViewPage.body.includes(`/jobs/${weekJob.id}`));
  check("Week view excludes a job scheduled outside that week", !weekViewPage.body.includes(`/jobs/${outOfWeekJob.id}`));

  console.log("\nTEST 7 — Day view shows the selected day's Jobs in chronological order");
  const chronoDay = new Date(2026, 7, 12);
  const chronoDayIso = formatISODate(chronoDay);
  const laterJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: new Date(2026, 7, 12, 15, 0, 0),
      scheduledDurationMinutes: 30,
    },
  });
  const earlierJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: new Date(2026, 7, 12, 8, 0, 0),
      scheduledDurationMinutes: 30,
    },
  });
  const dayViewPage = await fetchRaw(ownerSession, `/jobs?view=day&date=${chronoDayIso}`);
  check("Day view includes both of this day's jobs", dayViewPage.body.includes(`/jobs/${laterJob.id}`) && dayViewPage.body.includes(`/jobs/${earlierJob.id}`));
  check(
    "Day view lists them in chronological (start-time) order -- the 8:00 AM job before the 3:00 PM job",
    dayViewPage.body.indexOf(`/jobs/${earlierJob.id}`) < dayViewPage.body.indexOf(`/jobs/${laterJob.id}`),
  );

  console.log(
    "\nTEST 8 — Crew view groups Jobs by their REAL assignment (Phase 3 / Step 4), and keeps a truthful Unassigned bucket",
  );
  const crewViewBefore = await fetchRaw(ownerSession, `/jobs?view=crew&date=${anchorIso}`);
  check(
    "Before any assignment exists, Crew view groups real scheduled jobs under Unassigned",
    crewViewBefore.body.includes("Unassigned"),
  );
  check(
    "Crew view includes a real SCHEDULED job from this month (as Unassigned)",
    crewViewBefore.body.includes(`/jobs/${weekJob.id}`) || crewViewBefore.body.includes(`/jobs/${scheduleResult.job.id}`),
  );
  check(
    "Crew view (bounded to the selected month) does not include a Job scheduled in a different month",
    !crewViewBefore.body.includes(`/jobs/${nextMonthJob.id}`),
  );

  // memberUser (businessA MEMBER, created earlier for the access-control
  // tests above) doubles as the eligible employee here -- assign them to
  // weekJob directly (mirroring assignJobMember() in
  // src/app/actions/job.ts) and confirm Crew view now shows a REAL
  // per-employee group, not the old single Unassigned bucket for
  // everything.
  const memberMembership = await prisma.membership.findFirstOrThrow({
    where: { userId: memberUser.id, businessId: businessA.id },
  });
  await prisma.job.update({
    where: { id: weekJob.id },
    data: { assignedMembershipId: memberMembership.id },
  });

  const crewViewAfter = await fetchRaw(ownerSession, `/jobs?view=crew&date=${anchorIso}`);
  check(
    "Crew view now shows a real group for the assigned member's name",
    crewViewAfter.body.includes(memberUser.name),
  );
  check(
    "The assigned job appears under that member's group",
    crewViewAfter.body.indexOf(memberUser.name) < crewViewAfter.body.indexOf(`/jobs/${weekJob.id}`) &&
      crewViewAfter.body.indexOf(`/jobs/${weekJob.id}`) <
        crewViewAfter.body.indexOf("Unassigned"),
  );
  check(
    "Unassigned bucket still exists and still contains a real still-unassigned job this month",
    crewViewAfter.body.includes("Unassigned") &&
      (crewViewAfter.body.includes(`/jobs/${scheduleResult.job.id}`)),
  );
  check(
    "The now-assigned job no longer appears under Unassigned",
    crewViewAfter.body.indexOf(`/jobs/${weekJob.id}`) < crewViewAfter.body.indexOf("Unassigned"),
  );
  check(
    "Crew view (bounded to the selected month) still does not include a Job scheduled in a different month",
    !crewViewAfter.body.includes(`/jobs/${nextMonthJob.id}`),
  );

  console.log("\nTEST 17 (HTTP) — Conflict UI only appears where the underlying data really overlaps");
  const overlapBase = new Date(2026, 7, 18, 9, 0, 0);
  const overlapJob1 = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: overlapBase,
      scheduledDurationMinutes: 90,
    },
  });
  const overlapJob2 = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: new Date(overlapBase.getTime() + 30 * 60 * 1000),
      scheduledDurationMinutes: 60,
    },
  });
  const nonOverlapJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: new Date(2026, 7, 18, 14, 0, 0),
      scheduledDurationMinutes: 30,
    },
  });
  const overlapDayView = await fetchRaw(ownerSession, `/jobs?view=day&date=2026-08-18`);
  function jobRowHtml(body, jobId) {
    const start = body.indexOf(`href="/jobs/${jobId}"`);
    if (start === -1) {
      return "";
    }
    const end = body.indexOf("</a>", start);
    return end === -1 ? "" : body.slice(start, end);
  }
  check(
    "Job 1 (9:00-10:30) really overlaps Job 2 (9:30-10:30) -> its own row is flagged",
    jobRowHtml(overlapDayView.body, overlapJob1.id).includes("Possible scheduling conflict"),
  );
  check(
    "Job 2's own row is flagged too (the conflict is mutual, not one-sided)",
    jobRowHtml(overlapDayView.body, overlapJob2.id).includes("Possible scheduling conflict"),
  );
  check(
    "A same-day Job with no real overlap (2:00-2:30, well after the others end) is correctly NOT flagged",
    !jobRowHtml(overlapDayView.body, nonOverlapJob.id).includes("Possible scheduling conflict"),
  );
  check(
    "Overlap detection page also documents its own known limitation (never silently over-claims precision)",
    monthAfterSchedule.body.includes("A Job with no saved duration is compared as a single instant"),
  );

  console.log("\nTEST 15 — Customer Project Portal reflects the updated schedule for its own Job only");
  const portalBefore = await fetch(`${APP_URL}/p/${unscheduledJob.projectToken}`, { redirect: "manual" });
  const portalBeforeBody = await portalBefore.text();
  check(
    "Customer portal shows the rescheduled appointment time for this job",
    portalBeforeBody.includes("Scheduled") && portalBeforeBody.includes(formatDateTime(rescheduledTime).split(",")[0]),
  );

  console.log("\nTEST 14 — Business A cannot see Business B's Jobs on the Schedule calendar");
  const customerB = await prisma.customer.create({
    data: { businessId: businessB.id, name: CANARY_B },
  });
  const propertyB = await prisma.property.create({
    data: { businessId: businessB.id, customerId: customerB.id, addressLine1: "9 Beta Canary Ln" },
  });
  const betaJob = await prisma.job.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      propertyId: propertyB.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: dayInMonth,
      scheduledDurationMinutes: 60,
    },
  });
  const alphaMonthView = await fetchRaw(ownerSession, `/jobs?view=month&date=${anchorIso}`);
  check("Business A's Month view never shows Business B's canary customer", !alphaMonthView.body.includes(CANARY_B));
  check("Business A's Month view never links to Business B's job", !alphaMonthView.body.includes(`/jobs/${betaJob.id}`));
  const betaMonthView = await fetchRaw(betaOwnerSession, `/jobs?view=month&date=${anchorIso}`);
  check("Business B's own Month view DOES show its own job", betaMonthView.body.includes(`/jobs/${betaJob.id}`));
  check("Business B's own Month view never shows Business A's canary customer", !betaMonthView.body.includes(CANARY_A));
  check(
    "Business B's Unscheduled Jobs panel never shows any of Business A's Job ids",
    !betaMonthView.body.includes(`/jobs/${nextMonthJob.id}`) && !betaMonthView.body.includes(`/jobs/${completedJob.id}`),
  );

  console.log("\nTEST 16 (HTTP) — Invalid view/date query params render a safe default, never a 500");
  const invalidView = await fetchRaw(ownerSession, "/jobs?view=not-a-real-view&date=also-not-a-date");
  check("An invalid view/date combination still returns 200 (safe default), not a server error", invalidView.status === 200);
  check(
    "...and it silently falls back to Month view content (Unscheduled Jobs panel present)",
    invalidView.body.includes("Unscheduled Jobs"),
  );
  const invalidDateOnly = await fetchRaw(ownerSession, "/jobs?view=week&date=2026-13-99");
  check("An out-of-range date also fails safely with a 200, not a crash", invalidDateOnly.status === 200);

  console.log(
    failures === 0
      ? "\nAll schedule-calendar checks passed."
      : `\n${failures} schedule-calendar check(s) failed.`,
  );
} finally {
  if (serverProcess) {
    serverProcess.kill("SIGKILL");
  }
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
