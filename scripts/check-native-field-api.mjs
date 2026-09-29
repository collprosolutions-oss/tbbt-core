/**
 * Native field API — session boundary + assigned-job / Today isolation
 * + assigned-worker Start job and Complete job writes.
 *
 * Imports the REAL production helpers from src/lib/native-session.ts,
 * src/lib/native-field.ts, and src/lib/native-field-ops.ts. Those
 * modules take a Prisma client and do not use next/headers cookies, so
 * they can run in this script.
 *
 * Uses a disposable sibling Postgres database
 * (`tbbt_native_field_test`), matching the existing isolation harness.
 *
 * Run with:
 *   npm run test:native-field
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { hashPassword, hashToken } = await import("@/lib/auth-crypto");
const { currentTotpCode } = await import("@/lib/totp");
const {
  TOTP_CHALLENGE_LOCKED_MESSAGE,
  TOTP_CHALLENGE_MAX_ATTEMPTS,
} = await import("@/lib/account-security");
const {
  NATIVE_PASSWORD_LOCKED_MESSAGE,
  NATIVE_PASSWORD_MAX_ATTEMPTS,
  NATIVE_SESSION_MAX_BODY_BYTES,
  NATIVE_SESSION_TOO_LARGE,
  nativePasswordSubjectHash,
  parseNativeSessionJson,
  readCappedRequestText,
} = await import("@/lib/native-session-limits");
const { isNativeFieldApiPath, NATIVE_FIELD_API_PREFIX } = await import(
  "@/lib/native-field-api-path"
);
const {
  NATIVE_TODAY_JOB_LIMIT,
  buildNativeTodayPayload,
  listNativeAssignedJobs,
  loadNativeAssignedJob,
  loadNativeToday,
  nativeAssignedJobWhere,
  nativeCompleteAction,
  nativeStartAction,
  nativeStopTimeAction,
  nativeTodayTruncatedNotice,
} = await import("@/lib/native-field");
const {
  completeNativeAssignedJob,
  startNativeAssignedJob,
  stopNativeAssignedJobRunningTime,
  NATIVE_JOB_NOT_AVAILABLE,
} = await import("@/lib/native-field-ops");
const { JOB_STOP_TIME_CLOSED_REASON } = await import("@/lib/time-card-ops");
const { CUSTOMER_HAS_NOT_CONFIRMED_APPOINTMENT } = await import(
  "@/lib/appointment-confirmation"
);
const {
  readBearerToken,
  resolveNativeFieldAccess,
  revokeNativeSession,
  signInNativeField,
} = await import("@/lib/native-session");
const { SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE } = await import(
  "@/lib/saas-billing/messages"
);
const { weekRange } = await import("@/lib/time-cards");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error(
    "DATABASE_URL must be set (pointing at a reachable Postgres server) to run this check.",
  );
  process.exit(1);
}

const testDbName = "tbbt_native_field_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for native-field test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");
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

function readRepo(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function jsonBlob(value) {
  return JSON.stringify(value);
}

function containsAny(haystack, needles) {
  return needles.some((needle) => haystack.includes(needle));
}

console.log("\nPURE — Bearer parsing and native API path");
check("readBearerToken reads a Bearer token", readBearerToken("Bearer abc.def") === "abc.def");
check("readBearerToken ignores cookies-style values", readBearerToken("abc.def") === null);
check("readBearerToken ignores empty", readBearerToken("") === null);
check(
  "isNativeFieldApiPath accepts the versioned prefix only",
  isNativeFieldApiPath("/api/native/v1/today") &&
    isNativeFieldApiPath("/api/native/v1") &&
    !isNativeFieldApiPath("/api/native") &&
    !isNativeFieldApiPath("/field") &&
    !isNativeFieldApiPath("/today"),
);
check("NATIVE_FIELD_API_PREFIX is /api/native/v1", NATIVE_FIELD_API_PREFIX === "/api/native/v1");

const oversized = await readCappedRequestText(
  new Request("http://native.test/api/native/v1/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "x".repeat(NATIVE_SESSION_MAX_BODY_BYTES + 1),
  }),
);
check(
  "Oversized native session body is rejected before JSON parse",
  oversized.ok === false && oversized.status === 413 && oversized.error === NATIVE_SESSION_TOO_LARGE,
);
const cappedOk = await readCappedRequestText(
  new Request("http://native.test/api/native/v1/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "a@b.co", password: "x" }),
  }),
);
check("In-cap native session JSON is accepted", cappedOk.ok === true);
check(
  "Overlong email field is rejected after parse",
  parseNativeSessionJson(JSON.stringify({ email: "a".repeat(400), password: "secret" })).ok === false,
);

const assignedShape = nativeAssignedJobWhere("job-1", {
  businessId: "biz-1",
  membershipId: "mem-1",
});
check(
  "nativeAssignedJobWhere matches assignedJobWhere(businessId + assignedMembershipId)",
  assignedShape.id === "job-1" &&
    assignedShape.businessId === "biz-1" &&
    assignedShape.assignedMembershipId === "mem-1" &&
    JSON.stringify(assignedShape) ===
      JSON.stringify({
        id: "job-1",
        businessId: "biz-1",
        assignedMembershipId: "mem-1",
      }),
);

const proxySrc = readRepo("src/proxy.ts");
check(
  "Auth proxy lets /api/native/ through without a session cookie",
  proxySrc.includes("isNativeFieldApiPath") &&
    proxySrc.includes("api/native/") &&
    proxySrc.includes("isPublicWebsitePath(pathname) || isStripeWebhookPath(pathname)"),
);

const sessionRouteSrc = readRepo("src/app/api/native/v1/session/route.ts");
const todayRouteSrc = readRepo("src/app/api/native/v1/today/route.ts");
const jobRouteSrc = readRepo("src/app/api/native/v1/jobs/[jobId]/route.ts");
const completeRouteSrc = readRepo("src/app/api/native/v1/jobs/[jobId]/complete/route.ts");
const startRouteSrc = readRepo("src/app/api/native/v1/jobs/[jobId]/start/route.ts");
const stopTimeRouteSrc = readRepo("src/app/api/native/v1/jobs/[jobId]/stop-time/route.ts");
const visitRouteSrc = readRepo("src/app/api/native/v1/jobs/[jobId]/visit/route.ts");
const checklistRouteSrc = readRepo("src/app/api/native/v1/jobs/[jobId]/checklist/route.ts");
const checklistSyncRouteSrc = readRepo(
  "src/app/api/native/v1/jobs/[jobId]/checklist/sync/route.ts",
);
const photoAuthorizeRouteSrc = readRepo("src/app/api/native/v1/jobs/[jobId]/photos/authorize/route.ts");
const photoFinalizeRouteSrc = readRepo("src/app/api/native/v1/jobs/[jobId]/photos/finalize/route.ts");
const photoAbortRouteSrc = readRepo("src/app/api/native/v1/jobs/[jobId]/photos/abort/route.ts");
const photoPreviewRouteSrc = readRepo("src/app/api/native/v1/jobs/[jobId]/photos/[photoId]/route.ts");
const completeOpsSrc = readRepo("src/lib/native-field-ops.ts");
const membershipGuardSrc = readRepo("src/lib/exact-active-membership.ts");
const timeCardOpsSrc = readRepo("src/lib/time-card-ops.ts");
const limitsSrc = readRepo("src/lib/native-session-limits.ts");
const stopFnSrc = completeOpsSrc.slice(
  completeOpsSrc.indexOf("export async function stopNativeAssignedJobRunningTime"),
  completeOpsSrc.indexOf("export async function completeNativeAssignedJob"),
);
const completeFnSrc = completeOpsSrc.slice(
  completeOpsSrc.indexOf("export async function completeNativeAssignedJob"),
  completeOpsSrc.indexOf("export async function startNativeAssignedJob"),
);
const startFnSrc = completeOpsSrc.slice(
  completeOpsSrc.indexOf("export async function startNativeAssignedJob"),
);
check(
  "Native routes authenticate with Bearer helpers, not cookies()",
  sessionRouteSrc.includes("readBearerToken") &&
    todayRouteSrc.includes("readBearerToken") &&
    jobRouteSrc.includes("readBearerToken") &&
    completeRouteSrc.includes("readBearerToken") &&
    startRouteSrc.includes("readBearerToken") &&
    stopTimeRouteSrc.includes("readBearerToken") &&
    visitRouteSrc.includes("readBearerToken") &&
    checklistRouteSrc.includes("readBearerToken") &&
    checklistSyncRouteSrc.includes("readBearerToken") &&
    photoAuthorizeRouteSrc.includes("readBearerToken") &&
    photoFinalizeRouteSrc.includes("readBearerToken") &&
    photoAbortRouteSrc.includes("readBearerToken") &&
    photoPreviewRouteSrc.includes("readBearerToken") &&
    !sessionRouteSrc.includes("cookies(") &&
    !todayRouteSrc.includes("cookies(") &&
    !jobRouteSrc.includes("cookies(") &&
    !completeRouteSrc.includes("cookies(") &&
    !startRouteSrc.includes("cookies(") &&
    !stopTimeRouteSrc.includes("cookies(") &&
    !visitRouteSrc.includes("cookies(") &&
    !checklistRouteSrc.includes("cookies(") &&
    !checklistSyncRouteSrc.includes("cookies(") &&
    !photoAuthorizeRouteSrc.includes("cookies(") &&
    !photoFinalizeRouteSrc.includes("cookies(") &&
    !photoAbortRouteSrc.includes("cookies(") &&
    !photoPreviewRouteSrc.includes("cookies(") &&
    !completeOpsSrc.includes("cookies("),
);
check(
  "Complete job reuses assigned-job scope and the canonical time-safe write",
  completeOpsSrc.includes("nativeAssignedJobWhere") &&
    completeOpsSrc.includes("lockTenantOwnedJob") &&
    completeOpsSrc.includes("completeJobWithRunningTimeSafetyInTransaction") &&
    completeOpsSrc.includes("assignedMembershipId") &&
    completeOpsSrc.includes("afterInitialRead") &&
    completeOpsSrc.includes("requireSaasOperatingEntitlement") &&
    completeOpsSrc.includes("exactActiveMembershipHeld") &&
    completeRouteSrc.includes("completeNativeAssignedJob") &&
    !completeOpsSrc.includes("completeJobAndSendInvoice"),
);
check(
  "Exact active membership is rechecked after the Job lock on start, complete, and stop",
  membershipGuardSrc.includes('FROM "Membership"') &&
    membershipGuardSrc.includes("FOR UPDATE") &&
    membershipGuardSrc.includes("actor.membershipId") &&
    membershipGuardSrc.includes('actor.businessId') &&
    !membershipGuardSrc.includes("userId") &&
    completeFnSrc.includes("exactActiveMembershipHeld") &&
    startFnSrc.includes("exactActiveMembershipHeld") &&
    stopFnSrc.includes("exactActiveMembershipHeld") &&
    completeFnSrc.slice(completeFnSrc.indexOf("$transaction")).indexOf("lockTenantOwnedJob") <
      completeFnSrc.slice(completeFnSrc.indexOf("$transaction")).indexOf("exactActiveMembershipHeld") &&
    startFnSrc.slice(startFnSrc.indexOf("$transaction")).indexOf("lockTenantOwnedJob") <
      startFnSrc.slice(startFnSrc.indexOf("$transaction")).indexOf("exactActiveMembershipHeld") &&
    stopFnSrc.slice(stopFnSrc.indexOf("$transaction")).indexOf("lockTenantOwnedJob") <
      stopFnSrc.slice(stopFnSrc.indexOf("$transaction")).indexOf("exactActiveMembershipHeld"),
);
check(
  "Start job reuses assigned-job scope and the canonical status + time-card write",
  completeOpsSrc.includes("startNativeAssignedJob") &&
    completeOpsSrc.includes("startJobWithRunningTimeSafetyInTransaction") &&
    completeOpsSrc.includes("evaluateStartJob") &&
    completeOpsSrc.includes("startJobRequiresCustomerConfirmation") &&
    timeCardOpsSrc.includes("startJobWithRunningTimeSafetyInTransaction") &&
    timeCardOpsSrc.includes("evaluateStartJob") &&
    timeCardOpsSrc.includes("JOB_START_TIME_STARTED_REASON") &&
    startRouteSrc.includes("startNativeAssignedJob") &&
    !completeOpsSrc.includes("completeJobAndSendInvoice"),
);
check(
  "Stop job time reuses assigned-job scope and the canonical time-card write",
  completeOpsSrc.includes("stopNativeAssignedJobRunningTime") &&
    completeOpsSrc.includes("stopRunningAssignedJobTimeInTransaction") &&
    completeOpsSrc.includes("lockTenantOwnedJob") &&
    completeOpsSrc.includes("assignedMembershipId") &&
    completeOpsSrc.includes("afterInitialRead") &&
    timeCardOpsSrc.includes("stopRunningAssignedJobTimeInTransaction") &&
    timeCardOpsSrc.includes("JOB_STOP_TIME_CLOSED_REASON") &&
    stopTimeRouteSrc.includes("stopNativeAssignedJobRunningTime") &&
    !completeOpsSrc.includes("completeJobAndSendInvoice"),
);
check(
  "nativeCompleteAction follows evaluateCompleteJob",
  nativeCompleteAction("IN_PROGRESS").available === true &&
    nativeCompleteAction("IN_PROGRESS").reason === null &&
    nativeCompleteAction("COMPLETED").available === false &&
    nativeCompleteAction("COMPLETED").reason === null &&
    nativeCompleteAction("SCHEDULED").available === false &&
    nativeCompleteAction("SCHEDULED").reason === "Start the job before completing it.",
);
const confirmedStartJob = {
  scheduledAt: new Date(),
  scheduledDurationMinutes: 60,
  appointmentConfirmationStatus: "CONFIRMED",
  appointmentProposalId: 1,
  appointmentConfirmedForProposalId: 1,
  appointmentConfirmationSource: "PORTAL",
  propertyAccessMethod: "CUSTOMER_PRESENT",
  propertyAccessInstructions: null,
  propertyAccessContactName: null,
  propertyAccessContactInfo: null,
  propertyAccessPickupLocation: null,
  propertyAccessNote: null,
};
check(
  "nativeStartAction follows evaluateStartJob and the Field confirmation gate",
  nativeStartAction("SCHEDULED", confirmedStartJob).available === true &&
    nativeStartAction("SCHEDULED", confirmedStartJob).reason === null &&
    nativeStartAction("IN_PROGRESS", confirmedStartJob).available === false &&
    nativeStartAction("IN_PROGRESS", confirmedStartJob).reason === null &&
    nativeStartAction("COMPLETED", confirmedStartJob).available === false &&
    nativeStartAction("COMPLETED", confirmedStartJob).reason ===
      "A completed job cannot be started." &&
    nativeStartAction("SCHEDULED", {
      ...confirmedStartJob,
      appointmentConfirmationStatus: "AWAITING_CUSTOMER",
      appointmentConfirmedForProposalId: null,
    }).available === false &&
    nativeStartAction("SCHEDULED", {
      ...confirmedStartJob,
      appointmentConfirmationStatus: "AWAITING_CUSTOMER",
      appointmentConfirmedForProposalId: null,
    }).reason === CUSTOMER_HAS_NOT_CONFIRMED_APPOINTMENT,
);
check(
  "nativeStopTimeAction follows the caller's running JOB time, not Job.status",
  nativeStopTimeAction(true).available === true &&
    nativeStopTimeAction(true).reason === null &&
    nativeStopTimeAction(false).available === false &&
    nativeStopTimeAction(false).reason === null,
);
check(
  "Native session POST caps JSON and uses a durable throttle, not process memory",
    sessionRouteSrc.includes("readCappedRequestText") &&
    sessionRouteSrc.includes("parseNativeSessionJson") &&
    limitsSrc.includes("nativeSignInThrottle") &&
    limitsSrc.includes('ON CONFLICT ("subjectHash", "purpose")') &&
    limitsSrc.includes('"NativeSignInThrottle"."failedAttemptCount" + 1') &&
    !limitsSrc.includes("new Map") &&
    !limitsSrc.includes("globalThis") &&
    limitsSrc.includes("NATIVE_SESSION_MAX_BODY_BYTES"),
);

const nativeFieldSrc = readRepo("src/lib/native-field.ts");
check(
  "Native job select never asks for customer email, money, portal tokens, or wages",
  !nativeFieldSrc.includes("email: true") &&
    !nativeFieldSrc.includes("unitPrice") &&
    !nativeFieldSrc.includes("laborMinimum") &&
    !nativeFieldSrc.includes("projectToken") &&
    !nativeFieldSrc.includes("hourlyWage") &&
    nativeFieldSrc.includes("assignedMembershipId: field.membershipId"),
);
check(
  "Today list is hard-capped in listNativeAssignedJobs (take limit+1, then slice)",
  nativeFieldSrc.includes("NATIVE_TODAY_JOB_LIMIT") &&
    nativeFieldSrc.includes("take: NATIVE_TODAY_JOB_LIMIT + 1") &&
    nativeFieldSrc.includes("rows.slice(0, NATIVE_TODAY_JOB_LIMIT)") &&
    NATIVE_TODAY_JOB_LIMIT > 0,
);

const nativeAppSrc = [
  readRepo("apps/native/App.tsx"),
  readRepo("apps/native/src/api.ts"),
  readRepo("apps/native/src/session.ts"),
  readRepo("apps/native/src/screens/SignInScreen.tsx"),
  readRepo("apps/native/src/screens/TodayScreen.tsx"),
  readRepo("apps/native/src/screens/JobScreen.tsx"),
  readRepo("apps/native/src/screens/JobPhotosSection.tsx"),
  readRepo("apps/native/src/screens/JobChecklistSection.tsx"),
].join("\n");
check(
  "Native app is not a WebView wrapper and does not embed credentials",
  !/WebView|react-native-webview/.test(nativeAppSrc) &&
    !nativeAppSrc.includes("passwordHash") &&
    nativeAppSrc.includes("Bearer") &&
    nativeAppSrc.includes("SecureStore") &&
    nativeAppSrc.includes("/api/native/v1/today") &&
    nativeAppSrc.includes("/api/native/v1/jobs/") &&
    nativeAppSrc.includes("/complete") &&
    nativeAppSrc.includes("/start") &&
    nativeAppSrc.includes("/stop-time") &&
    nativeAppSrc.includes("Complete job") &&
    nativeAppSrc.includes("Start job") &&
    nativeAppSrc.includes("Stop job time") &&
    nativeAppSrc.includes("Recorded job time") &&
    nativeAppSrc.includes("Record visit completed") &&
    nativeAppSrc.includes("/visit") &&
    nativeAppSrc.includes("/checklist") &&
    nativeAppSrc.includes("Mark done") &&
    nativeAppSrc.includes("runningTime") &&
    nativeAppSrc.includes("loadNativeJob") &&
    nativeAppSrc.includes("truncatedNotice") &&
    nativeAppSrc.includes("payload.truncated") &&
    nativeAppSrc.includes("/photos/authorize") &&
    nativeAppSrc.includes("Take photo") &&
    nativeAppSrc.includes("Review photo") &&
    nativeAppSrc.includes("Upload photo"),
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

  const password = "native-field-pass-9";
  const passwordHash = await hashPassword(password);

  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Native Field",
      slug: "alpha-native-field",
      tradeCode: "HANDYMAN",
      ...completedOnboarding,
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Native Field",
      slug: "beta-native-field",
      tradeCode: "HANDYMAN",
      ...completedOnboarding,
    },
  });

  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: "owner@native-field.example", passwordHash },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: "member@native-field.example", passwordHash },
  });
  const otherMemberUser = await prisma.user.create({
    data: { name: "Max Member", email: "other-member@native-field.example", passwordHash },
  });
  const inactiveUser = await prisma.user.create({
    data: { name: "Ivy Inactive", email: "inactive@native-field.example", passwordHash },
  });
  const totpSecret = "JBSWY3DPEHPK3PXP";
  const totpUser = await prisma.user.create({
    data: {
      name: "Tess Totp",
      email: "totp@native-field.example",
      passwordHash,
      totpSecret,
      totpEnabledAt: new Date(),
    },
  });
  const sprayUser = await prisma.user.create({
    data: { name: "Sam Spray", email: "spray@native-field.example", passwordHash },
  });
  const burstUser = await prisma.user.create({
    data: { name: "Bea Burst", email: "burst@native-field.example", passwordHash },
  });
  const betaMemberUser = await prisma.user.create({
    data: { name: "Bree Beta", email: "bree@beta-native-field.example", passwordHash },
  });

  const ownerMembership = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const memberMembership = await prisma.membership.create({
    data: {
      userId: memberUser.id,
      businessId: businessA.id,
      role: "MEMBER",
      hourlyWage: new Prisma.Decimal(41.17),
    },
  });
  const otherMembership = await prisma.membership.create({
    data: { userId: otherMemberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  await prisma.membership.create({
    data: { userId: inactiveUser.id, businessId: businessA.id, role: "MEMBER", active: false },
  });
  await prisma.membership.create({
    data: { userId: totpUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  await prisma.membership.create({
    data: { userId: sprayUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  await prisma.membership.create({
    data: { userId: burstUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const betaMembership = await prisma.membership.create({
    data: { userId: betaMemberUser.id, businessId: businessB.id, role: "MEMBER" },
  });

  const customerEmail = "owner-private-cara@leak-test.example";
  const customerA = await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: "Cara Canary Native Q9x",
      email: customerEmail,
      phone: "555-0142",
    },
  });
  const propertyA = await prisma.property.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      addressLine1: "42 Canary Way",
      city: "Springfield",
      region: "IL",
      postalCode: "62704",
    },
  });
  const otherCustomer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Other Worker Job Canary", phone: "555-0199" },
  });
  const betaCustomer = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Job Canary", phone: "555-0177" },
  });

  const estimateTotal = new Prisma.Decimal("888.17");
  const estimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      total: estimateTotal,
      publicToken: randomUUID(),
      status: "APPROVED",
    },
  });
  const version = await prisma.estimateVersion.create({
    data: {
      businessId: businessA.id,
      estimateId: estimate.id,
      versionNumber: 1,
      total: estimateTotal,
      laborMinimumWaived: false,
      laborMinimumAdjustment: new Prisma.Decimal("25.00"),
      approvedAt: new Date(),
    },
  });
  await prisma.estimateVersionLineItem.create({
    data: {
      businessId: businessA.id,
      estimateVersionId: version.id,
      description: "Canary Approved Scope Line Q9x",
      quantity: new Prisma.Decimal(2),
      unitPrice: new Prisma.Decimal("444.085"),
      total: estimateTotal,
      type: "LABOR",
    },
  });
  await prisma.estimate.update({
    where: { id: estimate.id },
    data: { approvedVersionId: version.id },
  });

  const assignedJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      estimateId: estimate.id,
      approvedEstimateVersionId: version.id,
      assignedMembershipId: memberMembership.id,
      projectToken: `portal-${randomUUID()}`,
      status: "SCHEDULED",
      scheduledAt: new Date(),
      scheduledDurationMinutes: 60,
      appointmentProposalId: 1,
      appointmentConfirmationStatus: "CONFIRMED",
      appointmentConfirmedForProposalId: 1,
      appointmentConfirmationSource: "PORTAL",
      propertyAccessMethod: "CUSTOMER_PRESENT",
    },
  });
  const otherJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: otherCustomer.id,
      assignedMembershipId: otherMembership.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: new Date(),
    },
  });
  const unassignedJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: new Date(),
    },
  });
  const betaJob = await prisma.job.create({
    data: {
      businessId: businessB.id,
      customerId: betaCustomer.id,
      assignedMembershipId: betaMembership.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: new Date(),
    },
  });

  const assignedBase = assignedJob.scheduledAt ?? new Date();
  const overflowAssigned = [];
  for (let i = 1; i <= NATIVE_TODAY_JOB_LIMIT + 2; i += 1) {
    const name = `Overflow Assigned Canary ${String(i).padStart(2, "0")}`;
    const customer = await prisma.customer.create({
      data: { businessId: businessA.id, name, phone: "555-0100" },
    });
    const job = await prisma.job.create({
      data: {
        businessId: businessA.id,
        customerId: customer.id,
        assignedMembershipId: memberMembership.id,
        projectToken: randomUUID(),
        status: "SCHEDULED",
        scheduledAt: new Date(assignedBase.getTime() + i * 60 * 60 * 1000),
      },
    });
    overflowAssigned.push({ i, id: job.id, name });
  }
  const keptOverflow = overflowAssigned.filter((row) => row.i < NATIVE_TODAY_JOB_LIMIT);
  const droppedOverflow = overflowAssigned.filter((row) => row.i >= NATIVE_TODAY_JOB_LIMIT);

  const extraBetaJobs = [];
  for (let i = 1; i <= 3; i += 1) {
    const name = `Beta Job Canary ${i}`;
    const customer = await prisma.customer.create({
      data: { businessId: businessB.id, name, phone: "555-0177" },
    });
    const job = await prisma.job.create({
      data: {
        businessId: businessB.id,
        customerId: customer.id,
        assignedMembershipId: betaMembership.id,
        projectToken: randomUUID(),
        status: "SCHEDULED",
        scheduledAt: new Date(assignedBase.getTime() + i * 60 * 60 * 1000),
      },
    });
    extraBetaJobs.push({ id: job.id, name });
  }

  console.log("\nAUTH — native sign-in issues a hashed Session, not a copied password");
  const badPassword = await signInNativeField(prisma, {
    email: memberUser.email,
    password: "wrong-password",
  });
  check("Wrong password is rejected", badPassword.ok === false);

  const inactiveSignIn = await signInNativeField(prisma, {
    email: inactiveUser.email,
    password,
  });
  check(
    "Deactivated membership cannot sign in",
    inactiveSignIn.ok === false && inactiveSignIn.error.includes("not assigned"),
  );

  const totpSignIn = await signInNativeField(prisma, {
    email: totpUser.email,
    password,
  });
  check(
    "TOTP-enabled user does not receive a session token before the challenge",
    totpSignIn.ok === false &&
      totpSignIn.totpRequired === true &&
      Boolean(totpSignIn.challengeToken) &&
      !("token" in totpSignIn),
  );

  const totpOk = await signInNativeField(prisma, {
    challengeToken: totpSignIn.challengeToken,
    totpCode: currentTotpCode(totpSecret),
  });
  check("Valid TOTP challenge issues a Bearer session", totpOk.ok === true);
  if (totpOk.ok) {
    const totpAccess = await resolveNativeFieldAccess(prisma, { token: totpOk.token });
    check("Valid TOTP session resolves field access", totpAccess.ok === true);
    await revokeNativeSession(prisma, totpOk.token);
    const afterTotpRevoke = await resolveNativeFieldAccess(prisma, { token: totpOk.token });
    check("TOTP session can be revoked", afterTotpRevoke.ok === false && afterTotpRevoke.status === 401);
  }

  const totpRetry = await signInNativeField(prisma, {
    email: totpUser.email,
    password,
  });
  check("TOTP user can start a new challenge after revoke", totpRetry.ok === false && Boolean(totpRetry.challengeToken));
  let totpLocked = "";
  for (let attempt = 0; attempt < TOTP_CHALLENGE_MAX_ATTEMPTS; attempt += 1) {
    const failed = await signInNativeField(prisma, {
      challengeToken: totpRetry.challengeToken,
      totpCode: "000000",
    });
    totpLocked = failed.ok ? "" : failed.error;
  }
  const leftoverTotp = await prisma.authChallenge.findMany({
    where: { userId: totpUser.id, purpose: "TOTP_SIGN_IN" },
  });
  check(
    "Five wrong TOTP codes lock the durable challenge",
    totpLocked === TOTP_CHALLENGE_LOCKED_MESSAGE && leftoverTotp.length === 0,
  );

  let sprayLocked = "";
  for (let attempt = 0; attempt < NATIVE_PASSWORD_MAX_ATTEMPTS; attempt += 1) {
    const failed = await signInNativeField(prisma, {
      email: sprayUser.email,
      password: "wrong-password",
    });
    sprayLocked = failed.ok ? "" : failed.error;
  }
  const sprayThrottle = await prisma.nativeSignInThrottle.findUnique({
    where: {
      subjectHash_purpose: {
        subjectHash: nativePasswordSubjectHash(sprayUser.email),
        purpose: "NATIVE_PASSWORD",
      },
    },
  });
  const sprayCorrectAfterLock = await signInNativeField(prisma, {
    email: sprayUser.email,
    password,
  });
  check(
    "Five wrong passwords persist on NativeSignInThrottle and block the next try",
    sprayLocked === NATIVE_PASSWORD_LOCKED_MESSAGE &&
      sprayThrottle?.failedAttemptCount === NATIVE_PASSWORD_MAX_ATTEMPTS &&
      sprayCorrectAfterLock.ok === false &&
      sprayCorrectAfterLock.error === NATIVE_PASSWORD_LOCKED_MESSAGE,
  );

  const burstResults = await Promise.all(
    Array.from({ length: NATIVE_PASSWORD_MAX_ATTEMPTS }, () =>
      signInNativeField(prisma, {
        email: burstUser.email,
        password: "wrong-password",
      }),
    ),
  );
  const burstThrottle = await prisma.nativeSignInThrottle.findUnique({
    where: {
      subjectHash_purpose: {
        subjectHash: nativePasswordSubjectHash(burstUser.email),
        purpose: "NATIVE_PASSWORD",
      },
    },
  });
  const burstNext = await signInNativeField(prisma, {
    email: burstUser.email,
    password,
  });
  check(
    "Five simultaneous wrong passwords count as five failures and lock the next try",
    burstResults.every((result) => result.ok === false) &&
      burstThrottle?.failedAttemptCount === NATIVE_PASSWORD_MAX_ATTEMPTS &&
      burstNext.ok === false &&
      burstNext.error === NATIVE_PASSWORD_LOCKED_MESSAGE,
  );

  const memberSignIn = await signInNativeField(prisma, {
    email: memberUser.email,
    password,
    userAgent: "TBBTFieldTest/1.0",
  });
  check("MEMBER sign-in succeeds", memberSignIn.ok === true);
  if (!memberSignIn.ok) {
    throw new Error("MEMBER sign-in failed; cannot continue isolation proof.");
  }
  check("Returned token is not the password", memberSignIn.token !== password);
  check(
    "Session stores only the token hash",
    Boolean(
      await prisma.session.findUnique({
        where: { tokenHash: hashToken(memberSignIn.token) },
      }),
    ) &&
      !(await prisma.session.findFirst({
        where: { userId: memberUser.id, tokenHash: memberSignIn.token },
      })),
  );
  check("MEMBER workspace is field-scoped to their membership", memberSignIn.workspace.membershipId === memberMembership.id);
  check("MEMBER role is MEMBER", memberSignIn.viewer.role === "MEMBER");

  const cookieIgnored = await resolveNativeFieldAccess(prisma, { token: null });
  check("No Bearer token is unauthorized", cookieIgnored.ok === false && cookieIgnored.status === 401);

  const memberAccess = await resolveNativeFieldAccess(prisma, { token: memberSignIn.token });
  check("Bearer token resolves the MEMBER field workspace", memberAccess.ok === true);
  if (!memberAccess.ok) {
    throw new Error("MEMBER bearer resolve failed.");
  }

  const stolenWorkspace = await resolveNativeFieldAccess(prisma, {
    token: memberSignIn.token,
    requestedBusinessId: businessB.id,
  });
  check(
    "MEMBER cannot select another business via workspace header",
    stolenWorkspace.ok === false && stolenWorkspace.status === 403,
  );

  console.log("\nTODAY — assigned-job isolation, cap, and no owner records");
  const listed = await listNativeAssignedJobs(prisma, memberAccess.access);
  check(
    `listNativeAssignedJobs returns at most ${NATIVE_TODAY_JOB_LIMIT} assigned jobs`,
    listed.jobs.length === NATIVE_TODAY_JOB_LIMIT &&
      listed.limit === NATIVE_TODAY_JOB_LIMIT &&
      listed.truncated === true,
  );
  check(
    `MEMBER has more assigned jobs than the cap (${NATIVE_TODAY_JOB_LIMIT + 3} > ${NATIVE_TODAY_JOB_LIMIT})`,
    overflowAssigned.length === NATIVE_TODAY_JOB_LIMIT + 2,
  );

  const today = await loadNativeToday(prisma, memberAccess.access);
  const todayJson = jsonBlob(today);
  const todayIds = [...today.today, ...today.upcoming, ...today.completed].map((job) => job.id);
  check("Today includes the MEMBER's earliest assigned job", todayIds.includes(assignedJob.id));
  check(
    "Today includes assigned overflow jobs that fit under the cap",
    keptOverflow.every((row) => todayIds.includes(row.id)),
  );
  check(
    "Today omits assigned overflow jobs beyond the cap",
    droppedOverflow.every((row) => !todayIds.includes(row.id)) &&
      droppedOverflow.every((row) => !todayJson.includes(row.name)),
  );
  check(
    "Today returned count equals the cap and advertises truncation",
    todayIds.length === NATIVE_TODAY_JOB_LIMIT &&
      today.truncated === true &&
      today.limit === NATIVE_TODAY_JOB_LIMIT &&
      today.truncatedNotice === nativeTodayTruncatedNotice(NATIVE_TODAY_JOB_LIMIT),
  );
  check("Today hides the other MEMBER's job", !todayIds.includes(otherJob.id));
  check("Today hides the unassigned job", !todayIds.includes(unassignedJob.id));
  check("Today hides the other business's job", !todayIds.includes(betaJob.id));
  check(
    "Today hides additional cross-tenant assigned jobs",
    extraBetaJobs.every((row) => !todayIds.includes(row.id) && !todayJson.includes(row.name)),
  );
  check(
    "Today JSON does not leak owner/financial canaries",
    !containsAny(todayJson, [
      customerEmail,
      "888.17",
      "41.17",
      "Other Worker Job Canary",
      "Beta Job Canary",
      assignedJob.projectToken,
      "passwordHash",
      "hourlyWage",
    ]),
  );

  const ownerSignIn = await signInNativeField(prisma, {
    email: ownerUser.email,
    password,
  });
  check("OWNER can sign in to the field API", ownerSignIn.ok === true);
  if (ownerSignIn.ok) {
    const ownerAccess = await resolveNativeFieldAccess(prisma, { token: ownerSignIn.token });
    check("OWNER bearer resolves", ownerAccess.ok === true);
    if (ownerAccess.ok) {
      const ownerToday = await loadNativeToday(prisma, ownerAccess.access);
      const ownerIds = [...ownerToday.today, ...ownerToday.upcoming, ...ownerToday.completed].map(
        (job) => job.id,
      );
      check(
        "OWNER Today is assignment-scoped (empty here) and does not list every job",
        ownerIds.length === 0 &&
          ownerToday.truncated === false &&
          ownerToday.truncatedNotice === null &&
          !ownerIds.includes(assignedJob.id) &&
          !ownerIds.includes(otherJob.id),
      );
    }
  }

  console.log("\nJOB — assigned detail only, field-safe projection");
  const detail = await loadNativeAssignedJob(prisma, memberAccess.access, assignedJob.id);
  check("Assigned job detail loads", Boolean(detail));
  const detailJson = jsonBlob(detail);
  check("Detail includes the customer name and address", Boolean(detail?.customerName === "Cara Canary Native Q9x" && detail?.address?.includes("42 Canary Way")));
  check(
    "Detail includes approved scope description without money",
    Boolean(detail?.scope.items.some((item) => item.description === "Canary Approved Scope Line Q9x")),
  );
  check(
    "Detail JSON does not leak email, totals, portal token, or wages",
    !containsAny(detailJson, [
      customerEmail,
      "888.17",
      "444.085",
      "25.00",
      "41.17",
      assignedJob.projectToken,
      "unitPrice",
      "laborMinimumAdjustment",
    ]),
  );

  const otherDetail = await loadNativeAssignedJob(prisma, memberAccess.access, otherJob.id);
  const unassignedDetail = await loadNativeAssignedJob(prisma, memberAccess.access, unassignedJob.id);
  const betaDetail = await loadNativeAssignedJob(prisma, memberAccess.access, betaJob.id);
  check("Other member's job is not available", otherDetail === null);
  check("Unassigned job is not available", unassignedDetail === null);
  check("Cross-tenant job is not available", betaDetail === null);
  check(
    "Scheduled assigned job advertises Complete job as unavailable until started",
    detail?.completeAction.available === false &&
      detail?.completeAction.reason === "Start the job before completing it.",
  );
  check(
    "Scheduled assigned job advertises Start job and idle running time",
    detail?.startAction.available === true &&
      detail?.startAction.reason === null &&
      detail?.stopTimeAction.available === false &&
      detail?.runningTime.running === false &&
      detail?.runningTime.recorded === false &&
      detail?.runningTime.startedAt === null,
  );
  check(
    "Handyman assigned job does not advertise a Cleaning visit outcome",
    detail?.visit == null,
  );

  console.log("\nCOMPLETE — assigned-worker write, isolation, duplicates, rollback");
  await prisma.businessSaasSubscription.create({
    data: {
      businessId: businessA.id,
      status: "active",
      planCode: "FOUNDER",
      legacyExempt: true,
    },
  });
  await prisma.businessSaasSubscription.create({
    data: {
      businessId: businessB.id,
      status: "active",
      planCode: "FOUNDER",
      legacyExempt: true,
    },
  });

  async function createScopedJob(input) {
    const customer =
      input.customerId
        ? { id: input.customerId }
        : await prisma.customer.create({
            data: {
              businessId: input.businessId,
              name: input.customerName,
              phone: "555-0101",
            },
          });
    return prisma.job.create({
      data: {
        businessId: input.businessId,
        customerId: customer.id,
        assignedMembershipId: input.assignedMembershipId,
        projectToken: randomUUID(),
        status: input.status,
        scheduledAt: new Date(),
      },
    });
  }

  async function createDeactivationWorker(label) {
    const user = await prisma.user.create({
      data: {
        name: `${label} Worker`,
        email: `${label}-${randomUUID()}@native-deactivate.example`,
        passwordHash,
      },
    });
    const membership = await prisma.membership.create({
      data: { userId: user.id, businessId: businessA.id, role: "MEMBER" },
    });
    const signIn = await signInNativeField(prisma, { email: user.email, password });
    if (!signIn.ok) {
      throw new Error(`${label} deactivation fixture sign-in failed.`);
    }
    const resolved = await resolveNativeFieldAccess(prisma, { token: signIn.token });
    if (!resolved.ok) {
      throw new Error(`${label} deactivation fixture access failed.`);
    }
    return { membership, access: resolved.access };
  }

  async function deactivateExactMembership(membershipId) {
    const otherClient = new PrismaClient({ datasourceUrl: testUrl });
    try {
      await otherClient.membership.update({
        where: { id: membershipId },
        data: { active: false },
      });
    } finally {
      await otherClient.$disconnect();
    }
  }

  const inProgressJob = await createScopedJob({
    businessId: businessA.id,
    assignedMembershipId: memberMembership.id,
    customerId: customerA.id,
    status: "IN_PROGRESS",
  });
  const otherInProgress = await createScopedJob({
    businessId: businessA.id,
    assignedMembershipId: otherMembership.id,
    customerName: "Other In Progress Canary",
    status: "IN_PROGRESS",
  });
  const betaInProgress = await createScopedJob({
    businessId: businessB.id,
    assignedMembershipId: betaMembership.id,
    customerName: "Beta In Progress Canary",
    status: "IN_PROGRESS",
  });
  const duplicateJob = await createScopedJob({
    businessId: businessA.id,
    assignedMembershipId: memberMembership.id,
    customerId: customerA.id,
    status: "IN_PROGRESS",
  });
  const rollbackJob = await createScopedJob({
    businessId: businessA.id,
    assignedMembershipId: memberMembership.id,
    customerId: customerA.id,
    status: "IN_PROGRESS",
  });
  const raceJob = await createScopedJob({
    businessId: businessA.id,
    assignedMembershipId: memberMembership.id,
    customerId: customerA.id,
    status: "IN_PROGRESS",
  });

  const blockedBusiness = await prisma.business.create({
    data: {
      name: "Blocked Native Field",
      slug: "blocked-native-field",
      tradeCode: "HANDYMAN",
      ...completedOnboarding,
    },
  });
  const blockedUser = await prisma.user.create({
    data: {
      name: "No Sub Member",
      email: "nosub@blocked-native-field.example",
      passwordHash,
    },
  });
  const blockedMembership = await prisma.membership.create({
    data: { userId: blockedUser.id, businessId: blockedBusiness.id, role: "MEMBER" },
  });
  const blockedJob = await createScopedJob({
    businessId: blockedBusiness.id,
    assignedMembershipId: blockedMembership.id,
    customerName: "Blocked Complete Canary",
    status: "IN_PROGRESS",
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

  const invoicesBefore = await prisma.invoice.count({
    where: { businessId: { in: [businessA.id, businessB.id, blockedBusiness.id] } },
  });

  const unauthorizedComplete = await completeNativeAssignedJob(
    prisma,
    memberAccess.access,
    otherInProgress.id,
  );
  const unassignedComplete = await completeNativeAssignedJob(
    prisma,
    memberAccess.access,
    unassignedJob.id,
  );
  const crossTenantComplete = await completeNativeAssignedJob(
    prisma,
    memberAccess.access,
    betaInProgress.id,
  );
  check(
    "Assigned worker cannot complete another member's job",
    unauthorizedComplete.ok === false &&
      unauthorizedComplete.status === 404 &&
      unauthorizedComplete.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Assigned worker cannot complete an unassigned job",
    unassignedComplete.ok === false && unassignedComplete.status === 404,
  );
  check(
    "Assigned worker cannot complete a cross-tenant job",
    crossTenantComplete.ok === false &&
      crossTenantComplete.status === 404 &&
      crossTenantComplete.error === NATIVE_JOB_NOT_AVAILABLE,
  );

  const otherSignIn = await signInNativeField(prisma, {
    email: otherMemberUser.email,
    password,
    userAgent: "TBBTFieldTest/1.0",
  });
  check("Other MEMBER can sign in for isolation proof", otherSignIn.ok === true);
  if (!otherSignIn.ok) {
    throw new Error("Other MEMBER sign-in failed; cannot continue complete isolation proof.");
  }
  const otherAccess = await resolveNativeFieldAccess(prisma, { token: otherSignIn.token });
  check("Other MEMBER bearer resolves", otherAccess.ok === true);
  if (!otherAccess.ok) {
    throw new Error("Other MEMBER bearer resolve failed.");
  }
  const stolenComplete = await completeNativeAssignedJob(
    prisma,
    otherAccess.access,
    inProgressJob.id,
  );
  const otherJobAfterSteal = await prisma.job.findFirst({
    where: { id: inProgressJob.id, businessId: businessA.id },
    select: { status: true, assignedMembershipId: true },
  });
  check(
    "Other MEMBER cannot complete a job assigned to someone else",
    stolenComplete.ok === false &&
      stolenComplete.status === 404 &&
      otherJobAfterSteal?.status === "IN_PROGRESS" &&
      otherJobAfterSteal?.assignedMembershipId === memberMembership.id,
  );

  const betaSignIn = await signInNativeField(prisma, {
    email: betaMemberUser.email,
    password,
    userAgent: "TBBTFieldTest/1.0",
  });
  check("Beta MEMBER can sign in for tenant isolation", betaSignIn.ok === true);
  if (!betaSignIn.ok) {
    throw new Error("Beta MEMBER sign-in failed.");
  }
  const betaAccess = await resolveNativeFieldAccess(prisma, { token: betaSignIn.token });
  check("Beta MEMBER bearer resolves", betaAccess.ok === true);
  if (!betaAccess.ok) {
    throw new Error("Beta MEMBER bearer resolve failed.");
  }
  const betaSteal = await completeNativeAssignedJob(
    prisma,
    betaAccess.access,
    inProgressJob.id,
  );
  const alphaAfterBetaSteal = await prisma.job.findFirst({
    where: { id: inProgressJob.id, businessId: businessA.id },
    select: { status: true },
  });
  const betaAfterAlphaAttempt = await prisma.job.findFirst({
    where: { id: betaInProgress.id, businessId: businessB.id },
    select: { status: true },
  });
  check(
    "Cross-tenant complete leaves both jobs unchanged",
    betaSteal.ok === false &&
      betaSteal.status === 404 &&
      alphaAfterBetaSteal?.status === "IN_PROGRESS" &&
      betaAfterAlphaAttempt?.status === "IN_PROGRESS",
  );

  const scheduledComplete = await completeNativeAssignedJob(
    prisma,
    memberAccess.access,
    assignedJob.id,
  );
  const scheduledAfter = await prisma.job.findFirst({
    where: { id: assignedJob.id, businessId: businessA.id },
    select: { status: true },
  });
  check(
    "Status safeguard refuses Complete job before the job is started",
    scheduledComplete.ok === false &&
      scheduledComplete.status === 409 &&
      scheduledComplete.error === "Start the job before completing it." &&
      scheduledAfter?.status === "SCHEDULED",
  );

  const blockedSignIn = await signInNativeField(prisma, {
    email: blockedUser.email,
    password,
    userAgent: "TBBTFieldTest/1.0",
  });
  check("Blocked-subscription MEMBER can sign in", blockedSignIn.ok === true);
  if (!blockedSignIn.ok) {
    throw new Error("Blocked MEMBER sign-in failed.");
  }
  const blockedAccess = await resolveNativeFieldAccess(prisma, { token: blockedSignIn.token });
  check("Blocked-subscription bearer resolves", blockedAccess.ok === true);
  if (!blockedAccess.ok) {
    throw new Error("Blocked MEMBER bearer resolve failed.");
  }
  const blockedComplete = await completeNativeAssignedJob(
    prisma,
    blockedAccess.access,
    blockedJob.id,
  );
  const blockedAfter = await prisma.job.findFirst({
    where: { id: blockedJob.id, businessId: blockedBusiness.id },
    select: { status: true },
  });
  check(
    "Complete job requires an operating SaaS entitlement",
    blockedComplete.ok === false &&
      blockedComplete.status === 403 &&
      blockedComplete.error === SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE &&
      blockedAfter?.status === "IN_PROGRESS",
  );

  const raceStartedAt = new Date(Date.now() - 90_000);
  await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: memberMembership.id,
      jobId: raceJob.id,
      activityType: "JOB",
      status: "RUNNING",
      startedAt: raceStartedAt,
      source: "CLOCK",
    },
  });
  const raceEventsBefore = await prisma.businessEvent.count({
    where: {
      businessId: businessA.id,
      type: "JOB_COMPLETED",
      subjectId: raceJob.id,
    },
  });
  const raceComplete = await completeNativeAssignedJob(
    prisma,
    memberAccess.access,
    raceJob.id,
    {
      afterInitialRead: async () => {
        await prisma.job.update({
          where: { id: raceJob.id },
          data: { assignedMembershipId: otherMembership.id },
        });
      },
    },
  );
  const raceJobAfter = await prisma.job.findFirst({
    where: { id: raceJob.id, businessId: businessA.id },
    select: { status: true, assignedMembershipId: true },
  });
  const raceTimeAfter = await prisma.timeEntry.findFirst({
    where: { jobId: raceJob.id, businessId: businessA.id },
    select: { status: true, endedAt: true, membershipId: true },
  });
  const raceEventsAfter = await prisma.businessEvent.count({
    where: {
      businessId: businessA.id,
      type: "JOB_COMPLETED",
      subjectId: raceJob.id,
    },
  });
  check(
    "Assignment change after the initial read refuses Complete job",
    raceComplete.ok === false &&
      raceComplete.status === 404 &&
      raceComplete.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Reassigned Job after the initial read leaves Job, running time, and completion event unchanged",
    raceJobAfter?.status === "IN_PROGRESS" &&
      raceJobAfter?.assignedMembershipId === otherMembership.id &&
      raceTimeAfter?.status === "RUNNING" &&
      raceTimeAfter?.endedAt === null &&
      raceTimeAfter?.membershipId === memberMembership.id &&
      raceEventsAfter === raceEventsBefore &&
      raceEventsAfter === 0,
  );

  const deactivateCompleteWorker = await createDeactivationWorker("ops-complete");
  const deactivateCompleteJob = await createScopedJob({
    businessId: businessA.id,
    assignedMembershipId: deactivateCompleteWorker.membership.id,
    customerName: "Deactivate Complete Canary",
    status: "IN_PROGRESS",
  });
  const deactivateCompleteStartedAt = new Date(Date.now() - 90_000);
  await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: deactivateCompleteWorker.membership.id,
      jobId: deactivateCompleteJob.id,
      activityType: "JOB",
      status: "RUNNING",
      startedAt: deactivateCompleteStartedAt,
      source: "CLOCK",
    },
  });
  const deactivateCompleteEventsBefore = await prisma.businessEvent.count({
    where: {
      businessId: businessA.id,
      type: "JOB_COMPLETED",
      subjectId: deactivateCompleteJob.id,
    },
  });
  const deactivateComplete = await completeNativeAssignedJob(
    prisma,
    deactivateCompleteWorker.access,
    deactivateCompleteJob.id,
    {
      afterInitialRead: () =>
        deactivateExactMembership(deactivateCompleteWorker.membership.id),
    },
  );
  const deactivateCompleteJobAfter = await prisma.job.findFirst({
    where: { id: deactivateCompleteJob.id, businessId: businessA.id },
    select: { status: true, assignedMembershipId: true },
  });
  const deactivateCompleteTimeAfter = await prisma.timeEntry.findFirst({
    where: { jobId: deactivateCompleteJob.id, businessId: businessA.id },
    select: { status: true, endedAt: true, membershipId: true },
  });
  const deactivateCompleteEventsAfter = await prisma.businessEvent.count({
    where: {
      businessId: businessA.id,
      type: "JOB_COMPLETED",
      subjectId: deactivateCompleteJob.id,
    },
  });
  const deactivateCompleteMembershipAfter = await prisma.membership.findFirst({
    where: { id: deactivateCompleteWorker.membership.id, businessId: businessA.id },
    select: { active: true },
  });
  check(
    "Deactivated membership after the initial read refuses Complete job",
    deactivateComplete.ok === false &&
      deactivateComplete.status === 404 &&
      deactivateComplete.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Deactivated Complete job leaves Job, running time, and completion event unchanged",
    deactivateCompleteJobAfter?.status === "IN_PROGRESS" &&
      deactivateCompleteJobAfter?.assignedMembershipId ===
        deactivateCompleteWorker.membership.id &&
      deactivateCompleteTimeAfter?.status === "RUNNING" &&
      deactivateCompleteTimeAfter?.endedAt === null &&
      deactivateCompleteTimeAfter?.membershipId === deactivateCompleteWorker.membership.id &&
      deactivateCompleteEventsAfter === deactivateCompleteEventsBefore &&
      deactivateCompleteEventsAfter === 0 &&
      deactivateCompleteMembershipAfter?.active === false,
  );

  const rollbackStartedAt = new Date(Date.now() - 60_000);
  await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: memberMembership.id,
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
      membershipId: memberMembership.id,
      weekStartedAt: weekRange(rollbackStartedAt).start,
      status: "APPROVED",
      approvedAt: new Date(),
      approvedByMembershipId: ownerMembership.id,
    },
  });
  const rollbackComplete = await completeNativeAssignedJob(
    prisma,
    memberAccess.access,
    rollbackJob.id,
  );
  const rollbackJobAfter = await prisma.job.findFirst({
    where: { id: rollbackJob.id, businessId: businessA.id },
    select: { status: true },
  });
  const rollbackTimeAfter = await prisma.timeEntry.findFirst({
    where: { jobId: rollbackJob.id, businessId: businessA.id },
    select: { status: true, endedAt: true },
  });
  check(
    "Approved-week running Job time refuses Complete job",
    rollbackComplete.ok === false &&
      rollbackComplete.status === 409 &&
      /approved job time is still running/i.test(rollbackComplete.error ?? ""),
  );
  check(
    "Failed Complete job rolls back Job status and leaves time running",
    rollbackJobAfter?.status === "IN_PROGRESS" &&
      rollbackTimeAfter?.status === "RUNNING" &&
      rollbackTimeAfter?.endedAt === null,
  );

  const firstComplete = await completeNativeAssignedJob(
    prisma,
    memberAccess.access,
    inProgressJob.id,
  );
  const inProgressAfter = await prisma.job.findFirst({
    where: { id: inProgressJob.id, businessId: businessA.id },
    select: { status: true },
  });
  check(
    "Assigned worker can complete their own IN_PROGRESS job",
    firstComplete.ok === true &&
      firstComplete.alreadyCompleted === false &&
      firstComplete.job.status === "COMPLETED" &&
      firstComplete.job.completeAction.available === false &&
      inProgressAfter?.status === "COMPLETED",
  );

  const repeatComplete = await completeNativeAssignedJob(
    prisma,
    memberAccess.access,
    inProgressJob.id,
  );
  const repeatAfter = await prisma.job.findFirst({
    where: { id: inProgressJob.id, businessId: businessA.id },
    select: { status: true },
  });
  check(
    "Duplicate Complete job on an already-completed job is a successful no-op",
    repeatComplete.ok === true &&
      repeatComplete.alreadyCompleted === true &&
      repeatAfter?.status === "COMPLETED",
  );

  const [dupA, dupB] = await Promise.all([
    completeNativeAssignedJob(prisma, memberAccess.access, duplicateJob.id),
    completeNativeAssignedJob(prisma, memberAccess.access, duplicateJob.id),
  ]);
  const duplicateAfter = await prisma.job.findFirst({
    where: { id: duplicateJob.id, businessId: businessA.id },
    select: { status: true },
  });
  check(
    "Concurrent Complete job requests both succeed and leave the Job completed once",
    dupA.ok === true &&
      dupB.ok === true &&
      [dupA.alreadyCompleted, dupB.alreadyCompleted].filter(Boolean).length <= 1 &&
      duplicateAfter?.status === "COMPLETED",
  );

  const otherAfterWrites = await prisma.job.findFirst({
    where: { id: otherInProgress.id, businessId: businessA.id },
    select: { status: true },
  });
  const betaAfterWrites = await prisma.job.findFirst({
    where: { id: betaInProgress.id, businessId: businessB.id },
    select: { status: true },
  });
  const invoicesAfter = await prisma.invoice.count({
    where: { businessId: { in: [businessA.id, businessB.id, blockedBusiness.id] } },
  });
  check(
    "Complete job writes stay on the assigned job and never send an invoice",
    otherAfterWrites?.status === "IN_PROGRESS" &&
      betaAfterWrites?.status === "IN_PROGRESS" &&
      invoicesAfter === invoicesBefore,
  );

  console.log("\nSTART — assigned-worker write, isolation, races, duplicates, rollback");
  function confirmedJobFields() {
    return {
      scheduledAt: new Date(),
      scheduledDurationMinutes: 60,
      appointmentProposalId: 1,
      appointmentConfirmationStatus: "CONFIRMED",
      appointmentConfirmedForProposalId: 1,
      appointmentConfirmationSource: "PORTAL",
      propertyAccessMethod: "CUSTOMER_PRESENT",
    };
  }

  async function createStartJob(input) {
    const customer =
      input.customerId
        ? { id: input.customerId }
        : await prisma.customer.create({
            data: {
              businessId: input.businessId,
              name: input.customerName,
              phone: "555-0102",
            },
          });
    return prisma.job.create({
      data: {
        businessId: input.businessId,
        customerId: customer.id,
        assignedMembershipId: input.assignedMembershipId,
        projectToken: randomUUID(),
        status: input.status ?? "SCHEDULED",
        ...confirmedJobFields(),
        ...(input.confirmation === "unconfirmed"
          ? {
              appointmentConfirmationStatus: "AWAITING_CUSTOMER",
              appointmentConfirmedForProposalId: null,
              appointmentConfirmationSource: null,
            }
          : {}),
      },
    });
  }

  const startJob = await createStartJob({
    businessId: businessA.id,
    assignedMembershipId: memberMembership.id,
    customerId: customerA.id,
  });
  const otherStartJob = await createStartJob({
    businessId: businessA.id,
    assignedMembershipId: otherMembership.id,
    customerName: "Other Start Canary",
  });
  const betaStartJob = await createStartJob({
    businessId: businessB.id,
    assignedMembershipId: betaMembership.id,
    customerName: "Beta Start Canary",
  });
  const unassignedStartJob = unassignedJob;
  const raceStartJob = await createStartJob({
    businessId: businessA.id,
    assignedMembershipId: memberMembership.id,
    customerId: customerA.id,
  });
  const rollbackStartJob = await createStartJob({
    businessId: businessA.id,
    assignedMembershipId: memberMembership.id,
    customerId: customerA.id,
  });
  const duplicateStartJob = await createStartJob({
    businessId: businessA.id,
    assignedMembershipId: memberMembership.id,
    customerId: customerA.id,
  });
  const unconfirmedStartJob = await createStartJob({
    businessId: businessA.id,
    assignedMembershipId: memberMembership.id,
    customerId: customerA.id,
    confirmation: "unconfirmed",
  });
  const completedStartJob = await createStartJob({
    businessId: businessA.id,
    assignedMembershipId: memberMembership.id,
    customerId: customerA.id,
    status: "COMPLETED",
  });
  const blockedStartJob = await createStartJob({
    businessId: blockedBusiness.id,
    assignedMembershipId: blockedMembership.id,
    customerName: "Blocked Start Canary",
  });

  const unauthorizedStart = await startNativeAssignedJob(
    prisma,
    memberAccess.access,
    otherStartJob.id,
  );
  const unassignedStart = await startNativeAssignedJob(
    prisma,
    memberAccess.access,
    unassignedStartJob.id,
  );
  const crossTenantStart = await startNativeAssignedJob(
    prisma,
    memberAccess.access,
    betaStartJob.id,
  );
  check(
    "Assigned worker cannot start another member's job",
    unauthorizedStart.ok === false &&
      unauthorizedStart.status === 404 &&
      unauthorizedStart.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Assigned worker cannot start an unassigned job",
    unassignedStart.ok === false && unassignedStart.status === 404,
  );
  check(
    "Assigned worker cannot start a cross-tenant job",
    crossTenantStart.ok === false &&
      crossTenantStart.status === 404 &&
      crossTenantStart.error === NATIVE_JOB_NOT_AVAILABLE,
  );

  const stolenStart = await startNativeAssignedJob(
    prisma,
    otherAccess.access,
    startJob.id,
  );
  const startJobAfterSteal = await prisma.job.findFirst({
    where: { id: startJob.id, businessId: businessA.id },
    select: { status: true, assignedMembershipId: true },
  });
  const stolenStartTime = await prisma.timeEntry.count({
    where: { jobId: startJob.id, businessId: businessA.id },
  });
  check(
    "Other MEMBER cannot start a job assigned to someone else",
    stolenStart.ok === false &&
      stolenStart.status === 404 &&
      startJobAfterSteal?.status === "SCHEDULED" &&
      startJobAfterSteal?.assignedMembershipId === memberMembership.id &&
      stolenStartTime === 0,
  );

  const betaStealStart = await startNativeAssignedJob(
    prisma,
    betaAccess.access,
    startJob.id,
  );
  const alphaAfterBetaStartSteal = await prisma.job.findFirst({
    where: { id: startJob.id, businessId: businessA.id },
    select: { status: true },
  });
  const betaAfterAlphaStartAttempt = await prisma.job.findFirst({
    where: { id: betaStartJob.id, businessId: businessB.id },
    select: { status: true },
  });
  const betaStartTime = await prisma.timeEntry.count({
    where: { jobId: { in: [startJob.id, betaStartJob.id] } },
  });
  check(
    "Cross-tenant start leaves both jobs and time unchanged",
    betaStealStart.ok === false &&
      betaStealStart.status === 404 &&
      alphaAfterBetaStartSteal?.status === "SCHEDULED" &&
      betaAfterAlphaStartAttempt?.status === "SCHEDULED" &&
      betaStartTime === 0,
  );

  const completedStart = await startNativeAssignedJob(
    prisma,
    memberAccess.access,
    completedStartJob.id,
  );
  check(
    "Status safeguard refuses Start job on a completed job",
    completedStart.ok === false &&
      completedStart.status === 409 &&
      completedStart.error === "A completed job cannot be started.",
  );

  const unconfirmedStart = await startNativeAssignedJob(
    prisma,
    memberAccess.access,
    unconfirmedStartJob.id,
  );
  const unconfirmedAfter = await prisma.job.findFirst({
    where: { id: unconfirmedStartJob.id, businessId: businessA.id },
    select: { status: true },
  });
  check(
    "Unconfirmed appointment refuses Start job",
    unconfirmedStart.ok === false &&
      unconfirmedStart.status === 409 &&
      unconfirmedStart.error === CUSTOMER_HAS_NOT_CONFIRMED_APPOINTMENT &&
      unconfirmedAfter?.status === "SCHEDULED",
  );

  const blockedStart = await startNativeAssignedJob(
    prisma,
    blockedAccess.access,
    blockedStartJob.id,
  );
  const blockedStartAfter = await prisma.job.findFirst({
    where: { id: blockedStartJob.id, businessId: blockedBusiness.id },
    select: { status: true },
  });
  check(
    "Start job requires an operating SaaS entitlement",
    blockedStart.ok === false &&
      blockedStart.status === 403 &&
      blockedStart.error === SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE &&
      blockedStartAfter?.status === "SCHEDULED",
  );

  const raceStartEventsBefore = await prisma.businessEvent.count({
    where: {
      businessId: businessA.id,
      type: "JOB_STARTED",
      subjectId: raceStartJob.id,
    },
  });
  const raceStart = await startNativeAssignedJob(
    prisma,
    memberAccess.access,
    raceStartJob.id,
    {
      afterInitialRead: async () => {
        await prisma.job.update({
          where: { id: raceStartJob.id },
          data: { assignedMembershipId: otherMembership.id },
        });
      },
    },
  );
  const raceStartJobAfter = await prisma.job.findFirst({
    where: { id: raceStartJob.id, businessId: businessA.id },
    select: { status: true, assignedMembershipId: true },
  });
  const raceStartTimeAfter = await prisma.timeEntry.count({
    where: { jobId: raceStartJob.id, businessId: businessA.id },
  });
  const raceStartEventsAfter = await prisma.businessEvent.count({
    where: {
      businessId: businessA.id,
      type: "JOB_STARTED",
      subjectId: raceStartJob.id,
    },
  });
  check(
    "Assignment change after the initial read refuses Start job",
    raceStart.ok === false &&
      raceStart.status === 404 &&
      raceStart.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Reassigned Job after the initial read leaves Job, time, and start event unchanged",
    raceStartJobAfter?.status === "SCHEDULED" &&
      raceStartJobAfter?.assignedMembershipId === otherMembership.id &&
      raceStartTimeAfter === 0 &&
      raceStartEventsAfter === raceStartEventsBefore &&
      raceStartEventsAfter === 0,
  );

  const deactivateStartWorker = await createDeactivationWorker("ops-start");
  const deactivateStartJob = await createStartJob({
    businessId: businessA.id,
    assignedMembershipId: deactivateStartWorker.membership.id,
    customerName: "Deactivate Start Canary",
  });
  const deactivateStartEventsBefore = await prisma.businessEvent.count({
    where: {
      businessId: businessA.id,
      type: "JOB_STARTED",
      subjectId: deactivateStartJob.id,
    },
  });
  const deactivateStart = await startNativeAssignedJob(
    prisma,
    deactivateStartWorker.access,
    deactivateStartJob.id,
    {
      afterInitialRead: () => deactivateExactMembership(deactivateStartWorker.membership.id),
    },
  );
  const deactivateStartJobAfter = await prisma.job.findFirst({
    where: { id: deactivateStartJob.id, businessId: businessA.id },
    select: { status: true, assignedMembershipId: true },
  });
  const deactivateStartTimeAfter = await prisma.timeEntry.count({
    where: { jobId: deactivateStartJob.id, businessId: businessA.id },
  });
  const deactivateStartEventsAfter = await prisma.businessEvent.count({
    where: {
      businessId: businessA.id,
      type: "JOB_STARTED",
      subjectId: deactivateStartJob.id,
    },
  });
  check(
    "Deactivated membership after the initial read refuses Start job",
    deactivateStart.ok === false &&
      deactivateStart.status === 404 &&
      deactivateStart.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Deactivated Start job leaves Job, time, and start event unchanged",
    deactivateStartJobAfter?.status === "SCHEDULED" &&
      deactivateStartJobAfter?.assignedMembershipId === deactivateStartWorker.membership.id &&
      deactivateStartTimeAfter === 0 &&
      deactivateStartEventsAfter === deactivateStartEventsBefore &&
      deactivateStartEventsAfter === 0,
  );

  const rollbackStart = await startNativeAssignedJob(
    prisma,
    memberAccess.access,
    rollbackStartJob.id,
  );
  const rollbackStartJobAfter = await prisma.job.findFirst({
    where: { id: rollbackStartJob.id, businessId: businessA.id },
    select: { status: true },
  });
  const rollbackStartTimeAfter = await prisma.timeEntry.count({
    where: { jobId: rollbackStartJob.id, businessId: businessA.id },
  });
  check(
    "Approved timesheet week refuses Start job clock-in",
    rollbackStart.ok === false &&
      rollbackStart.status === 409 &&
      /approved/i.test(rollbackStart.error ?? ""),
  );
  check(
    "Failed Start job rolls back Job status and creates no time",
    rollbackStartJobAfter?.status === "SCHEDULED" && rollbackStartTimeAfter === 0,
  );

  await prisma.timesheetWeek.deleteMany({
    where: {
      businessId: businessA.id,
      membershipId: memberMembership.id,
      status: "APPROVED",
    },
  });

  const firstStart = await startNativeAssignedJob(
    prisma,
    memberAccess.access,
    startJob.id,
  );
  const reloadedStart = await loadNativeAssignedJob(prisma, memberAccess.access, startJob.id);
  const startJobPersisted = await prisma.job.findFirst({
    where: { id: startJob.id, businessId: businessA.id },
    select: { status: true },
  });
  const startTimePersisted = await prisma.timeEntry.findFirst({
    where: {
      jobId: startJob.id,
      businessId: businessA.id,
      membershipId: memberMembership.id,
      activityType: "JOB",
      status: "RUNNING",
      endedAt: null,
    },
    select: { id: true, startedAt: true },
  });
  check(
    "Assigned worker can start their own confirmed job",
    firstStart.ok === true &&
      firstStart.alreadyStarted === false &&
      firstStart.alreadyRunningTime === false &&
      firstStart.job.status === "IN_PROGRESS" &&
      firstStart.job.startAction.available === false &&
      firstStart.job.completeAction.available === true &&
      firstStart.job.runningTime.running === true &&
      firstStart.job.runningTime.activityType === "JOB" &&
      startJobPersisted?.status === "IN_PROGRESS" &&
      Boolean(startTimePersisted),
  );
  check(
    "Reload after Start job shows IN_PROGRESS and running time",
    reloadedStart?.status === "IN_PROGRESS" &&
      reloadedStart?.runningTime.running === true &&
      reloadedStart?.runningTime.activityType === "JOB" &&
      reloadedStart?.runningTime.startedAt === startTimePersisted?.startedAt.toISOString() &&
      reloadedStart?.completeAction.available === true &&
      reloadedStart?.startAction.available === false,
  );

  const repeatStart = await startNativeAssignedJob(
    prisma,
    memberAccess.access,
    startJob.id,
  );
  const repeatStartTimeCount = await prisma.timeEntry.count({
    where: {
      jobId: startJob.id,
      businessId: businessA.id,
      activityType: "JOB",
    },
  });
  check(
    "Duplicate Start job on an already-started job is a successful no-op",
    repeatStart.ok === true &&
      repeatStart.alreadyStarted === true &&
      repeatStart.alreadyRunningTime === true &&
      repeatStart.job.status === "IN_PROGRESS" &&
      repeatStart.job.runningTime.running === true &&
      repeatStartTimeCount === 1,
  );

  const [startDupA, startDupB] = await Promise.all([
    startNativeAssignedJob(prisma, memberAccess.access, duplicateStartJob.id),
    startNativeAssignedJob(prisma, memberAccess.access, duplicateStartJob.id),
  ]);
  const duplicateStartAfter = await prisma.job.findFirst({
    where: { id: duplicateStartJob.id, businessId: businessA.id },
    select: { status: true },
  });
  const duplicateStartTimeCount = await prisma.timeEntry.count({
    where: {
      jobId: duplicateStartJob.id,
      businessId: businessA.id,
      activityType: "JOB",
      status: "RUNNING",
    },
  });
  check(
    "Concurrent Start job requests both succeed and leave one IN_PROGRESS job with one running time",
    startDupA.ok === true &&
      startDupB.ok === true &&
      [startDupA.alreadyStarted, startDupB.alreadyStarted].filter(Boolean).length <= 1 &&
      duplicateStartAfter?.status === "IN_PROGRESS" &&
      duplicateStartTimeCount === 1,
  );

  const otherStartAfterWrites = await prisma.job.findFirst({
    where: { id: otherStartJob.id, businessId: businessA.id },
    select: { status: true },
  });
  const betaStartAfterWrites = await prisma.job.findFirst({
    where: { id: betaStartJob.id, businessId: businessB.id },
    select: { status: true },
  });
  check(
    "Start job writes stay on the assigned job",
    otherStartAfterWrites?.status === "SCHEDULED" &&
      betaStartAfterWrites?.status === "SCHEDULED",
  );

  console.log("\nSTOP TIME — assigned-worker write, isolation, races, duplicates, rollback");
  async function createStopJob(input) {
    const customer =
      input.customerId
        ? { id: input.customerId }
        : await prisma.customer.create({
            data: {
              businessId: input.businessId,
              name: input.customerName,
              phone: "555-0103",
            },
          });
    return prisma.job.create({
      data: {
        businessId: input.businessId,
        customerId: customer.id,
        assignedMembershipId: input.assignedMembershipId,
        projectToken: randomUUID(),
        status: input.status ?? "IN_PROGRESS",
        scheduledAt: new Date(),
      },
    });
  }

  async function createRunningJobTime(input) {
    return prisma.timeEntry.create({
      data: {
        businessId: input.businessId,
        membershipId: input.membershipId,
        jobId: input.jobId,
        activityType: input.activityType ?? "JOB",
        status: "RUNNING",
        startedAt: input.startedAt ?? new Date(Date.now() - 90_000),
        source: "CLOCK",
      },
    });
  }

  const stopJob = await createStopJob({
    businessId: businessA.id,
    assignedMembershipId: memberMembership.id,
    customerId: customerA.id,
  });
  const stopStartedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const stopTime = await createRunningJobTime({
    businessId: businessA.id,
    membershipId: memberMembership.id,
    jobId: stopJob.id,
    startedAt: stopStartedAt,
  });
  const otherStopJob = await createStopJob({
    businessId: businessA.id,
    assignedMembershipId: otherMembership.id,
    customerName: "Other Stop Canary",
  });
  const otherStopTime = await createRunningJobTime({
    businessId: businessA.id,
    membershipId: otherMembership.id,
    jobId: otherStopJob.id,
  });
  const betaStopJob = await createStopJob({
    businessId: businessB.id,
    assignedMembershipId: betaMembership.id,
    customerName: "Beta Stop Canary",
  });
  const betaStopTime = await createRunningJobTime({
    businessId: businessB.id,
    membershipId: betaMembership.id,
    jobId: betaStopJob.id,
  });
  const leftoverStopJob = await createStopJob({
    businessId: businessA.id,
    assignedMembershipId: memberMembership.id,
    customerId: customerA.id,
  });
  const leftoverOtherTime = await createRunningJobTime({
    businessId: businessA.id,
    membershipId: otherMembership.id,
    jobId: leftoverStopJob.id,
  });
  const travelStopJob = await createStopJob({
    businessId: businessA.id,
    assignedMembershipId: memberMembership.id,
    customerId: customerA.id,
  });
  const travelStopTime = await createRunningJobTime({
    businessId: businessA.id,
    membershipId: memberMembership.id,
    jobId: travelStopJob.id,
    activityType: "TRAVEL",
  });
  const raceStopJob = await createStopJob({
    businessId: businessA.id,
    assignedMembershipId: memberMembership.id,
    customerId: customerA.id,
  });
  const raceStopTime = await createRunningJobTime({
    businessId: businessA.id,
    membershipId: memberMembership.id,
    jobId: raceStopJob.id,
  });
  const rollbackStopJob = await createStopJob({
    businessId: businessA.id,
    assignedMembershipId: memberMembership.id,
    customerId: customerA.id,
  });
  const rollbackStopStartedAt = new Date(Date.now() - 60_000);
  const rollbackStopTime = await createRunningJobTime({
    businessId: businessA.id,
    membershipId: memberMembership.id,
    jobId: rollbackStopJob.id,
    startedAt: rollbackStopStartedAt,
  });
  const duplicateStopJob = await createStopJob({
    businessId: businessA.id,
    assignedMembershipId: memberMembership.id,
    customerId: customerA.id,
  });
  await createRunningJobTime({
    businessId: businessA.id,
    membershipId: memberMembership.id,
    jobId: duplicateStopJob.id,
  });
  const idleStopJob = await createStopJob({
    businessId: businessA.id,
    assignedMembershipId: memberMembership.id,
    customerId: customerA.id,
  });
  const blockedStopJob = await createStopJob({
    businessId: blockedBusiness.id,
    assignedMembershipId: blockedMembership.id,
    customerName: "Blocked Stop Canary",
  });
  await createRunningJobTime({
    businessId: blockedBusiness.id,
    membershipId: blockedMembership.id,
    jobId: blockedStopJob.id,
  });

  const unauthorizedStop = await stopNativeAssignedJobRunningTime(
    prisma,
    memberAccess.access,
    otherStopJob.id,
  );
  const unassignedStop = await stopNativeAssignedJobRunningTime(
    prisma,
    memberAccess.access,
    unassignedJob.id,
  );
  const crossTenantStop = await stopNativeAssignedJobRunningTime(
    prisma,
    memberAccess.access,
    betaStopJob.id,
  );
  check(
    "Assigned worker cannot stop time on another member's job",
    unauthorizedStop.ok === false &&
      unauthorizedStop.status === 404 &&
      unauthorizedStop.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Assigned worker cannot stop time on an unassigned job",
    unassignedStop.ok === false && unassignedStop.status === 404,
  );
  check(
    "Assigned worker cannot stop time on a cross-tenant job",
    crossTenantStop.ok === false &&
      crossTenantStop.status === 404 &&
      crossTenantStop.error === NATIVE_JOB_NOT_AVAILABLE,
  );

  const stolenStop = await stopNativeAssignedJobRunningTime(
    prisma,
    otherAccess.access,
    stopJob.id,
  );
  const stopJobAfterSteal = await prisma.job.findFirst({
    where: { id: stopJob.id, businessId: businessA.id },
    select: { status: true, assignedMembershipId: true },
  });
  const stolenStopTime = await prisma.timeEntry.findFirst({
    where: { id: stopTime.id, businessId: businessA.id },
    select: { status: true, endedAt: true },
  });
  check(
    "Other MEMBER cannot stop time on a job assigned to someone else",
    stolenStop.ok === false &&
      stolenStop.status === 404 &&
      stopJobAfterSteal?.status === "IN_PROGRESS" &&
      stopJobAfterSteal?.assignedMembershipId === memberMembership.id &&
      stolenStopTime?.status === "RUNNING" &&
      stolenStopTime?.endedAt === null,
  );

  const betaStealStop = await stopNativeAssignedJobRunningTime(
    prisma,
    betaAccess.access,
    stopJob.id,
  );
  const alphaAfterBetaStopSteal = await prisma.job.findFirst({
    where: { id: stopJob.id, businessId: businessA.id },
    select: { status: true },
  });
  const betaAfterAlphaStopAttempt = await prisma.timeEntry.findFirst({
    where: { id: betaStopTime.id, businessId: businessB.id },
    select: { status: true, endedAt: true },
  });
  check(
    "Cross-tenant stop leaves both jobs and time unchanged",
    betaStealStop.ok === false &&
      betaStealStop.status === 404 &&
      alphaAfterBetaStopSteal?.status === "IN_PROGRESS" &&
      betaAfterAlphaStopAttempt?.status === "RUNNING" &&
      betaAfterAlphaStopAttempt?.endedAt === null,
  );

  const leftoverStop = await stopNativeAssignedJobRunningTime(
    prisma,
    memberAccess.access,
    leftoverStopJob.id,
  );
  const leftoverAfter = await prisma.timeEntry.findFirst({
    where: { id: leftoverOtherTime.id, businessId: businessA.id },
    select: { status: true, endedAt: true, membershipId: true },
  });
  const leftoverJobAfter = await prisma.job.findFirst({
    where: { id: leftoverStopJob.id, businessId: businessA.id },
    select: { status: true },
  });
  check(
    "Stop job time does not close another worker's leftover RUNNING JOB time",
    leftoverStop.ok === true &&
      leftoverStop.alreadyStopped === true &&
      leftoverJobAfter?.status === "IN_PROGRESS" &&
      leftoverAfter?.status === "RUNNING" &&
      leftoverAfter?.endedAt === null &&
      leftoverAfter?.membershipId === otherMembership.id,
  );

  const travelStop = await stopNativeAssignedJobRunningTime(
    prisma,
    memberAccess.access,
    travelStopJob.id,
  );
  const travelAfter = await prisma.timeEntry.findFirst({
    where: { id: travelStopTime.id, businessId: businessA.id },
    select: { status: true, endedAt: true, activityType: true },
  });
  const travelJobAfter = await prisma.job.findFirst({
    where: { id: travelStopJob.id, businessId: businessA.id },
    select: { status: true },
  });
  check(
    "Stop job time leaves TRAVEL running and does not complete the Job",
    travelStop.ok === true &&
      travelStop.alreadyStopped === true &&
      travelJobAfter?.status === "IN_PROGRESS" &&
      travelAfter?.activityType === "TRAVEL" &&
      travelAfter?.status === "RUNNING" &&
      travelAfter?.endedAt === null,
  );

  const blockedStop = await stopNativeAssignedJobRunningTime(
    prisma,
    blockedAccess.access,
    blockedStopJob.id,
  );
  const blockedStopAfter = await prisma.job.findFirst({
    where: { id: blockedStopJob.id, businessId: blockedBusiness.id },
    select: { status: true },
  });
  check(
    "Stop job time requires an operating SaaS entitlement",
    blockedStop.ok === false &&
      blockedStop.status === 403 &&
      blockedStop.error === SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE &&
      blockedStopAfter?.status === "IN_PROGRESS",
  );

  const raceStopEventsBefore = await prisma.businessEvent.count({
    where: {
      businessId: businessA.id,
      type: { in: ["JOB_STARTED", "JOB_COMPLETED"] },
      subjectId: raceStopJob.id,
    },
  });
  const raceStop = await stopNativeAssignedJobRunningTime(
    prisma,
    memberAccess.access,
    raceStopJob.id,
    {
      afterInitialRead: async () => {
        await prisma.job.update({
          where: { id: raceStopJob.id },
          data: { assignedMembershipId: otherMembership.id },
        });
      },
    },
  );
  const raceStopJobAfter = await prisma.job.findFirst({
    where: { id: raceStopJob.id, businessId: businessA.id },
    select: { status: true, assignedMembershipId: true },
  });
  const raceStopTimeAfter = await prisma.timeEntry.findFirst({
    where: { id: raceStopTime.id, businessId: businessA.id },
    select: { status: true, endedAt: true, membershipId: true },
  });
  const raceStopEventsAfter = await prisma.businessEvent.count({
    where: {
      businessId: businessA.id,
      type: { in: ["JOB_STARTED", "JOB_COMPLETED"] },
      subjectId: raceStopJob.id,
    },
  });
  check(
    "Assignment change after the initial read refuses Stop job time",
    raceStop.ok === false &&
      raceStop.status === 404 &&
      raceStop.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Reassigned Job after the initial read leaves Job, running time, and events unchanged",
    raceStopJobAfter?.status === "IN_PROGRESS" &&
      raceStopJobAfter?.assignedMembershipId === otherMembership.id &&
      raceStopTimeAfter?.status === "RUNNING" &&
      raceStopTimeAfter?.endedAt === null &&
      raceStopTimeAfter?.membershipId === memberMembership.id &&
      raceStopEventsAfter === raceStopEventsBefore &&
      raceStopEventsAfter === 0,
  );

  const deactivateStopWorker = await createDeactivationWorker("ops-stop");
  const deactivateStopJob = await createStopJob({
    businessId: businessA.id,
    assignedMembershipId: deactivateStopWorker.membership.id,
    customerName: "Deactivate Stop Canary",
  });
  const deactivateStopTime = await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: deactivateStopWorker.membership.id,
      jobId: deactivateStopJob.id,
      activityType: "JOB",
      status: "RUNNING",
      startedAt: new Date(Date.now() - 90_000),
      source: "CLOCK",
    },
  });
  const deactivateStopEventsBefore = await prisma.businessEvent.count({
    where: {
      businessId: businessA.id,
      type: { in: ["JOB_STARTED", "JOB_COMPLETED"] },
      subjectId: deactivateStopJob.id,
    },
  });
  const deactivateStop = await stopNativeAssignedJobRunningTime(
    prisma,
    deactivateStopWorker.access,
    deactivateStopJob.id,
    {
      afterInitialRead: () => deactivateExactMembership(deactivateStopWorker.membership.id),
    },
  );
  const deactivateStopJobAfter = await prisma.job.findFirst({
    where: { id: deactivateStopJob.id, businessId: businessA.id },
    select: { status: true, assignedMembershipId: true },
  });
  const deactivateStopTimeAfter = await prisma.timeEntry.findFirst({
    where: { id: deactivateStopTime.id, businessId: businessA.id },
    select: { status: true, endedAt: true, membershipId: true },
  });
  const deactivateStopEventsAfter = await prisma.businessEvent.count({
    where: {
      businessId: businessA.id,
      type: { in: ["JOB_STARTED", "JOB_COMPLETED"] },
      subjectId: deactivateStopJob.id,
    },
  });
  check(
    "Deactivated membership after the initial read refuses Stop job time",
    deactivateStop.ok === false &&
      deactivateStop.status === 404 &&
      deactivateStop.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Deactivated Stop job time leaves Job, running time, and events unchanged",
    deactivateStopJobAfter?.status === "IN_PROGRESS" &&
      deactivateStopJobAfter?.assignedMembershipId === deactivateStopWorker.membership.id &&
      deactivateStopTimeAfter?.status === "RUNNING" &&
      deactivateStopTimeAfter?.endedAt === null &&
      deactivateStopTimeAfter?.membershipId === deactivateStopWorker.membership.id &&
      deactivateStopEventsAfter === deactivateStopEventsBefore &&
      deactivateStopEventsAfter === 0,
  );

  await prisma.timesheetWeek.create({
    data: {
      businessId: businessA.id,
      membershipId: memberMembership.id,
      weekStartedAt: weekRange(rollbackStopStartedAt).start,
      status: "APPROVED",
      approvedAt: new Date(),
      approvedByMembershipId: ownerMembership.id,
    },
  });
  const rollbackStop = await stopNativeAssignedJobRunningTime(
    prisma,
    memberAccess.access,
    rollbackStopJob.id,
  );
  const rollbackStopJobAfter = await prisma.job.findFirst({
    where: { id: rollbackStopJob.id, businessId: businessA.id },
    select: { status: true },
  });
  const rollbackStopTimeAfter = await prisma.timeEntry.findFirst({
    where: { id: rollbackStopTime.id, businessId: businessA.id },
    select: { status: true, endedAt: true },
  });
  check(
    "Approved timesheet week refuses Stop job time",
    rollbackStop.ok === false &&
      rollbackStop.status === 409 &&
      /approved/i.test(rollbackStop.error ?? ""),
  );
  check(
    "Failed Stop job time rolls back Job status and leaves time running",
    rollbackStopJobAfter?.status === "IN_PROGRESS" &&
      rollbackStopTimeAfter?.status === "RUNNING" &&
      rollbackStopTimeAfter?.endedAt === null,
  );

  await prisma.timesheetWeek.deleteMany({
    where: {
      businessId: businessA.id,
      membershipId: memberMembership.id,
      status: "APPROVED",
    },
  });

  const stopEventsBefore = await prisma.businessEvent.count({
    where: {
      businessId: businessA.id,
      type: { in: ["JOB_STARTED", "JOB_COMPLETED"] },
      subjectId: stopJob.id,
    },
  });
  const firstStop = await stopNativeAssignedJobRunningTime(
    prisma,
    memberAccess.access,
    stopJob.id,
  );
  const reloadedStop = await loadNativeAssignedJob(prisma, memberAccess.access, stopJob.id);
  const stopJobPersisted = await prisma.job.findFirst({
    where: { id: stopJob.id, businessId: businessA.id },
    select: { status: true },
  });
  const stopTimePersisted = await prisma.timeEntry.findFirst({
    where: { id: stopTime.id, businessId: businessA.id },
    select: { status: true, endedAt: true, startedAt: true, activityType: true },
  });
  const stopAdjustment = await prisma.timeEntryAdjustment.findFirst({
    where: { timeEntryId: stopTime.id, reason: JOB_STOP_TIME_CLOSED_REASON },
    select: { action: true },
  });
  const stopEventsAfter = await prisma.businessEvent.count({
    where: {
      businessId: businessA.id,
      type: { in: ["JOB_STARTED", "JOB_COMPLETED"] },
      subjectId: stopJob.id,
    },
  });
  check(
    "Assigned worker can stop their own RUNNING JOB time without completing the Job",
    firstStop.ok === true &&
      firstStop.alreadyStopped === false &&
      firstStop.job.status === "IN_PROGRESS" &&
      firstStop.job.completeAction.available === true &&
      firstStop.job.stopTimeAction.available === false &&
      firstStop.job.runningTime.running === false &&
      firstStop.job.runningTime.recorded === true &&
      firstStop.job.runningTime.activityType === "JOB" &&
      firstStop.job.runningTime.hours != null &&
      firstStop.job.runningTime.hours > 0 &&
      firstStop.job.runningTime.hoursLabel != null &&
      firstStop.job.runningTime.endedAt != null &&
      stopJobPersisted?.status === "IN_PROGRESS" &&
      stopTimePersisted?.status === "READY" &&
      stopTimePersisted?.activityType === "JOB" &&
      stopTimePersisted?.endedAt != null &&
      stopTimePersisted?.startedAt.getTime() === stopStartedAt.getTime() &&
      stopAdjustment?.action === "UPDATE" &&
      stopEventsAfter === stopEventsBefore,
  );
  check(
    "Reload after Stop job time shows IN_PROGRESS and recorded time",
    reloadedStop?.status === "IN_PROGRESS" &&
      reloadedStop?.runningTime.running === false &&
      reloadedStop?.runningTime.recorded === true &&
      reloadedStop?.runningTime.activityType === "JOB" &&
      reloadedStop?.runningTime.endedAt === stopTimePersisted?.endedAt?.toISOString() &&
      reloadedStop?.runningTime.startedAt === stopTimePersisted?.startedAt.toISOString() &&
      reloadedStop?.completeAction.available === true &&
      reloadedStop?.stopTimeAction.available === false,
  );

  const repeatStop = await stopNativeAssignedJobRunningTime(
    prisma,
    memberAccess.access,
    stopJob.id,
  );
  const repeatStopTimeCount = await prisma.timeEntry.count({
    where: {
      jobId: stopJob.id,
      businessId: businessA.id,
      activityType: "JOB",
    },
  });
  const repeatStopReady = await prisma.timeEntry.findFirst({
    where: { id: stopTime.id, businessId: businessA.id },
    select: { endedAt: true, status: true },
  });
  const repeatStopAdjustments = await prisma.timeEntryAdjustment.count({
    where: { timeEntryId: stopTime.id, reason: JOB_STOP_TIME_CLOSED_REASON },
  });
  check(
    "Duplicate Stop job time on already-stopped time is a successful no-op",
    repeatStop.ok === true &&
      repeatStop.alreadyStopped === true &&
      repeatStop.job.status === "IN_PROGRESS" &&
      repeatStop.job.runningTime.running === false &&
      repeatStop.job.runningTime.recorded === true &&
      repeatStopTimeCount === 1 &&
      repeatStopReady?.status === "READY" &&
      repeatStopReady?.endedAt?.getTime() === stopTimePersisted?.endedAt?.getTime() &&
      repeatStopAdjustments === 1,
  );

  const idleStop = await stopNativeAssignedJobRunningTime(
    prisma,
    memberAccess.access,
    idleStopJob.id,
  );
  const idleStopJobAfter = await prisma.job.findFirst({
    where: { id: idleStopJob.id, businessId: businessA.id },
    select: { status: true },
  });
  check(
    "Stop job time with no running JOB entry is a successful no-op",
    idleStop.ok === true &&
      idleStop.alreadyStopped === true &&
      idleStop.job.status === "IN_PROGRESS" &&
      idleStopJobAfter?.status === "IN_PROGRESS",
  );

  const [stopDupA, stopDupB] = await Promise.all([
    stopNativeAssignedJobRunningTime(prisma, memberAccess.access, duplicateStopJob.id),
    stopNativeAssignedJobRunningTime(prisma, memberAccess.access, duplicateStopJob.id),
  ]);
  const duplicateStopAfter = await prisma.job.findFirst({
    where: { id: duplicateStopJob.id, businessId: businessA.id },
    select: { status: true },
  });
  const duplicateStopTimeRows = await prisma.timeEntry.findMany({
    where: {
      jobId: duplicateStopJob.id,
      businessId: businessA.id,
      activityType: "JOB",
    },
    select: { status: true, endedAt: true },
  });
  check(
    "Concurrent Stop job time requests both succeed and leave one READY JOB entry",
    stopDupA.ok === true &&
      stopDupB.ok === true &&
      [stopDupA.alreadyStopped, stopDupB.alreadyStopped].filter(Boolean).length <= 1 &&
      duplicateStopAfter?.status === "IN_PROGRESS" &&
      duplicateStopTimeRows.length === 1 &&
      duplicateStopTimeRows[0]?.status === "READY" &&
      duplicateStopTimeRows[0]?.endedAt != null,
  );

  const otherStopAfterWrites = await prisma.timeEntry.findFirst({
    where: { id: otherStopTime.id, businessId: businessA.id },
    select: { status: true, endedAt: true },
  });
  const betaStopAfterWrites = await prisma.timeEntry.findFirst({
    where: { id: betaStopTime.id, businessId: businessB.id },
    select: { status: true, endedAt: true },
  });
  const otherStopJobAfterWrites = await prisma.job.findFirst({
    where: { id: otherStopJob.id, businessId: businessA.id },
    select: { status: true },
  });
  const betaStopJobAfterWrites = await prisma.job.findFirst({
    where: { id: betaStopJob.id, businessId: businessB.id },
    select: { status: true },
  });
  check(
    "Stop job time writes stay on the assigned job and never complete other jobs",
    otherStopAfterWrites?.status === "RUNNING" &&
      otherStopAfterWrites?.endedAt === null &&
      betaStopAfterWrites?.status === "RUNNING" &&
      betaStopAfterWrites?.endedAt === null &&
      otherStopJobAfterWrites?.status === "IN_PROGRESS" &&
      betaStopJobAfterWrites?.status === "IN_PROGRESS",
  );

  const revoked = await revokeNativeSession(prisma, memberSignIn.token);
  const afterRevoke = await resolveNativeFieldAccess(prisma, { token: memberSignIn.token });
  check("Sign-out revokes the hashed session", revoked === true);
  check("Revoked token cannot read Today", afterRevoke.ok === false && afterRevoke.status === 401);

  const grouped = buildNativeTodayPayload(
    [
      {
        id: assignedJob.id,
        status: "SCHEDULED",
        scheduledAt: new Date("2026-08-15T15:00:00.000Z"),
        scheduledDurationMinutes: 60,
        customer: { name: "Cara Canary Native Q9x" },
        property: {
          addressLine1: "42 Canary Way",
          addressLine2: null,
          city: "Springfield",
          region: "IL",
          postalCode: "62704",
        },
      },
    ],
    {
      access: memberAccess.access,
      now: new Date("2026-08-15T16:00:00.000Z"),
      timeZone: "UTC",
    },
  );
  check("Frozen Today grouping places the assigned job in Today", grouped.today.some((job) => job.id === assignedJob.id));
  check("Frozen Today grouping is not truncated when under the cap", grouped.truncated === false && grouped.truncatedNotice === null);

  if (failures > 0) {
    throw new Error(`Native field check failed (${failures} case(s)).`);
  }
  console.log(
    "\nNative field API check passed: Bearer session, assigned-job isolation, Start job, Stop job time, and Complete job safeguards held.",
  );
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}
