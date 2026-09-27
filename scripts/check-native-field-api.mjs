/**
 * Native field API — session boundary + assigned-job / Today isolation.
 *
 * Imports the REAL production helpers from src/lib/native-session.ts and
 * src/lib/native-field.ts. Those modules take a Prisma client and do not
 * use next/headers cookies, so they can run in this script.
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
const { isNativeFieldApiPath, NATIVE_FIELD_API_PREFIX } = await import(
  "@/lib/native-field-api-path"
);
const {
  buildNativeTodayPayload,
  loadNativeAssignedJob,
  loadNativeToday,
  nativeAssignedJobWhere,
} = await import("@/lib/native-field");
const {
  readBearerToken,
  resolveNativeFieldAccess,
  revokeNativeSession,
  signInNativeField,
} = await import("@/lib/native-session");

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
check(
  "Native routes authenticate with Bearer helpers, not cookies()",
  sessionRouteSrc.includes("readBearerToken") &&
    todayRouteSrc.includes("readBearerToken") &&
    jobRouteSrc.includes("readBearerToken") &&
    !sessionRouteSrc.includes("cookies(") &&
    !todayRouteSrc.includes("cookies(") &&
    !jobRouteSrc.includes("cookies("),
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
    nativeAppSrc.includes("/api/native/v1/today"),
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
  const totpUser = await prisma.user.create({
    data: {
      name: "Tess Totp",
      email: "totp@native-field.example",
      passwordHash,
      totpSecret: "JBSWY3DPEHPK3PXP",
      totpEnabledAt: new Date(),
    },
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

  console.log("\nTODAY — assigned-job isolation, no owner records");
  const today = await loadNativeToday(prisma, memberAccess.access);
  const todayJson = jsonBlob(today);
  const todayIds = [...today.today, ...today.upcoming, ...today.completed].map((job) => job.id);
  check("Today includes the MEMBER's assigned job", todayIds.includes(assignedJob.id));
  check("Today hides the other MEMBER's job", !todayIds.includes(otherJob.id));
  check("Today hides the unassigned job", !todayIds.includes(unassignedJob.id));
  check("Today hides the other business's job", !todayIds.includes(betaJob.id));
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

  if (failures > 0) {
    throw new Error(`Native field check failed (${failures} case(s)).`);
  }
  console.log("\nNative field API check passed: Bearer session + assigned-job isolation held.");
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}
