/**
 * Opt-in native Handyman job alerts — fake provider proofs.
 *
 * Dedicated local disposable database (name prefix tbbt_native_push_alerts).
 *
 * Proves device register/revoke per active membership, OWNER assignment
 * and material-reschedule alerts, reassignment, deactivation revoke,
 * tenant isolation, provider retries, and duplicate suppression. Payloads
 * stay informational and never include a customer address or access code.
 * No real Expo/FCM/APNs send.
 *
 * Run with:
 *   npm run test:native-push-alerts
 */
import { register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  assertLocalDatabaseUrl,
  openDisposableTestDatabase,
} from "./disposable-test-database.mjs";

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for native-push-alerts checks.");
  process.exit(generateEarly.status ?? 1);
}

register(new URL("./estimate-options-test-loader.mjs", import.meta.url), import.meta.url);

process.env.TZ = process.env.TZ || "America/New_York";
process.env.TBBT_CUSTOMER_MESSAGING_ADAPTER =
  process.env.TBBT_CUSTOMER_MESSAGING_ADAPTER || "fake";
process.env.TBBT_NATIVE_PUSH_TEST_FLUSH = "1";

const { writeAssignedMembershipAndLaneWindows } = await import("@/lib/job-assignment-ops");
const { writeTeamMemberActive } = await import("@/lib/team-member-active-ops");
const {
  FAKE_NATIVE_PUSH_PROVIDER,
  NATIVE_PUSH_ALERT_DISCLAIMER,
  NATIVE_PUSH_DEVICE_NOT_OWNED,
  NATIVE_PUSH_FORBIDDEN_PAYLOAD_KEYS,
  NATIVE_PUSH_DEVICE_TOKEN_HEADER,
  NATIVE_PUSH_MAX_ATTEMPTS,
  NATIVE_PUSH_MEMBERSHIP_INACTIVE,
  NATIVE_PUSH_PENDING_STALE_MS,
  NATIVE_PUSH_SEND_TIMEOUT_MS,
  assignmentAlertIdempotencyKey,
  buildNativePushAlertPayload,
  createFakeNativePushProvider,
  flushNativePushNotifies,
  hashNativePushDeviceToken,
  isFakeNativePushAdapterEnabled,
  isHandymanJobForNativePush,
  listNativePushPreference,
  nativePushAlertAction,
  nativePushPayloadHasForbiddenFields,
  notifyHandymanJobAssigned,
  notifyHandymanJobRescheduled,
  registerNativePushDevice,
  rescheduleAlertIdempotencyKey,
  resetNativePushSchemaEnsure,
  retryNativePushDelivery,
  revokeNativePushDevice,
  setNativePushPendingStaleMs,
  setNativePushProvider,
} = await import("@/lib/native-push");
const { isMaterialAppointmentChange } = await import("@/lib/appointment-confirmation");
const { hashToken } = await import("@/lib/auth-crypto");
const { resolveNativeSession, revokeNativeSession } = await import("@/lib/native-session");
const { revokeOtherSessionsOp, revokeSessionOp } = await import("@/lib/account-security");

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

function fieldAccess({ userId, businessId, membershipId, role, name, email, sessionId }) {
  return {
    userId,
    sessionId: sessionId ?? "native-push-session",
    viewer: { id: userId, name, email, role },
    workspace: { businessId, businessName: "Alpha", membershipId, role },
    businessId,
    membershipId,
  };
}

const schema = readRepo("prisma/schema.prisma");
const migration = readRepo("prisma/migrations/20261002192000_native_push_alerts/migration.sql");
const routeSrc = readRepo("src/app/api/native/v1/push-devices/route.ts");
const accountSecuritySrc = readRepo("src/lib/account-security.ts");
const configSrc = readRepo("src/lib/native-push/config.ts");
const payloadSrc = readRepo("src/lib/native-push/payload.ts");
const notifySrc = readRepo("src/lib/native-push/notify.ts");
const schemaSrc = readRepo("src/lib/native-push/schema.ts");
const devicesSrc = readRepo("src/lib/native-push/devices.ts");
const assignSrc = readRepo("src/lib/job-assignment-ops.ts");
const deactivateSrc = readRepo("src/lib/team-member-active-ops.ts");
const scheduleSrc = readRepo("src/app/actions/job.ts");
const dayRouteSrc = readRepo("src/lib/owner-day-route-appointment-ops.ts");
const sessionSrc = readRepo("src/lib/native-session.ts");
const nativeApi = readRepo("apps/native/src/api.ts");
const todaySrc = readRepo("apps/native/src/screens/TodayScreen.tsx");
const appSrc = readRepo("apps/native/App.tsx");
const settingsSrc = readRepo("src/components/settings/settings-workspace.tsx");
const nativePkg = readRepo("apps/native/package.json");
const envExample = readRepo(".env.example");
const checkSrc = readRepo("scripts/check-native-push-alerts.mjs");

console.log("\nSTATIC — informational alerts, no real push, reserved migration");

check(
  "Reserved additive migration 20261002192000 does not alter Job",
  migration.includes("20261002192000") &&
    migration.includes('CREATE TABLE IF NOT EXISTS "NativePushDevice"') &&
    migration.includes('CREATE TABLE IF NOT EXISTS "NativePushDelivery"') &&
    migration.includes("Reserved unique timestamp 20261002192000") &&
    !migration.includes('ALTER TABLE "Job"') &&
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migration),
);
check(
  "Schema stores tokens per membership, session, and sanitized deliveries",
  schema.includes("model NativePushDevice") &&
    schema.includes("model NativePushDelivery") &&
    schema.includes("@@unique([membershipId, tokenHash])") &&
    schema.includes("@@unique([businessId, idempotencyKey])") &&
    schema.includes("sessionId") &&
    schema.includes("never include a customer address or access code") &&
    migration.includes('"sessionId" TEXT') &&
    migration.includes('ADD COLUMN IF NOT EXISTS "sessionId"') &&
    migration.includes("NativePushDevice_sessionId_fkey") &&
    !migration.includes("20261002193000") &&
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migration),
);
check(
  "Request-path schema helper does not ship unused ensure SQL",
  !schemaSrc.includes("NATIVE_PUSH_ENSURE_SQL") &&
    schemaSrc.includes("assertRequiredTablesExist") &&
    schemaSrc.includes("assertRequiredColumnsExist") &&
    schemaSrc.includes("sessionId"),
);
check(
  "Fake adapter cannot enable in Vercel production",
  configSrc.includes('process.env.VERCEL_ENV === "production"') &&
    configSrc.includes("return false") &&
    configSrc.includes("never talks to Expo, FCM, or APNs") &&
    envExample.includes("TBBT_NATIVE_PUSH_ADAPTER=fake"),
);
check(
  "Payload builder is informational and omits address/access",
  !nativePushPayloadHasForbiddenFields(
    buildNativePushAlertPayload({ kind: "JOB_ASSIGNED", jobId: "job_1" }),
  ) &&
    nativePushAlertAction(buildNativePushAlertPayload({ kind: "JOB_RESCHEDULED", jobId: "job_1" }))
      .startsTime === false &&
    nativePushAlertAction(buildNativePushAlertPayload({ kind: "JOB_RESCHEDULED", jobId: "job_1" }))
      .acceptsAppointment === false &&
    NATIVE_PUSH_FORBIDDEN_PAYLOAD_KEYS.includes("address") &&
    NATIVE_PUSH_FORBIDDEN_PAYLOAD_KEYS.includes("propertyAccessInstructions") &&
    payloadSrc.includes("startsTime: false") &&
    payloadSrc.includes("acceptsAppointment: false"),
);
check(
  "Assignment and material reschedule emit after commit",
  assignSrc.includes("notifyHandymanJobAssigned") &&
    assignSrc.includes("This path never sends a customer") &&
    scheduleSrc.includes("notifyHandymanJobRescheduled") &&
    scheduleSrc.includes("if (rescheduled)") &&
    scheduleSrc.includes("enqueueNativePushNotify") &&
    scheduleSrc.includes("isMaterialAppointmentChange") &&
    dayRouteSrc.includes("notifyHandymanJobRescheduled") &&
    dayRouteSrc.includes("previousScheduledAt") &&
    deactivateSrc.includes("revokeActiveNativePushDevicesForMembership"),
);
check(
  "Claim-before-send, max attempts, and per-device opt-in are wired",
  notifySrc.includes("P2002") &&
    notifySrc.includes('status: "FAILED"') &&
    notifySrc.includes("attemptCount: { lt: NATIVE_PUSH_MAX_ATTEMPTS }") &&
    notifySrc.includes('reason: "max-attempts"') &&
    configSrc.includes("NATIVE_PUSH_MAX_ATTEMPTS = 3") &&
    configSrc.includes("NATIVE_PUSH_PENDING_STALE_MS = 30_000") &&
    configSrc.includes("NATIVE_PUSH_SEND_TIMEOUT_MS = 5_000") &&
    notifySrc.includes('from "next/server"') &&
    notifySrc.includes("after(") &&
    notifySrc.includes("withDeliveryHeartbeat") &&
    notifySrc.includes("sessionId: { not: null }") &&
    scheduleSrc.includes("enqueueNativePushNotify") &&
    devicesSrc.includes("thisDeviceOptedIn") &&
    todaySrc.includes("preference?.thisDeviceOptedIn") &&
    !/preference\?\.optedIn/.test(todaySrc) &&
    sessionSrc.includes("revokeNativePushDevicesForSessions") &&
    accountSecuritySrc.includes("revokeNativePushDevicesForSessions") &&
    appSrc.includes("signOutNative(session.token).catch") &&
    NATIVE_PUSH_MAX_ATTEMPTS === 3 &&
    NATIVE_PUSH_PENDING_STALE_MS > 0 &&
    NATIVE_PUSH_PENDING_STALE_MS > NATIVE_PUSH_SEND_TIMEOUT_MS,
);
check(
  "NATIVE_PUSH_PENDING_STALE_MS default is not 0",
  NATIVE_PUSH_PENDING_STALE_MS > 0 && NATIVE_PUSH_PENDING_STALE_MS >= 30_000,
);
check(
  "Native app drives the toggle from thisDeviceOptedIn, not membership optedIn",
  todaySrc.includes("preference?.thisDeviceOptedIn") &&
    !/preference\?\.optedIn/.test(todaySrc) &&
    nativeApi.includes(NATIVE_PUSH_DEVICE_TOKEN_HEADER) &&
    !nativeApi.includes("?token=") &&
    routeSrc.includes("NATIVE_PUSH_DEVICE_TOKEN_HEADER") &&
    !routeSrc.includes("searchParams.get(\"token\")"),
);
check(
  "Native UI and owner settings stay informational; no Expo push SDK",
  todaySrc.includes("never starts your time or accepts an appointment") &&
    nativeApi.includes("/api/native/v1/push-devices") &&
    settingsSrc.includes("Worker assignment alerts are opted in on the field app") &&
    !nativePkg.includes("expo-notifications") &&
    !notifySrc.includes("notifyTeamEvents"),
);
check(
  "Test harness refuses a non-localhost DATABASE_URL before connecting",
  checkSrc.includes("assertLocalDatabaseUrl") &&
    checkSrc.includes("openDisposableTestDatabase") &&
    checkSrc.includes("tbbt_native_push_alerts"),
);
check(
  "Handyman gate uses request/catalog trade, not a customer address",
  isHandymanJobForNativePush({}) &&
    isHandymanJobForNativePush({ requestTradeCode: "HANDYMAN" }) &&
    !isHandymanJobForNativePush({ requestTradeCode: "CLEANING" }),
);

const previousAdapter = process.env.TBBT_NATIVE_PUSH_ADAPTER;
const previousVercel = process.env.VERCEL_ENV;
process.env.VERCEL_ENV = "production";
process.env.TBBT_NATIVE_PUSH_ADAPTER = "fake";
check("Production ignores TBBT_NATIVE_PUSH_ADAPTER=fake", isFakeNativePushAdapterEnabled() === false);
process.env.VERCEL_ENV = previousVercel ?? "";
if (!previousVercel) delete process.env.VERCEL_ENV;
process.env.TBBT_NATIVE_PUSH_ADAPTER = "fake";
check("Non-production fake adapter can be enabled for scripts", isFakeNativePushAdapterEnabled() === true);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run native-push-alerts Prisma checks.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "native-push-alerts dedicated local database");

const session = await openDisposableTestDatabase({
  databaseUrl: baseUrl,
  namePrefix: "tbbt_native_push_alerts",
  setProcessEnv: true,
});
const prisma = session.prisma;
const fake = createFakeNativePushProvider();
setNativePushProvider(fake);

try {
  const onboardingDone = new Date();
  const completedOnboarding = {
    firstRunSetupCompletedAt: onboardingDone,
    starterServicesSetupCompletedAt: onboardingDone,
    starterServicesSetupChoice: "SKIPPED",
    websiteSetupCompletedAt: onboardingDone,
    websiteSetupChoice: "SKIPPED",
  };
  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Handyman",
      slug: "alpha-native-push",
      tradeCode: "HANDYMAN",
      timezone: "America/New_York",
      ...completedOnboarding,
    },
  });
  await prisma.businessSettings.create({
    data: {
      businessId: businessA.id,
      workingWeekdays: "1,2,3,4,5",
      workStartMinutes: 8 * 60,
      workEndMinutes: 17 * 60,
      schedulingBufferMinutes: 0,
    },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Handyman", slug: "beta-native-push", tradeCode: "HANDYMAN", ...completedOnboarding },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: "owner@native-push.example", passwordHash: "x" },
  });
  const memberAUser = await prisma.user.create({
    data: { name: "Ava Worker", email: "ava@native-push.example", passwordHash: "x" },
  });
  const memberBUser = await prisma.user.create({
    data: { name: "Ben Worker", email: "ben@native-push.example", passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Ada Admin", email: "admin@native-push.example", passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Bea Beta", email: "bea@beta-native-push.example", passwordHash: "x" },
  });
  const ownerMembership = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const memberA = await prisma.membership.create({
    data: { userId: memberAUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const memberB = await prisma.membership.create({
    data: { userId: memberBUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const adminMembership = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: businessA.id, role: "ADMIN" },
  });
  const betaMembership = await prisma.membership.create({
    data: { userId: betaUser.id, businessId: businessB.id, role: "MEMBER" },
  });

  async function createUserSession(userId) {
    return prisma.session.create({
      data: {
        tokenHash: hashToken(`native-push-session-${userId}-${randomUUID()}`),
        userId,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
  }
  const sessionA = await createUserSession(memberAUser.id);
  const sessionB = await createUserSession(memberBUser.id);
  const sessionBeta = await createUserSession(betaUser.id);

  const accessA = fieldAccess({
    userId: memberAUser.id,
    businessId: businessA.id,
    membershipId: memberA.id,
    role: "MEMBER",
    name: memberAUser.name,
    email: memberAUser.email,
    sessionId: sessionA.id,
  });
  const accessB = fieldAccess({
    userId: memberBUser.id,
    businessId: businessA.id,
    membershipId: memberB.id,
    role: "MEMBER",
    name: memberBUser.name,
    email: memberBUser.email,
    sessionId: sessionB.id,
  });
  const accessBeta = fieldAccess({
    userId: betaUser.id,
    businessId: businessB.id,
    membershipId: betaMembership.id,
    role: "MEMBER",
    name: betaUser.name,
    email: betaUser.email,
    sessionId: sessionBeta.id,
  });

  const tokenA = `device-token-ava-${randomUUID()}`;
  const tokenB = `device-token-ben-${randomUUID()}`;
  const tokenBeta = `device-token-bea-${randomUUID()}`;

  const registeredA = await registerNativePushDevice(prisma, accessA, {
    token: tokenA,
    platform: "test",
    optedIn: true,
  });
  const registeredB = await registerNativePushDevice(prisma, accessB, {
    token: tokenB,
    platform: "test",
    optedIn: true,
  });
  const registeredBeta = await registerNativePushDevice(prisma, accessBeta, {
    token: tokenBeta,
    platform: "test",
    optedIn: true,
  });
  check(
    "Workers can opt in and register a token on their active membership",
    registeredA.ok && registeredA.preference.optedIn && registeredA.preference.thisDeviceOptedIn,
  );
  check("Second worker registers independently", registeredB.ok && registeredB.preference.devices.length === 1);
  check("Beta tenant registers its own token", registeredBeta.ok);

  const crossRegister = await registerNativePushDevice(prisma, accessBeta, {
    token: tokenA,
    platform: "test",
    optedIn: true,
  });
  const alphaDevices = await prisma.nativePushDevice.findMany({
    where: { businessId: businessA.id, membershipId: memberA.id },
  });
  const betaHasAlphaToken = await prisma.nativePushDevice.findFirst({
    where: { businessId: businessB.id, membershipId: memberA.id },
  });
  check(
    "Tenant isolation: beta register cannot attach a token to alpha's membership",
    crossRegister.ok &&
      alphaDevices.length === 1 &&
      alphaDevices[0].businessId === businessA.id &&
      !betaHasAlphaToken,
  );
  const restoredA = await registerNativePushDevice(prisma, accessA, {
    token: tokenA,
    platform: "test",
    optedIn: true,
  });
  check(
    "Assignee can reclaim a token after another membership registers the same hash",
    restoredA.ok && restoredA.preference.thisDeviceOptedIn === true,
  );
  check(
    "Preference payloads never include the raw token or an address",
    registeredA.ok &&
      !JSON.stringify(registeredA.preference).includes(tokenA) &&
      !JSON.stringify(registeredA.preference).includes("address") &&
      registeredA.preference.startsTime === false &&
      registeredA.preference.acceptsAppointment === false &&
      registeredA.preference.disclaimer === NATIVE_PUSH_ALERT_DISCLAIMER,
  );

  const customer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Cara Canary", phone: "555-0100" },
  });
  const property = await prisma.property.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      addressLine1: "42 Secret Garden Way",
      city: "Springfield",
      region: "IL",
      postalCode: "62704",
    },
  });
  async function createHandymanJob(suffix) {
    return prisma.job.create({
      data: {
        businessId: businessA.id,
        customerId: customer.id,
        propertyId: property.id,
        projectToken: randomUUID(),
        status: "SCHEDULED",
        scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        scheduledDurationMinutes: 60,
        appointmentProposalId: 1,
        propertyAccessMethod: "LOCKBOX",
        propertyAccessInstructions: `Gate code 4821-${suffix}`,
        propertyAccessNote: "Hide the key",
      },
    });
  }

  const assignJob = await createHandymanJob("assign");
  fake.sent.length = 0;
  const assigned = await writeAssignedMembershipAndLaneWindows(prisma, {
    businessId: businessA.id,
    job: assignJob,
    nextAssignedMembershipId: memberA.id,
    actorMembershipId: ownerMembership.id,
  });
  check("OWNER assignment write succeeds", !assigned?.error);
  check(
    "Opted-in assignee receives exactly one informational assignment alert",
    fake.sent.length === 1 &&
      fake.sent[0].membershipId === memberA.id &&
      fake.sent[0].businessId === businessA.id &&
      fake.sent[0].kind === "JOB_ASSIGNED" &&
      fake.sent[0].payload.jobId === assignJob.id &&
      fake.sent[0].payload.informational === true &&
      fake.sent[0].payload.startsTime === false &&
      fake.sent[0].payload.acceptsAppointment === false,
  );
  const sentBlob = JSON.stringify(fake.sent[0].payload);
  check(
    "Assignment payload omits customer address and access codes",
    !sentBlob.includes("42 Secret Garden") &&
      !sentBlob.includes("4821") &&
      !sentBlob.includes("Cara Canary") &&
      !sentBlob.includes("address") &&
      !sentBlob.includes("propertyAccess") &&
      !Object.prototype.hasOwnProperty.call(fake.sent[0].payload, "address") &&
      fake.sent[0].provider === undefined,
  );
  check("Fake provider id is recorded, not a vendor", fake.id === FAKE_NATIVE_PUSH_PROVIDER);

  const duplicateAssign = await notifyHandymanJobAssigned(prisma, {
    businessId: businessA.id,
    jobId: assignJob.id,
    previousMembershipId: null,
    nextMembershipId: memberA.id,
    actorMembershipId: ownerMembership.id,
  });
  check(
    "Duplicate assignment notify is suppressed",
    duplicateAssign.status === "SUPPRESSED" &&
      duplicateAssign.reason === "duplicate" &&
      fake.sent.length === 1,
  );

  fake.sent.length = 0;
  const reassigned = await writeAssignedMembershipAndLaneWindows(prisma, {
    businessId: businessA.id,
    job: { ...assignJob, assignedMembershipId: memberA.id },
    nextAssignedMembershipId: memberB.id,
    actorMembershipId: ownerMembership.id,
  });
  check("OWNER reassignment write succeeds", !reassigned?.error);
  check(
    "Reassignment alerts only the new worker",
    fake.sent.length === 1 &&
      fake.sent[0].membershipId === memberB.id &&
      fake.sent[0].kind === "JOB_ASSIGNED" &&
      !fake.sent.some((row) => row.membershipId === memberA.id),
  );

  const refreshed = await prisma.job.findFirst({ where: { id: assignJob.id } });
  const nextStart = new Date(refreshed.scheduledAt.getTime() + 60 * 60 * 1000);
  check(
    "Slot move is a material appointment change",
    isMaterialAppointmentChange(refreshed, nextStart, refreshed.scheduledDurationMinutes),
  );
  await prisma.job.update({
    where: { id: assignJob.id },
    data: {
      scheduledAt: nextStart,
      appointmentProposalId: refreshed.appointmentProposalId + 1,
    },
  });
  fake.sent.length = 0;
  const rescheduled = await notifyHandymanJobRescheduled(prisma, {
    businessId: businessA.id,
    jobId: assignJob.id,
    membershipId: memberB.id,
    actorMembershipId: ownerMembership.id,
    proposalId: refreshed.appointmentProposalId + 1,
  });
  check("Material reschedule notifies the current assignee", rescheduled.status === "SENT");
  check(
    "Former assignee does not receive the reschedule alert",
    fake.sent.length === 1 &&
      fake.sent[0].membershipId === memberB.id &&
      fake.sent[0].kind === "JOB_RESCHEDULED" &&
      fake.sent[0].payload.acceptsAppointment === false &&
      !JSON.stringify(fake.sent[0].payload).includes("4821"),
  );
  const duplicateReschedule = await notifyHandymanJobRescheduled(prisma, {
    businessId: businessA.id,
    jobId: assignJob.id,
    membershipId: memberB.id,
    actorMembershipId: ownerMembership.id,
    proposalId: refreshed.appointmentProposalId + 1,
  });
  check(
    "Duplicate reschedule notify is suppressed",
    duplicateReschedule.status === "SUPPRESSED" &&
      duplicateReschedule.reason === "duplicate" &&
      fake.sent.length === 1,
  );
  check(
    "Idempotency keys are stable for one assignment/reschedule event",
    assignmentAlertIdempotencyKey({
      jobId: "job",
      nextMembershipId: "m2",
      previousMembershipId: "m1",
      committedAt: new Date("2026-10-02T00:00:00.000Z"),
    }) === "JOB_ASSIGNED:job:m2:from:m1:2026-10-02T00:00:00.000Z" &&
      rescheduleAlertIdempotencyKey({ jobId: "job", membershipId: "m2", proposalId: 3 }) ===
        "JOB_RESCHEDULED:job:m2:3",
  );

  const retryJob = await createHandymanJob("retry");
  fake.sent.length = 0;
  fake.setFailNext(true);
  const failedAssign = await writeAssignedMembershipAndLaneWindows(prisma, {
    businessId: businessA.id,
    job: retryJob,
    nextAssignedMembershipId: memberA.id,
    actorMembershipId: ownerMembership.id,
  });
  const failedDelivery = await prisma.nativePushDelivery.findFirst({
    where: { jobId: retryJob.id, kind: "JOB_ASSIGNED" },
  });
  check("Assignment still commits when the fake provider rejects", !failedAssign?.error);
  check(
    "Failed send is recorded for retry and does not leak to sent[]",
    failedDelivery?.status === "FAILED" && fake.sent.length === 0,
  );
  const retried = await retryNativePushDelivery(prisma, failedDelivery.id);
  check("Retry after provider failure sends once", retried.status === "SENT" && fake.sent.length === 1);
  const retryAgain = await retryNativePushDelivery(prisma, failedDelivery.id);
  check(
    "Retry of an already-sent delivery is suppressed",
    retryAgain.status === "SUPPRESSED" && retryAgain.reason === "duplicate" && fake.sent.length === 1,
  );

  const isolateJob = await createHandymanJob("isolate");
  fake.sent.length = 0;
  await writeAssignedMembershipAndLaneWindows(prisma, {
    businessId: businessA.id,
    job: isolateJob,
    nextAssignedMembershipId: memberA.id,
    actorMembershipId: ownerMembership.id,
  });
  check(
    "Tenant isolation: alpha assignment never sends to beta's device",
    fake.sent.length === 1 &&
      fake.sent[0].membershipId === memberA.id &&
      fake.sent[0].businessId === businessA.id &&
      !fake.sent.some((row) => row.membershipId === betaMembership.id),
  );

  const cleaningRequest = await prisma.serviceRequest.create({
    data: { businessId: businessA.id, tradeCode: "CLEANING", summary: "Weekly clean" },
  });
  const cleaningEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      serviceRequestId: cleaningRequest.id,
      total: 0,
      publicToken: randomUUID(),
    },
  });
  const cleaningJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      estimateId: cleaningEstimate.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
    },
  });
  fake.sent.length = 0;
  await writeAssignedMembershipAndLaneWindows(prisma, {
    businessId: businessA.id,
    job: cleaningJob,
    nextAssignedMembershipId: memberA.id,
    actorMembershipId: ownerMembership.id,
  });
  check("Cleaning job assignment does not send a Handyman alert", fake.sent.length === 0);

  const tokenA2 = `device-token-ava-second-${randomUUID()}`;
  const secondDeviceList = await listNativePushPreference(prisma, accessA, { token: tokenA2 });
  check(
    "Second device GET reports thisDeviceOptedIn false while another device is opted in",
    secondDeviceList.ok &&
      secondDeviceList.preference.optedIn === true &&
      secondDeviceList.preference.thisDeviceOptedIn === false,
  );
  const registeredA2 = await registerNativePushDevice(prisma, accessA, {
    token: tokenA2,
    platform: "test",
    optedIn: true,
  });
  check(
    "Second device can opt in using thisDeviceOptedIn, not membership optedIn",
    registeredA2.ok &&
      registeredA2.preference.thisDeviceOptedIn === true &&
      registeredA2.preference.devices.length === 2,
  );
  const revokedA2 = await revokeNativePushDevice(prisma, accessA, { token: tokenA2 });
  check(
    "Second device revoke is scoped to that token",
    revokedA2.ok &&
      revokedA2.preference.thisDeviceOptedIn === false &&
      revokedA2.preference.optedIn === true,
  );

  const sharedToken = `device-token-shared-${randomUUID()}`;
  await registerNativePushDevice(prisma, accessA, {
    token: sharedToken,
    platform: "test",
    optedIn: true,
  });
  const sharedOnB = await registerNativePushDevice(prisma, accessB, {
    token: sharedToken,
    platform: "test",
    optedIn: true,
  });
  const sharedHash = hashNativePushDeviceToken(sharedToken);
  const sharedARow = await prisma.nativePushDevice.findFirst({
    where: { membershipId: memberA.id, tokenHash: sharedHash },
  });
  const sharedBRow = await prisma.nativePushDevice.findFirst({
    where: { membershipId: memberB.id, tokenHash: sharedHash },
  });
  check(
    "Registering a token on another membership revokes the previous active row",
    sharedOnB.ok &&
      sharedARow?.revokedAt != null &&
      sharedBRow?.revokedAt == null &&
      sharedBRow?.optedIn === true,
  );
  await revokeNativePushDevice(prisma, accessB, { token: sharedToken });

  const crossRevoke = await revokeNativePushDevice(prisma, accessB, { token: tokenA });
  const stillA = await prisma.nativePushDevice.findFirst({
    where: { membershipId: memberA.id, tokenHash: hashNativePushDeviceToken(tokenA) },
  });
  check(
    "Cross-worker revoke is refused and leaves the other worker's token",
    crossRevoke.ok === false &&
      crossRevoke.status === 403 &&
      crossRevoke.error === NATIVE_PUSH_DEVICE_NOT_OWNED &&
      stillA?.revokedAt == null &&
      stillA?.optedIn === true,
  );

  const sessionRaw = `native-session-${randomUUID()}`;
  const sessionRow = await prisma.session.create({
    data: {
      tokenHash: hashToken(sessionRaw),
      userId: memberAUser.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  const sessionToken = `device-token-session-${randomUUID()}`;
  const sessionAccess = { ...accessA, sessionId: sessionRow.id };
  await registerNativePushDevice(prisma, sessionAccess, {
    token: sessionToken,
    platform: "test",
    optedIn: true,
  });
  const revokedSession = await revokeNativeSession(prisma, sessionRaw);
  const sessionDevice = await prisma.nativePushDevice.findFirst({
    where: {
      membershipId: memberA.id,
      tokenHash: hashNativePushDeviceToken(sessionToken),
    },
  });
  check(
    "Session revoke clears the device stored on that session",
    revokedSession === true && sessionDevice?.revokedAt != null && sessionDevice?.optedIn === false,
  );

  const expiredRaw = `expired-session-${randomUUID()}`;
  const expiredSession = await prisma.session.create({
    data: {
      tokenHash: hashToken(expiredRaw),
      userId: memberAUser.id,
      expiresAt: new Date(Date.now() - 60_000),
    },
  });
  const expiredToken = `device-token-expired-${randomUUID()}`;
  await registerNativePushDevice(
    prisma,
    { ...accessA, sessionId: expiredSession.id },
    { token: expiredToken, platform: "test", optedIn: true },
  );
  const expireJob = await createHandymanJob("expired-session");
  fake.sent.length = 0;
  await writeAssignedMembershipAndLaneWindows(prisma, {
    businessId: businessA.id,
    job: expireJob,
    nextAssignedMembershipId: memberA.id,
    actorMembershipId: ownerMembership.id,
  });
  const expiredResolved = await resolveNativeSession(prisma, expiredRaw);
  const expiredDevice = await prisma.nativePushDevice.findFirst({
    where: {
      membershipId: memberA.id,
      tokenHash: hashNativePushDeviceToken(expiredToken),
    },
  });
  check(
    "Expired session device is not selected for assignment alerts",
    fake.sent.length === 1 &&
      fake.sent[0].deviceToken === tokenA &&
      !fake.sent.some((row) => row.deviceToken === expiredToken),
  );
  check(
    "resolveNativeSession revokes devices before deleting an expired session",
    expiredResolved === null &&
      expiredDevice?.revokedAt != null &&
      expiredDevice?.optedIn === false,
  );

  const otherRaw = `other-session-${randomUUID()}`;
  const otherSession = await prisma.session.create({
    data: {
      tokenHash: hashToken(otherRaw),
      userId: memberAUser.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  const otherToken = `device-token-other-${randomUUID()}`;
  await registerNativePushDevice(
    prisma,
    { ...accessA, sessionId: otherSession.id },
    { token: otherToken, platform: "test", optedIn: true },
  );
  const revokedOthers = await revokeOtherSessionsOp(prisma, {
    userId: memberAUser.id,
    currentSessionId: sessionA.id,
  });
  const otherDevice = await prisma.nativePushDevice.findFirst({
    where: {
      membershipId: memberA.id,
      tokenHash: hashNativePushDeviceToken(otherToken),
    },
  });
  const currentDevice = await prisma.nativePushDevice.findFirst({
    where: {
      membershipId: memberA.id,
      tokenHash: hashNativePushDeviceToken(tokenA),
    },
  });
  const othersJob = await createHandymanJob("revoke-others");
  fake.sent.length = 0;
  await writeAssignedMembershipAndLaneWindows(prisma, {
    businessId: businessA.id,
    job: othersJob,
    nextAssignedMembershipId: memberA.id,
    actorMembershipId: ownerMembership.id,
  });
  check("revokeOtherSessionsOp revokes at least the extra session", revokedOthers >= 1);
  check(
    "Revoke-others leaves the current-session device live and revokes the lost-phone device",
    otherDevice?.revokedAt != null &&
      otherDevice?.optedIn === false &&
      currentDevice?.revokedAt == null &&
      currentDevice?.optedIn === true,
  );
  check(
    "Revoke-others does not send to the revoked device",
    fake.sent.length === 1 && fake.sent[0].deviceToken === tokenA,
  );

  const targetedRaw = `targeted-session-${randomUUID()}`;
  const targetedSession = await prisma.session.create({
    data: {
      tokenHash: hashToken(targetedRaw),
      userId: memberAUser.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  const targetedToken = `device-token-targeted-${randomUUID()}`;
  await registerNativePushDevice(
    prisma,
    { ...accessA, sessionId: targetedSession.id },
    { token: targetedToken, platform: "test", optedIn: true },
  );
  await revokeSessionOp(prisma, {
    userId: memberAUser.id,
    sessionId: targetedSession.id,
    currentSessionId: sessionA.id,
  });
  const targetedDevice = await prisma.nativePushDevice.findFirst({
    where: {
      membershipId: memberA.id,
      tokenHash: hashNativePushDeviceToken(targetedToken),
    },
  });
  check(
    "revokeSessionOp revokes devices on that session",
    targetedDevice?.revokedAt != null && targetedDevice?.optedIn === false,
  );

  const selfAssignJob = await createHandymanJob("self-assign");
  fake.sent.length = 0;
  const selfAssigned = await writeAssignedMembershipAndLaneWindows(prisma, {
    businessId: businessA.id,
    job: selfAssignJob,
    nextAssignedMembershipId: memberA.id,
    actorMembershipId: memberA.id,
  });
  check("MEMBER self-assign write still commits", !selfAssigned?.error);
  check("MEMBER self-assign sends 0 alerts", fake.sent.length === 0);
  const memberNotify = await notifyHandymanJobAssigned(prisma, {
    businessId: businessA.id,
    jobId: selfAssignJob.id,
    previousMembershipId: null,
    nextMembershipId: memberA.id,
    actorMembershipId: memberA.id,
  });
  check(
    "OWNER/ADMIN actor check suppresses MEMBER notify",
    memberNotify.status === "SUPPRESSED" &&
      memberNotify.reason === "not-owner-side" &&
      fake.sent.length === 0,
  );

  const adminJob = await createHandymanJob("admin-assign");
  fake.sent.length = 0;
  const adminAssigned = await writeAssignedMembershipAndLaneWindows(prisma, {
    businessId: businessA.id,
    job: adminJob,
    nextAssignedMembershipId: memberA.id,
    actorMembershipId: adminMembership.id,
  });
  check("ADMIN assignment write succeeds", !adminAssigned?.error);
  check("ADMIN actor check allows an assignment alert", fake.sent.length === 1);

  fake.sent.length = 0;
  const unchanged = await notifyHandymanJobAssigned(prisma, {
    businessId: businessA.id,
    jobId: adminJob.id,
    previousMembershipId: memberA.id,
    nextMembershipId: memberA.id,
    actorMembershipId: ownerMembership.id,
  });
  check(
    "previous-vs-next assignment check suppresses an unchanged assignee",
    unchanged.status === "SUPPRESSED" &&
      unchanged.reason === "unchanged-assignment" &&
      fake.sent.length === 0,
  );

  fake.sent.length = 0;
  const mismatch = await notifyHandymanJobAssigned(prisma, {
    businessId: businessA.id,
    jobId: adminJob.id,
    previousMembershipId: null,
    nextMembershipId: memberB.id,
    actorMembershipId: ownerMembership.id,
  });
  check(
    "assignedMembershipId check suppresses a notify for the wrong worker",
    mismatch.status === "SUPPRESSED" &&
      mismatch.reason === "job-unavailable" &&
      fake.sent.length === 0,
  );

  const optedOutOnlyJob = await createHandymanJob("opted-out-only");
  await prisma.nativePushDevice.updateMany({
    where: { membershipId: memberA.id, tokenHash: hashNativePushDeviceToken(tokenA) },
    data: { optedIn: false, revokedAt: null },
  });
  fake.sent.length = 0;
  await writeAssignedMembershipAndLaneWindows(prisma, {
    businessId: businessA.id,
    job: optedOutOnlyJob,
    nextAssignedMembershipId: memberA.id,
    actorMembershipId: ownerMembership.id,
  });
  check("optedIn filter alone suppresses a send when revokedAt is null", fake.sent.length === 0);
  await prisma.nativePushDevice.updateMany({
    where: { membershipId: memberA.id, tokenHash: hashNativePushDeviceToken(tokenA) },
    data: { optedIn: true, revokedAt: null },
  });

  const revokedOnlyJob = await createHandymanJob("revoked-only");
  await prisma.nativePushDevice.updateMany({
    where: { membershipId: memberA.id, tokenHash: hashNativePushDeviceToken(tokenA) },
    data: { optedIn: true, revokedAt: new Date() },
  });
  fake.sent.length = 0;
  await writeAssignedMembershipAndLaneWindows(prisma, {
    businessId: businessA.id,
    job: revokedOnlyJob,
    nextAssignedMembershipId: memberA.id,
    actorMembershipId: ownerMembership.id,
  });
  check("revokedAt filter alone suppresses a send when optedIn is still true", fake.sent.length === 0);
  await prisma.nativePushDevice.updateMany({
    where: { membershipId: memberA.id, tokenHash: hashNativePushDeviceToken(tokenA) },
    data: { optedIn: true, revokedAt: null },
  });

  const partialJob = await createHandymanJob("partial-success");
  const extraDeviceToken = `device-token-ava-partial-${randomUUID()}`;
  await registerNativePushDevice(prisma, accessA, {
    token: extraDeviceToken,
    platform: "test",
    optedIn: true,
  });
  fake.sent.length = 0;
  fake.setFailNext(true);
  const partialAssigned = await writeAssignedMembershipAndLaneWindows(prisma, {
    businessId: businessA.id,
    job: partialJob,
    nextAssignedMembershipId: memberA.id,
    actorMembershipId: ownerMembership.id,
  });
  const partialDelivery = await prisma.nativePushDelivery.findFirst({
    where: { jobId: partialJob.id, kind: "JOB_ASSIGNED" },
  });
  check("Partial multi-device success still commits the assignment", !partialAssigned?.error);
  check(
    "Partial multi-device success is SENT when sentCount > 0",
    partialDelivery?.status === "SENT" && fake.sent.length === 1,
  );
  await revokeNativePushDevice(prisma, accessA, { token: extraDeviceToken });

  const maxJob = await createHandymanJob("max-attempts");
  fake.sent.length = 0;
  fake.sendCalls = 0;
  fake.setFailAlways(true);
  await writeAssignedMembershipAndLaneWindows(prisma, {
    businessId: businessA.id,
    job: maxJob,
    nextAssignedMembershipId: memberA.id,
    actorMembershipId: ownerMembership.id,
  });
  let maxDelivery = await prisma.nativePushDelivery.findFirst({
    where: { jobId: maxJob.id, kind: "JOB_ASSIGNED" },
  });
  for (let i = 0; i < 25; i += 1) {
    await retryNativePushDelivery(prisma, maxDelivery.id);
  }
  maxDelivery = await prisma.nativePushDelivery.findFirst({
    where: { id: maxDelivery.id },
  });
  check(
    "NATIVE_PUSH_MAX_ATTEMPTS settles failing retries at 3 without more adapter calls",
    maxDelivery?.attemptCount === 3 &&
      maxDelivery?.status === "FAILED" &&
      maxDelivery?.failureReason === "max-attempts" &&
      fake.sendCalls === 3 &&
      fake.sent.length === 0,
  );
  fake.setFailAlways(false);

  const staleJob = await createHandymanJob("stale-pending");
  await prisma.job.update({
    where: { id: staleJob.id },
    data: { assignedMembershipId: memberA.id },
  });
  const staleFresh = await prisma.job.findFirst({ where: { id: staleJob.id } });
  const staleKey = assignmentAlertIdempotencyKey({
    jobId: staleFresh.id,
    nextMembershipId: memberA.id,
    previousMembershipId: null,
    committedAt: staleFresh.updatedAt,
  });
  const staleRow = await prisma.nativePushDelivery.create({
    data: {
      businessId: businessA.id,
      membershipId: memberA.id,
      jobId: staleJob.id,
      kind: "JOB_ASSIGNED",
      idempotencyKey: staleKey,
      status: "PENDING",
      attemptCount: 1,
      payloadSnapshot: buildNativePushAlertPayload({ kind: "JOB_ASSIGNED", jobId: staleJob.id }),
      provider: FAKE_NATIVE_PUSH_PROVIDER,
    },
  });
  await prisma.$executeRaw`
    UPDATE "NativePushDelivery"
    SET "updatedAt" = NOW() - INTERVAL '2 minutes'
    WHERE id = ${staleRow.id}
  `;
  setNativePushPendingStaleMs(1_000);
  fake.sent.length = 0;
  const staleClients = [prisma, session.createClient()];
  const staleArgs = {
    businessId: businessA.id,
    jobId: staleJob.id,
    previousMembershipId: null,
    nextMembershipId: memberA.id,
    actorMembershipId: ownerMembership.id,
  };
  await Promise.all(staleClients.map((client) => notifyHandymanJobAssigned(client, staleArgs)));
  const staleDeliveries = await prisma.nativePushDelivery.findMany({
    where: { jobId: staleJob.id, kind: "JOB_ASSIGNED" },
  });
  check(
    "Stale PENDING reclaim sends once and keeps one delivery row",
    fake.sent.length === 1 && staleDeliveries.length === 1 && staleDeliveries[0].status === "SENT",
  );

  const overlapJob = await createHandymanJob("overlap-stale");
  await prisma.job.update({
    where: { id: overlapJob.id },
    data: { assignedMembershipId: memberA.id },
  });
  setNativePushPendingStaleMs(50);
  fake.sent.length = 0;
  fake.sendCalls = 0;
  fake.setSendDelayMs(400);
  const overlapArgs = {
    businessId: businessA.id,
    jobId: overlapJob.id,
    previousMembershipId: null,
    nextMembershipId: memberA.id,
    actorMembershipId: ownerMembership.id,
  };
  const overlapFirst = notifyHandymanJobAssigned(prisma, overlapArgs);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const overlapSecond = notifyHandymanJobAssigned(session.createClient(), overlapArgs);
  await Promise.all([overlapFirst, overlapSecond]);
  const overlapDeliveries = await prisma.nativePushDelivery.findMany({
    where: { jobId: overlapJob.id, kind: "JOB_ASSIGNED" },
  });
  check(
    "Heartbeat keeps a live send from being reclaimed after the stale window",
    fake.sent.length === 1 &&
      fake.sendCalls === 1 &&
      overlapDeliveries.length === 1 &&
      overlapDeliveries[0].status === "SENT",
  );
  fake.setSendDelayMs(0);
  setNativePushPendingStaleMs(null);

  const raceClients = [prisma, session.createClient(), session.createClient()];
  const raceJobs = [];
  for (let i = 0; i < 50; i += 1) {
    const job = await createHandymanJob(`race-${i}`);
    await prisma.job.update({
      where: { id: job.id },
      data: { assignedMembershipId: memberA.id },
    });
    raceJobs.push(job);
  }
  fake.sent.length = 0;
  fake.sendCalls = 0;
  fake.setSendDelayMs(15);
  await Promise.all(
    raceJobs.map(async (job) => {
      const args = {
        businessId: businessA.id,
        jobId: job.id,
        previousMembershipId: null,
        nextMembershipId: memberA.id,
        actorMembershipId: ownerMembership.id,
      };
      await Promise.all(raceClients.map((client) => notifyHandymanJobAssigned(client, args)));
    }),
  );
  const raceDeliveries = await prisma.nativePushDelivery.findMany({
    where: { jobId: { in: raceJobs.map((job) => job.id) }, kind: "JOB_ASSIGNED" },
  });
  check(
    "3-connection x50 race with latency sends exactly once per event",
    fake.sent.length === 50 &&
      fake.sendCalls === 50 &&
      raceDeliveries.length === 50 &&
      raceDeliveries.every((row) => row.status === "SENT"),
  );
  fake.setSendDelayMs(0);

  const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
  const { scheduleJob } = await import("@/app/actions/job");
  const { setTestAccess } = await import("./estimate-options-test-access.mjs");
  function form(fields) {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value != null) data.set(key, String(value));
    }
    return data;
  }
  const ownerAccess = {
    businessId: businessA.id,
    workspace: {
      role: "OWNER",
      membership: { id: ownerMembership.id },
      user: { id: ownerUser.id },
      business: {
        id: businessA.id,
        name: businessA.name,
        slug: businessA.slug,
        tradeCode: businessA.tradeCode,
        timezone: "America/New_York",
      },
    },
    scope: businessScope(businessA.id),
    assertOwned(record) {
      return assertBusinessRecord(record, businessA.id);
    },
    assertAttachable(record) {
      return assertBusinessRecord(record, businessA.id);
    },
  };
  setTestAccess(ownerAccess);
  const firstScheduleJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      propertyId: property.id,
      projectToken: randomUUID(),
      status: "UNSCHEDULED",
      assignedMembershipId: memberA.id,
    },
  });
  fake.sent.length = 0;
  const firstScheduled = await scheduleJob(
    {},
    form({
      jobId: firstScheduleJob.id,
      date: "2027-06-16",
      time: "10:00",
      durationPreset: "60",
    }),
  );
  await flushNativePushNotifies();
  check("First scheduleJob write succeeds", !firstScheduled?.error);
  check("First scheduleJob does not send a reschedule alert", fake.sent.length === 0);

  fake.sent.length = 0;
  const nonMaterial = await scheduleJob(
    {},
    form({
      jobId: firstScheduleJob.id,
      date: "2027-06-16",
      time: "10:00",
      durationPreset: "60",
    }),
  );
  await flushNativePushNotifies();
  check("Non-material scheduleJob write succeeds", !nonMaterial?.error && !nonMaterial?.warning);
  check("Non-material scheduleJob sends 0 alerts", fake.sent.length === 0);

  fake.sent.length = 0;
  const materialReschedule = await scheduleJob(
    {},
    form({
      jobId: firstScheduleJob.id,
      date: "2027-06-16",
      time: "11:00",
      durationPreset: "60",
    }),
  );
  await flushNativePushNotifies();
  check("Material scheduleJob reschedule write succeeds", !materialReschedule?.error);
  check(
    "Material scheduleJob reschedule sends one informational alert",
    fake.sent.length === 1 && fake.sent[0].kind === "JOB_RESCHEDULED",
  );

  const optedOut = await revokeNativePushDevice(prisma, accessB, { token: tokenB });
  check("Worker can revoke their own device token", optedOut.ok && optedOut.preference.optedIn === false);
  const quietJob = await createHandymanJob("quiet");
  fake.sent.length = 0;
  await writeAssignedMembershipAndLaneWindows(prisma, {
    businessId: businessA.id,
    job: quietJob,
    nextAssignedMembershipId: memberB.id,
    actorMembershipId: ownerMembership.id,
  });
  check("Revoked / opted-out worker does not receive an assignment alert", fake.sent.length === 0);

  await registerNativePushDevice(prisma, accessA, { token: tokenA, platform: "test", optedIn: true });
  const deactivated = await writeTeamMemberActive(prisma, {
    businessId: businessA.id,
    membershipId: memberA.id,
    actorMembershipId: ownerMembership.id,
    active: false,
  });
  const revokedAfterDeactivate = await prisma.nativePushDevice.findMany({
    where: { membershipId: memberA.id },
  });
  check("Deactivation write succeeds", !deactivated?.error);
  check(
    "Deactivation revokes every device token on that membership",
    revokedAfterDeactivate.length > 0 &&
      revokedAfterDeactivate.every((row) => row.revokedAt && row.optedIn === false),
  );
  const inactiveToken = `device-token-ava-after-${randomUUID()}`;
  const inactiveHash = hashNativePushDeviceToken(inactiveToken);
  const devicesBeforeInactive = await prisma.nativePushDevice.count({
    where: { membershipId: memberA.id, tokenHash: inactiveHash },
  });
  const registerAfterDeactivate = await registerNativePushDevice(prisma, accessA, {
    token: inactiveToken,
    platform: "test",
    optedIn: true,
  });
  const devicesAfterInactive = await prisma.nativePushDevice.count({
    where: { membershipId: memberA.id, tokenHash: inactiveHash },
  });
  check(
    "Inactive membership cannot register a new device token",
    registerAfterDeactivate.ok === false &&
      registerAfterDeactivate.status === 403 &&
      registerAfterDeactivate.error === NATIVE_PUSH_MEMBERSHIP_INACTIVE,
  );
  check(
    "No NativePushDevice row is written for an inactive membership",
    devicesBeforeInactive === 0 && devicesAfterInactive === 0,
  );
  fake.sent.length = 0;
  const postDeactivateJob = await createHandymanJob("post-deactivate");
  await writeAssignedMembershipAndLaneWindows(prisma, {
    businessId: businessA.id,
    job: postDeactivateJob,
    nextAssignedMembershipId: memberA.id,
    actorMembershipId: ownerMembership.id,
  });
  check(
    "Alerts to a deactivated membership are suppressed",
    fake.sent.length === 0,
  );

  const missingColumnRaw = `missing-column-session-${randomUUID()}`;
  await prisma.session.create({
    data: {
      tokenHash: hashToken(missingColumnRaw),
      userId: memberBUser.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "NativePushDevice" DROP COLUMN IF EXISTS "sessionId"`,
  );
  resetNativePushSchemaEnsure();
  const missingColumnRegister = await registerNativePushDevice(prisma, accessB, {
    token: `device-token-missing-col-${randomUUID()}`,
    platform: "test",
    optedIn: true,
  });
  const missingColumnList = await listNativePushPreference(prisma, accessB, { token: tokenB });
  let missingColumnSignOutThrew = false;
  try {
    await revokeNativeSession(prisma, missingColumnRaw);
  } catch {
    missingColumnSignOutThrew = true;
  }
  check(
    "Missing sessionId column register/list return 503 without throwing",
    missingColumnRegister.ok === false &&
      missingColumnRegister.status === 503 &&
      missingColumnList.ok === false &&
      missingColumnList.status === 503,
  );
  check("Missing sessionId column sign-out does not throw", missingColumnSignOutThrew === false);

  const missingJob = await createHandymanJob("missing-table");
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "NativePushDelivery" CASCADE`);
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "NativePushDevice" CASCADE`);
  resetNativePushSchemaEnsure();
  fake.sent.length = 0;
  const missingAssign = await writeAssignedMembershipAndLaneWindows(prisma, {
    businessId: businessA.id,
    job: missingJob,
    nextAssignedMembershipId: memberB.id,
    actorMembershipId: ownerMembership.id,
  });
  const missingJobRow = await prisma.job.findFirst({ where: { id: missingJob.id } });
  const missingList = await listNativePushPreference(prisma, accessB, { token: tokenB });
  const missingRegister = await registerNativePushDevice(prisma, accessB, {
    token: `device-token-missing-${randomUUID()}`,
    platform: "test",
    optedIn: true,
  });
  check("Missing-table assignment still commits", !missingAssign?.error);
  check(
    "Missing-table assignment persists assignedMembershipId",
    missingJobRow?.assignedMembershipId === memberB.id,
  );
  check("Missing-table list returns 503", missingList.ok === false && missingList.status === 503);
  check(
    "Missing-table register returns 503",
    missingRegister.ok === false && missingRegister.status === 503,
  );
} finally {
  setNativePushProvider(null);
  if (previousAdapter == null) delete process.env.TBBT_NATIVE_PUSH_ADAPTER;
  else process.env.TBBT_NATIVE_PUSH_ADAPTER = previousAdapter;
  await session.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
