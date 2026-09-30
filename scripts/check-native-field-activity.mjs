/**
 * Native assigned-job TRAVEL / MATERIAL_PICKUP time — reuse the
 * canonical time-card writes, assignment isolation, duplicate taps,
 * reassignment races, and approved-timesheet refusal.
 *
 * Imports the REAL production helpers from src/lib/native-field.ts,
 * src/lib/native-field-activity.ts, and src/lib/time-card-ops.ts.
 * Uses a disposable sibling Postgres database
 * (`tbbt_native_field_activity_test`).
 *
 * Run with:
 *   npm run test:native-field-activity
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { hashPassword } = await import("@/lib/auth-crypto");
const { NATIVE_JOB_NOT_AVAILABLE } = await import("@/lib/native-field-ops");
const {
  loadNativeAssignedJob,
  nativeActivityStartAction,
  nativeActivityStopAction,
} = await import("@/lib/native-field");
const {
  NATIVE_ACTIVITY_CHOOSE_TYPE,
  NATIVE_ACTIVITY_JSON_MAX_BYTES,
  parseNativeActivityTypeJson,
  startNativeAssignedActivityTime,
  stopNativeAssignedActivityTime,
} = await import("@/lib/native-field-activity");
const { resolveNativeFieldAccess, signInNativeField } = await import(
  "@/lib/native-session"
);
const { readCappedRequestText } = await import("@/lib/native-session-limits");
const { SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE } = await import(
  "@/lib/saas-billing/messages"
);
const { weekRange } = await import("@/lib/time-cards");
const NY = "America/New_York";
const {
  MATERIAL_PICKUP_START_TIME_STARTED_REASON,
  MATERIAL_PICKUP_STOP_TIME_CLOSED_REASON,
  TRAVEL_START_TIME_STARTED_REASON,
  TRAVEL_STOP_TIME_CLOSED_REASON,
} = await import("@/lib/time-card-ops");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_native_field_activity_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const adminUrl = new URL(baseUrl);
adminUrl.search = "";
const createDb = spawnSync("psql", [adminUrl.toString(), "-c", `CREATE DATABASE "${testDbName}"`], {
  encoding: "utf8",
});
if (createDb.status !== 0 && !/already exists/i.test(`${createDb.stderr}${createDb.stdout}`)) {
  console.warn(createDb.stderr || createDb.stdout);
}

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for native-field activity test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
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

function readRepo(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const activityOpsSrc = readRepo("src/lib/native-field-activity.ts");
const timeCardOpsSrc = readRepo("src/lib/time-card-ops.ts");
const nativeFieldSrc = readRepo("src/lib/native-field.ts");
const startRouteSrc = readRepo("src/app/api/native/v1/jobs/[jobId]/start-activity/route.ts");
const stopRouteSrc = readRepo("src/app/api/native/v1/jobs/[jobId]/stop-activity/route.ts");
const jobScreenSrc = readRepo("apps/native/src/screens/JobScreen.tsx");
const nativeApiSrc = readRepo("apps/native/src/api.ts");
const nativeTypesSrc = readRepo("apps/native/src/types.ts");
const docsSrc = readRepo("docs/NATIVE_FIELD.md");
const startActivityFnSrc = timeCardOpsSrc.slice(
  timeCardOpsSrc.indexOf("export async function startAssignedActivityTimeInTransaction"),
);
const stopActivityFnSrc = timeCardOpsSrc.slice(
  timeCardOpsSrc.indexOf("export async function stopAssignedActivityTimeInTransaction"),
);

console.log("\nSTATIC — Canonical activity write, lock recheck, and Job-screen reload");
check(
  "Native activity write reuses canonical start/stop and assigned-job scope",
  activityOpsSrc.includes("startAssignedActivityTimeInTransaction") &&
    activityOpsSrc.includes("stopAssignedActivityTimeInTransaction") &&
    activityOpsSrc.includes("nativeAssignedJobWhere") &&
    activityOpsSrc.includes("lockTenantOwnedJob") &&
    activityOpsSrc.includes("assignmentStillHeld") &&
    activityOpsSrc.includes("afterInitialRead") &&
    activityOpsSrc.includes("requireSaasOperatingEntitlement") &&
    startRouteSrc.includes("startNativeAssignedActivityTime") &&
    stopRouteSrc.includes("stopNativeAssignedActivityTime") &&
    !activityOpsSrc.includes("completeJobAndSendInvoice") &&
    !activityOpsSrc.includes("startJobWithRunningTimeSafetyInTransaction"),
);
check(
  "Canonical activity start locks the Job and does not change Job.status",
  startActivityFnSrc.includes("lockTenantOwnedJob") &&
    startActivityFnSrc.includes("ensureRunningAssignedActivityTimeInTransaction") &&
    !/startAssignedActivityTimeInTransaction[\s\S]*status: lifecycle.nextStatus/.test(
      startActivityFnSrc,
    ) &&
    !startActivityFnSrc.includes("evaluateStartJob") &&
    timeCardOpsSrc.includes("TRAVEL_START_TIME_STARTED_REASON") &&
    timeCardOpsSrc.includes("MATERIAL_PICKUP_START_TIME_STARTED_REASON"),
);
check(
  "Canonical activity stop closes only the named activity and leaves Job.status alone",
  stopActivityFnSrc.includes("lockTenantOwnedJob") &&
    stopActivityFnSrc.includes("closeLockedJobRunningTime") &&
    stopActivityFnSrc.includes("activityType: input.activityType") &&
    !stopActivityFnSrc.includes("evaluateCompleteJob") &&
    timeCardOpsSrc.includes("TRAVEL_STOP_TIME_CLOSED_REASON") &&
    timeCardOpsSrc.includes("MATERIAL_PICKUP_STOP_TIME_CLOSED_REASON"),
);
check(
  "Native activity routes use Bearer helpers, cap JSON, and never use cookies()",
  startRouteSrc.includes("readBearerToken") &&
    startRouteSrc.includes("readCappedRequestText") &&
    startRouteSrc.includes("parseNativeActivityTypeJson") &&
    stopRouteSrc.includes("readBearerToken") &&
    stopRouteSrc.includes("readCappedRequestText") &&
    !startRouteSrc.includes("cookies(") &&
    !stopRouteSrc.includes("cookies("),
);
check(
  "Native activity JSON is capped at 4 KB",
  activityOpsSrc.includes("NATIVE_ACTIVITY_JSON_MAX_BYTES = 4096") &&
    NATIVE_ACTIVITY_JSON_MAX_BYTES === 4096,
);
check(
  "Native job detail keeps JOB / TRAVEL / MATERIAL_PICKUP time distinct",
  nativeFieldSrc.includes("travelTime") &&
    nativeFieldSrc.includes("pickupTime") &&
    nativeFieldSrc.includes("loadNativeJobActivityTime") &&
    nativeFieldSrc.includes('loadNativeJobActivityTime(db, field, jobId, timeZone, "JOB")') &&
    nativeFieldSrc.includes('loadNativeJobActivityTime(db, field, jobId, timeZone, "TRAVEL")') &&
    nativeFieldSrc.includes(
      'loadNativeJobActivityTime(db, field, jobId, timeZone, "MATERIAL_PICKUP")',
    ),
);
check(
  "Native Job screen starts and stops travel and pickup, then reloads",
  jobScreenSrc.includes("startNativeActivityTime") &&
    jobScreenSrc.includes("stopNativeActivityTime") &&
    jobScreenSrc.includes("reloadAssignedJob") &&
    jobScreenSrc.includes("Start travel") &&
    jobScreenSrc.includes("Stop travel") &&
    jobScreenSrc.includes("Start material pickup") &&
    jobScreenSrc.includes("Stop material pickup") &&
    nativeApiSrc.includes("/start-activity") &&
    nativeApiSrc.includes("/stop-activity") &&
    nativeTypesSrc.includes("NativeFieldActivityType") &&
    nativeTypesSrc.includes("travelTime") &&
    nativeTypesSrc.includes("pickupTime"),
);
check(
  "Docs describe assignment-scoped travel/pickup and the dedicated activity check",
  docsSrc.includes("Travel and material pickup") &&
    docsSrc.includes("startAssignedActivityTimeInTransaction") &&
    docsSrc.includes("test:native-field-activity"),
);
check(
  "Activity start/stop actions follow the caller's running activity, not Job.status",
  nativeActivityStartAction(false).available === true &&
    nativeActivityStartAction(true).available === false &&
    nativeActivityStopAction(true).available === true &&
    nativeActivityStopAction(false).available === false,
);
check(
  "Activity start checks every running entry's week before the automatic close",
  timeCardOpsSrc.includes("assertRunningEntriesEditable") &&
    /await assertRunningEntriesEditable[\s\S]*for \(const current of running\)/.test(
      timeCardOpsSrc.slice(
        timeCardOpsSrc.indexOf("async function ensureRunningAssignedActivityTimeInTransaction"),
      ),
    ),
);

const emptyJson = parseNativeActivityTypeJson("{}");
const invalidJson = parseNativeActivityTypeJson('{"activityType":"JOB"}');
const breakJson = parseNativeActivityTypeJson('{"activityType":"BREAK"}');
const travelJson = parseNativeActivityTypeJson('{"activityType":"TRAVEL"}');
const pickupJson = parseNativeActivityTypeJson('{"activityType":"MATERIAL_PICKUP"}');
check(
  "Activity JSON accepts only TRAVEL and MATERIAL_PICKUP",
  emptyJson.ok === false &&
    emptyJson.error === NATIVE_ACTIVITY_CHOOSE_TYPE &&
    invalidJson.ok === false &&
    breakJson.ok === false &&
    travelJson.ok === true &&
    travelJson.activityType === "TRAVEL" &&
    pickupJson.ok === true &&
    pickupJson.activityType === "MATERIAL_PICKUP",
);

const oversizedBody = await readCappedRequestText(
  new Request("http://native.test/api/native/v1/jobs/job/start-activity", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "x".repeat(NATIVE_ACTIVITY_JSON_MAX_BYTES + 1),
  }),
  NATIVE_ACTIVITY_JSON_MAX_BYTES,
);
check(
  "Oversized activity JSON body is rejected before parse",
  oversizedBody.ok === false && oversizedBody.status === 413,
);

try {
  const onboardingDone = new Date();
  const completedOnboarding = {
    firstRunSetupCompletedAt: onboardingDone,
    starterServicesSetupCompletedAt: onboardingDone,
    starterServicesSetupChoice: "SKIPPED",
    websiteSetupCompletedAt: onboardingDone,
    websiteSetupChoice: "SKIPPED",
  };
  const password = "native-activity-pass-9";
  const passwordHash = await hashPassword(password);

  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Native Activity",
      slug: `alpha-native-activity-${randomUUID()}`,
      tradeCode: "HANDYMAN",
      ...completedOnboarding,
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Native Activity",
      slug: `beta-native-activity-${randomUUID()}`,
      tradeCode: "HANDYMAN",
      ...completedOnboarding,
    },
  });
  const blockedBusiness = await prisma.business.create({
    data: {
      name: "Blocked Native Activity",
      slug: `blocked-native-activity-${randomUUID()}`,
      tradeCode: "HANDYMAN",
      ...completedOnboarding,
    },
  });

  const ownerUser = await prisma.user.create({
    data: {
      name: "Olivia Owner",
      email: `owner-${randomUUID()}@native-activity.example`,
      passwordHash,
    },
  });
  const memberUser = await prisma.user.create({
    data: {
      name: "Mia Member",
      email: `mia-${randomUUID()}@native-activity.example`,
      passwordHash,
    },
  });
  const otherUser = await prisma.user.create({
    data: {
      name: "Max Other",
      email: `max-${randomUUID()}@native-activity.example`,
      passwordHash,
    },
  });
  const betaUser = await prisma.user.create({
    data: {
      name: "Bree Beta",
      email: `bree-${randomUUID()}@beta-activity.example`,
      passwordHash,
    },
  });
  const blockedUser = await prisma.user.create({
    data: {
      name: "Blocked Member",
      email: `blocked-${randomUUID()}@native-activity.example`,
      passwordHash,
    },
  });

  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const otherMem = await prisma.membership.create({
    data: { userId: otherUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const betaMem = await prisma.membership.create({
    data: { userId: betaUser.id, businessId: businessB.id, role: "MEMBER" },
  });
  const blockedMem = await prisma.membership.create({
    data: { userId: blockedUser.id, businessId: blockedBusiness.id, role: "MEMBER" },
  });

  await prisma.businessSaasSubscription.create({
    data: { businessId: businessA.id, status: "active", planCode: "FOUNDER", legacyExempt: true },
  });
  await prisma.businessSaasSubscription.create({
    data: { businessId: businessB.id, status: "active", planCode: "FOUNDER", legacyExempt: true },
  });
  const endedTrial = new Date(Date.now() - 60_000);
  await prisma.businessSaasSubscription.create({
    data: {
      businessId: blockedBusiness.id,
      status: "canceled",
      planCode: "FOUNDER",
      legacyExempt: false,
      trialStartedAt: new Date(endedTrial.getTime() - 14 * 24 * 60 * 60 * 1000),
      trialEndsAt: endedTrial,
      founderEligibilityEndedAt: endedTrial,
    },
  });

  async function createActivityJob(input) {
    const customer = await prisma.customer.create({
      data: {
        businessId: input.businessId,
        name: input.customerName ?? "Activity Customer",
        phone: "555-0142",
      },
    });
    return prisma.job.create({
      data: {
        businessId: input.businessId,
        customerId: customer.id,
        assignedMembershipId: input.assignedMembershipId ?? null,
        projectToken: randomUUID(),
        status: input.status ?? "SCHEDULED",
        scheduledAt: new Date(),
      },
    });
  }

  async function createRunningTime(input) {
    return prisma.timeEntry.create({
      data: {
        businessId: input.businessId,
        membershipId: input.membershipId,
        jobId: input.jobId,
        activityType: input.activityType,
        status: "RUNNING",
        startedAt: input.startedAt ?? new Date(Date.now() - 90_000),
        source: "CLOCK",
      },
    });
  }

  const travelJob = await createActivityJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Travel Canary",
    status: "SCHEDULED",
  });
  const pickupJob = await createActivityJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Pickup Canary",
    status: "IN_PROGRESS",
  });
  const otherJob = await createActivityJob({
    businessId: businessA.id,
    assignedMembershipId: otherMem.id,
    customerName: "Other Activity Canary",
  });
  const unassignedJob = await createActivityJob({
    businessId: businessA.id,
    customerName: "Unassigned Activity Canary",
  });
  const betaJob = await createActivityJob({
    businessId: businessB.id,
    assignedMembershipId: betaMem.id,
    customerName: "Beta Activity Canary",
  });
  const leftoverJob = await createActivityJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Leftover Job Time Canary",
    status: "IN_PROGRESS",
  });
  const leftoverJobTime = await createRunningTime({
    businessId: businessA.id,
    membershipId: memberMem.id,
    jobId: leftoverJob.id,
    activityType: "JOB",
  });
  const leftoverOtherTime = await createRunningTime({
    businessId: businessA.id,
    membershipId: otherMem.id,
    jobId: leftoverJob.id,
    activityType: "TRAVEL",
  });
  const raceJob = await createActivityJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Race Activity Canary",
  });
  const rollbackJob = await createActivityJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Rollback Activity Canary",
  });
  const duplicateJob = await createActivityJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Duplicate Activity Canary",
  });
  const blockedJob = await createActivityJob({
    businessId: blockedBusiness.id,
    assignedMembershipId: blockedMem.id,
    customerName: "Blocked Activity Canary",
  });
  const otherTravelJob = await createActivityJob({
    businessId: businessA.id,
    assignedMembershipId: otherMem.id,
    customerName: "Other Travel Canary",
    status: "IN_PROGRESS",
  });
  const otherTravelTime = await createRunningTime({
    businessId: businessA.id,
    membershipId: otherMem.id,
    jobId: otherTravelJob.id,
    activityType: "TRAVEL",
  });
  const betaTravelJob = await createActivityJob({
    businessId: businessB.id,
    assignedMembershipId: betaMem.id,
    customerName: "Beta Travel Canary",
    status: "IN_PROGRESS",
  });
  const betaTravelTime = await createRunningTime({
    businessId: businessB.id,
    membershipId: betaMem.id,
    jobId: betaTravelJob.id,
    activityType: "TRAVEL",
  });

  const memberSignIn = await signInNativeField(prisma, {
    email: memberUser.email,
    password,
  });
  const otherSignIn = await signInNativeField(prisma, {
    email: otherUser.email,
    password,
  });
  const betaSignIn = await signInNativeField(prisma, {
    email: betaUser.email,
    password,
  });
  const blockedSignIn = await signInNativeField(prisma, {
    email: blockedUser.email,
    password,
  });
  check("Assigned worker can sign in", memberSignIn.ok === true);
  if (!memberSignIn.ok || !otherSignIn.ok || !betaSignIn.ok || !blockedSignIn.ok) {
    throw new Error("Native activity fixture sign-in failed.");
  }

  const memberAccess = await resolveNativeFieldAccess(prisma, { token: memberSignIn.token });
  const otherAccess = await resolveNativeFieldAccess(prisma, { token: otherSignIn.token });
  const betaAccess = await resolveNativeFieldAccess(prisma, { token: betaSignIn.token });
  const blockedAccess = await resolveNativeFieldAccess(prisma, { token: blockedSignIn.token });
  if (!memberAccess.ok || !otherAccess.ok || !betaAccess.ok || !blockedAccess.ok) {
    throw new Error("Native activity fixture access failed.");
  }

  console.log("\nLIVE — Authorization, tenant isolation, and activity distinctness");

  const assignedDetail = await loadNativeAssignedJob(prisma, memberAccess.access, travelJob.id);
  const otherDetail = await loadNativeAssignedJob(prisma, memberAccess.access, otherJob.id);
  const betaDetail = await loadNativeAssignedJob(prisma, memberAccess.access, betaJob.id);
  const leftoverDetail = await loadNativeAssignedJob(prisma, memberAccess.access, leftoverJob.id);
  check(
    "Assigned job advertises distinct travel/pickup actions without starting the job",
    assignedDetail?.startTravelAction.available === true &&
      assignedDetail?.stopTravelAction.available === false &&
      assignedDetail?.startPickupAction.available === true &&
      assignedDetail?.stopPickupAction.available === false &&
      assignedDetail?.runningTime.running === false &&
      assignedDetail?.travelTime.running === false &&
      assignedDetail?.pickupTime.running === false &&
      assignedDetail?.status === "SCHEDULED",
  );
  check(
    "Running JOB time does not advertise Stop travel",
    leftoverDetail?.stopTimeAction.available === true &&
      leftoverDetail?.stopTravelAction.available === false &&
      leftoverDetail?.startTravelAction.available === true &&
      leftoverDetail?.runningTime.running === true &&
      leftoverDetail?.runningTime.activityType === "JOB" &&
      leftoverDetail?.travelTime.running === false,
  );
  check(
    "Unassigned and cross-tenant jobs are not readable",
    otherDetail === null && betaDetail === null,
  );

  const unauthorizedStart = await startNativeAssignedActivityTime(
    prisma,
    memberAccess.access,
    otherJob.id,
    "TRAVEL",
  );
  const unassignedStart = await startNativeAssignedActivityTime(
    prisma,
    memberAccess.access,
    unassignedJob.id,
    "TRAVEL",
  );
  const crossTenantStart = await startNativeAssignedActivityTime(
    prisma,
    memberAccess.access,
    betaJob.id,
    "TRAVEL",
  );
  const stolenStart = await startNativeAssignedActivityTime(
    prisma,
    otherAccess.access,
    travelJob.id,
    "TRAVEL",
  );
  const betaStealStart = await startNativeAssignedActivityTime(
    prisma,
    betaAccess.access,
    travelJob.id,
    "TRAVEL",
  );
  const travelJobAfterAuth = await prisma.job.findFirst({
    where: { id: travelJob.id, businessId: businessA.id },
    select: { status: true, assignedMembershipId: true },
  });
  const travelEntriesAfterAuth = await prisma.timeEntry.count({
    where: { jobId: travelJob.id, businessId: businessA.id },
  });
  check(
    "Assigned worker cannot start travel on another member's job",
    unauthorizedStart.ok === false &&
      unauthorizedStart.status === 404 &&
      unauthorizedStart.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Assigned worker cannot start travel on an unassigned job",
    unassignedStart.ok === false && unassignedStart.status === 404,
  );
  check(
    "Assigned worker cannot start travel on a cross-tenant job",
    crossTenantStart.ok === false &&
      crossTenantStart.status === 404 &&
      crossTenantStart.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Other MEMBER cannot start travel on a job assigned to someone else",
    stolenStart.ok === false && stolenStart.status === 404,
  );
  check(
    "Failed start-travel leaves Job, assignment, and time unchanged",
    travelJobAfterAuth?.status === "SCHEDULED" &&
      travelJobAfterAuth?.assignedMembershipId === memberMem.id &&
      travelEntriesAfterAuth === 0 &&
      betaStealStart.ok === false &&
      betaStealStart.status === 404,
  );

  const unauthorizedStop = await stopNativeAssignedActivityTime(
    prisma,
    memberAccess.access,
    otherTravelJob.id,
    "TRAVEL",
  );
  const crossTenantStop = await stopNativeAssignedActivityTime(
    prisma,
    memberAccess.access,
    betaTravelJob.id,
    "TRAVEL",
  );
  const otherTravelAfter = await prisma.timeEntry.findFirst({
    where: { id: otherTravelTime.id, businessId: businessA.id },
    select: { status: true, endedAt: true },
  });
  const betaTravelAfter = await prisma.timeEntry.findFirst({
    where: { id: betaTravelTime.id, businessId: businessB.id },
    select: { status: true, endedAt: true },
  });
  check(
    "Assigned worker cannot stop travel on another member's job",
    unauthorizedStop.ok === false && unauthorizedStop.status === 404,
  );
  check(
    "Assigned worker cannot stop travel on a cross-tenant job",
    crossTenantStop.ok === false &&
      crossTenantStop.status === 404 &&
      otherTravelAfter?.status === "RUNNING" &&
      otherTravelAfter?.endedAt === null &&
      betaTravelAfter?.status === "RUNNING" &&
      betaTravelAfter?.endedAt === null,
  );

  const blockedStart = await startNativeAssignedActivityTime(
    prisma,
    blockedAccess.access,
    blockedJob.id,
    "TRAVEL",
  );
  const blockedJobAfter = await prisma.job.findFirst({
    where: { id: blockedJob.id, businessId: blockedBusiness.id },
    select: { status: true },
  });
  check(
    "Start travel requires an operating SaaS entitlement",
    blockedStart.ok === false &&
      blockedStart.status === 403 &&
      blockedStart.error === SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE &&
      blockedJobAfter?.status === "SCHEDULED",
  );

  const leftoverTravelStart = await startNativeAssignedActivityTime(
    prisma,
    memberAccess.access,
    leftoverJob.id,
    "TRAVEL",
  );
  const leftoverJobAfter = await prisma.job.findFirst({
    where: { id: leftoverJob.id, businessId: businessA.id },
    select: { status: true },
  });
  const leftoverJobTimeAfter = await prisma.timeEntry.findFirst({
    where: { id: leftoverJobTime.id, businessId: businessA.id },
    select: { status: true, endedAt: true, activityType: true },
  });
  const leftoverOtherAfter = await prisma.timeEntry.findFirst({
    where: { id: leftoverOtherTime.id, businessId: businessA.id },
    select: { status: true, endedAt: true, membershipId: true, activityType: true },
  });
  const leftoverTravelAfter = await prisma.timeEntry.findFirst({
    where: {
      jobId: leftoverJob.id,
      businessId: businessA.id,
      membershipId: memberMem.id,
      activityType: "TRAVEL",
    },
    select: { status: true, endedAt: true },
  });
  check(
    "Starting TRAVEL closes the caller's running JOB clock and leaves Job IN_PROGRESS",
    leftoverTravelStart.ok === true &&
      leftoverJobAfter?.status === "IN_PROGRESS" &&
      leftoverJobTimeAfter?.activityType === "JOB" &&
      leftoverJobTimeAfter?.status === "READY" &&
      leftoverJobTimeAfter?.endedAt != null &&
      leftoverTravelAfter?.status === "RUNNING" &&
      leftoverOtherAfter?.status === "RUNNING" &&
      leftoverOtherAfter?.endedAt === null &&
      leftoverOtherAfter?.membershipId === otherMem.id &&
      leftoverOtherAfter?.activityType === "TRAVEL",
  );

  const leftoverStopTravel = await stopNativeAssignedActivityTime(
    prisma,
    memberAccess.access,
    leftoverJob.id,
    "TRAVEL",
  );
  const leftoverJobTimeAfterStop = await prisma.timeEntry.findFirst({
    where: { id: leftoverJobTime.id, businessId: businessA.id },
    select: { status: true, endedAt: true },
  });
  const leftoverJobAfterStop = await prisma.job.findFirst({
    where: { id: leftoverJob.id, businessId: businessA.id },
    select: { status: true },
  });
  const leftoverTravelStopped = await prisma.timeEntry.findFirst({
    where: {
      jobId: leftoverJob.id,
      businessId: businessA.id,
      membershipId: memberMem.id,
      activityType: "TRAVEL",
    },
    select: { status: true, endedAt: true },
  });
  check(
    "Stopping TRAVEL does not reopen or complete JOB time and leaves Job IN_PROGRESS",
    leftoverStopTravel.ok === true &&
      leftoverStopTravel.alreadyStopped === false &&
      leftoverJobAfterStop?.status === "IN_PROGRESS" &&
      leftoverTravelStopped?.status === "READY" &&
      leftoverTravelStopped?.endedAt != null &&
      leftoverJobTimeAfterStop?.status === "READY" &&
      leftoverJobTimeAfterStop?.endedAt != null,
  );

  console.log("\nLIVE — Start/stop travel, JOB distinctness, duplicates, races, rollback");

  const firstTravel = await startNativeAssignedActivityTime(
    prisma,
    memberAccess.access,
    travelJob.id,
    "TRAVEL",
  );
  const reloadedTravel = await loadNativeAssignedJob(prisma, memberAccess.access, travelJob.id);
  const travelJobPersisted = await prisma.job.findFirst({
    where: { id: travelJob.id, businessId: businessA.id },
    select: { status: true },
  });
  const travelTimePersisted = await prisma.timeEntry.findFirst({
    where: {
      jobId: travelJob.id,
      businessId: businessA.id,
      membershipId: memberMem.id,
      activityType: "TRAVEL",
    },
    select: { id: true, status: true, endedAt: true, activityType: true, jobId: true },
  });
  const travelJobTimeCount = await prisma.timeEntry.count({
    where: { jobId: travelJob.id, businessId: businessA.id, activityType: "JOB" },
  });
  const travelStartAdjustment = await prisma.timeEntryAdjustment.findFirst({
    where: { timeEntryId: travelTimePersisted?.id ?? "", reason: TRAVEL_START_TIME_STARTED_REASON },
    select: { action: true },
  });
  const travelEvents = await prisma.businessEvent.count({
    where: {
      businessId: businessA.id,
      type: { in: ["JOB_STARTED", "JOB_COMPLETED"] },
      subjectId: travelJob.id,
    },
  });
  check(
    "Assigned worker can start TRAVEL without starting the Job or creating JOB time",
    firstTravel.ok === true &&
      firstTravel.alreadyStarted === false &&
      firstTravel.job.status === "SCHEDULED" &&
      firstTravel.job.travelTime.running === true &&
      firstTravel.job.travelTime.activityType === "TRAVEL" &&
      firstTravel.job.runningTime.running === false &&
      firstTravel.job.stopTravelAction.available === true &&
      firstTravel.job.startTravelAction.available === false &&
      firstTravel.job.stopTimeAction.available === false &&
      travelJobPersisted?.status === "SCHEDULED" &&
      travelTimePersisted?.status === "RUNNING" &&
      travelTimePersisted?.activityType === "TRAVEL" &&
      travelTimePersisted?.endedAt === null &&
      travelJobTimeCount === 0 &&
      travelStartAdjustment?.action === "CREATE" &&
      travelEvents === 0,
  );
  check(
    "Reload after Start travel shows SCHEDULED and running travel, not JOB time",
    reloadedTravel?.status === "SCHEDULED" &&
      reloadedTravel?.travelTime.running === true &&
      reloadedTravel?.travelTime.activityType === "TRAVEL" &&
      reloadedTravel?.runningTime.running === false &&
      reloadedTravel?.stopTravelAction.available === true,
  );

  const firstTravelStop = await stopNativeAssignedActivityTime(
    prisma,
    memberAccess.access,
    travelJob.id,
    "TRAVEL",
  );
  const travelTimeAfterStop = await prisma.timeEntry.findFirst({
    where: { id: travelTimePersisted?.id ?? "", businessId: businessA.id },
    select: { status: true, endedAt: true },
  });
  const travelJobAfterStop = await prisma.job.findFirst({
    where: { id: travelJob.id, businessId: businessA.id },
    select: { status: true },
  });
  const travelStopAdjustment = await prisma.timeEntryAdjustment.findFirst({
    where: { timeEntryId: travelTimePersisted?.id ?? "", reason: TRAVEL_STOP_TIME_CLOSED_REASON },
    select: { action: true },
  });
  check(
    "Assigned worker can stop TRAVEL without starting or completing the Job",
    firstTravelStop.ok === true &&
      firstTravelStop.alreadyStopped === false &&
      firstTravelStop.job.status === "SCHEDULED" &&
      firstTravelStop.job.travelTime.running === false &&
      firstTravelStop.job.travelTime.recorded === true &&
      travelJobAfterStop?.status === "SCHEDULED" &&
      travelTimeAfterStop?.status === "READY" &&
      travelTimeAfterStop?.endedAt != null &&
      travelStopAdjustment?.action === "UPDATE",
  );

  const firstPickup = await startNativeAssignedActivityTime(
    prisma,
    memberAccess.access,
    pickupJob.id,
    "MATERIAL_PICKUP",
  );
  const pickupJobPersisted = await prisma.job.findFirst({
    where: { id: pickupJob.id, businessId: businessA.id },
    select: { status: true },
  });
  const pickupTimePersisted = await prisma.timeEntry.findFirst({
    where: {
      jobId: pickupJob.id,
      businessId: businessA.id,
      membershipId: memberMem.id,
      activityType: "MATERIAL_PICKUP",
    },
    select: { id: true, status: true, activityType: true },
  });
  const pickupJobTimeCount = await prisma.timeEntry.count({
    where: { jobId: pickupJob.id, businessId: businessA.id, activityType: "JOB" },
  });
  const pickupStartAdjustment = await prisma.timeEntryAdjustment.findFirst({
    where: {
      timeEntryId: pickupTimePersisted?.id ?? "",
      reason: MATERIAL_PICKUP_START_TIME_STARTED_REASON,
    },
    select: { action: true },
  });
  check(
    "Assigned worker can start MATERIAL_PICKUP without creating JOB time or completing the Job",
    firstPickup.ok === true &&
      firstPickup.alreadyStarted === false &&
      firstPickup.job.status === "IN_PROGRESS" &&
      firstPickup.job.pickupTime.running === true &&
      firstPickup.job.pickupTime.activityType === "MATERIAL_PICKUP" &&
      firstPickup.job.runningTime.running === false &&
      firstPickup.job.travelTime.running === false &&
      pickupJobPersisted?.status === "IN_PROGRESS" &&
      pickupTimePersisted?.status === "RUNNING" &&
      pickupTimePersisted?.activityType === "MATERIAL_PICKUP" &&
      pickupJobTimeCount === 0 &&
      pickupStartAdjustment?.action === "CREATE",
  );

  const firstPickupStop = await stopNativeAssignedActivityTime(
    prisma,
    memberAccess.access,
    pickupJob.id,
    "MATERIAL_PICKUP",
  );
  const pickupTimeAfterStop = await prisma.timeEntry.findFirst({
    where: { id: pickupTimePersisted?.id ?? "", businessId: businessA.id },
    select: { status: true, endedAt: true },
  });
  const pickupStopAdjustment = await prisma.timeEntryAdjustment.findFirst({
    where: {
      timeEntryId: pickupTimePersisted?.id ?? "",
      reason: MATERIAL_PICKUP_STOP_TIME_CLOSED_REASON,
    },
    select: { action: true },
  });
  check(
    "Assigned worker can stop MATERIAL_PICKUP without completing the Job",
    firstPickupStop.ok === true &&
      firstPickupStop.alreadyStopped === false &&
      firstPickupStop.job.status === "IN_PROGRESS" &&
      firstPickupStop.job.pickupTime.running === false &&
      firstPickupStop.job.pickupTime.recorded === true &&
      pickupJobPersisted?.status === "IN_PROGRESS" &&
      pickupTimeAfterStop?.status === "READY" &&
      pickupTimeAfterStop?.endedAt != null &&
      pickupStopAdjustment?.action === "UPDATE",
  );

  const repeatTravel = await startNativeAssignedActivityTime(
    prisma,
    memberAccess.access,
    travelJob.id,
    "TRAVEL",
  );
  const repeatTravelAgain = await startNativeAssignedActivityTime(
    prisma,
    memberAccess.access,
    travelJob.id,
    "TRAVEL",
  );
  const repeatTravelCount = await prisma.timeEntry.count({
    where: {
      jobId: travelJob.id,
      businessId: businessA.id,
      activityType: "TRAVEL",
      status: "RUNNING",
    },
  });
  check(
    "Duplicate Start travel on already-running travel is a successful no-op",
    repeatTravel.ok === true &&
      repeatTravel.alreadyStarted === false &&
      repeatTravelAgain.ok === true &&
      repeatTravelAgain.alreadyStarted === true &&
      repeatTravelAgain.alreadyRunningTime === true &&
      repeatTravelAgain.job.status === "SCHEDULED" &&
      repeatTravelCount === 1,
  );

  const repeatTravelStop = await stopNativeAssignedActivityTime(
    prisma,
    memberAccess.access,
    travelJob.id,
    "TRAVEL",
  );
  const idleTravelStop = await stopNativeAssignedActivityTime(
    prisma,
    memberAccess.access,
    travelJob.id,
    "TRAVEL",
  );
  check(
    "Duplicate Stop travel on already-stopped travel is a successful no-op",
    repeatTravelStop.ok === true &&
      repeatTravelStop.alreadyStopped === false &&
      idleTravelStop.ok === true &&
      idleTravelStop.alreadyStopped === true &&
      idleTravelStop.job.status === "SCHEDULED",
  );

  const [startDupA, startDupB] = await Promise.all([
    startNativeAssignedActivityTime(prisma, memberAccess.access, duplicateJob.id, "TRAVEL"),
    startNativeAssignedActivityTime(prisma, memberAccess.access, duplicateJob.id, "TRAVEL"),
  ]);
  const duplicateAfter = await prisma.job.findFirst({
    where: { id: duplicateJob.id, businessId: businessA.id },
    select: { status: true },
  });
  const duplicateTravelRows = await prisma.timeEntry.findMany({
    where: {
      jobId: duplicateJob.id,
      businessId: businessA.id,
      activityType: "TRAVEL",
      status: "RUNNING",
    },
    select: { status: true },
  });
  check(
    "Concurrent Start travel requests both succeed and leave one RUNNING TRAVEL entry",
    startDupA.ok === true &&
      startDupB.ok === true &&
      [startDupA.alreadyStarted, startDupB.alreadyStarted].filter(Boolean).length <= 1 &&
      duplicateAfter?.status === "SCHEDULED" &&
      duplicateTravelRows.length === 1,
  );

  const [stopDupA, stopDupB] = await Promise.all([
    stopNativeAssignedActivityTime(prisma, memberAccess.access, duplicateJob.id, "TRAVEL"),
    stopNativeAssignedActivityTime(prisma, memberAccess.access, duplicateJob.id, "TRAVEL"),
  ]);
  const duplicateStopRows = await prisma.timeEntry.findMany({
    where: {
      jobId: duplicateJob.id,
      businessId: businessA.id,
      activityType: "TRAVEL",
    },
    select: { status: true, endedAt: true },
  });
  check(
    "Concurrent Stop travel requests both succeed and leave one READY TRAVEL entry",
    stopDupA.ok === true &&
      stopDupB.ok === true &&
      [stopDupA.alreadyStopped, stopDupB.alreadyStopped].filter(Boolean).length <= 1 &&
      duplicateStopRows.length === 1 &&
      duplicateStopRows[0]?.status === "READY" &&
      duplicateStopRows[0]?.endedAt != null,
  );

  const race = await startNativeAssignedActivityTime(
    prisma,
    memberAccess.access,
    raceJob.id,
    "TRAVEL",
    {
      afterInitialRead: async () => {
        await prisma.job.update({
          where: { id: raceJob.id },
          data: { assignedMembershipId: otherMem.id },
        });
      },
    },
  );
  const raceJobAfter = await prisma.job.findFirst({
    where: { id: raceJob.id, businessId: businessA.id },
    select: { status: true, assignedMembershipId: true },
  });
  const raceTimeAfter = await prisma.timeEntry.count({
    where: { jobId: raceJob.id, businessId: businessA.id },
  });
  check(
    "Assignment change after the initial read refuses Start travel",
    race.ok === false && race.status === 404 && race.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Reassigned Job after the initial read leaves Job and time unchanged",
    raceJobAfter?.status === "SCHEDULED" &&
      raceJobAfter?.assignedMembershipId === otherMem.id &&
      raceTimeAfter === 0,
  );

  const priorWeekUser = await prisma.user.create({
    data: {
      name: "Prior Week Worker",
      email: `prior-${randomUUID()}@native-activity.example`,
      passwordHash,
    },
  });
  const priorWeekMem = await prisma.membership.create({
    data: { userId: priorWeekUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const priorWeekSignIn = await signInNativeField(prisma, {
    email: priorWeekUser.email,
    password,
  });
  if (!priorWeekSignIn.ok) {
    throw new Error("Prior-week activity fixture sign-in failed.");
  }
  const priorWeekAccess = await resolveNativeFieldAccess(prisma, {
    token: priorWeekSignIn.token,
  });
  if (!priorWeekAccess.ok) {
    throw new Error("Prior-week activity fixture access failed.");
  }
  const priorWeekJob = await createActivityJob({
    businessId: businessA.id,
    assignedMembershipId: priorWeekMem.id,
    customerName: "Prior Week Travel Canary",
    status: "IN_PROGRESS",
  });
  const currentWeekJob = await createActivityJob({
    businessId: businessA.id,
    assignedMembershipId: priorWeekMem.id,
    customerName: "Open Current Week Canary",
  });
  const now = new Date();
  const currentWeekStart = weekRange(now, NY).start;
  const priorStartedAt = new Date(currentWeekStart.getTime() - 24 * 60 * 60 * 1000);
  const priorWeekStart = weekRange(priorStartedAt, NY).start;
  const priorWeekTime = await createRunningTime({
    businessId: businessA.id,
    membershipId: priorWeekMem.id,
    jobId: priorWeekJob.id,
    activityType: "TRAVEL",
    startedAt: priorStartedAt,
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
  const priorWeekStartTravel = await startNativeAssignedActivityTime(
    prisma,
    priorWeekAccess.access,
    currentWeekJob.id,
    "MATERIAL_PICKUP",
  );
  const priorWeekTimeAfter = await prisma.timeEntry.findFirst({
    where: { id: priorWeekTime.id, businessId: businessA.id },
    select: { status: true, endedAt: true, activityType: true, startedAt: true },
  });
  const currentWeekPickupAfter = await prisma.timeEntry.findFirst({
    where: {
      jobId: currentWeekJob.id,
      businessId: businessA.id,
      membershipId: priorWeekMem.id,
    },
  });
  const priorWeekCloseAdjustments = await prisma.timeEntryAdjustment.count({
    where: { timeEntryId: priorWeekTime.id },
  });
  const priorWeekJobAfter = await prisma.job.findFirst({
    where: { id: priorWeekJob.id, businessId: businessA.id },
    select: { status: true },
  });
  const currentWeekJobAfter = await prisma.job.findFirst({
    where: { id: currentWeekJob.id, businessId: businessA.id },
    select: { status: true },
  });
  check(
    "Approved prior week and open current week are distinct fixtures",
    priorWeekStart.getTime() < currentWeekStart.getTime(),
  );
  check(
    "Approved prior-week running time refuses Start pickup in an open current week",
    priorWeekStartTravel.ok === false &&
      priorWeekStartTravel.status === 409 &&
      /approved/i.test(priorWeekStartTravel.error ?? "") &&
      currentWeekPickupAfter == null,
  );
  check(
    "Refused prior-week clock transition rolls back all time changes",
    priorWeekTimeAfter?.status === "RUNNING" &&
      priorWeekTimeAfter?.endedAt === null &&
      priorWeekTimeAfter?.activityType === "TRAVEL" &&
      priorWeekTimeAfter?.startedAt.getTime() === priorStartedAt.getTime() &&
      priorWeekCloseAdjustments === 0 &&
      priorWeekJobAfter?.status === "IN_PROGRESS" &&
      currentWeekJobAfter?.status === "SCHEDULED",
  );

  const rollbackStartedAt = new Date(Date.now() - 60_000);
  const rollbackTime = await createRunningTime({
    businessId: businessA.id,
    membershipId: memberMem.id,
    jobId: rollbackJob.id,
    activityType: "TRAVEL",
    startedAt: rollbackStartedAt,
  });
  await prisma.timesheetWeek.create({
    data: {
      businessId: businessA.id,
      membershipId: memberMem.id,
      weekStartedAt: weekRange(rollbackStartedAt, NY).start,
      status: "APPROVED",
      approvedAt: new Date(),
      approvedByMembershipId: ownerMem.id,
    },
  });
  const rollbackStop = await stopNativeAssignedActivityTime(
    prisma,
    memberAccess.access,
    rollbackJob.id,
    "TRAVEL",
  );
  const rollbackStart = await startNativeAssignedActivityTime(
    prisma,
    memberAccess.access,
    pickupJob.id,
    "TRAVEL",
  );
  const rollbackJobAfter = await prisma.job.findFirst({
    where: { id: rollbackJob.id, businessId: businessA.id },
    select: { status: true },
  });
  const rollbackTimeAfter = await prisma.timeEntry.findFirst({
    where: { id: rollbackTime.id, businessId: businessA.id },
    select: { status: true, endedAt: true, activityType: true },
  });
  const pickupAfterApprovedStart = await prisma.timeEntry.findFirst({
    where: {
      jobId: pickupJob.id,
      businessId: businessA.id,
      activityType: "TRAVEL",
    },
  });
  check(
    "Approved timesheet week refuses Stop travel",
    rollbackStop.ok === false &&
      rollbackStop.status === 409 &&
      /approved/i.test(rollbackStop.error ?? ""),
  );
  check(
    "Approved timesheet week refuses Start travel",
    rollbackStart.ok === false &&
      rollbackStart.status === 409 &&
      /approved/i.test(rollbackStart.error ?? "") &&
      pickupAfterApprovedStart == null,
  );
  check(
    "Failed activity write rolls back Job status and leaves TRAVEL running",
    rollbackJobAfter?.status === "SCHEDULED" &&
      rollbackTimeAfter?.status === "RUNNING" &&
      rollbackTimeAfter?.endedAt === null &&
      rollbackTimeAfter?.activityType === "TRAVEL",
  );

  const otherTravelFinal = await prisma.timeEntry.findFirst({
    where: { id: otherTravelTime.id, businessId: businessA.id },
    select: { status: true, endedAt: true },
  });
  const betaTravelFinal = await prisma.timeEntry.findFirst({
    where: { id: betaTravelTime.id, businessId: businessB.id },
    select: { status: true, endedAt: true },
  });
  check(
    "Activity writes stay on the assigned job and never mutate other tenants",
    otherTravelFinal?.status === "RUNNING" &&
      otherTravelFinal?.endedAt === null &&
      betaTravelFinal?.status === "RUNNING" &&
      betaTravelFinal?.endedAt === null,
  );
} catch (error) {
  failures += 1;
  console.error("FAIL - live native activity time", error);
} finally {
  await prisma.$disconnect();
}

console.log(
  failures === 0
    ? "\nNative field activity check passed: canonical write, isolation, duplicates, races, and rollback held."
    : `\n${failures} native field activity check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
