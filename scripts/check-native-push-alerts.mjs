/**
 * Opt-in native Handyman job alerts — fake provider proofs.
 *
 * Dedicated local disposable database (name prefix tbbt_native_push_alerts).
 *
 * Proves device register/revoke per active membership, OWNER assignment
 * and material-reschedule alerts, reassignment, deactivation revoke,
 * tenant isolation, provider retries, and duplicate suppression. Payloads
 * stay informational and never include a customer address or access code.
 * Expo Push is the connected provider; this suite uses a fetch stand-in
 * and never calls the live Expo host. Real-device delivery is UNVERIFIED.
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
  DISCONNECTED_NATIVE_PUSH_PROVIDER,
  EXPO_NATIVE_PUSH_PROVIDER,
  EXPO_PUSH_API_ORIGIN,
  EXPO_PUSH_SEND_PATH,
  EXPO_PUSH_SEND_URL,
  EXPO_PUSH_TOKEN_PATTERN,
  FAKE_NATIVE_PUSH_PROVIDER,
  NATIVE_PUSH_ALERT_DISCLAIMER,
  NATIVE_PUSH_DEVICE_NOT_OWNED,
  NATIVE_PUSH_FORBIDDEN_PAYLOAD_KEYS,
  NATIVE_PUSH_DEVICE_TOKEN_HEADER,
  NATIVE_PUSH_EXPO_TOKEN_REQUIRED,
  NATIVE_PUSH_MAX_ATTEMPTS,
  NATIVE_PUSH_MEMBERSHIP_INACTIVE,
  NATIVE_PUSH_PENDING_STALE_MS,
  NATIVE_PUSH_SEND_TIMEOUT_MS,
  assignmentAlertIdempotencyKey,
  buildNativePushAlertPayload,
  createExpoNativePushProvider,
  createFakeNativePushProvider,
  expoPushMessageFromAlert,
  expoFailureRevokesDevice,
  flushNativePushNotifies,
  getNativePushProvider,
  hashNativePushDeviceToken,
  isExpoNativePushConfigured,
  isExpoPushToken,
  isFakeNativePushAdapterEnabled,
  isHandymanJobForNativePush,
  isNativePushConfigured,
  listNativePushPreference,
  nativePushAlertAction,
  nativePushPayloadHasForbiddenFields,
  notifyHandymanJobAssigned,
  notifyHandymanJobRescheduled,
  registerNativePushDevice,
  rescheduleAlertIdempotencyKey,
  resetNativePushProvider,
  resetNativePushSchemaEnsure,
  retryNativePushDelivery,
  revokeNativePushDevice,
  sanitizeNativePushFailureReason,
  setNativePushPendingStaleMs,
  setNativePushProvider,
} = await import("@/lib/native-push");
const { isMaterialAppointmentChange } = await import("@/lib/appointment-confirmation");
const { createSecureToken, hashToken } = await import("@/lib/auth-crypto");
const { resolveNativeSession, revokeNativeSession } = await import("@/lib/native-session");
const {
  NATIVE_PUSH_PERMISSION_DENIED,
  NATIVE_PUSH_TOKEN_UNAVAILABLE,
  resolveNativePushOptInToken,
} = await import(new URL("../apps/native/src/push-token-resolve.ts", import.meta.url).href);
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
const loaderSrc = readRepo("scripts/ts-alias-loader.mjs");
const passwordResetSrc = readRepo("src/lib/password-reset.ts");
const authSrc = readRepo("src/lib/auth.ts");
const fakeSrc = readRepo("src/lib/native-push/fake.ts");
const expoSrc = readRepo("src/lib/native-push/expo.ts");
const providerSrc = readRepo("src/lib/native-push/provider.ts");
const nativeApi = readRepo("apps/native/src/api.ts");
const todaySrc = readRepo("apps/native/src/screens/TodayScreen.tsx");
const appSrc = readRepo("apps/native/App.tsx");
const pushTokenSrc = readRepo("apps/native/src/push-token.ts");
const pushTokenResolveSrc = readRepo("apps/native/src/push-token-resolve.ts");
const nativeSessionSrc = readRepo("apps/native/src/session.ts");
const settingsSrc = readRepo("src/components/settings/settings-workspace.tsx");
const nativePkg = readRepo("apps/native/package.json");
const nativeEnvExample = readRepo("apps/native/.env.example");
const gitignore = readRepo(".gitignore");
const docsSrc = readRepo("docs/NATIVE_FIELD.md");
const envExample = readRepo(".env.example");
const checkSrc = readRepo("scripts/check-native-push-alerts.mjs");
const preflightSrc = readRepo("src/lib/founder-production-preflight.ts");

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
    envExample.includes("TBBT_NATIVE_PUSH_ADAPTER=fake") &&
    envExample.includes("EXPO_ACCESS_TOKEN") &&
    !/\nEXPO_ACCESS_TOKEN=[^\n"]+/.test(`\n${envExample}`) &&
    gitignore.includes(".env*") &&
    gitignore.includes("!.env.example") &&
    preflightSrc.includes('"EXPO_ACCESS_TOKEN"'),
);
check(
  "Expo Push is the connected provider behind EXPO_ACCESS_TOKEN",
  configSrc.includes("EXPO_NATIVE_PUSH_PROVIDER") &&
    configSrc.includes("getExpoAccessToken") &&
    providerSrc.includes("createExpoNativePushProvider") &&
    providerSrc.includes("isExpoNativePushConfigured") &&
    expoSrc.includes(EXPO_PUSH_API_ORIGIN) &&
    expoSrc.includes(EXPO_PUSH_SEND_PATH) &&
    expoSrc.includes("Bearer") &&
    expoSrc.includes("nativePushPayloadHasForbiddenFields") &&
    expoSrc.includes("isExpoPushToken") &&
    EXPO_PUSH_SEND_URL === "https://exp.host/--/api/v2/push/send" &&
    !expoSrc.includes("fcm.googleapis.com") &&
    !expoSrc.includes("api.push.apple.com"),
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
  "ts-alias-loader mocks next/server so notify.ts can load in Node suites",
  loaderSrc.includes('specifier === "next/server"') &&
    loaderSrc.includes("./mocks/next-server.mjs"),
);
check(
  "after() outside a request scope falls back to fire-and-forget",
  notifySrc.includes("try {") &&
    notifySrc.includes("after(() => runNotifyWork(work))") &&
    notifySrc.includes("void runNotifyWork(work)"),
);
check(
  "Password reset and getSessionUser revoke devices before deleting sessions",
  passwordResetSrc.includes("revokeNativePushDevicesForSessions") &&
    passwordResetSrc.indexOf("revokeNativePushDevicesForSessions") <
      passwordResetSrc.indexOf("session.deleteMany") &&
    authSrc.includes("revokeNativePushDevicesForSessions") &&
    authSrc.indexOf("revokeNativePushDevicesForSessions") < authSrc.indexOf("session.delete") &&
    fakeSrc.includes("setHangNext") &&
    notifySrc.includes("withTimeout(NATIVE_PUSH_SEND_TIMEOUT_MS"),
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
  "Native UI stays informational; Expo token registration does not start time",
  todaySrc.includes("never starts your time or accepts an appointment") &&
    nativeApi.includes("/api/native/v1/push-devices") &&
    settingsSrc.includes("Worker assignment alerts are opted in on the field app") &&
    nativePkg.includes("expo-notifications") &&
    nativeSessionSrc.includes("readExpoPushToken") &&
    !nativeSessionSrc.includes("randomDeviceToken") &&
    nativeSessionSrc.includes("readOptInNativePushDeviceToken") &&
    pushTokenSrc.includes("getExpoPushTokenAsync") &&
    pushTokenSrc.includes("jobIdFromNativePushNotification") &&
    pushTokenResolveSrc.includes("ExponentPushToken|ExpoPushToken") &&
    todaySrc.includes("readOptInNativePushDeviceToken") &&
    todaySrc.includes("resolved.error") &&
    todaySrc.includes("thisDeviceOptedIn: false") &&
    devicesSrc.includes("NATIVE_PUSH_EXPO_TOKEN_REQUIRED") &&
    notifySrc.includes("revokeDevice") &&
    assignSrc.includes("enqueueNativePushNotify") &&
    appSrc.includes("jobIdFromNativePushNotification") &&
    appSrc.includes("addNotificationResponseReceivedListener") &&
    !appSrc.includes("startNativeJob") &&
    !notifySrc.includes("notifyTeamEvents") &&
    nativeEnvExample.includes("EXPO_PUBLIC_PROJECT_ID") &&
    !nativeEnvExample.includes("EXPO_ACCESS_TOKEN") &&
    todaySrc.includes("requestPermission: true") &&
    todaySrc.includes("nativePushPlatform(Platform.OS)"),
);
check(
  "Docs mark real-device Expo delivery UNVERIFIED",
  docsSrc.includes("UNVERIFIED") &&
    docsSrc.includes("EXPO_ACCESS_TOKEN") &&
    docsSrc.includes("never includes a customer address or access code"),
);
check(
  "Fake-provider proofs still cover revoke, opt-out, inactive membership, reassignment, and delivery failure",
  checkSrc.includes("Worker can revoke their own device token") &&
    checkSrc.includes("Revoked / opted-out worker does not receive an assignment alert") &&
    checkSrc.includes("Deactivation revokes every device token on that membership") &&
    checkSrc.includes("Inactive membership cannot register a new device token") &&
    checkSrc.includes("Reassignment alerts only the new worker") &&
    checkSrc.includes("Assignment still commits when the fake provider rejects"),
);
check(
  "Suite covers permission denial, missing Expo token, Expo 4xx, and DeviceNotRegistered prune",
  checkSrc.includes("Denied notification permission does not invent a device token") &&
    checkSrc.includes("Missing Expo token does not fall back to a random device token") &&
    checkSrc.includes("Expo path rejects non-Expo-shaped tokens with a clear 4xx") &&
    checkSrc.includes("DeviceNotRegistered revokes only that device row") &&
    checkSrc.includes("Later alerts skip the DeviceNotRegistered row") &&
    checkSrc.includes("MessageRateExceeded records FAILED without revoking the device") &&
    checkSrc.includes("Network Expo failure records FAILED without revoking the device"),
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

const previousExpoToken = process.env.EXPO_ACCESS_TOKEN;
process.env.EXPO_ACCESS_TOKEN = "expo_test_access_token_not_real";
resetNativePushProvider();
check("Fake adapter still wins over Expo credentials in non-production", getNativePushProvider().id === FAKE_NATIVE_PUSH_PROVIDER);
delete process.env.TBBT_NATIVE_PUSH_ADAPTER;
resetNativePushProvider();
check("Expo credentials connect the Expo adapter when fake is off", getNativePushProvider().id === EXPO_NATIVE_PUSH_PROVIDER && isExpoNativePushConfigured() === true && isNativePushConfigured() === true);
process.env.VERCEL_ENV = "production";
process.env.TBBT_NATIVE_PUSH_ADAPTER = "fake";
resetNativePushProvider();
check(
  "Production with Expo credentials uses Expo, not fake",
  isFakeNativePushAdapterEnabled() === false && getNativePushProvider().id === EXPO_NATIVE_PUSH_PROVIDER,
);
delete process.env.EXPO_ACCESS_TOKEN;
resetNativePushProvider();
check(
  "Production without Expo credentials stays disconnected",
  getNativePushProvider().id === DISCONNECTED_NATIVE_PUSH_PROVIDER &&
    getNativePushProvider().connected === false &&
    isNativePushConfigured() === false,
);
if (previousVercel) process.env.VERCEL_ENV = previousVercel;
else delete process.env.VERCEL_ENV;
if (previousExpoToken == null) delete process.env.EXPO_ACCESS_TOKEN;
else process.env.EXPO_ACCESS_TOKEN = previousExpoToken;
process.env.TBBT_NATIVE_PUSH_ADAPTER = "fake";
resetNativePushProvider();

const expoToken = "ExponentPushToken[tbbt-test-device]";
check("Expo token helper accepts official Expo token shapes", isExpoPushToken(expoToken) && isExpoPushToken("ExpoPushToken[abc]") && !isExpoPushToken("device-token-ava"));
const denied = resolveNativePushOptInToken({
  permissionGranted: false,
  expoToken: null,
  requirePermission: true,
});
check(
  "Denied notification permission does not invent a device token",
  denied.ok === false &&
    denied.reason === "permission-denied" &&
    denied.error === NATIVE_PUSH_PERMISSION_DENIED,
);
const missingToken = resolveNativePushOptInToken({
  permissionGranted: true,
  expoToken: null,
  storedToken: "device-token-random-fallback",
  requirePermission: true,
});
check(
  "Missing Expo token does not fall back to a random device token",
  missingToken.ok === false &&
    missingToken.reason === "token-unavailable" &&
    missingToken.error === NATIVE_PUSH_TOKEN_UNAVAILABLE,
);
const storedExpo = resolveNativePushOptInToken({
  permissionGranted: true,
  expoToken: null,
  storedToken: expoToken,
});
check("Stored Expo token can be reused when the live read is empty", storedExpo.ok && storedExpo.token === expoToken);
check(
  "Failure reasons redact raw Expo tokens",
  sanitizeNativePushFailureReason(`failed ${expoToken}`) === "failed ExponentPushToken[redacted]" &&
    !sanitizeNativePushFailureReason(`failed ${expoToken}`).includes("tbbt-test-device"),
);
check("DeviceNotRegistered is the only Expo ticket that revokes", expoFailureRevokesDevice("DeviceNotRegistered") && !expoFailureRevokesDevice("MessageRateExceeded"));
const samplePayload = buildNativePushAlertPayload({ kind: "JOB_ASSIGNED", jobId: "job_expo" });
const expoMessage = expoPushMessageFromAlert({
  businessId: "biz",
  membershipId: "mem",
  jobId: samplePayload.jobId,
  kind: samplePayload.kind,
  deviceId: "dev",
  tokenLast4: "vice",
  deviceToken: expoToken,
  payload: samplePayload,
});
check(
  "Expo message data is job id + flags only",
  expoMessage.data.jobId === "job_expo" &&
    expoMessage.data.informational === true &&
    expoMessage.data.startsTime === false &&
    expoMessage.data.acceptsAppointment === false &&
    !Object.prototype.hasOwnProperty.call(expoMessage.data, "address") &&
    !Object.prototype.hasOwnProperty.call(expoMessage.data, "propertyAccessInstructions") &&
    !JSON.stringify(expoMessage).includes("address") &&
    !JSON.stringify(expoMessage).includes("accessCode"),
);

let expoFetches = 0;
let lastExpoUrl = "";
let lastExpoHeaders = {};
let lastExpoBody = "";
const expoTicketId = "expo-ticket-test-1";
const expo = createExpoNativePushProvider(
  { accessToken: "expo_test_access_token_not_real" },
  async (url, init) => {
    expoFetches += 1;
    lastExpoUrl = url;
    lastExpoHeaders = init.headers;
    lastExpoBody = init.body;
    return {
      ok: true,
      status: 200,
      async json() {
        return { data: [{ status: "ok", id: expoTicketId }] };
      },
    };
  },
);
const expoSent = await expo.send({
  businessId: "biz",
  membershipId: "mem",
  jobId: samplePayload.jobId,
  kind: samplePayload.kind,
  deviceId: "dev",
  tokenLast4: "vice",
  deviceToken: expoToken,
  payload: samplePayload,
});
check("Expo adapter reports SENT with the provider ticket id", expoSent.ok && expoSent.status === "SENT" && expoSent.providerMessageId === expoTicketId);
check(
  "Expo send uses the official host, Bearer token, and no address/access",
  lastExpoUrl === EXPO_PUSH_SEND_URL &&
    lastExpoHeaders.Authorization === "Bearer expo_test_access_token_not_real" &&
    lastExpoHeaders["Content-Type"] === "application/json" &&
    !lastExpoBody.includes("address") &&
    !lastExpoBody.includes("accessCode") &&
    !lastExpoBody.includes("42 Secret Garden") &&
    lastExpoBody.includes(expoToken) &&
    lastExpoBody.includes(samplePayload.jobId),
);

const expoFetchesAfterOk = expoFetches;
const localTokenFailed = await expo.send({
  businessId: "biz",
  membershipId: "mem",
  jobId: samplePayload.jobId,
  kind: samplePayload.kind,
  deviceId: "dev",
  tokenLast4: "oken",
  deviceToken: "device-token-not-expo",
  payload: samplePayload,
});
check(
  "Non-Expo token is refused without calling Expo",
  localTokenFailed.ok === false &&
    localTokenFailed.status === "FAILED" &&
    expoFetches === expoFetchesAfterOk,
);

const forbiddenFailed = await expo.send({
  businessId: "biz",
  membershipId: "mem",
  jobId: samplePayload.jobId,
  kind: samplePayload.kind,
  deviceId: "dev",
  tokenLast4: "vice",
  deviceToken: expoToken,
  payload: { ...samplePayload, address: "42 Secret Garden" },
});
check(
  "Forbidden address field is refused without calling Expo",
  forbiddenFailed.ok === false &&
    forbiddenFailed.status === "FAILED" &&
    expoFetches === expoFetchesAfterOk &&
    /forbidden/i.test(forbiddenFailed.error),
);

const failingExpo = createExpoNativePushProvider(
  { accessToken: "expo_test_access_token_not_real" },
  async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        data: [{ status: "error", message: "Device not registered", details: { error: "DeviceNotRegistered" } }],
      };
    },
  }),
);
const expoFailed = await failingExpo.send({
  businessId: "biz",
  membershipId: "mem",
  jobId: samplePayload.jobId,
  kind: samplePayload.kind,
  deviceId: "dev",
  tokenLast4: "vice",
  deviceToken: expoToken,
  payload: samplePayload,
});
check(
  "Expo DeviceNotRegistered is recorded as FAILED and asks to revoke the device",
  expoFailed.ok === false &&
    expoFailed.status === "FAILED" &&
    expoFailed.revokeDevice === true &&
    /no longer registered/i.test(expoFailed.error) &&
    !expoFailed.error.includes(expoToken),
);

const rateLimitedExpo = createExpoNativePushProvider(
  { accessToken: "expo_test_access_token_not_real" },
  async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        data: [{ status: "error", message: "slow down", details: { error: "MessageRateExceeded" } }],
      };
    },
  }),
);
const rateLimited = await rateLimitedExpo.send({
  businessId: "biz",
  membershipId: "mem",
  jobId: samplePayload.jobId,
  kind: samplePayload.kind,
  deviceId: "dev",
  tokenLast4: "vice",
  deviceToken: expoToken,
  payload: samplePayload,
});
check(
  "MessageRateExceeded fails without revoking the device",
  rateLimited.ok === false && rateLimited.status === "FAILED" && rateLimited.revokeDevice !== true,
);

const networkExpo = createExpoNativePushProvider(
  { accessToken: "expo_test_access_token_not_real" },
  async () => {
    throw new Error("network down");
  },
);
const networkFailed = await networkExpo.send({
  businessId: "biz",
  membershipId: "mem",
  jobId: samplePayload.jobId,
  kind: samplePayload.kind,
  deviceId: "dev",
  tokenLast4: "vice",
  deviceToken: expoToken,
  payload: samplePayload,
});
check(
  "Network Expo failure does not revoke the device",
  networkFailed.ok === false && networkFailed.status === "FAILED" && networkFailed.revokeDevice !== true,
);

console.log("  note - Real-device Expo delivery is UNVERIFIED until a physical device is available.");

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

  const previousFakeForReject = process.env.TBBT_NATIVE_PUSH_ADAPTER;
  const previousExpoForReject = process.env.EXPO_ACCESS_TOKEN;
  delete process.env.TBBT_NATIVE_PUSH_ADAPTER;
  process.env.EXPO_ACCESS_TOKEN = "expo_test_access_token_not_real";
  const rejectedNonExpo = await registerNativePushDevice(prisma, accessA, {
    token: "device-token-not-expo-shape",
    platform: "test",
    optedIn: true,
  });
  const rejectedNonExpoRow = await prisma.nativePushDevice.findFirst({
    where: { tokenHash: hashNativePushDeviceToken("device-token-not-expo-shape") },
  });
  const acceptedExpoShape = await registerNativePushDevice(prisma, accessA, {
    token: "ExponentPushToken[tbbt-register-shape]",
    platform: "expo",
    optedIn: true,
  });
  check(
    "Expo path rejects non-Expo-shaped tokens with a clear 4xx",
    !rejectedNonExpo.ok &&
      rejectedNonExpo.status === 400 &&
      rejectedNonExpo.error === NATIVE_PUSH_EXPO_TOKEN_REQUIRED &&
      !rejectedNonExpoRow,
  );
  check("Expo path still accepts official Expo token shapes", acceptedExpoShape.ok === true);
  await prisma.nativePushDevice.deleteMany({
    where: {
      membershipId: memberA.id,
      tokenHash: hashNativePushDeviceToken("ExponentPushToken[tbbt-register-shape]"),
    },
  });
  if (previousFakeForReject == null) delete process.env.TBBT_NATIVE_PUSH_ADAPTER;
  else process.env.TBBT_NATIVE_PUSH_ADAPTER = previousFakeForReject;
  if (previousExpoForReject == null) delete process.env.EXPO_ACCESS_TOKEN;
  else process.env.EXPO_ACCESS_TOKEN = previousExpoForReject;
  setNativePushProvider(fake);

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

  const expoDeviceToken = "ExponentPushToken[tbbt-ava-assignment]";
  const expoRegistered = await registerNativePushDevice(prisma, accessA, {
    token: expoDeviceToken,
    platform: "expo",
    optedIn: true,
  });
  let expoNotifyFetches = 0;
  let expoNotifyBody = "";
  const expoNotify = createExpoNativePushProvider(
    { accessToken: "expo_test_access_token_not_real" },
    async (_url, init) => {
      expoNotifyFetches += 1;
      expoNotifyBody = init.body;
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: [{ status: "ok", id: "expo-ticket-assignment-1" }] };
        },
      };
    },
  );
  setNativePushProvider(expoNotify);
  const expoAssignJob = await createHandymanJob("expo-assign");
  const expoAssigned = await writeAssignedMembershipAndLaneWindows(prisma, {
    businessId: businessA.id,
    job: expoAssignJob,
    nextAssignedMembershipId: memberA.id,
    actorMembershipId: ownerMembership.id,
  });
  const expoDelivery = await prisma.nativePushDelivery.findFirst({
    where: { jobId: expoAssignJob.id, kind: "JOB_ASSIGNED" },
  });
  check("OWNER assignment through Expo still commits", !expoAssigned?.error);
  check(
    "Opted-in Expo token is sent once through the official Expo path",
    expoNotifyFetches === 1 &&
      expoDelivery?.status === "SENT" &&
      expoDelivery?.provider === EXPO_NATIVE_PUSH_PROVIDER &&
      expoNotifyBody.includes(expoDeviceToken) &&
      expoNotifyBody.includes(expoAssignJob.id) &&
      !expoNotifyBody.includes("42 Secret Garden") &&
      !expoNotifyBody.includes("4821") &&
      !expoNotifyBody.includes("accessCode"),
  );
  await prisma.nativePushDevice.deleteMany({
    where: {
      membershipId: memberA.id,
      tokenHash: hashNativePushDeviceToken(expoDeviceToken),
    },
  });
  setNativePushProvider(fake);

  const deadExpoToken = "ExponentPushToken[tbbt-dead-device]";
  const keepExpoToken = "ExponentPushToken[tbbt-keep-device]";
  await prisma.nativePushDevice.updateMany({
    where: { membershipId: memberA.id, tokenHash: hashNativePushDeviceToken(tokenA) },
    data: { optedIn: false },
  });
  const deadRegistered = await registerNativePushDevice(prisma, accessA, {
    token: deadExpoToken,
    platform: "expo",
    optedIn: true,
  });
  check("Dead Expo token can register for prune proofs", deadRegistered.ok === true);
  const deadExpo = createExpoNativePushProvider(
    { accessToken: "expo_test_access_token_not_real" },
    async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          data: [
            {
              status: "error",
              message: `Device ${deadExpoToken} is gone`,
              details: { error: "DeviceNotRegistered" },
            },
          ],
        };
      },
    }),
  );
  setNativePushProvider(deadExpo);
  const deadAssignJob = await createHandymanJob("expo-dead");
  const deadAssigned = await writeAssignedMembershipAndLaneWindows(prisma, {
    businessId: businessA.id,
    job: deadAssignJob,
    nextAssignedMembershipId: memberA.id,
    actorMembershipId: ownerMembership.id,
  });
  const deadJobRow = await prisma.job.findFirst({ where: { id: deadAssignJob.id } });
  const deadDelivery = await prisma.nativePushDelivery.findFirst({
    where: { jobId: deadAssignJob.id, kind: "JOB_ASSIGNED" },
  });
  const deadDeviceRow = await prisma.nativePushDevice.findFirst({
    where: { membershipId: memberA.id, tokenHash: hashNativePushDeviceToken(deadExpoToken) },
  });
  check(
    "DeviceNotRegistered records FAILED and still commits the assignment",
    !deadAssigned?.error &&
      deadJobRow?.assignedMembershipId === memberA.id &&
      deadDelivery?.status === "FAILED" &&
      typeof deadDelivery?.failureReason === "string" &&
      !deadDelivery.failureReason.includes(deadExpoToken) &&
      !deadDelivery.failureReason.includes("tbbt-dead-device"),
  );
  check(
    "DeviceNotRegistered revokes only that device row",
    deadDeviceRow?.optedIn === false && deadDeviceRow?.revokedAt instanceof Date,
  );

  const keepRegistered = await registerNativePushDevice(prisma, accessA, {
    token: keepExpoToken,
    platform: "expo",
    optedIn: true,
  });
  check("Keep Expo token can register after the dead row is revoked", keepRegistered.ok === true);
  const laterExpoBodies = [];
  const laterExpo = createExpoNativePushProvider(
    { accessToken: "expo_test_access_token_not_real" },
    async (_url, init) => {
      laterExpoBodies.push(init.body);
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: [{ status: "ok", id: "expo-ticket-keep-later-1" }] };
        },
      };
    },
  );
  setNativePushProvider(laterExpo);
  const laterAssignJob = await createHandymanJob("expo-later");
  const laterAssigned = await writeAssignedMembershipAndLaneWindows(prisma, {
    businessId: businessA.id,
    job: laterAssignJob,
    nextAssignedMembershipId: memberA.id,
    actorMembershipId: ownerMembership.id,
  });
  const laterDelivery = await prisma.nativePushDelivery.findFirst({
    where: { jobId: laterAssignJob.id, kind: "JOB_ASSIGNED" },
  });
  const keepAfterLater = await prisma.nativePushDevice.findFirst({
    where: { membershipId: memberA.id, tokenHash: hashNativePushDeviceToken(keepExpoToken) },
  });
  const deadAfterLater = await prisma.nativePushDevice.findFirst({
    where: { membershipId: memberA.id, tokenHash: hashNativePushDeviceToken(deadExpoToken) },
  });
  const leftoverAAfterLater = await prisma.nativePushDevice.findFirst({
    where: { membershipId: memberA.id, tokenHash: hashNativePushDeviceToken(tokenA) },
  });
  check(
    "Later alerts skip the DeviceNotRegistered row and do not select leftover fake tokens",
    !laterAssigned?.error &&
      laterDelivery?.status === "SENT" &&
      laterExpoBodies.length === 1 &&
      laterExpoBodies[0].includes(keepExpoToken) &&
      !laterExpoBodies[0].includes(deadExpoToken) &&
      !laterExpoBodies[0].includes(tokenA) &&
      keepAfterLater?.optedIn === true &&
      keepAfterLater?.revokedAt == null &&
      deadAfterLater?.optedIn === false &&
      deadAfterLater?.revokedAt instanceof Date &&
      leftoverAAfterLater?.optedIn === false &&
      leftoverAAfterLater?.revokedAt == null,
  );

  const rateExpo = createExpoNativePushProvider(
    { accessToken: "expo_test_access_token_not_real" },
    async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          data: [{ status: "error", message: "slow down", details: { error: "MessageRateExceeded" } }],
        };
      },
    }),
  );
  setNativePushProvider(rateExpo);
  const rateAssignJob = await createHandymanJob("expo-rate");
  const rateAssigned = await writeAssignedMembershipAndLaneWindows(prisma, {
    businessId: businessA.id,
    job: rateAssignJob,
    nextAssignedMembershipId: memberA.id,
    actorMembershipId: ownerMembership.id,
  });
  const rateDelivery = await prisma.nativePushDelivery.findFirst({
    where: { jobId: rateAssignJob.id, kind: "JOB_ASSIGNED" },
  });
  const keepAfterRate = await prisma.nativePushDevice.findFirst({
    where: { membershipId: memberA.id, tokenHash: hashNativePushDeviceToken(keepExpoToken) },
  });
  check(
    "MessageRateExceeded records FAILED without revoking the device",
    !rateAssigned?.error &&
      rateDelivery?.status === "FAILED" &&
      keepAfterRate?.optedIn === true &&
      keepAfterRate?.revokedAt == null,
  );

  const networkDbExpo = createExpoNativePushProvider(
    { accessToken: "expo_test_access_token_not_real" },
    async () => {
      throw new Error("network down");
    },
  );
  setNativePushProvider(networkDbExpo);
  const networkAssignJob = await createHandymanJob("expo-network");
  const networkAssigned = await writeAssignedMembershipAndLaneWindows(prisma, {
    businessId: businessA.id,
    job: networkAssignJob,
    nextAssignedMembershipId: memberA.id,
    actorMembershipId: ownerMembership.id,
  });
  const networkDelivery = await prisma.nativePushDelivery.findFirst({
    where: { jobId: networkAssignJob.id, kind: "JOB_ASSIGNED" },
  });
  const keepAfterNetwork = await prisma.nativePushDevice.findFirst({
    where: { membershipId: memberA.id, tokenHash: hashNativePushDeviceToken(keepExpoToken) },
  });
  check(
    "Network Expo failure records FAILED without revoking the device",
    !networkAssigned?.error &&
      networkDelivery?.status === "FAILED" &&
      keepAfterNetwork?.optedIn === true &&
      keepAfterNetwork?.revokedAt == null,
  );

  await prisma.nativePushDevice.deleteMany({
    where: {
      membershipId: memberA.id,
      tokenHash: {
        in: [hashNativePushDeviceToken(deadExpoToken), hashNativePushDeviceToken(keepExpoToken)],
      },
    },
  });
  await prisma.nativePushDevice.updateMany({
    where: { membershipId: memberA.id, tokenHash: hashNativePushDeviceToken(tokenA) },
    data: { optedIn: true, revokedAt: null },
  });
  setNativePushProvider(fake);

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

  const resetUser = await prisma.user.create({
    data: { name: "Reset Worker", email: "reset@native-push.example", passwordHash: "x" },
  });
  const resetMembership = await prisma.membership.create({
    data: { userId: resetUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const resetSession = await prisma.session.create({
    data: {
      tokenHash: hashToken(`reset-session-${randomUUID()}`),
      userId: resetUser.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  const resetDeviceToken = `device-token-reset-${randomUUID()}`;
  await registerNativePushDevice(
    prisma,
    {
      ...fieldAccess({
        userId: resetUser.id,
        businessId: businessA.id,
        membershipId: resetMembership.id,
        role: "MEMBER",
        name: resetUser.name,
        email: resetUser.email,
        sessionId: resetSession.id,
      }),
    },
    { token: resetDeviceToken, platform: "test", optedIn: true },
  );
  const resetRaw = createSecureToken();
  await prisma.passwordResetToken.create({
    data: {
      userId: resetUser.id,
      tokenHash: hashToken(resetRaw),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  const { completePasswordResetOp } = await import("@/lib/password-reset");
  const resetResult = await completePasswordResetOp(prisma, {
    token: resetRaw,
    password: "new-password-9",
    confirmPassword: "new-password-9",
  });
  const resetDevice = await prisma.nativePushDevice.findFirst({
    where: {
      membershipId: resetMembership.id,
      tokenHash: hashNativePushDeviceToken(resetDeviceToken),
    },
  });
  check(
    "Password reset revokes devices before deleting sessions",
    resetResult.ok === true &&
      (await prisma.session.count({ where: { userId: resetUser.id } })) === 0 &&
      resetDevice?.revokedAt != null &&
      resetDevice?.optedIn === false,
  );

  const authExpireRaw = createSecureToken();
  const authExpireUser = await prisma.user.create({
    data: { name: "Expire Worker", email: "expire@native-push.example", passwordHash: "x" },
  });
  const authExpireMembership = await prisma.membership.create({
    data: { userId: authExpireUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const authExpireSession = await prisma.session.create({
    data: {
      tokenHash: hashToken(authExpireRaw),
      userId: authExpireUser.id,
      expiresAt: new Date(Date.now() - 60_000),
    },
  });
  const authExpireToken = `device-token-auth-expire-${randomUUID()}`;
  await registerNativePushDevice(
    prisma,
    fieldAccess({
      userId: authExpireUser.id,
      businessId: businessA.id,
      membershipId: authExpireMembership.id,
      role: "MEMBER",
      name: authExpireUser.name,
      email: authExpireUser.email,
      sessionId: authExpireSession.id,
    }),
    { token: authExpireToken, platform: "test", optedIn: true },
  );
  const { getSessionUser, SESSION_COOKIE } = await import("@/lib/auth");
  const { setTestCookies } = await import("next/headers");
  setTestCookies({ [SESSION_COOKIE]: authExpireRaw });
  const expiredSessionUser = await getSessionUser();
  const authExpireDevice = await prisma.nativePushDevice.findFirst({
    where: {
      membershipId: authExpireMembership.id,
      tokenHash: hashNativePushDeviceToken(authExpireToken),
    },
  });
  check(
    "getSessionUser revokes devices before deleting an expired session",
    expiredSessionUser === null &&
      authExpireDevice?.revokedAt != null &&
      authExpireDevice?.optedIn === false,
  );
  setTestCookies({});

  const hangJob = await createHandymanJob("hanging-provider");
  await prisma.job.update({
    where: { id: hangJob.id },
    data: { assignedMembershipId: memberA.id },
  });
  fake.sent.length = 0;
  fake.setHangNext(true);
  const hangStarted = Date.now();
  const hangResult = await Promise.race([
    notifyHandymanJobAssigned(prisma, {
      businessId: businessA.id,
      jobId: hangJob.id,
      previousMembershipId: null,
      nextMembershipId: memberA.id,
      actorMembershipId: ownerMembership.id,
    }),
    new Promise((resolve) =>
      setTimeout(() => resolve({ status: "HUNG", sentCount: 0 }), 7_000),
    ),
  ]);
  const hangElapsed = Date.now() - hangStarted;
  const hangDelivery = await prisma.nativePushDelivery.findFirst({
    where: { jobId: hangJob.id, kind: "JOB_ASSIGNED" },
  });
  fake.setHangNext(false);
  check(
    "Hanging provider fails within ~5s instead of hanging forever",
    hangResult.status === "FAILED" &&
      String(hangResult.reason ?? "").includes("timed out") &&
      hangElapsed >= 4_000 &&
      hangElapsed < 7_000 &&
      hangDelivery?.status === "FAILED",
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
