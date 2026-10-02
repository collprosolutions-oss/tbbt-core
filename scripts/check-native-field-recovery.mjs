/**
 * Native field recovery — network loss, Retry/Reload, mid-session
 * 401, subscription 403 vs lost assignment, stale refresh, and writes
 * after reassignment or membership deactivation while the Job screen
 * is already open.
 *
 * Uses a dedicated local disposable database. Does not send customer
 * messages, invoices, or deploy.
 *
 * Run with:
 *   npm run test:native-field-recovery
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { fileURLToPath } from "node:url";
import { openDisposableTestDatabase } from "./disposable-test-database.mjs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const mutationChild = Boolean(process.env.NATIVE_FIELD_RECOVERY_MUTATION_CHILD);

const {
  applyLostAssignment,
  isLostAssignment,
  isSessionExpired,
  nativeRecoveryDecision,
  nextNativeRequestGeneration,
  NATIVE_JOB_NOT_AVAILABLE_MESSAGE,
  NATIVE_OWN_ENTRY_FORBIDDEN_MESSAGE,
  NATIVE_SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE,
  NATIVE_SIGN_IN_AGAIN_MESSAGE,
  NATIVE_WORKSPACE_UNAVAILABLE_MESSAGE,
  shouldApplyNativeResponse,
} = await import(new URL("../apps/native/src/recovery.ts", import.meta.url));
const { NATIVE_NETWORK_ERROR, requestNativeJson } = await import(
  new URL("../apps/native/src/api.ts", import.meta.url)
);

const NY = "America/New_York";
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

const apiSrc = readRepo("apps/native/src/api.ts");
const appSrc = readRepo("apps/native/App.tsx");
const jobScreenSrc = readRepo("apps/native/src/screens/JobScreen.tsx");
const todayScreenSrc = readRepo("apps/native/src/screens/TodayScreen.tsx");
const timeCardsSrc = readRepo("apps/native/src/screens/TimeCardsScreen.tsx");
const pickupSrc = readRepo("apps/native/src/screens/JobPickupSection.tsx");
const problemSrc = readRepo("apps/native/src/screens/JobProblemReportsSection.tsx");
const recoverySrc = readRepo("apps/native/src/recovery.ts");
const docsSrc = readRepo("docs/NATIVE_FIELD.md");
const packageSrc = readRepo("package.json");
const selfSrc = readRepo("scripts/check-native-field-recovery.mjs");

const applyLostAssignmentAt = jobScreenSrc.indexOf("function applyLostAssignment");
const applyLostAssignmentFn = jobScreenSrc.slice(
  applyLostAssignmentAt,
  jobScreenSrc.indexOf("\n  useEffect", applyLostAssignmentAt),
);

console.log("\nSTATIC — Network errors return instead of hanging pending writes");
check(
  "Native API helpers catch fetch failures and keep HTTP status on errors",
  apiSrc.includes("NATIVE_NETWORK_ERROR") &&
    apiSrc.includes("Couldn't reach the server. Check your connection and try again.") &&
    apiSrc.includes("export async function requestNativeJson") &&
    apiSrc.includes("return body as T;") &&
    apiSrc.includes("} catch {") &&
    apiSrc.includes("return { error: networkError };") &&
    apiSrc.includes("status: response.status") &&
    apiSrc.includes("export { isLostAssignment, isSessionExpired }") &&
    apiSrc.includes("/api/native/v1/today") &&
    apiSrc.includes("/api/native/v1/jobs/") &&
    apiSrc.includes("/start") &&
    apiSrc.includes("/complete") &&
    apiSrc.includes("/stop-time") &&
    apiSrc.includes("/start-activity") &&
    apiSrc.includes("/stop-activity") &&
    apiSrc.includes("/visit") &&
    apiSrc.includes("/pickup") &&
    apiSrc.includes("/photos/authorize") &&
    apiSrc.includes("/time-cards") &&
    apiSrc.includes("NATIVE_CHECKLIST_OFFLINE_MESSAGE") &&
    apiSrc.includes('return { error: "Couldn\'t reach the server." }'),
);
check(
  "Job screen retries, reloads, and clears only true lost assignments",
  jobScreenSrc.includes("void loadNativeJob(token, jobId)") &&
    jobScreenSrc.includes("reloadAssignedJob") &&
    jobScreenSrc.includes("retryAssignedJob") &&
    jobScreenSrc.includes("RefreshControl") &&
    jobScreenSrc.includes(">Retry<") &&
    jobScreenSrc.includes("Reload") &&
    jobScreenSrc.includes("isLostAssignment") &&
    jobScreenSrc.includes("isSessionExpired") &&
    jobScreenSrc.includes("applyLostAssignment") &&
    jobScreenSrc.includes("setJob(null)") &&
    applyLostAssignmentFn.includes("setJob(null)") &&
    applyLostAssignmentFn.includes("onSessionExpired") &&
    jobScreenSrc.includes("finally") &&
    jobScreenSrc.includes("NATIVE_NETWORK_ERROR") &&
    jobScreenSrc.includes("Start job") &&
    jobScreenSrc.includes("Start travel") &&
    jobScreenSrc.includes("Start material pickup") &&
    jobScreenSrc.includes("actionsLocked") &&
    jobScreenSrc.includes("pending || refreshing") &&
    jobScreenSrc.includes("shouldApplyNativeResponse") &&
    jobScreenSrc.includes("Sign in again"),
);
check(
  "Today, Time cards, and session restore re-auth on 401 instead of retrying forever",
  todayScreenSrc.includes(">Retry<") &&
    todayScreenSrc.includes("isLostAssignment") &&
    todayScreenSrc.includes("isSessionExpired") &&
    todayScreenSrc.includes("onSessionExpired") &&
    todayScreenSrc.includes("shouldApplyNativeResponse") &&
    timeCardsSrc.includes(">Retry<") &&
    timeCardsSrc.includes("isLostAssignment") &&
    timeCardsSrc.includes("isSessionExpired") &&
    timeCardsSrc.includes("onSessionExpired") &&
    timeCardsSrc.includes("Sign in again") &&
    timeCardsSrc.includes("finally") &&
    timeCardsSrc.includes("shouldApplyNativeResponse") &&
    appSrc.includes("restoreError") &&
    appSrc.includes("restoreSession") &&
    appSrc.includes("onSessionExpired") &&
    appSrc.includes("expireSession") &&
    appSrc.includes(">Retry<") &&
    pickupSrc.includes("finally") &&
    pickupSrc.includes("NATIVE_NETWORK_ERROR") &&
    problemSrc.includes("recordNativeJobProblem"),
);
check(
  "Docs and package register the recovery proof",
  docsSrc.includes("test:native-field-recovery") &&
    docsSrc.includes("lapsed SaaS subscription") &&
    packageSrc.includes("test:native-field-recovery") &&
    recoverySrc.includes("export function applyLostAssignment") &&
    recoverySrc.includes("export function isSessionExpired") &&
    selfSrc.includes("openDisposableTestDatabase") &&
    selfSrc.includes('namePrefix: "tbbt_native_field_recovery"') &&
    selfSrc.includes("NATIVE_FIELD_RECOVERY_MUTATION_CHILD"),
);

console.log("\nBEHAVIORAL — requestNativeJson, lost assignment, session, stale response");
const assignedJob = { id: "assigned-job" };
const notAvailable = {
  status: 404,
  error: NATIVE_JOB_NOT_AVAILABLE_MESSAGE,
};
const subscriptionDenied = {
  status: 403,
  error: NATIVE_SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE,
};
const ownEntryDenied = {
  status: 403,
  error: NATIVE_OWN_ENTRY_FORBIDDEN_MESSAGE,
};
const signedOut = {
  status: 401,
  error: NATIVE_SIGN_IN_AGAIN_MESSAGE,
};
const workspaceGone = {
  status: 403,
  error: NATIVE_WORKSPACE_UNAVAILABLE_MESSAGE,
};

check(
  "404 NATIVE_JOB_NOT_AVAILABLE clears the assigned job",
  applyLostAssignment(assignedJob, notAvailable) === null &&
    isLostAssignment(notAvailable) === true &&
    nativeRecoveryDecision(notAvailable) === "clear-record",
);
check(
  "403 SaaS subscription keeps the job visible",
  applyLostAssignment(assignedJob, subscriptionDenied) === assignedJob &&
    isLostAssignment(subscriptionDenied) === false &&
    isSessionExpired(subscriptionDenied) === false &&
    nativeRecoveryDecision(subscriptionDenied) === "keep-record",
);
check(
  "403 own-entry forbidden keeps the Time cards payload",
  applyLostAssignment(assignedJob, ownEntryDenied) === assignedJob &&
    isLostAssignment(ownEntryDenied) === false &&
    nativeRecoveryDecision(ownEntryDenied) === "keep-record",
);
check(
  "401 triggers session-expired instead of clearing the job",
  isSessionExpired(signedOut) === true &&
    nativeRecoveryDecision(signedOut) === "session-expired" &&
    applyLostAssignment(assignedJob, signedOut) === assignedJob,
);
check(
  "403 workspace-unavailable is session-expired, not a keep-and-retry loop",
  isSessionExpired(workspaceGone) === true &&
    nativeRecoveryDecision(workspaceGone) === "session-expired",
);

let latestGeneration = 0;
const refreshGeneration = (latestGeneration = nextNativeRequestGeneration(latestGeneration));
const startReloadGeneration = (latestGeneration = nextNativeRequestGeneration(latestGeneration));
check(
  "older refresh generation does not overwrite a newer Start reload",
  shouldApplyNativeResponse(latestGeneration, refreshGeneration) === false &&
    shouldApplyNativeResponse(latestGeneration, startReloadGeneration) === true &&
    refreshGeneration !== startReloadGeneration,
);

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => {
    throw new Error("offline");
  };
  const thrown = await requestNativeJson(
    "/api/native/v1/today",
    { headers: { Accept: "application/json" } },
    "Today is not available.",
  );
  check(
    "stubbed fetch throw returns {error} from the network catch",
    "error" in thrown &&
      thrown.error === NATIVE_NETWORK_ERROR &&
      thrown.status == null,
  );

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true, id: "today-1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const recovered = await requestNativeJson(
    "/api/native/v1/today",
    { headers: { Accept: "application/json" } },
    "Today is not available.",
  );
  check(
    "successful fetch is the JSON body, not a network error",
    !("error" in recovered) && recovered.ok === true && recovered.id === "today-1",
  );

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: NATIVE_JOB_NOT_AVAILABLE_MESSAGE }), {
      status: 404,
    });
  const missing = await requestNativeJson(
    "/api/native/v1/jobs/missing",
    { headers: { Accept: "application/json" } },
    "That job is not available.",
  );
  check(
    "HTTP 404 keeps status so lost-assignment logic can clear",
    "error" in missing &&
      missing.error === NATIVE_JOB_NOT_AVAILABLE_MESSAGE &&
      missing.status === 404 &&
      applyLostAssignment(assignedJob, missing) === null,
  );

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: NATIVE_SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE }), {
      status: 403,
    });
  const billed = await requestNativeJson(
    "/api/native/v1/jobs/assigned/start",
    { method: "POST", headers: { Accept: "application/json" } },
    "That job could not be started.",
  );
  check(
    "HTTP 403 subscription response does not clear the job",
    "error" in billed &&
      billed.status === 403 &&
      applyLostAssignment(assignedJob, billed) === assignedJob &&
      isSessionExpired(billed) === false,
  );
} finally {
  globalThis.fetch = originalFetch;
}

if (!mutationChild) {
  const { hashPassword } = await import("@/lib/auth-crypto");
  const { NATIVE_JOB_NOT_AVAILABLE, startNativeAssignedJob, completeNativeAssignedJob } =
    await import("@/lib/native-field-ops");
  const { loadNativeAssignedJob, loadNativeToday } = await import("@/lib/native-field");
  const { startNativeAssignedActivityTime } = await import("@/lib/native-field-activity");
  const { resolveNativeFieldAccess, signInNativeField } = await import(
    "@/lib/native-session"
  );

  const session = await openDisposableTestDatabase({
    databaseUrl: baseUrl,
    namePrefix: "tbbt_native_field_recovery",
    pushSchema: true,
  });
  const prisma = session.prisma;

  try {
    const password = "native-recovery-pass-9";
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
        name: "Recovery Field Co",
        slug: "recovery-native-field",
        tradeCode: "HANDYMAN",
        timezone: NY,
        ...onboarding,
      },
    });
    const ownerUser = await prisma.user.create({
      data: { name: "Olivia Owner", email: "owner@native-recovery.example", passwordHash },
    });
    const memberUser = await prisma.user.create({
      data: { name: "Mia Member", email: "member@native-recovery.example", passwordHash },
    });
    const otherUser = await prisma.user.create({
      data: { name: "Max Member", email: "other@native-recovery.example", passwordHash },
    });
    const ownerMem = await prisma.membership.create({
      data: { userId: ownerUser.id, businessId: business.id, role: "OWNER" },
    });
    const memberMem = await prisma.membership.create({
      data: { userId: memberUser.id, businessId: business.id, role: "MEMBER" },
    });
    const otherMem = await prisma.membership.create({
      data: { userId: otherUser.id, businessId: business.id, role: "MEMBER" },
    });
    void ownerMem;
    const customer = await prisma.customer.create({
      data: { businessId: business.id, name: "Riley Resident", phone: "555-0144" },
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
    const assignedRow = await prisma.job.create({
      data: {
        businessId: business.id,
        customerId: customer.id,
        assignedMembershipId: memberMem.id,
        projectToken: randomUUID(),
        status: "SCHEDULED",
        ...confirmed,
      },
    });
    const travelJob = await prisma.job.create({
      data: {
        businessId: business.id,
        customerId: customer.id,
        assignedMembershipId: memberMem.id,
        projectToken: randomUUID(),
        status: "SCHEDULED",
        ...confirmed,
      },
    });
    const deactivateJob = await prisma.job.create({
      data: {
        businessId: business.id,
        customerId: customer.id,
        assignedMembershipId: memberMem.id,
        projectToken: randomUUID(),
        status: "IN_PROGRESS",
        ...confirmed,
      },
    });

    const signIn = await signInNativeField(prisma, {
      email: memberUser.email,
      password,
    });
    check("Assigned MEMBER can sign in on the disposable workspace", signIn.ok === true);
    const resolved = signIn.ok
      ? await resolveNativeFieldAccess(prisma, { token: signIn.token })
      : { ok: false };
    check("Bearer session resolves to the assigned membership", resolved.ok === true);
    if (!resolved.ok) {
      throw new Error("Expected assigned MEMBER access.");
    }
    const access = resolved.access;

    console.log("\nDEDICATED DB — sign-in, Today, Start job, then reassignment while open");
    const today = await loadNativeToday(prisma, access);
    const todayIds = [
      ...(today.today ?? []),
      ...(today.upcoming ?? []),
      ...(today.completed ?? []),
    ].map((row) => row.id);
    check(
      "Today returns the assigned jobs for this membership only",
      todayIds.includes(assignedRow.id) &&
        todayIds.includes(travelJob.id) &&
        today.workspace.membershipId === memberMem.id,
    );

    const openJob = await loadNativeAssignedJob(prisma, access, assignedRow.id);
    check(
      "Job screen can load the assigned job before Start",
      openJob?.id === assignedRow.id &&
        openJob.startAction.available === true &&
        openJob.status === "SCHEDULED",
    );

    const started = await startNativeAssignedJob(prisma, access, assignedRow.id);
    const startedDetail = started.ok
      ? await loadNativeAssignedJob(prisma, access, assignedRow.id)
      : null;
    check(
      "Start job flips the assigned row to IN_PROGRESS with running JOB time",
      started.ok === true &&
        startedDetail?.status === "IN_PROGRESS" &&
        startedDetail.runningTime.running === true &&
        startedDetail.runningTime.activityType === "JOB",
    );

    const travel = await startNativeAssignedActivityTime(prisma, access, travelJob.id, "TRAVEL");
    const travelDetail = travel.ok
      ? await loadNativeAssignedJob(prisma, access, travelJob.id)
      : null;
    check(
      "Start travel opens TRAVEL time without starting the job",
      travel.ok === true &&
        travelDetail?.status === "SCHEDULED" &&
        travelDetail.travelTime.running === true &&
        travelDetail.runningTime.running === false,
    );

    await prisma.job.update({
      where: { id: assignedRow.id },
      data: { assignedMembershipId: otherMem.id },
    });
    await prisma.job.update({
      where: { id: travelJob.id },
      data: { assignedMembershipId: otherMem.id },
    });

    const afterReassignRead = await loadNativeAssignedJob(prisma, access, assignedRow.id);
    const afterReassignStart = await startNativeAssignedJob(prisma, access, assignedRow.id);
    const afterReassignComplete = await completeNativeAssignedJob(prisma, access, assignedRow.id);
    const afterReassignTravel = await startNativeAssignedActivityTime(
      prisma,
      access,
      travelJob.id,
      "TRAVEL",
    );
    const reassignedRow = await prisma.job.findFirst({
      where: { id: assignedRow.id, businessId: business.id },
    });
    check(
      "Reload after reassignment hides the former worker's open Job screen",
      afterReassignRead == null,
    );
    check(
      "Start/Complete/travel taps on the open screen are refused after reassignment",
      afterReassignStart.ok === false &&
        afterReassignStart.status === 404 &&
        afterReassignStart.error === NATIVE_JOB_NOT_AVAILABLE &&
        afterReassignComplete.ok === false &&
        afterReassignComplete.status === 404 &&
        afterReassignComplete.error === NATIVE_JOB_NOT_AVAILABLE &&
        afterReassignTravel.ok === false &&
        afterReassignTravel.status === 404 &&
        reassignedRow?.assignedMembershipId === otherMem.id &&
        reassignedRow?.status === "IN_PROGRESS",
    );

    console.log("\nDEDICATED DB — deactivation while the screen is open");
    const deactivateStart = await startNativeAssignedJob(prisma, access, deactivateJob.id, {
      afterInitialRead: async () => {
        await prisma.membership.update({
          where: { id: memberMem.id },
          data: { active: false },
        });
      },
    });
    const deactivateAfter = await prisma.job.findFirst({
      where: { id: deactivateJob.id, businessId: business.id },
    });
    const accessAfterDeactivate = await resolveNativeFieldAccess(prisma, {
      token: signIn.ok ? signIn.token : null,
    });
    check(
      "Start job after mid-flight deactivation writes nothing",
      deactivateStart.ok === false &&
        deactivateStart.status === 404 &&
        deactivateStart.error === NATIVE_JOB_NOT_AVAILABLE &&
        deactivateAfter?.status === "IN_PROGRESS" &&
        deactivateAfter?.assignedMembershipId === memberMem.id,
    );
    check(
      "Deactivated membership can no longer resolve a native workspace",
      accessAfterDeactivate.ok === false &&
        (accessAfterDeactivate.status === 403 || accessAfterDeactivate.status === 401),
    );
  } finally {
    await session.cleanup();
  }
}

if (failures > 0) {
  console.error(`\n${failures} native field recovery check(s) failed.`);
  process.exit(1);
}

if (!mutationChild) {
  console.log("\nMUTATION — revert each recovery guard and require a failing child run");
  const childScript = fileURLToPath(new URL("./check-native-field-recovery.mjs", import.meta.url));
  const mutations = [
    {
      label: "requestNativeJson catch replaced with finally",
      file: "apps/native/src/api.ts",
      search: "    return body as T;\n  } catch {\n    return { error: networkError };\n  }",
      replace: "    return body as T;\n  } finally {\n    return { error: networkError };\n  }",
    },
    {
      label: "setJob(null) removed inside applyLostAssignment",
      file: "apps/native/src/screens/JobScreen.tsx",
      search:
        "    if (isLostAssignment(result)) {\n      setJob(null);\n    }",
      replace: "    if (isLostAssignment(result)) {\n    }",
    },
    {
      label: "applyLostAssignment helper no longer returns null",
      file: "apps/native/src/recovery.ts",
      search:
        '  if (nativeRecoveryDecision(error) === "clear-record") {\n    return null;\n  }',
      replace:
        '  if (nativeRecoveryDecision(error) === "clear-record") {\n    return current;\n  }',
    },
    {
      label: "stale response always applied",
      file: "apps/native/src/recovery.ts",
      search: "  return latestGeneration === responseGeneration;",
      replace: "  return true;",
    },
  ];

  for (const mutation of mutations) {
    const target = fileURLToPath(new URL(`../${mutation.file}`, import.meta.url));
    const original = readFileSync(target, "utf8");
    if (!original.includes(mutation.search)) {
      check(`mutation setup finds ${mutation.label}`, false);
      continue;
    }
    writeFileSync(target, original.replace(mutation.search, mutation.replace));
    try {
      const child = spawnSync(process.execPath, ["--experimental-strip-types", childScript], {
        env: { ...process.env, NATIVE_FIELD_RECOVERY_MUTATION_CHILD: "1" },
        encoding: "utf8",
        timeout: 60_000,
      });
      const failed = child.status !== 0;
      check(`Mutation ${mutation.label} fails a test`, failed);
      if (!failed) {
        console.error((child.stdout || "").slice(-2000));
        console.error((child.stderr || "").slice(-1000));
      }
    } finally {
      writeFileSync(target, original);
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} native field recovery check(s) failed.`);
  process.exit(1);
}

console.log("\nNative field recovery checks passed.");
