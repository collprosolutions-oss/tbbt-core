/**
 * Native assigned-job problem reports — reuse the canonical Field
 * `reportAssignedJobProblem` write. Prove other-worker and tenant
 * denial, reassignment races, duplicate taps, job-state recheck, and
 * the bounded read on a dedicated local disposable database.
 *
 * A report must not complete, cancel, or reschedule the Job and must
 * send no customer message. The recorded row must appear after reload
 * and on the existing owner Work Order Field Reports query.
 *
 * Run with:
 *   npm run test:native-field-problem
 */
import { register } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { openDisposableTestDatabase } from "./disposable-test-database.mjs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { hashPassword } = await import("@/lib/auth-crypto");
const { formatDateTime } = await import("@/lib/format");
const {
  FIELD_JOB_PROBLEM_CLOSED,
  FIELD_JOB_PROBLEM_DESCRIBE,
  assignedJobCanReceiveProblemReport,
  reportAssignedJobProblem,
} = await import("@/lib/field-job-ops");
const { NATIVE_JOB_NOT_AVAILABLE } = await import("@/lib/native-field-ops");
const { loadNativeAssignedJob, nativeAssignedJobWhere } = await import(
  "@/lib/native-field"
);
const {
  NATIVE_JOB_PROBLEM_REPORT_LIMIT,
  NATIVE_JOB_PROBLEM_STATUS_LABELS,
  NATIVE_PROBLEM_CHOOSE_RECORD,
  NATIVE_PROBLEM_JSON_MAX_BYTES,
  boundNativeJobProblemReports,
  composeNativeProblemDescription,
  emptyNativeJobProblemReports,
  loadNativeAssignedJobProblemReports,
  nativeAssignedJobProblemAuthorizeWhere,
  nativeAssignedJobProblemWhere,
  nativeJobProblemTruncatedNotice,
  parseNativeProblemReportJson,
  recordNativeAssignedJobProblem,
  toNativeJobProblemReport,
} = await import("@/lib/native-field-problems");
const { resolveNativeFieldAccess, signInNativeField } = await import(
  "@/lib/native-session"
);
const { readCappedRequestText } = await import("@/lib/native-session-limits");
const { SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE } = await import(
  "@/lib/saas-billing/messages"
);

const NY = "America/New_York";
const MEMBER_NOTE = "gate was locked, no one answered";
const MEMBER_DESCRIPTION = composeNativeProblemDescription("ACCESS", MEMBER_NOTE);
const OWNER_NOTE = "unexpected rot behind the trim";
const OWNER_REVIEW_SELECT = {
  id: true,
  description: true,
  status: true,
  createdAt: true,
  membership: { select: { user: { select: { name: true } } } },
};

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
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

function readRepo(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function createArrivalBarrier(expectedCount, timeoutMs) {
  let arrived = 0;
  let release;
  let fail;
  const gate = new Promise((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  gate.catch(() => {});
  const timer = setTimeout(() => {
    fail(
      new Error(
        `Arrival barrier timed out after ${timeoutMs}ms (${arrived}/${expectedCount} arrived)`,
      ),
    );
  }, timeoutMs);
  return {
    async hold() {
      arrived += 1;
      if (arrived >= expectedCount) {
        clearTimeout(timer);
        release();
      }
      await gate;
    },
  };
}

const fieldOpsSrc = readRepo("src/lib/field-job-ops.ts");
const nativeProblemSrc = readRepo("src/lib/native-field-problems.ts");
const nativeFieldSrc = readRepo("src/lib/native-field.ts");
const problemRouteSrc = readRepo("src/app/api/native/v1/jobs/[jobId]/problem/route.ts");
const jobScreenSrc = readRepo("apps/native/src/screens/JobScreen.tsx");
const problemScreenSrc = readRepo("apps/native/src/screens/JobProblemReportsSection.tsx");
const nativeApiSrc = readRepo("apps/native/src/api.ts");
const nativeTypesSrc = readRepo("apps/native/src/types.ts");
const appSrc = readRepo("apps/native/App.tsx");
const navSrc = readRepo("src/lib/nav.ts");
const ownerJobPageSrc = readRepo("src/app/(app)/jobs/[jobId]/page.tsx");
const ownerListSrc = readRepo("src/components/jobs/job-problem-report-list.tsx");
const webFieldActionSrc = readRepo("src/app/actions/field-job.ts");
const webFieldFormSrc = readRepo("src/components/field/report-problem-form.tsx");
const packageSrc = readRepo("package.json");
const docsSrc = readRepo("docs/NATIVE_FIELD.md");
const selfSrc = readRepo("scripts/check-native-field-problem.mjs");
const reportFnSrc = fieldOpsSrc.slice(
  fieldOpsSrc.indexOf("export async function reportAssignedJobProblem"),
  fieldOpsSrc.indexOf("export async function requestAssignedJobAdditionalWork"),
);
const membershipGuardSrc = readRepo("src/lib/exact-active-membership.ts");

console.log("\nSTATIC — inspect canonical Field report and assigned-job authorization first");
check(
  "Web Field report still uses reportAssignedJobProblem and never accepts a reporter id",
  webFieldActionSrc.includes("reportAssignedJobProblem") &&
    webFieldActionSrc.includes("never accepted as form input") &&
    webFieldFormSrc.includes("reportJobProblem") &&
    webFieldFormSrc.includes("Never changes Job status"),
);
check(
  "Canonical write locks the Job and rechecks business, assignment, membership, and job state",
  reportFnSrc.includes("lockTenantOwnedJob") &&
    reportFnSrc.includes("locked.businessId !== actor.businessId") &&
    reportFnSrc.includes("locked.assignedMembershipId !== actor.membershipId") &&
    reportFnSrc.includes("assignedJobCanReceiveProblemReport(locked.status)") &&
    reportFnSrc.includes("exactActiveMembershipHeld") &&
    reportFnSrc.indexOf("lockTenantOwnedJob") <
      reportFnSrc.indexOf("exactActiveMembershipHeld") &&
    reportFnSrc.indexOf("assignedJobCanReceiveProblemReport(locked.status)") <
      reportFnSrc.indexOf("jobProblemReport.create") &&
    reportFnSrc.indexOf("exactActiveMembershipHeld") <
      reportFnSrc.indexOf("jobProblemReport.create") &&
    membershipGuardSrc.includes('FROM "Membership"') &&
    membershipGuardSrc.includes("FOR UPDATE"),
);
check(
  "Canonical write is idempotent for the same OPEN description and never mutates Job",
  reportFnSrc.includes('status: "OPEN"') &&
    reportFnSrc.includes("alreadyRecorded: true") &&
    !reportFnSrc.includes("job.update") &&
    !reportFnSrc.includes("scheduledAt") &&
    !reportFnSrc.includes("completeJob") &&
    !/mail|sendSms|notifyCustomer|resend/i.test(reportFnSrc),
);
check(
  "Native problem write reuses reportAssignedJobProblem and assigned-job scope",
  nativeProblemSrc.includes("reportAssignedJobProblem") &&
    nativeProblemSrc.includes("nativeAssignedJobProblemAuthorizeWhere") &&
    nativeProblemSrc.includes("assignedMembershipId: field.membershipId") &&
    nativeProblemSrc.includes("afterInitialRead") &&
    nativeProblemSrc.includes("requireSaasOperatingEntitlement") &&
    problemRouteSrc.includes("recordNativeAssignedJobProblem") &&
    !nativeProblemSrc.includes("$transaction"),
);
check(
  "Native problem route uses Bearer helpers, caps JSON, and never uses cookies()",
  problemRouteSrc.includes("readBearerToken") &&
    problemRouteSrc.includes("readCappedRequestText") &&
    problemRouteSrc.includes("parseNativeProblemReportJson") &&
    !problemRouteSrc.includes("cookies("),
);
check(
  "Native problem JSON is capped at 4 KB",
  nativeProblemSrc.includes("NATIVE_PROBLEM_JSON_MAX_BYTES = 4096") &&
    NATIVE_PROBLEM_JSON_MAX_BYTES === 4096,
);
check(
  "Job screen reloads assigned job and shows the recorded report",
  jobScreenSrc.includes("void loadNativeJob(token, jobId)") &&
    jobScreenSrc.includes("JobProblemReportsSection") &&
    jobScreenSrc.includes("job.problemReports") &&
    problemScreenSrc.includes("recordNativeJobProblem") &&
    problemScreenSrc.includes("Send report") &&
    problemScreenSrc.includes("does not complete") &&
    problemScreenSrc.includes("does not message the customer") &&
    nativeApiSrc.includes("/problem") &&
    nativeTypesSrc.includes("problemReports:") &&
    nativeFieldSrc.includes("problemReports:") &&
    nativeFieldSrc.includes("loadNativeAssignedJobProblemReports"),
);
check(
  "Existing owner Job review path still lists the same Field Reports rows",
  ownerJobPageSrc.includes("JobProblemReportList") &&
    ownerJobPageSrc.includes("problemReports:") &&
    ownerJobPageSrc.includes("Field Reports") &&
    ownerListSrc.includes("Never affects Job") &&
    ownerListSrc.includes("report.membership.user.name"),
);
check(
  "No global nav item or website navigation change",
  !navSrc.includes("problem") &&
    !appSrc.includes("Problem") &&
    appSrc.includes("JobScreen") &&
    !existsSync(
      fileURLToPath(new URL("../src/app/api/native/v1/problems", import.meta.url)),
    ) &&
    packageSrc.includes("test:native-field-problem") &&
    docsSrc.includes("test:native-field-problem") &&
    docsSrc.includes("reportAssignedJobProblem") &&
    docsSrc.includes("does not complete, cancel, or reschedule") &&
    selfSrc.includes("openDisposableTestDatabase") &&
    selfSrc.includes('namePrefix: "tbbt_native_field_problem"'),
);
check(
  "boundNativeJobProblemReports keeps the cap and marks overflow",
  boundNativeJobProblemReports(["a", "b", "c"], 2).truncated === true &&
    boundNativeJobProblemReports(["a", "b", "c"], 2).items.join(",") === "a,b" &&
    boundNativeJobProblemReports(["a", "b"], 2).truncated === false,
);
check(
  "Authorize where matches nativeAssignedJobWhere(businessId + assignedMembershipId)",
  JSON.stringify(
    nativeAssignedJobProblemAuthorizeWhere("job-1", {
      businessId: "biz-1",
      membershipId: "mem-1",
    }),
  ) ===
    JSON.stringify(
      nativeAssignedJobWhere("job-1", { businessId: "biz-1", membershipId: "mem-1" }),
    ) &&
    JSON.stringify(nativeAssignedJobProblemWhere("job-1", "biz-1")) ===
      JSON.stringify({ jobId: "job-1", businessId: "biz-1" }),
);
check(
  "Known job states can receive a report; unknown states cannot",
  assignedJobCanReceiveProblemReport("SCHEDULED") &&
    assignedJobCanReceiveProblemReport("UNSCHEDULED") &&
    assignedJobCanReceiveProblemReport("IN_PROGRESS") &&
    assignedJobCanReceiveProblemReport("COMPLETED") &&
    !assignedJobCanReceiveProblemReport("CANCELLED") &&
    !assignedJobCanReceiveProblemReport("CANCELED"),
);

const emptyJson = parseNativeProblemReportJson("{}");
const validJson = parseNativeProblemReportJson(
  JSON.stringify({ kind: "ACCESS", description: MEMBER_NOTE }),
);
const missingKind = parseNativeProblemReportJson(
  JSON.stringify({ description: MEMBER_NOTE }),
);
const missingDescription = parseNativeProblemReportJson(
  JSON.stringify({ kind: "ACCESS", description: "   " }),
);
check(
  "Problem JSON requires a kind and a description",
  emptyJson.ok === false &&
    emptyJson.error === NATIVE_PROBLEM_CHOOSE_RECORD &&
    validJson.ok === true &&
    validJson.input.kind === "ACCESS" &&
    validJson.input.description === MEMBER_NOTE &&
    missingKind.ok === false &&
    missingDescription.ok === false &&
    missingDescription.error === FIELD_JOB_PROBLEM_DESCRIBE,
);

const oversizedBody = await readCappedRequestText(
  new Request("http://native.test/api/native/v1/jobs/job/problem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "x".repeat(NATIVE_PROBLEM_JSON_MAX_BYTES + 1),
  }),
  NATIVE_PROBLEM_JSON_MAX_BYTES,
);
check(
  "Oversized problem JSON body is rejected before parse",
  oversizedBody.ok === false && oversizedBody.status === 413,
);

const labeled = toNativeJobProblemReport(
  {
    id: "pr-1",
    description: MEMBER_DESCRIPTION,
    status: "OPEN",
    createdAt: new Date("2026-10-01T14:00:00.000Z"),
  },
  NY,
);
check(
  "Mapper keeps Open wording, kind, and the recorded date",
  labeled.statusLabel === NATIVE_JOB_PROBLEM_STATUS_LABELS.OPEN &&
    labeled.kind === "ACCESS" &&
    labeled.kindLabel === "Access issue (can't get in / no one home)" &&
    labeled.reportedAtLabel ===
      formatDateTime(new Date("2026-10-01T14:00:00.000Z"), NY),
);

const session = await openDisposableTestDatabase({
  databaseUrl: baseUrl,
  namePrefix: "tbbt_native_field_problem",
  pushSchema: true,
});
const prisma = session.prisma;

try {
  const password = "native-problem-pass-9";
  const passwordHash = await hashPassword(password);
  const onboarding = {
    firstRunSetupCompletedAt: new Date(),
    starterServicesSetupCompletedAt: new Date(),
    starterServicesSetupChoice: "SKIPPED",
    websiteSetupCompletedAt: new Date(),
    websiteSetupChoice: "SKIPPED",
  };

  async function makeBusiness(name, slug, extras = {}) {
    return prisma.business.create({
      data: {
        name,
        slug,
        tradeCode: "HANDYMAN",
        timezone: NY,
        ...onboarding,
        ...extras,
      },
    });
  }

  async function makeUser(name, email) {
    return prisma.user.create({
      data: { name, email, passwordHash },
    });
  }

  async function makeMembership(userId, businessId, role, extras = {}) {
    return prisma.membership.create({
      data: { userId, businessId, role, ...extras },
    });
  }

  async function makeJob(businessId, extras = {}) {
    const customer = extras.customerId
      ? { id: extras.customerId }
      : await prisma.customer.create({
          data: {
            businessId,
            name: extras.customerName ?? "Problem Customer",
            phone: "555-0142",
          },
        });
    return prisma.job.create({
      data: {
        businessId,
        customerId: customer.id,
        projectToken: extras.projectToken ?? randomUUID(),
        status: extras.status ?? "IN_PROGRESS",
        assignedMembershipId: extras.assignedMembershipId ?? null,
        scheduledAt: extras.scheduledAt ?? new Date("2026-10-01T15:00:00.000Z"),
      },
    });
  }

  async function subscribe(businessId, extras = {}) {
    return prisma.businessSaasSubscription.create({
      data: {
        businessId,
        status: extras.status ?? "active",
        planCode: "FOUNDER",
        legacyExempt: extras.legacyExempt ?? true,
        ...extras.data,
      },
    });
  }

  const businessA = await makeBusiness("Alpha Problems", "alpha-native-problems");
  const businessB = await makeBusiness("Beta Problems", "beta-native-problems");
  const blockedBusiness = await makeBusiness(
    "Blocked Problems",
    "blocked-native-problems",
  );
  await subscribe(businessA.id);
  await subscribe(businessB.id);
  const endedTrial = new Date(Date.now() - 60_000);
  await subscribe(blockedBusiness.id, {
    status: "canceled",
    legacyExempt: false,
    data: {
      trialStartedAt: new Date(endedTrial.getTime() - 14 * 24 * 60 * 60 * 1000),
      trialEndsAt: endedTrial,
      founderEligibilityEndedAt: endedTrial,
    },
  });

  const ownerUser = await makeUser("Olivia Owner", "owner@native-problems.example");
  const memberUser = await makeUser("Mia Member", "member@native-problems.example");
  const otherUser = await makeUser("Max Member", "other@native-problems.example");
  const betaUser = await makeUser("Bree Beta", "bree@beta-native-problems.example");
  const blockedUser = await makeUser(
    "Blocked Member",
    "blocked@native-problems.example",
  );
  const deactivateUser = await makeUser(
    "Ivy Later",
    "later@native-problems.example",
  );

  const ownerMem = await makeMembership(ownerUser.id, businessA.id, "OWNER");
  const memberMem = await makeMembership(memberUser.id, businessA.id, "MEMBER");
  const otherMem = await makeMembership(otherUser.id, businessA.id, "MEMBER");
  const betaMem = await makeMembership(betaUser.id, businessB.id, "MEMBER");
  const blockedMem = await makeMembership(blockedUser.id, blockedBusiness.id, "MEMBER");
  const deactivateMem = await makeMembership(
    deactivateUser.id,
    businessA.id,
    "MEMBER",
  );

  const memberJob = await makeJob(businessA.id, {
    assignedMembershipId: memberMem.id,
    customerName: "Member Problem Canary",
  });
  const ownerJob = await makeJob(businessA.id, {
    assignedMembershipId: ownerMem.id,
    customerName: "Owner Problem Canary",
  });
  const otherJob = await makeJob(businessA.id, {
    assignedMembershipId: otherMem.id,
    customerName: "Other Problem Canary",
  });
  const raceJob = await makeJob(businessA.id, {
    assignedMembershipId: memberMem.id,
    customerName: "Race Problem Canary",
  });
  const duplicateJob = await makeJob(businessA.id, {
    assignedMembershipId: memberMem.id,
    customerName: "Duplicate Problem Canary",
  });
  const closedJob = await makeJob(businessA.id, {
    assignedMembershipId: memberMem.id,
    customerName: "Closed Problem Canary",
    status: "CANCELLED",
  });
  const boundJob = await makeJob(businessA.id, {
    assignedMembershipId: memberMem.id,
    customerName: "Bound Problem Canary",
  });
  const deactivateJob = await makeJob(businessA.id, {
    assignedMembershipId: deactivateMem.id,
    customerName: "Deactivate Problem Canary",
  });
  const betaJob = await makeJob(businessB.id, {
    assignedMembershipId: betaMem.id,
    customerName: "Beta Problem Canary",
  });
  const blockedJob = await makeJob(blockedBusiness.id, {
    assignedMembershipId: blockedMem.id,
    customerName: "Blocked Problem Canary",
  });

  await prisma.jobProblemReport.create({
    data: {
      businessId: businessB.id,
      jobId: betaJob.id,
      membershipId: betaMem.id,
      description: "Foreign tenant problem",
    },
  });
  await prisma.jobProblemReport.create({
    data: {
      businessId: businessA.id,
      jobId: otherJob.id,
      membershipId: otherMem.id,
      description: "Other worker problem",
    },
  });

  const memberSignIn = await signInNativeField(prisma, {
    email: memberUser.email,
    password,
  });
  const ownerSignIn = await signInNativeField(prisma, {
    email: ownerUser.email,
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
  const deactivateSignIn = await signInNativeField(prisma, {
    email: deactivateUser.email,
    password,
  });
  check(
    "Assigned MEMBER and assigned OWNER can sign in",
    memberSignIn.ok === true && ownerSignIn.ok === true,
  );
  if (
    !memberSignIn.ok ||
    !ownerSignIn.ok ||
    !otherSignIn.ok ||
    !betaSignIn.ok ||
    !blockedSignIn.ok ||
    !deactivateSignIn.ok
  ) {
    throw new Error("Native problem fixture sign-in failed.");
  }

  const memberAccess = await resolveNativeFieldAccess(prisma, {
    token: memberSignIn.token,
  });
  const ownerAccess = await resolveNativeFieldAccess(prisma, {
    token: ownerSignIn.token,
  });
  const otherAccess = await resolveNativeFieldAccess(prisma, {
    token: otherSignIn.token,
  });
  const betaAccess = await resolveNativeFieldAccess(prisma, {
    token: betaSignIn.token,
  });
  const blockedAccess = await resolveNativeFieldAccess(prisma, {
    token: blockedSignIn.token,
  });
  const deactivateAccess = await resolveNativeFieldAccess(prisma, {
    token: deactivateSignIn.token,
  });
  if (
    !memberAccess.ok ||
    !ownerAccess.ok ||
    !otherAccess.ok ||
    !betaAccess.ok ||
    !blockedAccess.ok ||
    !deactivateAccess.ok
  ) {
    throw new Error("Native problem fixture access failed.");
  }

  console.log("\nDEDICATED DB — other-worker and tenant denial");
  const stolen = await recordNativeAssignedJobProblem(
    prisma,
    otherAccess.access,
    memberJob.id,
    { kind: "ACCESS", description: MEMBER_NOTE },
  );
  const cross = await recordNativeAssignedJobProblem(
    prisma,
    betaAccess.access,
    memberJob.id,
    { kind: "ACCESS", description: MEMBER_NOTE },
  );
  const ownerOnMember = await recordNativeAssignedJobProblem(
    prisma,
    ownerAccess.access,
    memberJob.id,
    { kind: "ACCESS", description: MEMBER_NOTE },
  );
  const memberOnOwner = await recordNativeAssignedJobProblem(
    prisma,
    memberAccess.access,
    ownerJob.id,
    { kind: "SAFETY", description: OWNER_NOTE },
  );
  const blockedWrite = await recordNativeAssignedJobProblem(
    prisma,
    blockedAccess.access,
    blockedJob.id,
    { kind: "ACCESS", description: MEMBER_NOTE },
  );
  const leakedOther = await loadNativeAssignedJobProblemReports(
    prisma,
    memberAccess.access,
    otherJob.id,
    NY,
  );
  const leakedBeta = await loadNativeAssignedJobProblemReports(
    prisma,
    memberAccess.access,
    betaJob.id,
    NY,
  );
  const otherDetail = await loadNativeAssignedJob(
    prisma,
    memberAccess.access,
    otherJob.id,
  );
  const betaDetail = await loadNativeAssignedJob(
    prisma,
    memberAccess.access,
    betaJob.id,
  );
  const deniedCount = await prisma.jobProblemReport.count({
    where: { jobId: memberJob.id, businessId: businessA.id },
  });
  check(
    "Another worker cannot record a problem on this job",
    stolen.ok === false &&
      stolen.status === 404 &&
      stolen.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Cross-tenant worker cannot record a problem",
    cross.ok === false &&
      cross.status === 404 &&
      cross.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Unassigned OWNER cannot record a problem on a MEMBER job",
    ownerOnMember.ok === false && ownerOnMember.status === 404,
  );
  check(
    "Unassigned MEMBER cannot record a problem on an OWNER job",
    memberOnOwner.ok === false && memberOnOwner.status === 404,
  );
  check(
    "Problem write requires an operating SaaS subscription",
    blockedWrite.ok === false &&
      blockedWrite.status === 403 &&
      blockedWrite.error === SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE,
  );
  check(
    "Other-worker and other-tenant problem reads stay empty",
    leakedOther.items.length === 0 &&
      leakedBeta.items.length === 0 &&
      otherDetail === null &&
      betaDetail === null &&
      emptyNativeJobProblemReports().items.length === 0,
  );
  check("Failed authorization leaves no JobProblemReport", deniedCount === 0);

  console.log("\nDEDICATED DB — assigned write, reload, and owner Job review");
  const memberBefore = await prisma.job.findFirst({
    where: { id: memberJob.id, businessId: businessA.id },
    select: { status: true, scheduledAt: true },
  });
  const memberWrite = await recordNativeAssignedJobProblem(
    prisma,
    memberAccess.access,
    memberJob.id,
    { kind: "ACCESS", description: MEMBER_NOTE },
  );
  const memberReloaded = await loadNativeAssignedJob(
    prisma,
    memberAccess.access,
    memberJob.id,
  );
  const memberAfter = await prisma.job.findFirst({
    where: { id: memberJob.id, businessId: businessA.id },
    select: { status: true, scheduledAt: true },
  });
  const ownerReview = await prisma.job.findFirst({
    where: { id: memberJob.id, businessId: businessA.id },
    select: {
      problemReports: {
        orderBy: { createdAt: "desc" },
        select: OWNER_REVIEW_SELECT,
      },
    },
  });
  const recorded = memberReloaded?.problemReports.items[0];
  check(
    "Assigned MEMBER can record a structured problem report",
    memberWrite.ok === true &&
      memberWrite.alreadyRecorded === false &&
      memberWrite.job.problemReports.items[0]?.description === MEMBER_DESCRIPTION &&
      memberWrite.job.problemReports.items[0]?.statusLabel === "Open",
  );
  check(
    "Reloaded assigned job shows the recorded report",
    recorded?.description === MEMBER_DESCRIPTION &&
      recorded?.kind === "ACCESS" &&
      recorded?.status === "OPEN" &&
      recorded?.reportedAtLabel ===
        formatDateTime(new Date(recorded.reportedAt), NY),
  );
  check(
    "A report does not complete, cancel, or reschedule the job",
    memberAfter?.status === memberBefore?.status &&
      memberAfter?.status === "IN_PROGRESS" &&
      memberAfter?.scheduledAt?.getTime() === memberBefore?.scheduledAt?.getTime(),
  );
  check(
    "Existing owner Job review path shows the same recorded report",
    ownerReview?.problemReports.length === 1 &&
      ownerReview.problemReports[0].description === MEMBER_DESCRIPTION &&
      ownerReview.problemReports[0].status === "OPEN" &&
      ownerReview.problemReports[0].membership.user.name === "Mia Member",
  );

  const ownerWrite = await recordNativeAssignedJobProblem(
    prisma,
    ownerAccess.access,
    ownerJob.id,
    { kind: "SAFETY", description: OWNER_NOTE },
  );
  const ownerReloaded = await loadNativeAssignedJob(
    prisma,
    ownerAccess.access,
    ownerJob.id,
  );
  check(
    "Assigned OWNER can record a problem on their own assigned job",
    ownerWrite.ok === true &&
      ownerWrite.alreadyRecorded === false &&
      ownerReloaded?.problemReports.items[0]?.description ===
        composeNativeProblemDescription("SAFETY", OWNER_NOTE),
  );

  const closedWrite = await recordNativeAssignedJobProblem(
    prisma,
    memberAccess.access,
    closedJob.id,
    { kind: "ACCESS", description: MEMBER_NOTE },
  );
  const closedCount = await prisma.jobProblemReport.count({
    where: { jobId: closedJob.id, businessId: businessA.id },
  });
  check(
    "Unknown job state is rechecked and refused before write",
    closedWrite.ok === false &&
      closedWrite.status === 409 &&
      closedWrite.error === FIELD_JOB_PROBLEM_CLOSED &&
      closedCount === 0,
  );

  const repeat = await recordNativeAssignedJobProblem(
    prisma,
    memberAccess.access,
    memberJob.id,
    { kind: "ACCESS", description: MEMBER_NOTE },
  );
  const repeatCount = await prisma.jobProblemReport.count({
    where: { jobId: memberJob.id, businessId: businessA.id },
  });
  check(
    "Duplicate tap of the same type and description is a successful no-op",
    repeat.ok === true &&
      repeat.alreadyRecorded === true &&
      repeatCount === 1 &&
      repeat.job.problemReports.items[0]?.description === MEMBER_DESCRIPTION,
  );

  console.log("\nDEDICATED DB — reassignment race and concurrent duplicate taps");
  const race = await recordNativeAssignedJobProblem(
    prisma,
    memberAccess.access,
    raceJob.id,
    { kind: "ACCESS", description: MEMBER_NOTE },
    {
      afterInitialRead: async () => {
        await prisma.job.update({
          where: { id: raceJob.id },
          data: { assignedMembershipId: otherMem.id },
        });
      },
    },
  );
  const raceCount = await prisma.jobProblemReport.count({
    where: { jobId: raceJob.id, businessId: businessA.id },
  });
  const raceJobAfter = await prisma.job.findFirst({
    where: { id: raceJob.id, businessId: businessA.id },
    select: { assignedMembershipId: true, status: true, scheduledAt: true },
  });
  check(
    "Assignment change after the initial read refuses the report tap",
    race.ok === false &&
      race.status === 404 &&
      race.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Reassigned Job after the initial read leaves no report and no job mutation",
    raceCount === 0 &&
      raceJobAfter?.assignedMembershipId === otherMem.id &&
      raceJobAfter?.status === "IN_PROGRESS" &&
      raceJobAfter?.scheduledAt != null,
  );

  const racerA = session.createClient();
  const racerB = session.createClient();
  const duplicateBarrier = createArrivalBarrier(2, 5000);
  const duplicateSettled = await Promise.allSettled([
    recordNativeAssignedJobProblem(
      racerA,
      memberAccess.access,
      duplicateJob.id,
      { kind: "MATERIAL", description: "bag torn open" },
      { afterInitialRead: () => duplicateBarrier.hold() },
    ),
    recordNativeAssignedJobProblem(
      racerB,
      memberAccess.access,
      duplicateJob.id,
      { kind: "MATERIAL", description: "bag torn open" },
      { afterInitialRead: () => duplicateBarrier.hold() },
    ),
  ]);
  const duplicateRecorded = duplicateSettled.filter(
    (result) => result.status === "fulfilled" && result.value.ok === true,
  );
  const duplicateWriters = duplicateRecorded.filter(
    (result) => result.value.alreadyRecorded === false,
  );
  const duplicateNoops = duplicateRecorded.filter(
    (result) => result.value.alreadyRecorded === true,
  );
  const duplicateRows = await prisma.jobProblemReport.findMany({
    where: { jobId: duplicateJob.id, businessId: businessA.id },
  });
  check(
    "Concurrent duplicate taps both succeed and leave one OPEN report",
    duplicateSettled.length === 2 &&
      duplicateRecorded.length === 2 &&
      duplicateWriters.length === 1 &&
      duplicateNoops.length === 1 &&
      duplicateRows.length === 1 &&
      duplicateRows[0].description ===
        composeNativeProblemDescription("MATERIAL", "bag torn open") &&
      duplicateRows[0].status === "OPEN",
  );

  const deactivate = await recordNativeAssignedJobProblem(
    prisma,
    deactivateAccess.access,
    deactivateJob.id,
    { kind: "ACCESS", description: MEMBER_NOTE },
    {
      afterInitialRead: async () => {
        const otherClient = session.createClient();
        await otherClient.membership.update({
          where: { id: deactivateMem.id },
          data: { active: false },
        });
      },
    },
  );
  const deactivateCount = await prisma.jobProblemReport.count({
    where: { jobId: deactivateJob.id, businessId: businessA.id },
  });
  check(
    "Deactivated membership after the initial read refuses the report tap",
    deactivate.ok === false &&
      deactivate.status === 404 &&
      deactivate.error === NATIVE_JOB_NOT_AVAILABLE &&
      deactivateCount === 0,
  );

  console.log("\nDEDICATED DB — bounded reads on the assigned job");
  for (let index = 0; index < NATIVE_JOB_PROBLEM_REPORT_LIMIT + 3; index += 1) {
    await prisma.jobProblemReport.create({
      data: {
        businessId: businessA.id,
        jobId: boundJob.id,
        membershipId: memberMem.id,
        description: `Overflow report ${index + 1}`,
      },
    });
  }
  const bounded = await loadNativeAssignedJobProblemReports(
    prisma,
    memberAccess.access,
    boundJob.id,
    NY,
  );
  const boundedDetail = await loadNativeAssignedJob(
    prisma,
    memberAccess.access,
    boundJob.id,
  );
  check(
    "Assigned problem-report list is capped at NATIVE_JOB_PROBLEM_REPORT_LIMIT",
    bounded.items.length === NATIVE_JOB_PROBLEM_REPORT_LIMIT &&
      bounded.truncated === true &&
      bounded.limit === NATIVE_JOB_PROBLEM_REPORT_LIMIT &&
      bounded.count > NATIVE_JOB_PROBLEM_REPORT_LIMIT &&
      bounded.truncatedNotice === nativeJobProblemTruncatedNotice() &&
      boundedDetail?.problemReports.truncated === true &&
      !bounded.items.some((row) => row.description === "Overflow report 1"),
  );

  const canonicalDirect = await reportAssignedJobProblem(
    prisma,
    { businessId: businessA.id, membershipId: memberMem.id },
    { jobId: memberJob.id, description: MEMBER_DESCRIPTION },
  );
  check(
    "Canonical write itself treats the same OPEN description as already recorded",
    canonicalDirect.ok === true && canonicalDirect.alreadyRecorded === true,
  );
} catch (error) {
  failures += 1;
  console.error("FAIL - unexpected native field problem test error");
  console.error(error);
} finally {
  await session.cleanup();
}

if (failures > 0) {
  console.error(`\nNative field problem check failed: ${failures} issue(s).`);
  process.exit(1);
}

console.log("\nAll native field problem checks passed.");
