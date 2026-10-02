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

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { writeAssignedMembershipAndLaneWindows } = await import("@/lib/job-assignment-ops");
const { writeTeamMemberActive } = await import("@/lib/team-member-active-ops");
const {
  FAKE_NATIVE_PUSH_PROVIDER,
  NATIVE_PUSH_ALERT_DISCLAIMER,
  NATIVE_PUSH_FORBIDDEN_PAYLOAD_KEYS,
  NATIVE_PUSH_MEMBERSHIP_INACTIVE,
  assignmentAlertIdempotencyKey,
  buildNativePushAlertPayload,
  createFakeNativePushProvider,
  isFakeNativePushAdapterEnabled,
  isHandymanJobForNativePush,
  nativePushAlertAction,
  nativePushPayloadHasForbiddenFields,
  notifyHandymanJobAssigned,
  notifyHandymanJobRescheduled,
  registerNativePushDevice,
  rescheduleAlertIdempotencyKey,
  retryNativePushDelivery,
  revokeNativePushDevice,
  setNativePushProvider,
} = await import("@/lib/native-push");
const { isMaterialAppointmentChange } = await import("@/lib/appointment-confirmation");

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

function fieldAccess({ userId, businessId, membershipId, role, name, email }) {
  return {
    userId,
    sessionId: "native-push-session",
    viewer: { id: userId, name, email, role },
    workspace: { businessId, businessName: "Alpha", membershipId, role },
    businessId,
    membershipId,
  };
}

const schema = readRepo("prisma/schema.prisma");
const migration = readRepo("prisma/migrations/20261002192000_native_push_alerts/migration.sql");
const configSrc = readRepo("src/lib/native-push/config.ts");
const payloadSrc = readRepo("src/lib/native-push/payload.ts");
const notifySrc = readRepo("src/lib/native-push/notify.ts");
const assignSrc = readRepo("src/lib/job-assignment-ops.ts");
const deactivateSrc = readRepo("src/lib/team-member-active-ops.ts");
const scheduleSrc = readRepo("src/app/actions/job.ts");
const dayRouteSrc = readRepo("src/lib/owner-day-route-appointment-ops.ts");
const nativeApi = readRepo("apps/native/src/api.ts");
const todaySrc = readRepo("apps/native/src/screens/TodayScreen.tsx");
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
  "Schema stores tokens per membership and sanitized deliveries",
  schema.includes("model NativePushDevice") &&
    schema.includes("model NativePushDelivery") &&
    schema.includes("@@unique([membershipId, tokenHash])") &&
    schema.includes("@@unique([businessId, idempotencyKey])") &&
    schema.includes("never include a customer address or access code"),
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
    scheduleSrc.includes("isMaterialAppointmentChange") &&
    dayRouteSrc.includes("notifyHandymanJobRescheduled") &&
    deactivateSrc.includes("revokeActiveNativePushDevicesForMembership"),
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
    data: { name: "Alpha Handyman", slug: "alpha-native-push", tradeCode: "HANDYMAN", ...completedOnboarding },
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
  const betaMembership = await prisma.membership.create({
    data: { userId: betaUser.id, businessId: businessB.id, role: "MEMBER" },
  });

  const accessA = fieldAccess({
    userId: memberAUser.id,
    businessId: businessA.id,
    membershipId: memberA.id,
    role: "MEMBER",
    name: memberAUser.name,
    email: memberAUser.email,
  });
  const accessB = fieldAccess({
    userId: memberBUser.id,
    businessId: businessA.id,
    membershipId: memberB.id,
    role: "MEMBER",
    name: memberBUser.name,
    email: memberBUser.email,
  });
  const accessBeta = fieldAccess({
    userId: betaUser.id,
    businessId: businessB.id,
    membershipId: betaMembership.id,
    role: "MEMBER",
    name: betaUser.name,
    email: betaUser.email,
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
  check("Workers can opt in and register a token on their active membership", registeredA.ok && registeredA.preference.optedIn);
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
  const registerAfterDeactivate = await registerNativePushDevice(prisma, accessA, {
    token: `device-token-ava-after-${randomUUID()}`,
    platform: "test",
    optedIn: true,
  });
  check(
    "Inactive membership cannot register a new device token",
    registerAfterDeactivate.ok === false &&
      registerAfterDeactivate.status === 403 &&
      registerAfterDeactivate.error === NATIVE_PUSH_MEMBERSHIP_INACTIVE,
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
} finally {
  setNativePushProvider(null);
  if (previousAdapter == null) delete process.env.TBBT_NATIVE_PUSH_ADAPTER;
  else process.env.TBBT_NATIVE_PUSH_ADAPTER = previousAdapter;
  await session.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
