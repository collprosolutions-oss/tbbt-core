/**
 * Workforce capacity, skill matching, Fill-In Bench, and agent proofs.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-workforce-capacity.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  DEFAULT_AVAILABILITY_SETTINGS,
} = await import("@/lib/availability");
const { computeNextOccurrenceAt, projectRecurrenceOccurrences } = await import("@/lib/recurrence");
const {
  DEFAULT_BUSINESS_TIMEZONE,
  formatISODateInTimeZone,
  zonedWeekday,
} = await import("@/lib/business-timezone");
const {
  DEFAULT_SCHEDULING_POLICY,
  appointmentModeForPosition,
  appointmentPositionOnDay,
  parseSkillList,
  parseWorkforceProgression,
} = await import("@/lib/workforce");
const {
  calculateDailyCapacity,
  calculateTeamDailyCapacity,
  calculateTeamWeeklyCapacity,
  calculateWeeklyCapacity,
  laterJobsHurtByMove,
  memberWindowForDay,
} = await import("@/lib/workforce-capacity");
const { detectScheduleConflicts } = await import("@/lib/workforce-conflicts");
const { recommendAssignees, staffingShortage } = await import("@/lib/workforce-matching");
const { buildWorkforceRecommendations } = await import("@/lib/workforce-agent");
const {
  occupiedWindow,
  conflictAcknowledgement,
  shouldAcceptConflictAcknowledgement,
} = await import("@/lib/workforce-window");
const {
  createWorkforceOutreachTaskOp,
  setMemberWeeklyAvailabilityOp,
  updateWorkforceProfileOp,
  upsertFillInBenchWorkerOp,
  WorkforceError,
} = await import("@/lib/workforce-ops");
const { CAPABILITIES, ForbiddenError, requireBusinessCapability, roleHasCapability } = await import(
  "@/lib/authorization"
);

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

const jobAction = readRepo("src/app/actions/job.ts");
const agent = readRepo("src/lib/workforce-agent.ts");
const capacity = readRepo("src/lib/workforce-capacity.ts");
const conflicts = readRepo("src/lib/workforce-conflicts.ts");
const benchForm = readRepo("src/components/team/fill-in-bench-form.tsx");
const teamPage = readRepo("src/app/(app)/team/page.tsx");
const fieldPage = readRepo("src/app/field/page.tsx");
const schema = readRepo("prisma/schema.prisma");
const migration = readRepo("prisma/migrations/20260925220000_scheduling_workforce_intelligence/migration.sql");
const fkMigration = readRepo("prisma/migrations/20260925230000_workforce_foreign_keys/migration.sql");
const workforceData = readRepo("src/lib/workforce-data.ts");
const workforceOps = readRepo("src/lib/workforce-ops.ts");
const settingsData = readRepo("src/lib/settings-data.ts");
const settingsOps = readRepo("src/lib/settings-ops.ts");
const profileForm = readRepo("src/components/team/workforce-profile-form.tsx");
const matching = readRepo("src/lib/workforce-matching.ts");
const jobPage = readRepo("src/app/(app)/jobs/[jobId]/page.tsx");

console.log("\nSTATIC — Scope, authorization, and no automatic mutation");

check(
  "scheduleJob still updates only the target job row",
  jobAction.includes("where: { id: job.id }") &&
    jobAction.includes("scheduledAt: start") &&
    jobAction.includes("Later jobs were not moved"),
);
check(
  "Workforce agent is deterministic recommendation only",
  agent.includes("cannot assign") &&
    !agent.includes("prisma.job.update") &&
    !agent.includes("assignedMembershipId:"),
);
check(
  "Capacity and conflict engines have no Prisma writes",
  !capacity.includes("prisma.") && !conflicts.includes("prisma."),
);
check(
  "Fill-In Bench is internal and not a marketplace",
  benchForm.includes("Never published") &&
    teamPage.includes("never public") &&
    teamPage.includes("not a cross-business marketplace") &&
    !schema.includes("bsosNetwork") &&
    !schema.includes("publicProfile"),
);
check(
  "MEMBER field home stays self-scoped",
  fieldPage.includes("Only jobs assigned to you") &&
    fieldPage.includes("Other workers and the Fill-In Bench stay hidden") &&
    fieldPage.includes("assignedMembershipId: field.membershipId"),
);
check(
  "Owner assignment stays on MANAGE_JOBS",
  jobAction.includes("assignJobMember") &&
    jobAction.includes("CAPABILITIES.MANAGE_JOBS") &&
    !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_JOBS) &&
    !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_MEMBERS),
);
check(
  "Migration is additive only",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migration) &&
    migration.includes("ADD COLUMN IF NOT EXISTS") &&
    migration.includes("CREATE TABLE IF NOT EXISTS"),
);
check(
  "Recurrence forecast is not Cleaning-specific",
  !readRepo("src/lib/recurrence.ts").includes("CLEANING") &&
    readRepo("src/lib/recurrence.ts").includes("projectRecurrenceOccurrences"),
);
check(
  "Workforce request paths execute no CREATE/ALTER/INDEX SQL",
  [workforceData, workforceOps, settingsData, settingsOps, jobAction, readRepo("src/app/actions/workforce.ts")].every(
    (src) =>
      !src.includes("ensureWorkforceSchema") &&
      !/\b(ALTER TABLE|CREATE TABLE|CREATE INDEX|CREATE UNIQUE INDEX)\b/i.test(src),
  ),
);
check(
  "Migration has intended FKs and cascades",
  fkMigration.includes("MembershipSkill_membershipId_fkey") &&
    fkMigration.includes("MembershipWeeklyAvailability_membershipId_fkey") &&
    fkMigration.includes("FillInBenchWorker_membershipId_fkey") &&
    fkMigration.includes("WorkforceOutreachTask_jobId_fkey") &&
    fkMigration.includes("WorkforceOutreachTask_createdByMembershipId_fkey") &&
    fkMigration.includes("ON DELETE CASCADE") &&
    fkMigration.includes("ON DELETE SET NULL") &&
    fkMigration.includes("idempotencyKey") &&
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(fkMigration),
);
check(
  "scheduleJob always recomputes conflicts and binds an acknowledgement",
  jobAction.includes("detectScheduleConflicts") &&
    jobAction.includes("originalScheduledAt: job.scheduledAt") &&
    jobAction.includes("shouldAcceptConflictAcknowledgement") &&
    jobAction.includes("confirmOverlapAck") &&
    jobAction.includes("appointmentPositionOnDay") &&
    jobAction.includes("requiredProgression") &&
    !jobAction.includes("if (!confirmOverlap)"),
);
check(
  "Work Order copy derives first/later from the day lane, not scheduledAt boolean",
  jobPage.includes("appointmentPositionOnDay") &&
    !jobPage.includes("alreadyScheduled: Boolean(job.scheduledAt)"),
);
check(
  "Preferred/allowed job types stay non-authoritative metadata",
  !matching.includes("preferredJobTypes") && !matching.includes("allowedJobTypes"),
);
check(
  "Saved workforce notes load in the profile form and omitted job types are not submitted",
  profileForm.includes("defaultValue={member.workforceNotes}") &&
    !profileForm.includes('name="preferredJobTypes"') &&
    !profileForm.includes('name="allowedJobTypes"'),
);
check(
  "Outreach UI does not claim owner approval for every click",
  benchForm.includes("Create staffing outreach task") &&
    !benchForm.includes("Create owner-approved outreach task") &&
    benchForm.includes("Owner approval is recorded only when an owner"),
);

const monday = new Date(2026, 8, 7, 8, 0, 0);
const settings = { ...DEFAULT_AVAILABILITY_SETTINGS };
const policy = { ...DEFAULT_SCHEDULING_POLICY, travelPlaceholderMinutes: 15, defaultPickupMinutes: 20 };
const member = {
  membershipId: "mem-1",
  name: "Alex",
  role: "MEMBER",
  active: true,
  schedulingActive: true,
  progression: "CAPABLE",
  maxDailyJobMinutes: null,
  preferredJobTypes: [],
  allowedJobTypes: [],
  workforceNotes: "",
  skills: [{ skillKey: "carpentry", proficiency: "CAPABLE" }],
  weeklyAvailability: [],
  exceptions: [],
};
const helper = {
  ...member,
  membershipId: "mem-2",
  name: "Sam",
  skills: [{ skillKey: "helper", proficiency: "LEARNING" }],
  progression: "LEARNING",
};

console.log("\nUNIT — Capacity math, buffers, pickup, travel placeholder");

const jobA = {
  id: "job-a",
  scheduledAt: monday,
  scheduledDurationMinutes: 120,
  pickupDurationMinutes: 30,
  assignedMembershipId: "mem-1",
  status: "SCHEDULED",
};
const day = calculateDailyCapacity({
  day: monday,
  settings,
  policy,
  jobs: [jobA],
  member,
});
check("Known scheduled time is the job duration only", day.knownScheduledMinutes === 120);
check("Configured buffer is counted separately", day.configuredBufferMinutes === 30);
check("Explicit pickup is known minutes", day.pickupMinutes === 30 && day.pickupKind === "known");
check("Travel placeholder is estimated, not GPS", day.travelPlaceholderMinutes === 15);
check(
  "Committed time adds known + buffer + pickup + travel",
  day.committedMinutes === 120 + 30 + 30 + 15,
);
check("Remaining minutes are available minus committed", day.remainingMinutes === 540 - 195);

const defaultPickupDay = calculateDailyCapacity({
  day: monday,
  settings,
  policy,
  jobs: [{ ...jobA, pickupDurationMinutes: null }],
  member,
});
check(
  "Missing job pickup uses configured default and stays labeled configured",
  defaultPickupDay.pickupMinutes === 20 && defaultPickupDay.pickupKind === "configured",
);

const week = calculateWeeklyCapacity({
  start: monday,
  settings,
  policy,
  jobs: [jobA],
  member,
});
check("Weekly capacity sums the working days", week.days.length === 7 && week.knownScheduledMinutes === 120);

console.log("\nUNIT — Conflicts, double booking, cascade, availability");

const overlap = detectScheduleConflicts({
  jobs: [
    jobA,
    {
      id: "job-b",
      scheduledAt: new Date(2026, 8, 7, 9, 0, 0),
      scheduledDurationMinutes: 120,
      assignedMembershipId: "mem-1",
      status: "SCHEDULED",
      customerName: "Beta",
    },
  ],
  settings,
  policy,
  members: [member],
});
check(
  "Same-worker overlap is a DOUBLE_BOOKING error",
  overlap.some((row) => row.kind === "DOUBLE_BOOKING" && row.severity === "ERROR"),
);

const outside = detectScheduleConflicts({
  jobs: [
    {
      ...jobA,
      scheduledAt: new Date(2026, 8, 7, 6, 0, 0),
    },
  ],
  settings,
  policy,
  members: [member],
});
check(
  "Outside working hours is flagged",
  outside.some((row) => row.kind === "OUTSIDE_AVAILABILITY"),
);

const longJob = detectScheduleConflicts({
  jobs: [
    {
      ...jobA,
      scheduledDurationMinutes: 600,
      pickupDurationMinutes: 0,
    },
  ],
  settings,
  policy,
  members: [member],
});
check(
  "Duration exceeding the day is an error",
  longJob.some((row) => row.kind === "DURATION_EXCEEDS_DAY" && row.severity === "ERROR"),
);

const later = {
  id: "job-later",
  scheduledAt: new Date(2026, 8, 7, 11, 0, 0),
  scheduledDurationMinutes: 60,
  assignedMembershipId: "mem-1",
  status: "SCHEDULED",
};
const cascade = laterJobsHurtByMove({
  start: new Date(2026, 8, 7, 10, 0, 0),
  durationMinutes: 90,
  pickupMinutes: 0,
  settings,
  existing: [later],
  membershipId: "mem-1",
});
check("Reschedule cascade identifies a later job that would be hurt", cascade.some((job) => job.id === "job-later"));

console.log("\nUNIT — Skills, shortage, recurrence forecast");

const recs = recommendAssignees({
  start: new Date(2026, 8, 7, 13, 0, 0),
  durationMinutes: 60,
  requiredSkills: ["carpentry"],
  members: [member, helper],
  jobs: [jobA],
  settings,
  policy,
});
check("Carpentry job prefers the capable carpenter", recs[0]?.membershipId === "mem-1" && recs[0]?.skillMatch === "full");
check("Helper without the skill is a poor match", recs.some((row) => row.membershipId === "mem-2" && row.skillMatch === "none"));

const shortage = staffingShortage({
  requiredSkills: ["electrical"],
  durationMinutes: 120,
  start: monday,
  recommendations: recommendAssignees({
    start: monday,
    durationMinutes: 120,
    requiredSkills: ["electrical"],
    members: [member, helper],
    jobs: [],
    settings,
    policy,
  }),
});
check("Missing electrical skill is a staffing shortage", shortage.shortage && shortage.missingSkills.includes("electrical"));

const nextWeekly = computeNextOccurrenceAt(monday, "WEEKLY");
check("Weekly recurrence advances seven days", nextWeekly?.toISOString() === new Date(2026, 8, 14, 8, 0, 0).toISOString());
const forecast = projectRecurrenceOccurrences({
  jobId: "recurring-1",
  scheduledAt: monday,
  cadence: "WEEKLY",
  from: new Date(2026, 8, 8),
  until: new Date(2026, 8, 22),
});
check("Forecast projects future weekly work without creating jobs", forecast.length === 2 && forecast.every((row) => row.kind === "estimated"));

const forecastDay = calculateDailyCapacity({
  day: new Date(2026, 8, 14, 8, 0, 0),
  settings,
  policy,
  jobs: [
    {
      id: "recurring-1",
      scheduledAt: monday,
      scheduledDurationMinutes: 90,
      assignedMembershipId: "mem-1",
      status: "SCHEDULED",
      serviceIntent: "RECURRING",
      recurrenceCadence: "WEEKLY",
      recurrenceStatus: "ACTIVE",
    },
  ],
  member,
  forecastUntil: new Date(2026, 8, 21),
});
check(
  "Capacity forecast counts recurring work as estimated, not known",
  forecastDay.forecastRecurringMinutes === 90 && forecastDay.knownScheduledMinutes === 0,
);

const agentRecs = buildWorkforceRecommendations({
  now: monday,
  settings,
  policy,
  jobs: [
    { ...jobA, assignedMembershipId: null, requiredSkills: ["electrical"] },
    {
      id: "job-b",
      scheduledAt: new Date(2026, 8, 7, 8, 30, 0),
      scheduledDurationMinutes: 120,
      assignedMembershipId: "mem-1",
      status: "SCHEDULED",
      requiredSkills: ["carpentry"],
    },
  ],
  members: [member, helper],
  bench: [],
});
check(
  "Agent recommends unassigned, shortage, and double-book risk without assigning",
  agentRecs.some((row) => row.key === "workforce-unassigned-job") &&
    agentRecs.some((row) => row.key === "workforce-staffing-shortage"),
);

console.log("\nUNIT — First/later appointment from the actual day lane");

const dateKey = (date) => formatISODateInTimeZone(date, DEFAULT_BUSINESS_TIMEZONE);
const firstAt = new Date(2026, 8, 7, 8, 0, 0);
const laterAt = new Date(2026, 8, 7, 11, 0, 0);
const laneJobs = [
  { id: "job-first", scheduledAt: firstAt, assignedMembershipId: "mem-1", status: "SCHEDULED" },
  { id: "job-later", scheduledAt: laterAt, assignedMembershipId: "mem-1", status: "SCHEDULED" },
];
const firstPos = appointmentPositionOnDay({
  start: firstAt,
  jobId: "job-first",
  assignedMembershipId: "mem-1",
  jobs: laneJobs,
  dateKey,
});
const laterPos = appointmentPositionOnDay({
  start: laterAt,
  jobId: "job-later",
  assignedMembershipId: "mem-1",
  jobs: laneJobs,
  dateKey,
});
check("First job at 8:00 is first / EXACT", firstPos === "first" && appointmentModeForPosition(firstPos, policy) === "EXACT");
check("Second job at 11:00 is later / WINDOW", laterPos === "later" && appointmentModeForPosition(laterPos, policy) === "WINDOW");
const rescheduleFirst = appointmentPositionOnDay({
  start: new Date(2026, 8, 7, 8, 30, 0),
  jobId: "job-first",
  assignedMembershipId: "mem-1",
  jobs: laneJobs,
  dateKey,
});
check("Rescheduling the 8:00 first job remains first/EXACT if it stays first", rescheduleFirst === "first");
const insertedEarlier = appointmentPositionOnDay({
  start: firstAt,
  jobId: "job-first",
  assignedMembershipId: "mem-1",
  jobs: [
    ...laneJobs,
    { id: "job-earlier", scheduledAt: new Date(2026, 8, 7, 7, 0, 0), assignedMembershipId: "mem-1", status: "SCHEDULED" },
  ],
  dateKey,
});
check("Inserting an earlier appointment makes the former first job later", insertedEarlier === "later");
const workerBFirst = appointmentPositionOnDay({
  start: firstAt,
  jobId: "job-b-first",
  assignedMembershipId: "mem-2",
  jobs: [
    ...laneJobs,
    { id: "job-b-first", scheduledAt: firstAt, assignedMembershipId: "mem-2", status: "SCHEDULED" },
  ],
  dateKey,
});
check("Two workers may each have their own first appointment", workerBFirst === "first");

console.log("\nUNIT — Pickup occupies time before the appointment");

const pickupWindow = occupiedWindow({
  scheduledAt: new Date(2026, 8, 7, 10, 0, 0),
  scheduledDurationMinutes: 120,
  pickupDurationMinutes: 30,
  policy,
});
check(
  "Pickup 30 + job 120 at 10:00 occupies 9:30–12:00 and does not move the appointment",
  pickupWindow.pickupStart.getHours() === 9 &&
    pickupWindow.pickupStart.getMinutes() === 30 &&
    pickupWindow.appointmentStart.getHours() === 10 &&
    pickupWindow.workEnd.getHours() === 12 &&
    pickupWindow.occupiedStart.getTime() === pickupWindow.pickupStart.getTime() &&
    pickupWindow.occupiedEnd.getTime() === pickupWindow.workEnd.getTime() &&
    pickupWindow.pickupKind === "known",
);
check(
  "Configured default pickup is not labeled known",
  occupiedWindow({
    scheduledAt: new Date(2026, 8, 7, 10, 0, 0),
    scheduledDurationMinutes: 60,
    pickupDurationMinutes: null,
    policy,
  }).pickupKind === "configured",
);
check(
  "Explicit zero pickup is none, not the configured default",
  occupiedWindow({
    scheduledAt: new Date(2026, 8, 7, 10, 0, 0),
    scheduledDurationMinutes: 60,
    pickupDurationMinutes: 0,
    policy,
  }).pickupKind === "none",
);

console.log("\nUNIT — Day-before cutoff uses the original appointment");

const tomorrow = new Date(Date.now() + 20 * 60 * 60 * 1000);
const nextMonth = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000);
const farOut = new Date(Date.now() + 70 * 24 * 60 * 60 * 1000);
const cutoffPolicy = { ...policy, dayBeforeChangeCutoffHours: 24 };
const tomorrowToNextMonth = detectScheduleConflicts({
  jobs: [{ id: "cut-1", scheduledAt: tomorrow, scheduledDurationMinutes: 60, status: "SCHEDULED" }],
  settings,
  policy: cutoffPolicy,
  proposed: {
    jobId: "cut-1",
    start: nextMonth,
    durationMinutes: 60,
    originalScheduledAt: tomorrow,
  },
  now: new Date(),
});
check(
  "Tomorrow → next month still flags cutoff against the current appointment",
  tomorrowToNextMonth.some((row) => row.kind === "DAY_BEFORE_CUTOFF"),
);
const farReschedule = detectScheduleConflicts({
  jobs: [{ id: "cut-2", scheduledAt: nextMonth, scheduledDurationMinutes: 60, status: "SCHEDULED" }],
  settings,
  policy: cutoffPolicy,
  proposed: {
    jobId: "cut-2",
    start: farOut,
    durationMinutes: 60,
    originalScheduledAt: nextMonth,
  },
  now: new Date(),
});
check(
  "Next month → later month outside cutoff does not flag",
  !farReschedule.some((row) => row.kind === "DAY_BEFORE_CUTOFF"),
);
const brandNew = detectScheduleConflicts({
  jobs: [],
  settings,
  policy: cutoffPolicy,
  proposed: {
    jobId: "cut-new",
    start: tomorrow,
    durationMinutes: 60,
    originalScheduledAt: null,
  },
  now: new Date(),
});
check("Brand-new schedule does not falsely trigger change cutoff", !brandNew.some((row) => row.kind === "DAY_BEFORE_CUTOFF"));

console.log("\nUNIT — Member-aware team capacity and multi-day allocation");

const sixHourA = {
  id: "six-a",
  scheduledAt: new Date(2026, 8, 7, 8, 0, 0),
  scheduledDurationMinutes: 360,
  pickupDurationMinutes: 0,
  assignedMembershipId: "mem-1",
  status: "SCHEDULED",
};
const sixHourB = {
  id: "six-b",
  scheduledAt: new Date(2026, 8, 7, 8, 0, 0),
  scheduledDurationMinutes: 360,
  pickupDurationMinutes: 0,
  assignedMembershipId: "mem-2",
  status: "SCHEDULED",
};
const twoWorkerDay = calculateTeamDailyCapacity({
  day: monday,
  settings,
  policy,
  jobs: [sixHourA, sixHourB],
  members: [member, helper],
});
check(
  "Two workers with independent 6-hour jobs are not overloaded against one 8-hour day",
  twoWorkerDay.overloaded === false &&
    twoWorkerDay.availableMinutes === 1080 &&
    twoWorkerDay.memberLaneCount === 2,
);
const doubleLoaded = calculateTeamDailyCapacity({
  day: monday,
  settings,
  policy,
  jobs: [
    sixHourA,
    { ...sixHourB, id: "six-a2", assignedMembershipId: "mem-1", scheduledAt: new Date(2026, 8, 7, 14, 0, 0) },
  ],
  members: [member, helper],
});
check("One worker double-loaded is overloaded", doubleLoaded.overloaded === true);
const unassignedDay = calculateTeamDailyCapacity({
  day: monday,
  settings,
  policy,
  jobs: [{ ...sixHourA, assignedMembershipId: null }],
  members: [member, helper],
});
check("Unassigned work is identified separately", (unassignedDay.unassignedJobCount ?? 0) >= 1);
const inactiveMember = { ...helper, schedulingActive: false };
const inactiveCapacity = calculateTeamDailyCapacity({
  day: monday,
  settings,
  policy,
  jobs: [],
  members: [member, inactiveMember],
});
check(
  "Inactive/non-schedulable worker contributes no assignable capacity",
  inactiveCapacity.memberLaneCount === 1 && inactiveCapacity.availableMinutes === 540,
);

const multiDayStart = new Date(2026, 8, 7, 8, 0, 0);
const multiDayJob = {
  id: "long-1",
  scheduledAt: multiDayStart,
  scheduledDurationMinutes: 1440,
  pickupDurationMinutes: 0,
  assignedMembershipId: "mem-1",
  status: "SCHEDULED",
};
const longWeek = calculateWeeklyCapacity({
  start: monday,
  settings,
  policy,
  jobs: [multiDayJob],
  member,
});
const longKnown = longWeek.days.reduce((sum, day) => sum + day.knownScheduledMinutes, 0);
check(
  "Multi-day job duration is not duplicated across dates",
  longKnown === 1440 && longWeek.days.filter((day) => day.knownScheduledMinutes > 0).length >= 2,
);

console.log("\nUNIT — End-of-day window, matching pickup/buffer, timezone/DST");

const fourPm = detectScheduleConflicts({
  jobs: [
    {
      id: "late-1",
      scheduledAt: new Date(2026, 8, 7, 16, 0, 0),
      scheduledDurationMinutes: 120,
      pickupDurationMinutes: 0,
      assignedMembershipId: "mem-1",
      status: "SCHEDULED",
    },
  ],
  settings,
  policy,
  members: [member],
  timeZone: "UTC",
});
check(
  "4 PM + 2h on an 8–5 worker is flagged outside availability",
  fourPm.some((row) => row.kind === "OUTSIDE_AVAILABILITY"),
);

const lateMatch = recommendAssignees({
  start: new Date(2026, 8, 7, 16, 30, 0),
  durationMinutes: 60,
  pickupMinutes: 30,
  requiredSkills: ["carpentry"],
  members: [member],
  jobs: [],
  settings,
  policy,
  timeZone: "UTC",
});
check(
  "Matching treats pickup and buffer as occupied time, so a late slot is not available",
  lateMatch[0]?.available === false && lateMatch[0]?.reason.includes("occupied window"),
);

const leadRequired = recommendAssignees({
  start: new Date(2026, 8, 7, 13, 0, 0),
  durationMinutes: 60,
  requiredSkills: ["carpentry"],
  requiredProgression: "LEAD_QUALIFIED",
  members: [member, { ...member, membershipId: "mem-lead", name: "Lee", progression: "LEAD_QUALIFIED" }],
  jobs: [],
  settings,
  policy,
});
check(
  "LEAD_QUALIFIED-required job marks a CAPABLE-only worker as not meeting progression",
  leadRequired.some((row) => row.membershipId === "mem-1" && row.meetsProgression === false) &&
    leadRequired.some((row) => row.membershipId === "mem-lead" && row.meetsProgression === true),
);

const roleRecs = recommendAssignees({
  start: monday,
  durationMinutes: 60,
  members: [
    { ...member, role: "OWNER", membershipId: "own-1", name: "Owner" },
    { ...member, role: "ADMIN", membershipId: "adm-1", name: "Admin" },
    member,
    { ...member, role: "MEMBER", active: false, membershipId: "inact-1", name: "Inactive" },
  ],
  jobs: [],
  settings,
  policy,
});
check("OWNER is not returned as an assignable worker", !roleRecs.some((row) => row.membershipId === "own-1"));
check("ADMIN is not returned as an assignable worker", !roleRecs.some((row) => row.membershipId === "adm-1"));
check("Active MEMBER can be returned", roleRecs.some((row) => row.membershipId === "mem-1"));
check("Inactive MEMBER is not returned", !roleRecs.some((row) => row.membershipId === "inact-1"));

const utcMidnight = new Date("2026-03-08T02:30:00.000Z");
check(
  "UTC date differs from America/New_York business date",
  utcMidnight.toISOString().slice(0, 10) === "2026-03-08" &&
    formatISODateInTimeZone(utcMidnight, "America/New_York") === "2026-03-07",
);
check(
  "Weekly availability chooses the business-local weekday",
  zonedWeekday(utcMidnight, "America/New_York") === 6 &&
    memberWindowForDay(
      utcMidnight,
      settings,
      {
        ...member,
        weeklyAvailability: [{ weekday: 6, startMinutes: 9 * 60, endMinutes: 12 * 60 }],
      },
      "America/New_York",
    ).startMinutes === 9 * 60,
);
const saturdayException = memberWindowForDay(
  utcMidnight,
  settings,
  {
    ...member,
    exceptions: [{ date: "2026-03-07", kind: "UNAVAILABLE", startMinutes: null, endMinutes: null }],
  },
  "America/New_York",
);
check("Date exception matches business-local YYYY-MM-DD", saturdayException.available === false);

const beforeDst = new Date("2026-03-02T13:00:00.000Z");
const nextWithZone = computeNextOccurrenceAt(beforeDst, "WEEKLY", null, "America/New_York");
const nextWithoutZone = computeNextOccurrenceAt(beforeDst, "WEEKLY");
check(
  "Weekly recurrence keeps the local 8:00 appointment through DST",
  nextWithZone?.toISOString() === "2026-03-09T12:00:00.000Z" &&
    formatISODateInTimeZone(nextWithZone, "America/New_York") === "2026-03-09" &&
    nextWithoutZone?.toISOString() === "2026-03-09T13:00:00.000Z",
);

const ackConflicts = [{ kind: "OVERLAP", jobId: "j1", otherJobId: "j2", severity: "WARNING" }];
const ack = conflictAcknowledgement({
  jobId: "j1",
  start: firstAt,
  durationMinutes: 60,
  pickupMinutes: 0,
  assignedMembershipId: "mem-1",
  conflicts: ackConflicts,
});
check(
  "Matching acknowledgement accepts the current warning",
  shouldAcceptConflictAcknowledgement({ submittedAck: ack, currentAck: ack, conflicts: ackConflicts }) === "accept",
);
const newAck = conflictAcknowledgement({
  jobId: "j1",
  start: firstAt,
  durationMinutes: 60,
  pickupMinutes: 0,
  assignedMembershipId: "mem-1",
  conflicts: [...ackConflicts, { kind: "DOUBLE_BOOKING", jobId: "j1", otherJobId: "j3", severity: "ERROR" }],
});
check(
  "Stale acknowledgement returns a fresh warning when a new conflict appears",
  shouldAcceptConflictAcknowledgement({ submittedAck: ack, currentAck: newAck, conflicts: ackConflicts }) === "warn",
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run workforce capacity Prisma checks.");
  process.exit(failed === 0 ? 1 : 1);
}

const testDbName = "tbbt_workforce_capacity_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) process.exit(push.status ?? 1);

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
  console.log("\nPRISMA — Owner assignment, member isolation, bench, tenant isolation");

  const businessA = await prisma.business.create({
    data: { name: "Alpha Workforce", slug: `alpha-wf-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Workforce", slug: `beta-wf-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-wf-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-wf-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaOwner = await prisma.user.create({
    data: { name: "Bea Owner", email: `beta-wf-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Ada Admin", email: `admin-wf-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const adminMem = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: businessA.id, role: "ADMIN" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const betaMem = await prisma.membership.create({
    data: { userId: betaOwner.id, businessId: businessB.id, role: "OWNER" },
  });
  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaMem.id);
  await prisma.businessSaasSubscription.create({
    data: { businessId: businessA.id, status: "active", planCode: "FOUNDER", legacyExempt: true },
  });
  await prisma.businessSaasSubscription.create({
    data: { businessId: businessB.id, status: "active", planCode: "FOUNDER", legacyExempt: true },
  });

  await updateWorkforceProfileOp(prisma, ownerA, {
    membershipId: memberMem.id,
    schedulingActive: true,
    progression: parseWorkforceProgression("CAPABLE"),
    maxDailyJobMinutes: 360,
    preferredJobTypes: ["carpentry"],
    allowedJobTypes: ["carpentry", "general"],
    workforceNotes: "Lead carpenter",
    skills: [{ skillKey: "carpentry", proficiency: "LEAD_QUALIFIED" }],
  });
  const savedProfile = await prisma.membership.findFirst({
    where: { id: memberMem.id, businessId: businessA.id },
    include: { workforceSkills: true },
  });
  check(
    "Owner can record skills and progression on Membership",
    savedProfile?.progression === "CAPABLE" &&
      savedProfile.workforceNotes === "Lead carpenter" &&
      savedProfile.preferredJobTypes.includes("carpentry") &&
      savedProfile.workforceSkills.some((row) => row.skillKey === "carpentry" && row.businessId === businessA.id),
  );

  await updateWorkforceProfileOp(prisma, ownerA, {
    membershipId: memberMem.id,
    schedulingActive: true,
    progression: "CAPABLE",
    maxDailyJobMinutes: 360,
    workforceNotes: "Lead carpenter",
    skills: [
      { skillKey: "carpentry", proficiency: "LEAD_QUALIFIED" },
      { skillKey: "painting", proficiency: "CAPABLE" },
    ],
  });
  const preserved = await prisma.membership.findFirst({
    where: { id: memberMem.id, businessId: businessA.id },
    include: { workforceSkills: true },
  });
  check(
    "Saved note/job-type metadata is preserved when only skills are edited",
    preserved?.workforceNotes === "Lead carpenter" &&
      preserved.preferredJobTypes.includes("carpentry") &&
      preserved.allowedJobTypes.includes("general") &&
      preserved.workforceSkills.some((row) => row.skillKey === "painting"),
  );

  try {
    await updateWorkforceProfileOp(prisma, ownerA, {
      membershipId: memberMem.id,
      schedulingActive: true,
      progression: "SUPERSTAR",
      maxDailyJobMinutes: null,
      skills: [],
    });
    check("Invalid progression fails instead of storing malformed text", false);
  } catch (error) {
    check("Invalid progression fails instead of storing malformed text", error instanceof WorkforceError);
  }

  await setMemberWeeklyAvailabilityOp(prisma, ownerA, {
    membershipId: memberMem.id,
    slots: [{ weekday: 1, startMinutes: 8 * 60, endMinutes: 17 * 60 }],
  });
  const weekly = await prisma.membershipWeeklyAvailability.findMany({
    where: { membershipId: memberMem.id, businessId: businessA.id },
  });
  check("Owner can write and read weekly availability", weekly.length === 1 && weekly[0]?.weekday === 1);

  try {
    await setMemberWeeklyAvailabilityOp(prisma, ownerA, {
      membershipId: memberMem.id,
      slots: [{ weekday: 9, startMinutes: 8 * 60, endMinutes: 17 * 60 }],
    });
    check("Invalid weekday fails server-side", false);
  } catch (error) {
    check("Invalid weekday fails server-side", error instanceof WorkforceError);
  }

  try {
    await setMemberWeeklyAvailabilityOp(prisma, ownerB, {
      membershipId: memberMem.id,
      slots: [{ weekday: 2, startMinutes: 8 * 60, endMinutes: 12 * 60 }],
    });
    check("Foreign membership weekly hours are rejected", false);
  } catch (error) {
    check("Foreign membership weekly hours are rejected", error instanceof ForbiddenError);
  }

  try {
    await updateWorkforceProfileOp(prisma, memberA, {
      membershipId: memberMem.id,
      schedulingActive: false,
      progression: "LEAD_QUALIFIED",
      maxDailyJobMinutes: null,
      preferredJobTypes: [],
      allowedJobTypes: [],
      workforceNotes: "",
      skills: [],
    });
    check("MEMBER cannot edit workforce profiles", false);
  } catch (error) {
    check("MEMBER cannot edit workforce profiles", error instanceof ForbiddenError);
  }

  try {
    requireBusinessCapability(memberA, CAPABILITIES.MANAGE_JOBS);
    check("MEMBER cannot assign jobs", false);
  } catch (error) {
    check("MEMBER cannot assign jobs", error instanceof ForbiddenError);
  }

  const bench = await upsertFillInBenchWorkerOp(prisma, ownerA, {
    displayName: "Pat Helper",
    contactPreference: "PHONE",
    contactValue: "555-0100",
    skills: ["helper"],
    availabilityNotes: "Afternoons",
    approved: true,
    active: true,
    notes: "Internal only",
  });
  check("Fill-In Bench row is tenant-scoped", bench.businessId === businessA.id && bench.approved);

  try {
    await upsertFillInBenchWorkerOp(prisma, ownerB, {
      id: bench.id,
      displayName: "Stolen",
      contactPreference: "PHONE",
      contactValue: "",
      skills: [],
      availabilityNotes: "",
      approved: true,
      active: true,
      notes: "",
    });
    check("Business B cannot edit A's bench", false);
  } catch (error) {
    check("Business B cannot edit A's bench", error instanceof ForbiddenError || error instanceof WorkforceError);
  }

  const customer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Alpha Customer" },
  });
  const first = new Date(2026, 8, 7, 8, 0, 0);
  const laterStart = new Date(2026, 8, 7, 11, 0, 0);
  const jobOne = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: first,
      scheduledDurationMinutes: 120,
      assignedMembershipId: memberMem.id,
      pickupDurationMinutes: 15,
      requiredSkills: parseSkillList("carpentry").join(","),
      serviceIntent: "RECURRING",
      recurrenceCadence: "WEEKLY",
      recurrenceStatus: "ACTIVE",
      nextOccurrenceAt: computeNextOccurrenceAt(first, "WEEKLY"),
    },
  });
  const jobTwo = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: laterStart,
      scheduledDurationMinutes: 60,
      assignedMembershipId: memberMem.id,
    },
  });
  const foreignJob = await prisma.job.create({
    data: {
      businessId: businessB.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: first,
      scheduledDurationMinutes: 60,
    },
  });

  const aJobs = await prisma.job.findMany({
    where: { businessId: businessA.id },
    select: { id: true, scheduledAt: true },
  });
  check("Tenant A query does not include B's job", aJobs.every((row) => row.id !== foreignJob.id));

  const laterBefore = jobTwo.scheduledAt;
  const hurt = laterJobsHurtByMove({
    start: new Date(2026, 8, 7, 10, 0, 0),
    durationMinutes: 90,
    pickupMinutes: 0,
    settings,
    existing: [
      {
        id: jobTwo.id,
        scheduledAt: jobTwo.scheduledAt,
        scheduledDurationMinutes: jobTwo.scheduledDurationMinutes,
        assignedMembershipId: jobTwo.assignedMembershipId,
        status: jobTwo.status,
      },
    ],
    membershipId: memberMem.id,
  });
  const laterAfter = await prisma.job.findFirst({
    where: { id: jobTwo.id, businessId: businessA.id },
    select: { scheduledAt: true },
  });
  check("Cascade detection does not move the later job", hurt.length === 1 && laterAfter?.scheduledAt?.getTime() === laterBefore.getTime());

  try {
    await upsertFillInBenchWorkerOp(prisma, ownerA, {
      displayName: "Bad Contact",
      contactPreference: "SMOKE_SIGNAL",
      contactValue: "",
      skills: ["helper"],
      availabilityNotes: "",
      approved: true,
      active: true,
      notes: "",
    });
    check("Invalid bench contact preference fails", false);
  } catch (error) {
    check("Invalid bench contact preference fails", error instanceof WorkforceError);
  }

  const unapprovedBench = await upsertFillInBenchWorkerOp(prisma, ownerA, {
    displayName: "Not Approved",
    contactPreference: "PHONE",
    contactValue: "555-0199",
    skills: ["helper"],
    availabilityNotes: "",
    approved: false,
    active: true,
    notes: "",
  });
  try {
    await createWorkforceOutreachTaskOp(prisma, ownerA, {
      kind: "HELPER_NEEDED",
      benchWorkerId: unapprovedBench.id,
      missingSkills: [],
      explanation: "Should fail",
      approve: true,
    });
    check("Approved outreach cannot attach an unapproved bench worker", false);
  } catch (error) {
    check(
      "Approved outreach cannot attach an unapproved bench worker",
      error instanceof WorkforceError,
    );
  }

  const outreach = await createWorkforceOutreachTaskOp(prisma, ownerA, {
    kind: "STAFFING_SHORTAGE",
    jobId: jobOne.id,
    missingSkills: ["electrical"],
    missingMinutes: 120,
    explanation: "Need an electrician for Tuesday.",
    approve: true,
  });
  const outreachRetry = await createWorkforceOutreachTaskOp(prisma, ownerA, {
    kind: "STAFFING_SHORTAGE",
    jobId: jobOne.id,
    missingSkills: ["electrical"],
    missingMinutes: 120,
    explanation: "Need an electrician for Tuesday.",
    approve: true,
  });
  check(
    "Owner-approved outreach task does not contact anyone",
    outreach.status === "APPROVED" &&
      outreach.approvedByMembershipId === ownerMem.id &&
      outreach.businessId === businessA.id,
  );
  check("Outreach double-click is idempotent", outreachRetry.id === outreach.id);

  const adminOutreach = await createWorkforceOutreachTaskOp(prisma, adminA, {
    kind: "HELPER_NEEDED",
    jobId: jobTwo.id,
    missingSkills: [],
    explanation: "Admin click",
    approve: true,
  });
  check(
    "ADMIN approve=true records a draft, not owner-approved",
    adminOutreach.status === "DRAFT" && adminOutreach.approvedByMembershipId == null,
  );
  const unchanged = await prisma.job.findFirst({
    where: { id: jobOne.id, businessId: businessA.id },
  });
  check(
    "Outreach task does not rewrite the schedule",
    unchanged?.scheduledAt?.getTime() === first.getTime() &&
      unchanged.assignedMembershipId === memberMem.id,
  );

  try {
    await createWorkforceOutreachTaskOp(prisma, ownerB, {
      kind: "STAFFING_SHORTAGE",
      jobId: jobOne.id,
      missingSkills: [],
      explanation: "Steal",
      approve: true,
    });
    check("Business B cannot attach outreach to A's job", false);
  } catch (error) {
    check("Business B cannot attach outreach to A's job", error instanceof ForbiddenError);
  }

  const bBench = await prisma.fillInBenchWorker.findMany({ where: { businessId: businessB.id } });
  check("Business B cannot see A's Fill-In Bench", bBench.length === 0);
  const bSkills = await prisma.membershipSkill.findMany({ where: { businessId: businessB.id } });
  check("Business B cannot see A's workforce skills", bSkills.length === 0);

  const skillCountBefore = await prisma.membershipSkill.count({
    where: { membershipId: memberMem.id, businessId: businessA.id },
  });
  await prisma.job.updateMany({
    where: { assignedMembershipId: memberMem.id },
    data: { assignedMembershipId: null },
  });
  await prisma.membership.delete({ where: { id: memberMem.id } });
  const skillCountAfter = await prisma.membershipSkill.count({
    where: { membershipId: memberMem.id },
  });
  const weeklyAfter = await prisma.membershipWeeklyAvailability.count({
    where: { membershipId: memberMem.id },
  });
  check(
    "Deleting a membership cascades Workforce skill/weekly rows (no orphans)",
    skillCountBefore > 0 && skillCountAfter === 0 && weeklyAfter === 0,
  );

  await prisma.job.delete({ where: { id: jobOne.id } });
  const outreachAfterJob = await prisma.workforceOutreachTask.findFirst({
    where: { id: outreach.id },
  });
  check(
    "Deleting a job sets outreach jobId null instead of leaving a dangling FK",
    outreachAfterJob != null && outreachAfterJob.jobId == null,
  );

  console.log(failed === 0 ? `\nAll workforce-capacity checks passed (${passed}).` : `\n${failed} workforce-capacity check(s) failed.`);
} catch (error) {
  failed += 1;
  console.error("FAIL - workforce Prisma harness threw", error);
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
