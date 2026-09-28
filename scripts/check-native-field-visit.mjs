/**
 * Native assigned-job Cleaning visit outcome — reuse the canonical
 * visit write, assignment isolation, duplicate taps, reassignment
 * races, and running-time rollback.
 *
 * Imports the REAL production helpers from src/lib/native-field.ts and
 * src/lib/native-field-visits.ts. Uses a disposable sibling Postgres
 * database (`tbbt_native_field_visit_test`).
 *
 * Run with:
 *   npm run test:native-field-visit
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { hashPassword } = await import("@/lib/auth-crypto");
const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const {
  START_BEFORE_COMPLETE_MESSAGE,
  CLEANING_VISIT_ONLY_MESSAGE,
} = await import("@/lib/cleaning-visit-workflow");
const { setCleaningVisitCadence } = await import("@/lib/cleaning-visit-ops");
const { NATIVE_JOB_NOT_AVAILABLE } = await import("@/lib/native-field-ops");
const {
  loadNativeAssignedJob,
  nativeVisitCompletedAction,
} = await import("@/lib/native-field");
const {
  NATIVE_VISIT_CHOOSE_OUTCOME,
  NATIVE_VISIT_JSON_MAX_BYTES,
  parseNativeVisitOutcomeJson,
  recordNativeAssignedVisitOutcome,
} = await import("@/lib/native-field-visits");
const { resolveNativeFieldAccess, signInNativeField } = await import(
  "@/lib/native-session"
);
const { readCappedRequestText } = await import("@/lib/native-session-limits");
const { SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE } = await import(
  "@/lib/saas-billing/messages"
);
const { weekRange } = await import("@/lib/time-cards");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_native_field_visit_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for native-field visit test database.");
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

function makeOwnerAccess(businessId, membershipId, userId) {
  return {
    businessId,
    workspace: {
      role: "OWNER",
      membership: { id: membershipId },
      user: { id: userId, email: "owner@native-visit.example", name: "Owner" },
      business: { id: businessId, name: "Visit Co", timezone: "America/New_York" },
    },
    scope: businessScope(businessId),
    assertOwned(record) {
      return assertBusinessRecord(record, businessId);
    },
    assertAttachable(record) {
      return assertBusinessRecord(record, businessId);
    },
  };
}

const visitOpsSrc = readRepo("src/lib/native-field-visits.ts");
const visitLibSrc = readRepo("src/lib/native-field.ts");
const canonicalOpsSrc = readRepo("src/lib/cleaning-visit-ops.ts");
const visitRouteSrc = readRepo("src/app/api/native/v1/jobs/[jobId]/visit/route.ts");
const jobScreenSrc = readRepo("apps/native/src/screens/JobScreen.tsx");
const nativeApiSrc = readRepo("apps/native/src/api.ts");
const nativeTypesSrc = readRepo("apps/native/src/types.ts");
const docsSrc = readRepo("docs/NATIVE_FIELD.md");
const recordOutcomeSrc = canonicalOpsSrc.slice(
  canonicalOpsSrc.indexOf("export async function recordAssignedVisitOutcome"),
);

console.log("\nSTATIC — Canonical visit write, lock recheck, and Job-screen reload");
check(
  "Native visit write reuses recordAssignedVisitOutcome and assigned-job scope",
  visitOpsSrc.includes("recordAssignedVisitOutcome") &&
    visitOpsSrc.includes("nativeAssignedJobWhere") &&
    visitOpsSrc.includes("afterInitialRead") &&
    visitOpsSrc.includes("requireSaasOperatingEntitlement") &&
    visitRouteSrc.includes("recordNativeAssignedVisitOutcome") &&
    !visitOpsSrc.includes("$transaction") &&
    !visitOpsSrc.includes("completeJobWithRunningTimeSafetyInTransaction") &&
    !visitOpsSrc.includes("job.create("),
);
check(
  "Canonical VISIT_COMPLETED still locks, rechecks assignment, and completes atomically",
  recordOutcomeSrc.includes("lockTenantOwnedJob") &&
    recordOutcomeSrc.includes("completeJobWithRunningTimeSafetyInTransaction") &&
    recordOutcomeSrc.includes("assignedMembershipId") &&
    recordOutcomeSrc.indexOf("lockTenantOwnedJob") <
      recordOutcomeSrc.indexOf("jobCrewVisit.update") &&
    recordOutcomeSrc.indexOf("locked.assignedMembershipId") <
      recordOutcomeSrc.indexOf("jobCrewVisit.update"),
);
check(
  "Native visit route uses Bearer helpers, caps JSON, and never uses cookies()",
  visitRouteSrc.includes("readBearerToken") &&
    visitRouteSrc.includes("readCappedRequestText") &&
    visitRouteSrc.includes("parseNativeVisitOutcomeJson") &&
    !visitRouteSrc.includes("cookies("),
);
check(
  "Native visit JSON is capped at 4 KB",
  visitOpsSrc.includes("NATIVE_VISIT_JSON_MAX_BYTES = 4096") &&
    NATIVE_VISIT_JSON_MAX_BYTES === 4096,
);
check(
  "Native Job screen records a visit outcome and reloads it",
  jobScreenSrc.includes("recordNativeJobVisit") &&
    jobScreenSrc.includes("reloadAssignedJob") &&
    jobScreenSrc.includes("outcomeLabel") &&
    jobScreenSrc.includes("Record visit completed") &&
    jobScreenSrc.includes("Request re-clean") &&
    nativeApiSrc.includes("/visit") &&
    nativeTypesSrc.includes("NativeJobVisit") &&
    !jobScreenSrc.includes("itemKey") &&
    !jobScreenSrc.includes("Mark done"),
);
check(
  "Docs describe assignment-scoped visit outcome and the dedicated visit check",
  docsSrc.includes("Visit outcome") &&
    docsSrc.includes("recordAssignedVisitOutcome") &&
    docsSrc.includes("test:native-field-visit"),
);
check(
  "nativeVisitCompletedAction uses the visit start-before-complete gate",
  nativeVisitCompletedAction("IN_PROGRESS").available === true &&
    nativeVisitCompletedAction("COMPLETED").available === true &&
    nativeVisitCompletedAction("SCHEDULED").available === false &&
    nativeVisitCompletedAction("SCHEDULED").reason === START_BEFORE_COMPLETE_MESSAGE,
);

const emptyJson = parseNativeVisitOutcomeJson("{}");
const invalidJson = parseNativeVisitOutcomeJson('{"outcomeStatus":"NONE"}');
const completedJson = parseNativeVisitOutcomeJson('{"outcomeStatus":"VISIT_COMPLETED"}');
const recleanJson = parseNativeVisitOutcomeJson('{"outcomeStatus":"RE_CLEAN_REQUESTED"}');
check(
  "Visit JSON accepts only the two recorded outcomes",
  emptyJson.ok === false &&
    emptyJson.error === NATIVE_VISIT_CHOOSE_OUTCOME &&
    invalidJson.ok === false &&
    completedJson.ok === true &&
    completedJson.outcomeStatus === "VISIT_COMPLETED" &&
    recleanJson.ok === true &&
    recleanJson.outcomeStatus === "RE_CLEAN_REQUESTED",
);

const oversizedBody = await readCappedRequestText(
  new Request("http://native.test/api/native/v1/jobs/job/visit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "x".repeat(NATIVE_VISIT_JSON_MAX_BYTES + 1),
  }),
  NATIVE_VISIT_JSON_MAX_BYTES,
);
check(
  "Oversized visit JSON body is rejected before parse",
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
  const password = "native-visit-pass-9";
  const passwordHash = await hashPassword(password);

  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Native Visit",
      slug: `alpha-native-visit-${randomUUID()}`,
      tradeCode: "CLEANING",
      ...completedOnboarding,
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Native Visit",
      slug: `beta-native-visit-${randomUUID()}`,
      tradeCode: "CLEANING",
      ...completedOnboarding,
    },
  });
  const blockedBusiness = await prisma.business.create({
    data: {
      name: "Blocked Native Visit",
      slug: `blocked-native-visit-${randomUUID()}`,
      tradeCode: "CLEANING",
      ...completedOnboarding,
    },
  });
  const handyBusiness = await prisma.business.create({
    data: {
      name: "Handy Native Visit",
      slug: `handy-native-visit-${randomUUID()}`,
      tradeCode: "HANDYMAN",
      ...completedOnboarding,
    },
  });

  const ownerUser = await prisma.user.create({
    data: {
      name: "Olivia Owner",
      email: `owner-${randomUUID()}@native-visit.example`,
      passwordHash,
    },
  });
  const memberUser = await prisma.user.create({
    data: {
      name: "Mia Member",
      email: `mia-${randomUUID()}@native-visit.example`,
      passwordHash,
    },
  });
  const otherUser = await prisma.user.create({
    data: {
      name: "Max Other",
      email: `max-${randomUUID()}@native-visit.example`,
      passwordHash,
    },
  });
  const betaUser = await prisma.user.create({
    data: {
      name: "Bree Beta",
      email: `bree-${randomUUID()}@beta-visit.example`,
      passwordHash,
    },
  });
  const blockedUser = await prisma.user.create({
    data: {
      name: "Blocked Member",
      email: `blocked-${randomUUID()}@native-visit.example`,
      passwordHash,
    },
  });
  const handyUser = await prisma.user.create({
    data: {
      name: "Handy Member",
      email: `handy-${randomUUID()}@native-visit.example`,
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
  const handyMem = await prisma.membership.create({
    data: { userId: handyUser.id, businessId: handyBusiness.id, role: "MEMBER" },
  });

  await prisma.businessSaasSubscription.create({
    data: { businessId: businessA.id, status: "active", planCode: "FOUNDER", legacyExempt: true },
  });
  await prisma.businessSaasSubscription.create({
    data: { businessId: businessB.id, status: "active", planCode: "FOUNDER", legacyExempt: true },
  });
  await prisma.businessSaasSubscription.create({
    data: {
      businessId: handyBusiness.id,
      status: "active",
      planCode: "FOUNDER",
      legacyExempt: true,
    },
  });

  const ownerA = makeOwnerAccess(businessA.id, ownerMem.id, ownerUser.id);

  async function createTradeJob(input) {
    const customer = await prisma.customer.create({
      data: {
        businessId: input.businessId,
        name: input.customerName ?? `${input.tradeCode} Customer`,
        email: `${input.tradeCode}-${randomUUID().slice(0, 8)}@native-visit.example`,
        phone: "555-0142",
      },
    });
    const request = await prisma.serviceRequest.create({
      data: {
        businessId: input.businessId,
        customerId: customer.id,
        description: `${input.tradeCode} visit`,
        tradeCode: input.tradeCode,
        serviceIntent: "ONE_TIME",
      },
    });
    const estimate = await prisma.estimate.create({
      data: {
        businessId: input.businessId,
        customerId: customer.id,
        serviceRequestId: request.id,
        status: "APPROVED",
        publicToken: randomUUID(),
        total: 140,
      },
    });
    return prisma.job.create({
      data: {
        businessId: input.businessId,
        customerId: customer.id,
        estimateId: estimate.id,
        projectToken: randomUUID(),
        status: input.status ?? "IN_PROGRESS",
        scheduledAt: new Date("2026-09-28T14:00:00.000Z"),
        assignedMembershipId: input.assignedMembershipId,
      },
    });
  }

  const assignedJob = await createTradeJob({
    businessId: businessA.id,
    tradeCode: "CLEANING",
    assignedMembershipId: memberMem.id,
    customerName: "Cara Canary Native Visit",
  });
  const recleanJob = await createTradeJob({
    businessId: businessA.id,
    tradeCode: "CLEANING",
    assignedMembershipId: memberMem.id,
  });
  const scheduledJob = await createTradeJob({
    businessId: businessA.id,
    tradeCode: "CLEANING",
    assignedMembershipId: memberMem.id,
    status: "SCHEDULED",
  });
  const otherJob = await createTradeJob({
    businessId: businessA.id,
    tradeCode: "CLEANING",
    assignedMembershipId: otherMem.id,
  });
  const betaJob = await createTradeJob({
    businessId: businessB.id,
    tradeCode: "CLEANING",
    assignedMembershipId: betaMem.id,
  });
  const raceJob = await createTradeJob({
    businessId: businessA.id,
    tradeCode: "CLEANING",
    assignedMembershipId: memberMem.id,
  });
  const rollbackJob = await createTradeJob({
    businessId: businessA.id,
    tradeCode: "CLEANING",
    assignedMembershipId: memberMem.id,
  });
  const duplicateJob = await createTradeJob({
    businessId: businessA.id,
    tradeCode: "CLEANING",
    assignedMembershipId: memberMem.id,
  });
  const blockedJob = await createTradeJob({
    businessId: blockedBusiness.id,
    tradeCode: "CLEANING",
    assignedMembershipId: blockedMem.id,
  });
  const handyJob = await createTradeJob({
    businessId: handyBusiness.id,
    tradeCode: "HANDYMAN",
    assignedMembershipId: handyMem.id,
  });

  for (const job of [assignedJob, recleanJob, scheduledJob, raceJob, rollbackJob, duplicateJob]) {
    await setCleaningVisitCadence(prisma, ownerA, { jobId: job.id, cadence: "WEEKLY" });
  }

  const jobsBefore = await prisma.job.count({ where: { businessId: businessA.id } });

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
  const handySignIn = await signInNativeField(prisma, {
    email: handyUser.email,
    password,
  });
  check("Assigned worker can sign in", memberSignIn.ok === true);
  if (
    !memberSignIn.ok ||
    !otherSignIn.ok ||
    !betaSignIn.ok ||
    !blockedSignIn.ok ||
    !handySignIn.ok
  ) {
    throw new Error("Native visit fixture sign-in failed.");
  }

  const memberAccess = await resolveNativeFieldAccess(prisma, { token: memberSignIn.token });
  const otherAccess = await resolveNativeFieldAccess(prisma, { token: otherSignIn.token });
  const betaAccess = await resolveNativeFieldAccess(prisma, { token: betaSignIn.token });
  const blockedAccess = await resolveNativeFieldAccess(prisma, { token: blockedSignIn.token });
  const handyAccess = await resolveNativeFieldAccess(prisma, { token: handySignIn.token });
  if (
    !memberAccess.ok ||
    !otherAccess.ok ||
    !betaAccess.ok ||
    !blockedAccess.ok ||
    !handyAccess.ok
  ) {
    throw new Error("Native visit fixture access failed.");
  }

  console.log("\nLIVE — Authorization, tenant isolation, and Handyman refusal");

  const assignedDetail = await loadNativeAssignedJob(prisma, memberAccess.access, assignedJob.id);
  const otherDetail = await loadNativeAssignedJob(prisma, memberAccess.access, otherJob.id);
  const betaDetail = await loadNativeAssignedJob(prisma, memberAccess.access, betaJob.id);
  const handyDetail = await loadNativeAssignedJob(prisma, handyAccess.access, handyJob.id);
  const scheduledDetail = await loadNativeAssignedJob(
    prisma,
    memberAccess.access,
    scheduledJob.id,
  );
  check(
    "Assigned Cleaning job advertises visit outcome and completion after start",
    assignedDetail?.visit?.eligible === true &&
      assignedDetail.visit.outcomeStatus === "NONE" &&
      assignedDetail.visit.outcomeLabel === "No visit outcome recorded" &&
      assignedDetail.visit.cadenceLabel === "Weekly" &&
      assignedDetail.visit.recordCompleted.available === true &&
      assignedDetail.visit.recordReclean.available === true &&
      !JSON.stringify(assignedDetail).includes("kitchen"),
  );
  check(
    "Scheduled Cleaning job advertises start-before-complete for VISIT_COMPLETED",
    scheduledDetail?.visit?.recordCompleted.available === false &&
      scheduledDetail?.visit?.recordCompleted.reason === START_BEFORE_COMPLETE_MESSAGE &&
      scheduledDetail?.visit?.recordReclean.available === true,
  );
  check(
    "Unassigned, cross-tenant, and Handyman jobs do not return a visit payload",
    otherDetail === null && betaDetail === null && handyDetail?.visit == null,
  );

  const stolen = await recordNativeAssignedVisitOutcome(
    prisma,
    otherAccess.access,
    assignedJob.id,
    "VISIT_COMPLETED",
  );
  const cross = await recordNativeAssignedVisitOutcome(
    prisma,
    betaAccess.access,
    assignedJob.id,
    "VISIT_COMPLETED",
  );
  const handyWrite = await recordNativeAssignedVisitOutcome(
    prisma,
    handyAccess.access,
    handyJob.id,
    "VISIT_COMPLETED",
  );
  const blockedWrite = await recordNativeAssignedVisitOutcome(
    prisma,
    blockedAccess.access,
    blockedJob.id,
    "VISIT_COMPLETED",
  );
  const tooEarly = await recordNativeAssignedVisitOutcome(
    prisma,
    memberAccess.access,
    scheduledJob.id,
    "VISIT_COMPLETED",
  );
  const assignedAfterAuth = await prisma.jobCrewVisit.findFirst({
    where: { jobId: assignedJob.id, businessId: businessA.id },
  });
  const handyAfterAuth = await prisma.job.findFirst({
    where: { id: handyJob.id, businessId: handyBusiness.id },
    select: { status: true },
  });
  const scheduledAfterEarly = await prisma.job.findFirst({
    where: { id: scheduledJob.id, businessId: businessA.id },
    select: { status: true },
  });
  check(
    "Another worker cannot record a visit outcome on this job",
    stolen.ok === false && stolen.status === 404 && stolen.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Cross-tenant worker cannot record a visit outcome",
    cross.ok === false && cross.status === 404 && cross.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Handyman assigned job refuses the Cleaning visit write",
    handyWrite.ok === false &&
      handyWrite.status === 409 &&
      handyWrite.error === CLEANING_VISIT_ONLY_MESSAGE &&
      handyAfterAuth?.status === "IN_PROGRESS",
  );
  check(
    "Visit write requires an operating SaaS subscription",
    blockedWrite.ok === false &&
      blockedWrite.status === 403 &&
      blockedWrite.error === SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE,
  );
  check(
    "VISIT_COMPLETED is refused before the job is started",
    tooEarly.ok === false &&
      tooEarly.status === 409 &&
      tooEarly.error === START_BEFORE_COMPLETE_MESSAGE &&
      scheduledAfterEarly?.status === "SCHEDULED",
  );
  check(
    "Failed authorization leaves the assigned visit unrecorded",
    assignedAfterAuth?.outcomeStatus === "NONE" &&
      assignedAfterAuth?.outcomeRecordedAt == null,
  );

  console.log("\nLIVE — Recorded outcomes, reload, duplicate taps, race, rollback");

  const reclean = await recordNativeAssignedVisitOutcome(
    prisma,
    memberAccess.access,
    recleanJob.id,
    "RE_CLEAN_REQUESTED",
  );
  const recleanPersisted = await prisma.job.findFirst({
    where: { id: recleanJob.id, businessId: businessA.id },
    select: { status: true },
  });
  const jobsAfterReclean = await prisma.job.count({ where: { businessId: businessA.id } });
  check(
    "Assigned worker can record requested re-clean without completing or cloning the job",
    reclean.ok === true &&
      reclean.alreadyRecorded === false &&
      reclean.job.visit?.outcomeStatus === "RE_CLEAN_REQUESTED" &&
      reclean.job.visit?.outcomeLabel === "Re-clean requested" &&
      reclean.job.status === "IN_PROGRESS" &&
      recleanPersisted?.status === "IN_PROGRESS" &&
      jobsAfterReclean === jobsBefore,
  );

  const firstComplete = await recordNativeAssignedVisitOutcome(
    prisma,
    memberAccess.access,
    assignedJob.id,
    "VISIT_COMPLETED",
  );
  const reloaded = await loadNativeAssignedJob(prisma, memberAccess.access, assignedJob.id);
  const assignedPersisted = await prisma.job.findFirst({
    where: { id: assignedJob.id, businessId: businessA.id },
    select: { status: true, recurrenceCadence: true },
  });
  const jobsAfterComplete = await prisma.job.count({ where: { businessId: businessA.id } });
  check(
    "VISIT_COMPLETED records the exact status and completes the existing Job only",
    firstComplete.ok === true &&
      firstComplete.alreadyRecorded === false &&
      firstComplete.job.status === "COMPLETED" &&
      firstComplete.job.visit?.outcomeStatus === "VISIT_COMPLETED" &&
      firstComplete.job.visit?.outcomeLabel === "Visit completed" &&
      assignedPersisted?.status === "COMPLETED" &&
      assignedPersisted?.recurrenceCadence === "WEEKLY" &&
      jobsAfterComplete === jobsBefore,
  );
  check(
    "Reloaded assigned job shows the recorded visit outcome",
    reloaded?.visit?.outcomeStatus === "VISIT_COMPLETED" &&
      reloaded?.visit?.outcomeLabel === "Visit completed" &&
      reloaded?.status === "COMPLETED",
  );

  const repeatComplete = await recordNativeAssignedVisitOutcome(
    prisma,
    memberAccess.access,
    assignedJob.id,
    "VISIT_COMPLETED",
  );
  check(
    "Duplicate tap of the same VISIT_COMPLETED is a successful no-op",
    repeatComplete.ok === true &&
      repeatComplete.alreadyRecorded === true &&
      repeatComplete.job.status === "COMPLETED" &&
      repeatComplete.job.visit?.outcomeStatus === "VISIT_COMPLETED",
  );

  const [dupA, dupB] = await Promise.all([
    recordNativeAssignedVisitOutcome(
      prisma,
      memberAccess.access,
      duplicateJob.id,
      "VISIT_COMPLETED",
    ),
    recordNativeAssignedVisitOutcome(
      prisma,
      memberAccess.access,
      duplicateJob.id,
      "VISIT_COMPLETED",
    ),
  ]);
  const duplicateAfter = await prisma.job.findFirst({
    where: { id: duplicateJob.id, businessId: businessA.id },
    select: { status: true },
  });
  const duplicateVisits = await prisma.jobCrewVisit.findMany({
    where: { jobId: duplicateJob.id, businessId: businessA.id },
  });
  check(
    "Concurrent visit-completed taps both succeed and leave one completed Job",
    dupA.ok === true &&
      dupB.ok === true &&
      duplicateAfter?.status === "COMPLETED" &&
      duplicateVisits.length === 1 &&
      duplicateVisits[0]?.outcomeStatus === "VISIT_COMPLETED",
  );

  const race = await recordNativeAssignedVisitOutcome(
    prisma,
    memberAccess.access,
    raceJob.id,
    "VISIT_COMPLETED",
    {
      afterInitialRead: async () => {
        await prisma.job.update({
          where: { id: raceJob.id },
          data: { assignedMembershipId: otherMem.id },
        });
      },
    },
  );
  const raceVisit = await prisma.jobCrewVisit.findFirst({
    where: { jobId: raceJob.id, businessId: businessA.id },
  });
  const raceJobAfter = await prisma.job.findFirst({
    where: { id: raceJob.id, businessId: businessA.id },
    select: { status: true, assignedMembershipId: true },
  });
  check(
    "Assignment change after the initial read refuses VISIT_COMPLETED",
    race.ok === false && race.status === 404 && race.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Reassigned Job after the initial read leaves no visit or Job write",
    raceVisit?.outcomeStatus === "NONE" &&
      raceVisit?.outcomeRecordedAt == null &&
      raceVisit?.outcomeRecordedByMembershipId == null &&
      raceJobAfter?.status === "IN_PROGRESS" &&
      raceJobAfter?.assignedMembershipId === otherMem.id,
  );

  const rollbackStartedAt = new Date();
  await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: memberMem.id,
      jobId: rollbackJob.id,
      activityType: "JOB",
      status: "RUNNING",
      startedAt: rollbackStartedAt,
      source: "CLOCK",
    },
  });
  await prisma.timesheetWeek.create({
    data: {
      businessId: businessA.id,
      membershipId: memberMem.id,
      weekStartedAt: weekRange(rollbackStartedAt).start,
      status: "APPROVED",
      approvedAt: new Date(),
      approvedByMembershipId: ownerMem.id,
    },
  });
  const rollback = await recordNativeAssignedVisitOutcome(
    prisma,
    memberAccess.access,
    rollbackJob.id,
    "VISIT_COMPLETED",
  );
  const rollbackVisit = await prisma.jobCrewVisit.findFirst({
    where: { jobId: rollbackJob.id, businessId: businessA.id },
  });
  const rollbackJobAfter = await prisma.job.findFirst({
    where: { id: rollbackJob.id, businessId: businessA.id },
    select: { status: true },
  });
  const rollbackTime = await prisma.timeEntry.findFirst({
    where: { jobId: rollbackJob.id, businessId: businessA.id },
    select: { status: true, endedAt: true },
  });
  check(
    "Approved-week running Job time refuses VISIT_COMPLETED",
    rollback.ok === false &&
      rollback.status === 409 &&
      /approved job time is still running/i.test(rollback.error ?? ""),
  );
  check(
    "Failed VISIT_COMPLETED rolls back the visit, Job status, and running time",
    rollbackVisit?.outcomeStatus === "NONE" &&
      rollbackVisit?.outcomeRecordedAt == null &&
      rollbackVisit?.outcomeRecordedByMembershipId == null &&
      rollbackJobAfter?.status === "IN_PROGRESS" &&
      rollbackTime?.status === "RUNNING" &&
      rollbackTime?.endedAt === null,
  );

  const leftoverB = await prisma.jobCrewVisit.findMany({ where: { businessId: businessB.id } });
  const leftoverA = await prisma.jobCrewVisit.findMany({ where: { businessId: businessA.id } });
  check(
    "Visit records stay isolated by businessId",
    leftoverB.length === 0 &&
      leftoverA.every((row) => row.businessId === businessA.id) &&
      leftoverA.some(
        (row) => row.jobId === assignedJob.id && row.outcomeStatus === "VISIT_COMPLETED",
      ),
  );
} catch (error) {
  failures += 1;
  console.error("FAIL - live native visit outcome", error);
} finally {
  await prisma.$disconnect();
}

console.log(
  failures === 0
    ? "\nNative field visit check passed: canonical write, isolation, duplicates, races, and rollback held."
    : `\n${failures} native field visit check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
