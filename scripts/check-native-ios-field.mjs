/**
 * iOS field-app internal test-build recipe + versioning.
 *
 * Covers the missing iOS simulator recipe for com.tbbt.field, local
 * buildNumber versioning, a reachable https preview API, and one
 * disposable test-account walkthrough: sign-in, assigned job, offline
 * time, session expiry, and sign-out.
 *
 * Does not rebuild the Android APK recipe from #331, the web recovery
 * / offline-sync / push suites, or App Store submission. No Apple
 * credentials. This proof does not sign or install an iOS binary.
 *
 * No customer messages. No production writes. No Complete job.
 *
 * Run with:
 *   npm run test:native-ios-field
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { register } from "node:module";
import { fileURLToPath } from "node:url";
import { openDisposableTestDatabase } from "./disposable-test-database.mjs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);
register(new URL("./native-relative-ts-loader.mjs", import.meta.url), import.meta.url);

const { NATIVE_APP_VERSION, NATIVE_ANDROID_PACKAGE, NATIVE_ANDROID_VERSION_CODE } = await import(
  new URL("../apps/native/src/android.ts", import.meta.url)
);
const {
  NATIVE_IOS_BUNDLE_IDENTIFIER,
  NATIVE_IOS_BUILD_NUMBER,
  NATIVE_PREVIEW_API_ORIGIN,
  easConfigIncludesAppleCredentials,
  isReachablePreviewApiOrigin,
  nativeIosBuildStampLabel,
  parseGeneratedIosProject,
} = await import(new URL("../apps/native/src/ios.ts", import.meta.url));
const { isSessionExpired } = await import(
  new URL("../apps/native/src/recovery.ts", import.meta.url)
);
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

function findGeneratedFile(root, name) {
  if (!existsSync(root)) return "";
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const next = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "Pods" || entry.name === "build") continue;
        queue.push(next);
      } else if (entry.name === name) {
        return next;
      }
    }
  }
  return "";
}

const appJson = JSON.parse(readRepo("apps/native/app.json"));
const easJson = JSON.parse(readRepo("apps/native/eas.json"));
const nativePackage = JSON.parse(readRepo("apps/native/package.json"));
const stampSrc = readRepo("apps/native/src/screens/NativeBuildStamp.tsx");
const docsSrc = readRepo("docs/NATIVE_FIELD.md");
const packageSrc = readRepo("package.json");
const iosScriptSrc = readRepo("scripts/ios-simulator-build.sh");
const selfSrc = readRepo("scripts/check-native-ios-field.mjs");
const nativeReadme = readRepo("apps/native/README.md");
const androidScriptSrc = readRepo("scripts/android-debug-apk.sh");
const hasXcodebuild = Boolean(spawnSync("bash", ["-lc", "command -v xcodebuild"], { encoding: "utf8" }).stdout.trim());
const iosDir = fileURLToPath(new URL("../apps/native/ios", import.meta.url));

console.log("\nDEVICE / BUILD");
console.log(`  device      : Cursor Cloud Agent Linux VM`);
console.log(`  simulator   : none`);
console.log(`  xcodebuild  : ${hasXcodebuild ? "present" : "(absent)"}`);
console.log(`  build       : ${nativeIosBuildStampLabel()}`);
console.log(`  bundle      : ${NATIVE_IOS_BUNDLE_IDENTIFIER}`);
console.log(`  buildNumber : ${NATIVE_IOS_BUILD_NUMBER}`);
console.log(`  signed IPA  : not assembled`);
console.log(`  installed   : no`);

console.log("\nSTATIC — iOS internal recipe exists and is not App Store submission");
check(
  "app.json versions com.tbbt.field with an iOS buildNumber and keeps Android versionCode",
  appJson.expo.version === NATIVE_APP_VERSION &&
    appJson.expo.ios.bundleIdentifier === NATIVE_IOS_BUNDLE_IDENTIFIER &&
    appJson.expo.ios.buildNumber === NATIVE_IOS_BUILD_NUMBER &&
    appJson.expo.android.package === NATIVE_ANDROID_PACKAGE &&
    appJson.expo.android.versionCode === NATIVE_ANDROID_VERSION_CODE &&
    appJson.expo.android.softwareKeyboardLayoutMode === "resize" &&
    !Object.prototype.hasOwnProperty.call(appJson.expo.android, "usesCleartextTraffic"),
);
check(
  "eas.json preview keeps the Android APK, adds an unsigned iOS simulator build, and uses the reachable https test API",
  easJson.build.preview.android.buildType === "apk" &&
    easJson.build.preview.distribution === "internal" &&
    easJson.build.preview.ios?.simulator === true &&
    isReachablePreviewApiOrigin(easJson.build.preview.env.EXPO_PUBLIC_TBBT_API_URL) &&
    easJson.build.preview.env.EXPO_PUBLIC_TBBT_API_URL === NATIVE_PREVIEW_API_ORIGIN &&
    easJson.build.production == null &&
    easJson.submit == null &&
    easJson.build.submit == null &&
    easConfigIncludesAppleCredentials(easJson) === false,
);
check(
  "Native package.json routes iOS prebuild through the restore wrapper",
  nativePackage.scripts["ios:prebuild"]?.includes("ios-simulator-build.sh --prebuild-only") &&
    nativePackage.scripts["ios:simulator"]?.includes("ios-simulator-build.sh") &&
    nativePackage.scripts["android:debug-apk"]?.includes("android-debug-apk.sh") &&
    androidScriptSrc.includes("assembleDebug"),
);
check(
  "iOS simulator script generates the project without Apple credentials and refuses to sign on Linux",
  iosScriptSrc.includes("expo prebuild --platform ios --no-install") &&
    iosScriptSrc.includes("package.json") &&
    iosScriptSrc.includes("restore_pkg") &&
    iosScriptSrc.includes("xcodebuild") &&
    iosScriptSrc.includes("CODE_SIGNING_ALLOWED=NO") &&
    iosScriptSrc.includes("exit 2") &&
    iosScriptSrc.includes("UNVERIFIED") &&
    !iosScriptSrc.includes("appleId") &&
    !iosScriptSrc.includes("altool") &&
    !iosScriptSrc.includes("ascAppId"),
);
check(
  "Docs register the iOS proof, reachable https origin, and no store submission",
  docsSrc.includes("test:native-ios-field") &&
    docsSrc.includes("ios.buildNumber") &&
    docsSrc.includes("https://www.collproreno.com") &&
    docsSrc.includes("No Apple credentials") &&
    docsSrc.includes("cannot sign or install") &&
    packageSrc.includes("test:native-ios-field") &&
    nativeReadme.includes("ios:prebuild") &&
    nativeReadme.includes("UNVERIFIED") &&
    nativeReadme.includes("www.collproreno.com") &&
    stampSrc.includes("nativeIosBuildStampLabel") &&
    selfSrc.includes("openDisposableTestDatabase") &&
    selfSrc.includes('namePrefix: "tbbt_native_ios_field"') &&
    selfSrc.includes("Do not treat this as a successful device install"),
);
check(
  "iOS build stamp uses the iOS build number",
  nativeIosBuildStampLabel() === `TBBT Field ${NATIVE_APP_VERSION} (${NATIVE_IOS_BUILD_NUMBER})`,
);

console.log("\nNETWORK — preview API origin is reachable https");
const previewOrigin = String(easJson.build.preview.env.EXPO_PUBLIC_TBBT_API_URL).replace(/\/$/, "");
let homeStatus = 0;
let sessionStatus = 0;
try {
  const home = await fetch(previewOrigin, { method: "GET", redirect: "follow" });
  homeStatus = home.status;
  const session = await fetch(`${previewOrigin}/api/native/v1/session`, {
    method: "GET",
    redirect: "follow",
  });
  sessionStatus = session.status;
} catch (error) {
  console.error(`  preview fetch failed: ${error instanceof Error ? error.message : error}`);
}
check(
  "https://www.collproreno.com answers over HTTPS",
  previewOrigin === NATIVE_PREVIEW_API_ORIGIN && homeStatus >= 200 && homeStatus < 400,
);
check(
  "Native session route is present on that origin (auth required)",
  sessionStatus === 401 || sessionStatus === 405 || sessionStatus === 400,
);

console.log("\nGENERATED CONFIG — expo prebuild --platform ios --no-install");
const prebuild = spawnSync("bash", [fileURLToPath(new URL("./ios-simulator-build.sh", import.meta.url)), "--prebuild-only"], {
  encoding: "utf8",
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, EXPO_NO_GIT_STATUS: "1" },
});
if (prebuild.stdout) process.stdout.write(prebuild.stdout);
if (prebuild.stderr) process.stderr.write(prebuild.stderr);
check(
  "ios-simulator-build.sh --prebuild-only exits 0 and restores package.json",
  prebuild.status === 0 &&
    `${prebuild.stdout}${prebuild.stderr}`.includes("package.json was restored") &&
    JSON.parse(readRepo("apps/native/package.json")).scripts["ios:prebuild"]?.includes(
      "ios-simulator-build.sh --prebuild-only",
    ),
);

const pbxPath = findGeneratedFile(iosDir, "project.pbxproj");
const plistPath = findGeneratedFile(iosDir, "Info.plist");
const pbxText = pbxPath && existsSync(pbxPath) ? readFileSync(pbxPath, "utf8") : "";
const plistText = plistPath && existsSync(plistPath) ? readFileSync(plistPath, "utf8") : "";
const generated = parseGeneratedIosProject(pbxText, plistText);
check(
  "Generated Xcode project versions com.tbbt.field build 1",
  Boolean(pbxPath) &&
    generated.bundleId === NATIVE_IOS_BUNDLE_IDENTIFIER &&
    generated.projectVersion === NATIVE_IOS_BUILD_NUMBER &&
    generated.shortVersion === NATIVE_APP_VERSION &&
    generated.bundleVersion === NATIVE_IOS_BUILD_NUMBER &&
    generated.displayName === "TBBT Field" &&
    generated.allowsArbitraryLoads === false,
);
check(
  "Generated project does not embed an Apple team or store credentials",
  Boolean(plistText) &&
    generated.developmentTeams.every((team) => team === "" || team === "$(DEVELOPMENT_TEAM)") &&
    !pbxText.includes("AuthKey_") &&
    !/appleId|ascAppId/.test(pbxText),
);

const { hashPassword } = await import("@/lib/auth-crypto");
const { loadNativeAssignedJob, loadNativeToday } = await import("@/lib/native-field");
const { syncNativeAssignedTimeCardDraft } = await import("@/lib/native-field-time-sync");
const { resolveNativeFieldAccess, signInNativeField } = await import("@/lib/native-session");
const { hashNativePushDeviceToken, registerNativePushDevice, revokeNativePushDevice } = await import(
  "@/lib/native-push/devices"
);

const session = await openDisposableTestDatabase({
  databaseUrl: baseUrl,
  namePrefix: "tbbt_native_ios_field",
  pushSchema: true,
  setProcessEnv: true,
});
const prisma = session.prisma;

try {
  const password = "ios-field-pass-9";
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
      name: "iOS Field Co",
      slug: "ios-native-field",
      tradeCode: "HANDYMAN",
      timezone: NY,
      ...onboarding,
    },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Ivy Member", email: "ivy@ios-field.example", passwordHash },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: business.id, role: "MEMBER" },
  });
  const customer = await prisma.customer.create({
    data: { businessId: business.id, name: "Test Resident", phone: "555-0188" },
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
  const assignedJob = await prisma.job.create({
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

  console.log("\nWALKTHROUGH — sign-in and assigned job (disposable account, not a device)");
  const signIn = await signInNativeField(prisma, {
    email: memberUser.email,
    password,
    userAgent: "iOS/simulator 0.1.0",
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
    todayIds.includes(assignedJob.id) &&
      todayIds.includes(offlineTimeJob.id) &&
      today.workspace.membershipId === memberMem.id,
  );
  const openAssigned = await loadNativeAssignedJob(prisma, access, assignedJob.id);
  check(
    "Assigned job loads with Start available",
    openAssigned?.id === assignedJob.id && openAssigned.startAction.available === true,
  );

  console.log("\nWALKTHROUGH — offline time");
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

  console.log("\nWALKTHROUGH — session expiry and sign-out");
  const deviceToken = `ios-device-${randomUUID()}`;
  const registered = await registerNativePushDevice(prisma, access, {
    token: deviceToken,
    platform: "ios",
    optedIn: true,
  });
  check(
    "iOS platform device can opt in on this membership",
    registered.ok === true &&
      registered.preference.thisDeviceOptedIn === true &&
      registered.preference.devices.some((device) => device.platform === "ios"),
  );
  await prisma.session.update({
    where: { id: access.sessionId },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });
  const expired = await resolveNativeFieldAccess(prisma, { token: signIn.ok ? signIn.token : "" });
  const expiredDevice = await prisma.nativePushDevice.findFirst({
    where: { tokenHash: hashNativePushDeviceToken(deviceToken), membershipId: memberMem.id },
  });
  check(
    "Expired session returns 401 and is treated as sign-in-again on the client",
    expired.ok === false &&
      expired.status === 401 &&
      isSessionExpired({ status: expired.status, error: expired.error }) === true,
  );
  check(
    "Session expiry revokes the iOS device token on the server",
    expiredDevice?.revokedAt != null && expiredDevice.optedIn === false,
  );

  const signInAgain = await signInNativeField(prisma, {
    email: memberUser.email,
    password,
    userAgent: "iOS/simulator 0.1.0",
  });
  const signedInAgain = signInAgain.ok
    ? await resolveNativeFieldAccess(prisma, { token: signInAgain.token })
    : { ok: false };
  check("Worker can sign in again after expiry", signedInAgain.ok === true);
  if (!signedInAgain.ok) {
    throw new Error("Expected post-expiry MEMBER access.");
  }
  const signOutToken = `ios-signout-${randomUUID()}`;
  const signOutRegister = await registerNativePushDevice(prisma, signedInAgain.access, {
    token: signOutToken,
    platform: "ios",
    optedIn: true,
  });
  const revoked = await revokeNativePushDevice(prisma, signedInAgain.access, {
    token: signOutToken,
  });
  const revokedRow = await prisma.nativePushDevice.findFirst({
    where: { tokenHash: hashNativePushDeviceToken(signOutToken), membershipId: memberMem.id },
  });
  check(
    "Sign-out revokes the iOS device token for this membership",
    signOutRegister.ok === true &&
      revoked.ok === true &&
      revoked.preference.thisDeviceOptedIn === false &&
      revokedRow?.revokedAt != null &&
      revokedRow.optedIn === false,
  );
  check(
    "Walkthrough never completed a job",
    (await prisma.job.count({ where: { businessId: business.id, status: "COMPLETED" } })) === 0,
  );
} finally {
  await session.cleanup();
}

console.log("\nSIGNING / INSTALL");
if (!hasXcodebuild) {
  console.log("  skipped — xcodebuild is absent on this Linux VM.");
  console.log("  No IPA was signed. Nothing was installed on a simulator or device.");
  console.log("  recipe is UNVERIFIED. Not App Store submission.");
  const script = fileURLToPath(new URL("./ios-simulator-build.sh", import.meta.url));
  const refused = spawnSync("bash", [script], { encoding: "utf8" });
  check(
    "ios-simulator-build.sh exits 2 when xcodebuild is missing",
    refused.status === 2 &&
      (refused.stdout + refused.stderr).includes("cannot sign or install"),
  );
} else {
  console.log("  xcodebuild is present. This proof still does not install on a device.");
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
  console.error(`\n${failures} native iOS field check(s) failed.`);
  process.exit(1);
}
console.log("\nAll native iOS field checks passed.");
console.log("Signing and installation could not be run on this Linux VM.");
console.log("Do not treat this as a successful device install.");
