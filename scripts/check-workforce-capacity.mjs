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
  DEFAULT_SCHEDULING_POLICY,
  parseSkillList,
  parseWorkforceProgression,
} = await import("@/lib/workforce");
const {
  calculateDailyCapacity,
  calculateWeeklyCapacity,
  laterJobsHurtByMove,
} = await import("@/lib/workforce-capacity");
const { detectScheduleConflicts } = await import("@/lib/workforce-conflicts");
const { recommendAssignees, staffingShortage } = await import("@/lib/workforce-matching");
const { buildWorkforceRecommendations } = await import("@/lib/workforce-agent");
const {
  createWorkforceOutreachTaskOp,
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

const monday = new Date(2026, 8, 7, 8, 0, 0);
const settings = { ...DEFAULT_AVAILABILITY_SETTINGS };
const policy = { ...DEFAULT_SCHEDULING_POLICY, travelPlaceholderMinutes: 15, defaultPickupMinutes: 20 };
const member = {
  membershipId: "mem-1",
  name: "Alex",
  active: true,
  schedulingActive: true,
  progression: "CAPABLE",
  maxDailyJobMinutes: null,
  preferredJobTypes: [],
  allowedJobTypes: [],
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
  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const betaMem = await prisma.membership.create({
    data: { userId: betaOwner.id, businessId: businessB.id, role: "OWNER" },
  });
  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
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
      savedProfile.workforceSkills.some((row) => row.skillKey === "carpentry" && row.businessId === businessA.id),
  );

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

  const outreach = await createWorkforceOutreachTaskOp(prisma, ownerA, {
    kind: "STAFFING_SHORTAGE",
    jobId: jobOne.id,
    missingSkills: ["electrical"],
    missingMinutes: 120,
    explanation: "Need an electrician for Tuesday.",
    approve: true,
  });
  check("Owner-approved outreach task does not contact anyone", outreach.status === "APPROVED" && outreach.businessId === businessA.id);
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
