/**
 * Native field API — session boundary + assigned-job / Today isolation
 * + the one assigned-worker Complete job write.
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
  nativeTodayTruncatedNotice,
} = await import("@/lib/native-field");
const {
  completeNativeAssignedJob,
  NATIVE_JOB_NOT_AVAILABLE,
} = await import("@/lib/native-field-ops");
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
const completeOpsSrc = readRepo("src/lib/native-field-ops.ts");
const limitsSrc = readRepo("src/lib/native-session-limits.ts");
check(
  "Native routes authenticate with Bearer helpers, not cookies()",
  sessionRouteSrc.includes("readBearerToken") &&
    todayRouteSrc.includes("readBearerToken") &&
    jobRouteSrc.includes("readBearerToken") &&
    completeRouteSrc.includes("readBearerToken") &&
    !sessionRouteSrc.includes("cookies(") &&
    !todayRouteSrc.includes("cookies(") &&
    !jobRouteSrc.includes("cookies(") &&
    !completeRouteSrc.includes("cookies(") &&
    !completeOpsSrc.includes("cookies("),
);
check(
  "Complete job reuses assigned-job scope and the canonical time-safe write",
  completeOpsSrc.includes("nativeAssignedJobWhere") &&
    completeOpsSrc.includes("completeJobWithRunningTimeSafety") &&
    completeOpsSrc.includes("requireSaasOperatingEntitlement") &&
    completeRouteSrc.includes("completeNativeAssignedJob") &&
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
    nativeAppSrc.includes("Complete job") &&
    nativeAppSrc.includes("truncatedNotice") &&
    nativeAppSrc.includes("payload.truncated"),
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
    "\nNative field API check passed: Bearer session, assigned-job isolation, and Complete job safeguards held.",
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
