/**
 * Owner-reviewable staffing recommendations.
 *
 * Dedicated database: tbbt_workforce_staffing_test
 *
 * Proves exact availability / skills / schedule facts, OWNER-only
 * accept/dismiss through existing recommendation state, stale-fact
 * recheck, authorization, and tenant isolation. Accept never assigns,
 * contacts, hires, or reschedules.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-workforce-staffing.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { DEFAULT_AVAILABILITY_SETTINGS } = await import("@/lib/availability");
const { DEFAULT_BUSINESS_TIMEZONE, formatISODateInTimeZone, zonedWeekday } = await import(
  "@/lib/business-timezone"
);
const { DEFAULT_SCHEDULING_POLICY, parseSkillList } = await import("@/lib/workforce");
const { calculateTeamWeeklyCapacity } = await import("@/lib/workforce-capacity");
const { detectScheduleConflicts } = await import("@/lib/workforce-conflicts");
const { buildWorkforceRecommendations } = await import("@/lib/workforce-agent");
const {
  buildStaffingReviewRecommendations,
  staffingReviewEvidenceKey,
  staffingReviewKeyForJob,
} = await import("@/lib/workforce-staffing");
const { reviewStaffingRecommendationOp, loadOwnedStaffingReview } = await import(
  "@/lib/workforce-staffing-ops"
);
const { WorkforceError } = await import("@/lib/workforce-ops");
const { CONTROLLED_ACTION_KEYS } = await import("@/lib/chief-of-staff/controlled-actions");
const { CAPABILITIES, ForbiddenError, roleHasCapability } = await import("@/lib/authorization");
const { recommendationEvidenceKey } = await import("@/lib/bsos-actions");

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

const staffingSrc = readRepo("src/lib/workforce-staffing.ts");
const staffingOps = readRepo("src/lib/workforce-staffing-ops.ts");
const staffingAction = readRepo("src/app/actions/workforce.ts");
const staffingUi = readRepo("src/components/team/staffing-recommendations.tsx");
const teamPage = readRepo("src/app/(app)/team/page.tsx");
const benchPage = readRepo("src/app/(app)/team/bench/page.tsx");
const fieldPage = readRepo("src/app/field/page.tsx");
const nav = readRepo("src/lib/nav.ts");
const controlled = readRepo("src/lib/chief-of-staff/controlled-actions.ts");
const agent = readRepo("src/lib/workforce-agent.ts");

console.log("\nSTATIC — Scope, allowlist, MEMBER field, no automatic mutation");

check(
  "Staffing review never assigns, contacts, hires, or reschedules",
  !staffingSrc.includes("assignedMembershipId:") &&
    !staffingOps.includes("assignedMembershipId:") &&
    !staffingOps.includes("scheduledAt:") &&
    !staffingOps.includes("createWorkforceOutreachTask") &&
    !staffingAction.includes("assignJobMember") &&
    /does not assign, contact, hire, or\s+reschedule/.test(staffingUi) &&
    staffingAction.includes("No worker was assigned, contacted, hired, or rescheduled"),
);
check(
  "Accept/dismiss reuse existing recommendation state helpers",
  staffingOps.includes("createActionFromRecommendation") &&
    staffingOps.includes("upsertRecommendationState") &&
    staffingOps.includes("liveEvidence !== submittedEvidence"),
);
check(
  "Controlled AI allowlist stays the original three actions",
  CONTROLLED_ACTION_KEYS.length === 3 &&
    CONTROLLED_ACTION_KEYS[0] === "CREATE_RECOMMENDATION_ACTION_ITEM" &&
    CONTROLLED_ACTION_KEYS[1] === "DISMISS_RECOMMENDATION" &&
    CONTROLLED_ACTION_KEYS[2] === "COMPLETE_RECOMMENDATION",
);
check(
  "ASSIGN_WORKER remains excluded from the executable allowlist",
  controlled.includes("export const EXCLUDED_ACTION_KEYS") &&
    controlled.includes('"ASSIGN_WORKER"') &&
    !CONTROLLED_ACTION_KEYS.includes("ASSIGN_WORKER") &&
    !CONTROLLED_ACTION_KEYS.includes("RESCHEDULE_JOB"),
);
check(
  "MEMBER field home stays self-scoped and hides the bench",
  fieldPage.includes("Only jobs assigned to you") &&
    fieldPage.includes("Other workers and the Fill-In Bench stay hidden") &&
    fieldPage.includes("assignedMembershipId: field.membershipId"),
);
check(
  "No new global navigation entry",
  !nav.includes("/team/staffing") &&
    !nav.includes("Staffing recommendations") &&
    nav.includes('{ href: "/team", label: "Team"'),
);
check(
  "Review lives on existing Team and Fill-In Bench pages",
  teamPage.includes("StaffingRecommendationsPanel") &&
    benchPage.includes("StaffingRecommendationsPanel") &&
    agent.includes("buildStaffingReviewRecommendations"),
);
check(
  "MEMBER still cannot manage jobs or members",
  !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_JOBS) &&
    !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_MEMBERS) &&
    !roleHasCapability("MEMBER", CAPABILITIES.VIEW_REPORTS),
);

const monday = new Date(2026, 9, 5, 13, 0, 0);
const settings = { ...DEFAULT_AVAILABILITY_SETTINGS };
const policy = { ...DEFAULT_SCHEDULING_POLICY };
const carpenter = {
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
  weeklyAvailability: [{ weekday: 1, startMinutes: 8 * 60, endMinutes: 17 * 60 }],
  exceptions: [],
};
const helper = {
  ...carpenter,
  membershipId: "mem-2",
  name: "Sam",
  skills: [{ skillKey: "helper", proficiency: "LEARNING" }],
  progression: "LEARNING",
  weeklyAvailability: [],
};
const unassignedElectrical = {
  id: "job-short",
  scheduledAt: monday,
  scheduledDurationMinutes: 120,
  pickupDurationMinutes: 15,
  assignedMembershipId: null,
  status: "SCHEDULED",
  customerName: "Patton",
  requiredSkills: ["electrical"],
  requiredProgression: "",
};
const assignedPoorMatch = {
  id: "job-poor",
  scheduledAt: new Date(2026, 9, 5, 15, 0, 0),
  scheduledDurationMinutes: 60,
  pickupDurationMinutes: 0,
  assignedMembershipId: "mem-1",
  status: "SCHEDULED",
  customerName: "River",
  requiredSkills: ["electrical"],
  requiredProgression: "",
};

function snapshotFrom(jobs, members, bench = [], now = monday) {
  const week = calculateTeamWeeklyCapacity({
    start: monday,
    settings,
    policy,
    jobs,
    members,
    timeZone: DEFAULT_BUSINESS_TIMEZONE,
  });
  const conflicts = detectScheduleConflicts({
    jobs,
    settings,
    policy,
    members,
    timeZone: DEFAULT_BUSINESS_TIMEZONE,
  });
  const recommendations = buildWorkforceRecommendations({
    now,
    settings,
    policy,
    jobs,
    members,
    bench,
    timeZone: DEFAULT_BUSINESS_TIMEZONE,
  });
  return {
    settings,
    policy,
    members,
    bench,
    jobs,
    week,
    conflicts,
    recommendations,
    timeZone: DEFAULT_BUSINESS_TIMEZONE,
  };
}

console.log("\nUNIT — Exact availability, skills, and schedule facts");

const reviewNow = new Date(2026, 9, 4, 9, 0, 0);
const snapshot = snapshotFrom(
  [unassignedElectrical, assignedPoorMatch],
  [carpenter, helper],
  [
    {
      id: "bench-1",
      displayName: "Pat Helper",
      contactPreference: "PHONE",
      contactValue: "555-0100",
      skills: ["electrical"],
      availabilityNotes: "Afternoons",
      workerType: "BACKUP",
      locationNotes: "",
      approved: true,
      active: true,
      lastUsedAt: null,
      notes: "",
      membershipId: null,
      linkedMemberName: null,
      isRegularTeamMember: false,
      updatedAt: monday,
    },
  ],
  reviewNow,
);
const recs = buildStaffingReviewRecommendations(snapshot, reviewNow);
const shortageRec = recs.find((row) => row.key === staffingReviewKeyForJob("job-short"));
const poorRec = recs.find((row) => row.key === staffingReviewKeyForJob("job-poor"));
const fact = (item, key) => item?.facts.find((row) => row.key === key)?.value ?? "";

check("Shortage job produces a staffing review card", Boolean(shortageRec));
check(
  "Schedule fact includes the recorded date, duration, and pickup",
  fact(shortageRec, "schedule").includes(formatISODateInTimeZone(monday, DEFAULT_BUSINESS_TIMEZONE)) &&
    fact(shortageRec, "schedule").includes("120 minutes") &&
    fact(shortageRec, "schedule").includes("15 known pickup minutes"),
);
check(
  "Required-skills fact is the recorded catalog skill, not a guess",
  fact(shortageRec, "required-skills").toLowerCase().includes("electrical"),
);
check(
  "Availability fact shows weekly hours and business-hours fallback",
  fact(shortageRec, "availability").includes("Alex") &&
    fact(shortageRec, "availability").includes("weekly hours") &&
    fact(shortageRec, "availability").includes("Sam") &&
    fact(shortageRec, "availability").includes("business-hours fallback"),
);
check(
  "Skills fact lists recorded member skills only",
  fact(shortageRec, "skills").includes("Carpentry") &&
    fact(shortageRec, "skills").includes("Helper") &&
    !fact(shortageRec, "skills").toLowerCase().includes("555-0100"),
);
check(
  "Fill-In Bench fact uses recorded active-bench skills",
  fact(shortageRec, "bench").toLowerCase().includes("electrical") &&
    fact(shortageRec, "bench").includes("1 active"),
);
check("Poor skill match is a separate owner-review card", Boolean(poorRec));
check("Assignment fact names the recorded worker", fact(poorRec, "assignment") === "Alex");
check(
  "Evidence key is derived from the same facts the owner sees",
  staffingReviewEvidenceKey(shortageRec) === recommendationEvidenceKey(shortageRec) &&
    /required-skills:Electrical/i.test(staffingReviewEvidenceKey(shortageRec)),
);

const afterAssign = snapshotFrom(
  [{ ...unassignedElectrical, assignedMembershipId: "mem-1" }],
  [carpenter, helper],
  snapshot.bench,
  reviewNow,
);
const afterAssignRec = buildStaffingReviewRecommendations(afterAssign, reviewNow).find(
  (row) => row.key === staffingReviewKeyForJob("job-short"),
);
check(
  "Changing assignment changes the evidence fingerprint",
  !afterAssignRec ||
    staffingReviewEvidenceKey(afterAssignRec) !== staffingReviewEvidenceKey(shortageRec),
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run workforce staffing Prisma checks.");
  process.exit(1);
}

const testDbName = "tbbt_workforce_staffing_test";
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

function futureJobStart() {
  const start = new Date();
  start.setDate(start.getDate() + 3);
  start.setHours(13, 0, 0, 0);
  return start;
}

try {
  console.log("\nPRISMA — Stale-data, OWNER review, authorization, isolation");

  const businessA = await prisma.business.create({
    data: { name: "Alpha Staffing", slug: `alpha-stf-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Staffing", slug: `beta-stf-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-stf-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Ada Admin", email: `admin-stf-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-stf-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaOwner = await prisma.user.create({
    data: { name: "Bea Owner", email: `beta-stf-${randomUUID()}@example.com`, passwordHash: "x" },
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
  await prisma.membership.update({
    where: { id: memberMem.id },
    data: { schedulingActive: true, progression: "CAPABLE" },
  });
  await prisma.membershipSkill.create({
    data: {
      businessId: businessA.id,
      membershipId: memberMem.id,
      skillKey: "carpentry",
      proficiency: "CAPABLE",
    },
  });
  const start = futureJobStart();
  await prisma.membershipWeeklyAvailability.create({
    data: {
      businessId: businessA.id,
      membershipId: memberMem.id,
      weekday: zonedWeekday(start, DEFAULT_BUSINESS_TIMEZONE),
      startMinutes: 8 * 60,
      endMinutes: 17 * 60,
    },
  });
  const customer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Alpha Customer" },
  });
  const job = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: start,
      scheduledDurationMinutes: 120,
      pickupDurationMinutes: 15,
      requiredSkills: parseSkillList("electrical").join(","),
    },
  });
  const foreignJob = await prisma.job.create({
    data: {
      businessId: businessB.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: start,
      scheduledDurationMinutes: 60,
      requiredSkills: parseSkillList("electrical").join(","),
    },
  });

  const loaded = await loadOwnedStaffingReview(prisma, ownerA);
  const live = loaded.pending.find((row) => row.key === staffingReviewKeyForJob(job.id));
  check("OWNER can load a pending staffing recommendation for the owned job", Boolean(live));
  check(
    "Loaded card shows availability, skills, and schedule facts",
    Boolean(live) &&
      live.facts.some((row) => row.key === "availability" && row.value.includes("Mia Member")) &&
      live.facts.some((row) => row.key === "skills" && row.value.toLowerCase().includes("carpentry")) &&
      live.facts.some((row) => row.key === "schedule" && row.value.includes("120 minutes")),
  );
  check(
    "Foreign job is not in tenant A's staffing review",
    loaded.recommendations.every((row) => row.key !== staffingReviewKeyForJob(foreignJob.id)),
  );

  const beforeAccept = {
    assigned: (await prisma.job.findFirst({ where: { id: job.id, businessId: businessA.id } }))
      ?.assignedMembershipId,
    scheduledAt: (await prisma.job.findFirst({ where: { id: job.id, businessId: businessA.id } }))
      ?.scheduledAt,
    actions: await prisma.businessActionItem.count({ where: { businessId: businessA.id } }),
    outreach: await prisma.workforceOutreachTask.count({ where: { businessId: businessA.id } }),
  };
  const accepted = await reviewStaffingRecommendationOp(prisma, ownerA, {
    recommendationKey: live.key,
    evidenceKey: staffingReviewEvidenceKey(live),
    decision: "ACCEPT",
  });
  const afterAcceptJob = await prisma.job.findFirst({
    where: { id: job.id, businessId: businessA.id },
  });
  const actionRow = await prisma.businessActionItem.findFirst({
    where: { id: accepted.recordId, businessId: businessA.id },
  });
  check("OWNER accept writes an action-plan item", accepted.recordType === "BusinessActionItem" && Boolean(actionRow));
  check(
    "OWNER accept does not assign, reschedule, or create outreach",
    afterAcceptJob?.assignedMembershipId === beforeAccept.assigned &&
      afterAcceptJob?.scheduledAt?.getTime() === beforeAccept.scheduledAt?.getTime() &&
      (await prisma.workforceOutreachTask.count({ where: { businessId: businessA.id } })) ===
        beforeAccept.outreach,
  );

  const afterAcceptLoad = await loadOwnedStaffingReview(prisma, ownerA);
  check(
    "Accepted card leaves the pending list for the same evidence",
    afterAcceptLoad.pending.every((row) => row.key !== live.key) &&
      afterAcceptLoad.accepted.some((row) => row.key === live.key),
  );

  const dismissJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: new Date(start.getTime() + 24 * 60 * 60 * 1000),
      scheduledDurationMinutes: 90,
      requiredSkills: parseSkillList("plumbing").join(","),
    },
  });
  const dismissLoaded = await loadOwnedStaffingReview(prisma, ownerA);
  const dismissLive = dismissLoaded.pending.find((row) => row.key === staffingReviewKeyForJob(dismissJob.id));
  const dismissed = await reviewStaffingRecommendationOp(prisma, ownerA, {
    recommendationKey: dismissLive.key,
    evidenceKey: staffingReviewEvidenceKey(dismissLive),
    decision: "DISMISS",
  });
  const dismissState = await prisma.bsosRecommendationState.findFirst({
    where: { id: dismissed.recordId, businessId: businessA.id },
  });
  const dismissJobAfter = await prisma.job.findFirst({
    where: { id: dismissJob.id, businessId: businessA.id },
  });
  check(
    "OWNER dismiss writes recommendation state only",
    dismissed.recordType === "BsosRecommendationState" && dismissState?.status === "DISMISSED",
  );
  check(
    "OWNER dismiss does not assign or reschedule",
    dismissJobAfter?.assignedMembershipId == null &&
      dismissJobAfter?.scheduledAt?.getTime() === dismissJob.scheduledAt.getTime(),
  );

  const staleJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: new Date(start.getTime() + 2 * 24 * 60 * 60 * 1000),
      scheduledDurationMinutes: 60,
      requiredSkills: parseSkillList("electrical").join(","),
    },
  });
  const staleLoaded = await loadOwnedStaffingReview(prisma, ownerA);
  const staleLive = staleLoaded.pending.find((row) => row.key === staffingReviewKeyForJob(staleJob.id));
  const staleEvidence = staffingReviewEvidenceKey(staleLive);
  const statesBeforeStale = await prisma.bsosRecommendationState.count({
    where: { businessId: businessA.id, recommendationKey: staleLive.key },
  });
  const actionsBeforeStale = await prisma.businessActionItem.count({ where: { businessId: businessA.id } });
  await prisma.job.update({
    where: { id: staleJob.id },
    data: { requiredSkills: parseSkillList("plumbing").join(",") },
  });
  let staleFailed = false;
  try {
    await reviewStaffingRecommendationOp(prisma, ownerA, {
      recommendationKey: staleLive.key,
      evidenceKey: staleEvidence,
      decision: "ACCEPT",
    });
  } catch (error) {
    staleFailed = error instanceof WorkforceError && /facts changed/i.test(error.message);
  }
  const statesAfterStale = await prisma.bsosRecommendationState.count({
    where: { businessId: businessA.id, recommendationKey: staleLive.key },
  });
  const actionsAfterStale = await prisma.businessActionItem.count({ where: { businessId: businessA.id } });
  const staleJobAfter = await prisma.job.findFirst({
    where: { id: staleJob.id, businessId: businessA.id },
  });
  check("Stale evidence is rejected before any review write", staleFailed);
  check(
    "Stale accept does not write state, an action item, or an assignment",
    statesAfterStale === statesBeforeStale &&
      actionsAfterStale === actionsBeforeStale &&
      staleJobAfter?.assignedMembershipId == null,
  );

  let adminDenied = false;
  try {
    await reviewStaffingRecommendationOp(prisma, adminA, {
      recommendationKey: dismissLive.key,
      evidenceKey: staffingReviewEvidenceKey(dismissLive),
      decision: "DISMISS",
    });
  } catch (error) {
    adminDenied = error instanceof ForbiddenError;
  }
  check("ADMIN cannot accept or dismiss staffing recommendations", adminDenied);

  let memberDenied = false;
  try {
    await reviewStaffingRecommendationOp(prisma, memberA, {
      recommendationKey: live.key,
      evidenceKey: staffingReviewEvidenceKey(live),
      decision: "ACCEPT",
    });
  } catch (error) {
    memberDenied = error instanceof ForbiddenError;
  }
  check("MEMBER cannot accept or dismiss staffing recommendations", memberDenied);

  let memberLoadDenied = false;
  try {
    await loadOwnedStaffingReview(prisma, memberA);
  } catch (error) {
    memberLoadDenied = error instanceof ForbiddenError;
  }
  check("MEMBER cannot load the owner staffing review", memberLoadDenied);

  const statesBeforeIso = await prisma.bsosRecommendationState.count({
    where: { businessId: businessA.id },
  });
  const actionsBeforeIso = await prisma.businessActionItem.count({
    where: { businessId: businessA.id },
  });
  let foreignDenied = false;
  try {
    await reviewStaffingRecommendationOp(prisma, ownerB, {
      recommendationKey: live.key,
      evidenceKey: staffingReviewEvidenceKey(live),
      decision: "ACCEPT",
    });
  } catch (error) {
    foreignDenied =
      error instanceof WorkforceError || error instanceof ForbiddenError;
  }
  const statesAfterIso = await prisma.bsosRecommendationState.count({
    where: { businessId: businessA.id },
  });
  const actionsAfterIso = await prisma.businessActionItem.count({
    where: { businessId: businessA.id },
  });
  const bStates = await prisma.bsosRecommendationState.count({
    where: { businessId: businessB.id },
  });
  check("Business B cannot review tenant A's staffing recommendation", foreignDenied);
  check(
    "Cross-tenant review writes no state on A or B",
    statesAfterIso === statesBeforeIso && actionsAfterIso === actionsBeforeIso && bStates === 0,
  );

  const adminView = await loadOwnedStaffingReview(prisma, adminA);
  check(
    "ADMIN can read staffing facts but is not treated as a reviewer",
    adminView.canReview === false && adminView.recommendations.length > 0,
  );

  console.log(failed === 0 ? `\nAll workforce-staffing checks passed (${passed}).` : `\n${failed} workforce-staffing check(s) failed.`);
} catch (error) {
  failed += 1;
  console.error("FAIL - workforce staffing Prisma harness threw", error);
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
