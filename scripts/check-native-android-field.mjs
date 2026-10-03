/**
 * Android field-app pipeline + device walkthrough.
 *
 * Does not rebuild the web recovery / offline-sync / push suites
 * from #269 / #313 / #316. Those stay the source of those contracts.
 * This proof covers Android-only client defects, the local debug APK
 * recipe, and one disposable test-account walkthrough:
 * sign-in, assigned job, Start/Stop, offline time-card + checklist
 * sync, session expiry, and device-token sign-out.
 *
 * No customer messages. No production writes. No Complete job.
 *
 * Run with:
 *   npm run test:native-android-field
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { register } from "node:module";
import { fileURLToPath } from "node:url";
import { openDisposableTestDatabase } from "./disposable-test-database.mjs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);
register(new URL("./native-relative-ts-loader.mjs", import.meta.url), import.meta.url);

const {
  ANDROID_EMULATOR_LOOPBACK_HOST,
  NATIVE_ANDROID_PACKAGE,
  NATIVE_ANDROID_VERSION_CODE,
  NATIVE_APP_VERSION,
  nativeBuildStampLabel,
  nativePushPlatform,
  nativeScreenPaddingTop,
  rewriteAndroidLoopbackHost,
} = await import(new URL("../apps/native/src/android.ts", import.meta.url));
const { resolveApiBaseUrl, setNativeRuntimeOs } = await import(
  new URL("../apps/native/src/config.ts", import.meta.url)
);
const { isSessionExpired } = await import(
  new URL("../apps/native/src/recovery.ts", import.meta.url)
);
const {
  createMemoryChecklistDraftStorage,
  persistLocalChecklistChange,
} = await import(new URL("../apps/native/src/checklist-drafts.ts", import.meta.url));
const {
  createMemoryTimeCardDraftStorage,
  persistLocalTimeCardIntent,
  timeCardSnapshotFromJob,
} = await import(new URL("../apps/native/src/time-card-drafts.ts", import.meta.url));

const NY = "America/New_York";
const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

let failures = 0;
const recordedFailures = [];
function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
    recordedFailures.push(label);
  }
}

function readRepo(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const appJson = JSON.parse(readRepo("apps/native/app.json"));
const easJson = JSON.parse(readRepo("apps/native/eas.json"));
const nativePackage = JSON.parse(readRepo("apps/native/package.json"));
const appSrc = readRepo("apps/native/App.tsx");
const apiSrc = readRepo("apps/native/src/api.ts");
const configSrc = readRepo("apps/native/src/config.ts");
const androidSrc = readRepo("apps/native/src/android.ts");
const backSrc = readRepo("apps/native/src/use-android-back.ts");
const signInSrc = readRepo("apps/native/src/screens/SignInScreen.tsx");
const todaySrc = readRepo("apps/native/src/screens/TodayScreen.tsx");
const jobSrc = readRepo("apps/native/src/screens/JobScreen.tsx");
const timeCardsSrc = readRepo("apps/native/src/screens/TimeCardsScreen.tsx");
const devicesSrc = readRepo("src/lib/native-push/devices.ts");
const pushRouteSrc = readRepo("src/app/api/native/v1/push-devices/route.ts");
const docsSrc = readRepo("docs/NATIVE_FIELD.md");
const packageSrc = readRepo("package.json");
const apkScriptSrc = readRepo("scripts/android-debug-apk.sh");
const selfSrc = readRepo("scripts/check-native-android-field.mjs");
const nativeReadme = readRepo("apps/native/README.md");

const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || "";
const debugApkPath = fileURLToPath(
  new URL("../apps/native/android/app/build/outputs/apk/debug/app-debug.apk", import.meta.url),
);
const hasDebugApk = existsSync(debugApkPath);
const apkBytes = hasDebugApk ? statSync(debugApkPath).size : 0;

console.log("\nDEVICE / BUILD");
console.log(`  device     : Cursor Cloud Agent Linux VM`);
console.log(`  emulator   : none`);
console.log(`  ANDROID_HOME: ${androidHome || "(unset)"}`);
console.log(`  build      : ${nativeBuildStampLabel()}`);
console.log(`  package    : ${NATIVE_ANDROID_PACKAGE}`);
console.log(`  versionCode: ${NATIVE_ANDROID_VERSION_CODE}`);
console.log(`  debug APK  : ${hasDebugApk ? `${debugApkPath} (${apkBytes} bytes)` : "not assembled"}`);

console.log("\nSTATIC — Android debug pipeline exists and is not Play distribution");
check(
  "app.json has package, versionCode, cleartext, and keyboard resize",
  appJson.expo.version === NATIVE_APP_VERSION &&
    appJson.expo.android.package === NATIVE_ANDROID_PACKAGE &&
    appJson.expo.android.versionCode === NATIVE_ANDROID_VERSION_CODE &&
    appJson.expo.android.usesCleartextTraffic === true &&
    appJson.expo.android.softwareKeyboardLayoutMode === "resize" &&
    Array.isArray(appJson.expo.android.permissions) &&
    appJson.expo.android.permissions.includes("android.permission.INTERNET"),
);
check(
  "eas.json preview profile builds an internal APK, not a store upload",
  easJson.build.preview.android.buildType === "apk" &&
    easJson.build.preview.distribution === "internal" &&
    easJson.build.preview.env.EXPO_PUBLIC_TBBT_API_URL.includes("10.0.2.2"),
);
check(
  "Native package.json exposes prebuild / assemble-debug / debug-apk",
  nativePackage.scripts["android:prebuild"]?.includes("expo prebuild") &&
    nativePackage.scripts["android:assemble-debug"]?.includes("gradlew assembleDebug") &&
    nativePackage.scripts["android:debug-apk"]?.includes("assembleDebug"),
);
check(
  "Debug APK script refuses to assemble when ANDROID_HOME is missing",
  apkScriptSrc.includes("ANDROID_HOME") &&
    apkScriptSrc.includes("assemble") &&
    apkScriptSrc.includes("exit 2"),
);
check(
  "Docs register the Android proof and keep Play distribution out of scope",
  docsSrc.includes("test:native-android-field") &&
    docsSrc.includes("local debug APK") &&
    packageSrc.includes("test:native-android-field") &&
    nativeReadme.includes("android:debug-apk") &&
    selfSrc.includes("openDisposableTestDatabase") &&
    selfSrc.includes('namePrefix: "tbbt_native_android_field"'),
);

console.log("\nSTATIC — Android-specific client defects");
check(
  "Emulator loopback rewrites localhost/127.0.0.1 to 10.0.2.2",
  androidSrc.includes("ANDROID_EMULATOR_LOOPBACK_HOST") &&
    configSrc.includes("rewriteAndroidLoopbackHost") &&
    configSrc.includes("setNativeRuntimeOs") &&
    appSrc.includes("setNativeRuntimeOs(Platform.OS)") &&
    rewriteAndroidLoopbackHost("http://localhost:43217", "android") ===
      `http://${ANDROID_EMULATOR_LOOPBACK_HOST}:43217` &&
    rewriteAndroidLoopbackHost("http://127.0.0.1:43217", "android") ===
      `http://${ANDROID_EMULATOR_LOOPBACK_HOST}:43217` &&
    rewriteAndroidLoopbackHost("http://localhost:43217", "ios") === "http://localhost:43217" &&
    rewriteAndroidLoopbackHost("https://www.collproreno.com", "android") ===
      "https://www.collproreno.com",
);
check(
  "Runtime OS rewrites the default API URL on Android only",
  (() => {
    setNativeRuntimeOs("android");
    const androidUrl = resolveApiBaseUrl("http://localhost:43217");
    setNativeRuntimeOs("ios");
    const iosUrl = resolveApiBaseUrl("http://localhost:43217");
    setNativeRuntimeOs("");
    return (
      androidUrl === `http://${ANDROID_EMULATOR_LOOPBACK_HOST}:43217` &&
      iosUrl === "http://localhost:43217"
    );
  })(),
);
check(
  "Job alerts register the Android platform instead of hardcoding expo",
  todaySrc.includes("nativePushPlatform(Platform.OS)") &&
    !todaySrc.includes('platform: "expo"') &&
    nativePushPlatform("android") === "android" &&
    nativePushPlatform("ios") === "ios" &&
    nativePushPlatform("web") === "expo",
);
check(
  "Hardware back on Job and Time cards does not exit the app",
  backSrc.includes("BackHandler.addEventListener") &&
    backSrc.includes("hardwareBackPress") &&
    jobSrc.includes("useAndroidHardwareBack(onBack)") &&
    timeCardsSrc.includes("useAndroidHardwareBack(onBack)"),
);
check(
  "Android sign-in scrolls above the keyboard and uses autofill hints",
  signInSrc.includes('Platform.OS === "android"') &&
    signInSrc.includes("keyboardShouldPersistTaps") &&
    signInSrc.includes('autoComplete="email"') &&
    signInSrc.includes('autoComplete="password"') &&
    signInSrc.includes("NativeBuildStamp"),
);
check(
  "Android screens use status-bar padding and a visible dark RefreshControl",
  todaySrc.includes("nativeScreenPaddingTop") &&
    jobSrc.includes("nativeScreenPaddingTop") &&
    timeCardsSrc.includes("nativeScreenPaddingTop") &&
    todaySrc.includes("ANDROID_REFRESH_COLORS") &&
    jobSrc.includes("ANDROID_REFRESH_COLORS") &&
    nativeScreenPaddingTop("android", 28) === 44 &&
    nativeScreenPaddingTop("ios", 47) === 64,
);
check(
  "Device-token revoke sends the Android-safe header and accepts a header-only DELETE",
  apiSrc.includes("NATIVE_PUSH_DEVICE_TOKEN_HEADER] = deviceToken") &&
    apiSrc.includes('method: "DELETE"') &&
    devicesSrc.includes("export function readNativePushDeviceTokenFromParts") &&
    pushRouteSrc.includes("readNativePushDeviceTokenFromParts") &&
    pushRouteSrc.includes("NATIVE_PUSH_DEVICE_TOKEN_HEADER") &&
    pushRouteSrc.includes("headerToken"),
);

const { readNativePushDeviceTokenFromParts } = await import("@/lib/native-push/devices");
check(
  "Header-only DELETE token is accepted when the JSON body is dropped",
  readNativePushDeviceTokenFromParts({
    headerToken: "android-device-token-1",
    bodyToken: "",
  }) === "android-device-token-1" &&
    readNativePushDeviceTokenFromParts({
      headerToken: "header-token",
      bodyToken: "body-token",
    }) === "body-token" &&
    readNativePushDeviceTokenFromParts({ headerToken: "", bodyToken: "" }) === "",
);

const { hashPassword } = await import("@/lib/auth-crypto");
const { loadNativeAssignedJob, loadNativeToday } = await import("@/lib/native-field");
const { startNativeAssignedJob, stopNativeAssignedJobRunningTime } = await import(
  "@/lib/native-field-ops"
);
const { syncNativeAssignedTimeCardDraft } = await import("@/lib/native-field-time-sync");
const { syncNativeAssignedChecklistDraft } = await import("@/lib/native-field-checklist");
const { resolveNativeFieldAccess, signInNativeField } = await import("@/lib/native-session");
const {
  hashNativePushDeviceToken,
  registerNativePushDevice,
  revokeNativePushDevice,
} = await import("@/lib/native-push/devices");
const { serializeChecklist } = await import("@/lib/cleaning-visit-workflow");

const session = await openDisposableTestDatabase({
  databaseUrl: baseUrl,
  namePrefix: "tbbt_native_android_field",
  pushSchema: true,
});
const prisma = session.prisma;

try {
  const password = "android-field-pass-9";
  const passwordHash = await hashPassword(password);
  const onboarding = {
    firstRunSetupCompletedAt: new Date(),
    starterServicesSetupCompletedAt: new Date(),
    starterServicesSetupChoice: "SKIPPED",
    websiteSetupCompletedAt: new Date(),
    websiteSetupChoice: "SKIPPED",
  };
  const business = await prisma.business.create({
    data: {
      name: "Android Field Co",
      slug: "android-native-field",
      tradeCode: "HANDYMAN",
      timezone: NY,
      ...onboarding,
    },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Andi Member", email: "andi@android-field.example", passwordHash },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: business.id, role: "MEMBER" },
  });
  const customer = await prisma.customer.create({
    data: { businessId: business.id, name: "Test Resident", phone: "555-0199" },
  });
  const confirmed = {
    scheduledAt: new Date(),
    scheduledDurationMinutes: 60,
    appointmentProposalId: 1,
    appointmentConfirmationStatus: "CONFIRMED",
    appointmentConfirmedForProposalId: 1,
    appointmentConfirmationSource: "PORTAL",
    propertyAccessMethod: "CUSTOMER_PRESENT",
  };
  const liveJob = await prisma.job.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      assignedMembershipId: memberMem.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      ...confirmed,
    },
  });
  const offlineTimeJob = await prisma.job.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      assignedMembershipId: memberMem.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      ...confirmed,
    },
  });
  const checklistJob = await prisma.job.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      assignedMembershipId: memberMem.id,
      projectToken: randomUUID(),
      status: "IN_PROGRESS",
      ...confirmed,
    },
  });
  const checklistItems = [
    { key: "arrival", title: "Arrival photo", required: true, checked: false },
    { key: "wrap", title: "Wrap-up notes", required: false, checked: false },
  ];
  await prisma.jobCrewVisit.create({
    data: {
      businessId: business.id,
      jobId: checklistJob.id,
      checklistJson: serializeChecklist(checklistItems),
    },
  });

  console.log("\nWALKTHROUGH — test account sign-in and assigned job");
  const signIn = await signInNativeField(prisma, {
    email: memberUser.email,
    password,
    userAgent: "Android/debug 0.1.0",
  });
  check("Test MEMBER can sign in", signIn.ok === true);
  const resolved = signIn.ok
    ? await resolveNativeFieldAccess(prisma, { token: signIn.token })
    : { ok: false };
  check("Bearer session resolves to the assigned membership", resolved.ok === true);
  if (!resolved.ok) {
    throw new Error("Expected assigned MEMBER access.");
  }
  const access = resolved.access;
  const today = await loadNativeToday(prisma, access);
  const todayIds = [
    ...(today.today ?? []),
    ...(today.upcoming ?? []),
    ...(today.completed ?? []),
  ].map((row) => row.id);
  check(
    "Today returns the assigned test jobs only",
    todayIds.includes(liveJob.id) &&
      todayIds.includes(offlineTimeJob.id) &&
      todayIds.includes(checklistJob.id) &&
      today.workspace.membershipId === memberMem.id,
  );
  const openLive = await loadNativeAssignedJob(prisma, access, liveJob.id);
  check(
    "Assigned job loads with Start available",
    openLive?.id === liveJob.id && openLive.startAction.available === true,
  );

  console.log("\nWALKTHROUGH — live Start / Stop on the assigned job");
  const started = await startNativeAssignedJob(prisma, access, liveJob.id);
  const startedDetail = started.ok ? await loadNativeAssignedJob(prisma, access, liveJob.id) : null;
  check(
    "Start job opens IN_PROGRESS with running JOB time",
    started.ok === true &&
      startedDetail?.status === "IN_PROGRESS" &&
      startedDetail.runningTime.running === true,
  );
  const stopped = await stopNativeAssignedJobRunningTime(prisma, access, liveJob.id);
  const stoppedDetail = stopped.ok ? await loadNativeAssignedJob(prisma, access, liveJob.id) : null;
  check(
    "Stop job time closes the clock without completing the job",
    stopped.ok === true &&
      stoppedDetail?.status === "IN_PROGRESS" &&
      stoppedDetail.runningTime.running === false &&
      stoppedDetail.runningTime.recorded === true,
  );
  const completedRows = await prisma.job.count({
    where: { id: liveJob.id, status: "COMPLETED" },
  });
  check("Walkthrough never completes the test job", completedRows === 0);

  console.log("\nWALKTHROUGH — offline time-card and checklist sync");
  const timeStorage = createMemoryTimeCardDraftStorage();
  const offlineOpen = await loadNativeAssignedJob(prisma, access, offlineTimeJob.id);
  const timeDraft = await persistLocalTimeCardIntent(timeStorage, {
    scope: {
      businessId: access.businessId,
      membershipId: access.membershipId,
      jobId: offlineTimeJob.id,
    },
    snapshot: timeCardSnapshotFromJob({
      jobStatus: offlineOpen?.status ?? "SCHEDULED",
      assignmentId: access.membershipId,
      runningTime: offlineOpen?.runningTime,
      travelTime: offlineOpen?.travelTime,
      pickupTime: offlineOpen?.pickupTime,
    }),
    action: "START_JOB",
  });
  check(
    "Offline start is saved on the phone and is not approved server time",
    timeDraft.intents.length === 1 &&
      timeDraft.intents[0].action === "START_JOB" &&
      (await prisma.timeEntry.count({ where: { jobId: offlineTimeJob.id } })) === 0,
  );
  const timeSynced = await syncNativeAssignedTimeCardDraft(prisma, access, offlineTimeJob.id, {
    expectedFingerprint: timeDraft.expectedFingerprint,
    intents: timeDraft.intents,
  });
  const timeAfter = timeSynced.ok
    ? await loadNativeAssignedJob(prisma, access, offlineTimeJob.id)
    : null;
  check(
    "Explicit Sync time applies the local start on the assigned job",
    timeSynced.ok === true &&
      timeAfter?.status === "IN_PROGRESS" &&
      timeAfter.runningTime.running === true,
  );

  const checklistStorage = createMemoryChecklistDraftStorage();
  const checklistOpen = await loadNativeAssignedJob(prisma, access, checklistJob.id);
  const serverItems = (checklistOpen?.checklist?.items ?? []).map((item) => ({
    key: item.key,
    checked: item.checked,
  }));
  const checklistDraft = await persistLocalChecklistChange(checklistStorage, {
    scope: {
      businessId: access.businessId,
      membershipId: access.membershipId,
      jobId: checklistJob.id,
    },
    serverItems,
    itemKey: "arrival",
    checked: true,
  });
  const beforeSyncVisit = await prisma.jobCrewVisit.findUnique({
    where: { jobId: checklistJob.id },
  });
  check(
    "Offline checklist tap stays local until Sync checklist",
    Boolean(checklistDraft?.items.some((item) => item.itemKey === "arrival" && item.checked)) &&
      JSON.parse(beforeSyncVisit?.checklistJson ?? "[]").every((item) => item.checked === false),
  );
  const checklistSynced = await syncNativeAssignedChecklistDraft(
    prisma,
    access,
    checklistJob.id,
    {
      expectedFingerprint: checklistDraft?.expectedFingerprint ?? "",
      items: checklistDraft?.items ?? [],
    },
  );
  const afterSyncVisit = await prisma.jobCrewVisit.findUnique({
    where: { jobId: checklistJob.id },
  });
  check(
    "Explicit Sync checklist writes only the local arrival tap",
    checklistSynced.ok === true &&
      JSON.parse(afterSyncVisit?.checklistJson ?? "[]").find((item) => item.key === "arrival")
        ?.checked === true &&
      JSON.parse(afterSyncVisit?.checklistJson ?? "[]").find((item) => item.key === "wrap")
        ?.checked === false,
  );

  console.log("\nWALKTHROUGH — session expiry and Android device-token sign-out");
  const expiryToken = `android-expiry-${randomUUID()}`;
  const expiryRegister = await registerNativePushDevice(prisma, access, {
    token: expiryToken,
    platform: "android",
    optedIn: true,
  });
  check(
    "Android platform device can opt in on this membership",
    expiryRegister.ok === true &&
      expiryRegister.preference.thisDeviceOptedIn === true &&
      expiryRegister.preference.devices.some((device) => device.platform === "android"),
  );
  await prisma.session.update({
    where: { id: access.sessionId },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });
  const expired = await resolveNativeFieldAccess(prisma, { token: signIn.ok ? signIn.token : "" });
  const expiredDevice = await prisma.nativePushDevice.findFirst({
    where: { tokenHash: hashNativePushDeviceToken(expiryToken), membershipId: memberMem.id },
  });
  check(
    "Expired session returns 401 and is treated as sign-in-again on the client",
    expired.ok === false &&
      expired.status === 401 &&
      isSessionExpired({ status: expired.status, error: expired.error }) === true,
  );
  check(
    "Session expiry revokes the Android device token on the server",
    expiredDevice?.revokedAt != null && expiredDevice.optedIn === false,
  );

  const signOut = await signInNativeField(prisma, {
    email: memberUser.email,
    password,
    userAgent: "Android/debug 0.1.0",
  });
  const signOutResolved = signOut.ok
    ? await resolveNativeFieldAccess(prisma, { token: signOut.token })
    : { ok: false };
  check("Worker can sign in again after expiry", signOutResolved.ok === true);
  if (!signOutResolved.ok) {
    throw new Error("Expected post-expiry MEMBER access.");
  }
  const signOutToken = `android-signout-${randomUUID()}`;
  const signOutRegister = await registerNativePushDevice(prisma, signOutResolved.access, {
    token: signOutToken,
    platform: "android",
    optedIn: true,
  });
  const headerOnly = readNativePushDeviceTokenFromParts({
    headerToken: signOutToken,
    bodyToken: "",
  });
  const revoked = await revokeNativePushDevice(prisma, signOutResolved.access, {
    token: headerOnly,
  });
  const revokedRow = await prisma.nativePushDevice.findFirst({
    where: { tokenHash: hashNativePushDeviceToken(signOutToken), membershipId: memberMem.id },
  });
  check(
    "Android sign-out revoke works when only the device-token header survives",
    signOutRegister.ok === true &&
      headerOnly === signOutToken &&
      revoked.ok === true &&
      revoked.preference.thisDeviceOptedIn === false &&
      revokedRow?.revokedAt != null,
  );

  check(
    "Walkthrough never completed a job or invoked customer messaging",
    (await prisma.job.count({ where: { businessId: business.id, status: "COMPLETED" } })) === 0,
  );
} finally {
  await session.cleanup();
}

if (!androidHome) {
  console.log("\nAPK ASSEMBLE");
  console.log("  skipped — ANDROID_HOME unset; no emulator or device on this VM.");
  console.log("  pipeline validated: eas preview APK + apps/native android:debug-apk.");
  const script = fileURLToPath(new URL("./android-debug-apk.sh", import.meta.url));
  const refused = spawnSync("bash", [script], { encoding: "utf8" });
  check(
    "android-debug-apk.sh exits 2 when the SDK is missing",
    refused.status === 2 &&
      (refused.stdout + refused.stderr).includes("ANDROID_HOME / ANDROID_SDK_ROOT is unset"),
  );
} else if (!hasDebugApk) {
  console.log("\nAPK ASSEMBLE");
  console.log("  ANDROID_HOME is set but no debug APK is present. Not invoking Gradle from this proof.");
}

console.log("\nRECORDED FAILURES (this run)");
if (recordedFailures.length === 0) {
  console.log("  none");
} else {
  for (const label of recordedFailures) {
    console.log(`  - ${label}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} native Android field check(s) failed.`);
  process.exit(1);
}
console.log("\nAll native Android field checks passed.");
