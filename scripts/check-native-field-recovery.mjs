/**
 * Native field recovery — network loss, Retry/Reload, and writes
 * after reassignment or membership deactivation while the Job screen
 * is already open.
 *
 * Uses a dedicated local disposable database. Does not send customer
 * messages, invoices, or deploy.
 *
 * Run with:
 *   npm run test:native-field-recovery
 */
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { openDisposableTestDatabase } from "./disposable-test-database.mjs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { hashPassword } = await import("@/lib/auth-crypto");
const { NATIVE_JOB_NOT_AVAILABLE, startNativeAssignedJob, completeNativeAssignedJob } =
  await import("@/lib/native-field-ops");
const { loadNativeAssignedJob, loadNativeToday } = await import("@/lib/native-field");
const { startNativeAssignedActivityTime } = await import("@/lib/native-field-activity");
const { resolveNativeFieldAccess, signInNativeField } = await import(
  "@/lib/native-session"
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
const docsSrc = readRepo("docs/NATIVE_FIELD.md");
const packageSrc = readRepo("package.json");
const selfSrc = readRepo("scripts/check-native-field-recovery.mjs");

console.log("\nSTATIC — Network errors return instead of hanging pending writes");
check(
  "Native API helpers catch fetch failures and keep HTTP status on errors",
  apiSrc.includes("NATIVE_NETWORK_ERROR") &&
    apiSrc.includes("Couldn't reach the server. Check your connection and try again.") &&
    apiSrc.includes("async function requestNativeJson") &&
    apiSrc.includes("status: response.status") &&
    apiSrc.includes("export function isLostAssignment") &&
    apiSrc.includes("error.status === 401 || error.status === 403 || error.status === 404") &&
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
  "Job screen retries, reloads, and drops stale actions after 401/403/404",
  jobScreenSrc.includes("void loadNativeJob(token, jobId)") &&
    jobScreenSrc.includes("reloadAssignedJob") &&
    jobScreenSrc.includes("retryAssignedJob") &&
    jobScreenSrc.includes("RefreshControl") &&
    jobScreenSrc.includes(">Retry<") &&
    jobScreenSrc.includes("Reload") &&
    jobScreenSrc.includes("isLostAssignment") &&
    jobScreenSrc.includes("applyLostAssignment") &&
    jobScreenSrc.includes("setJob(null)") &&
    jobScreenSrc.includes("finally") &&
    jobScreenSrc.includes("NATIVE_NETWORK_ERROR") &&
    jobScreenSrc.includes("Start job") &&
    jobScreenSrc.includes("Start travel") &&
    jobScreenSrc.includes("Start material pickup"),
);
check(
  "Today, Time cards, and session restore expose Retry after network or lost access",
  todayScreenSrc.includes(">Retry<") &&
    todayScreenSrc.includes("isLostAssignment") &&
    todayScreenSrc.includes("setPayload(null)") &&
    timeCardsSrc.includes(">Retry<") &&
    timeCardsSrc.includes("isLostAssignment") &&
    timeCardsSrc.includes("finally") &&
    appSrc.includes("restoreError") &&
    appSrc.includes("restoreSession") &&
    appSrc.includes(">Retry<") &&
    pickupSrc.includes("finally") &&
    pickupSrc.includes("NATIVE_NETWORK_ERROR") &&
    problemSrc.includes("recordNativeJobProblem"),
);
check(
  "Docs and package register the recovery proof",
  docsSrc.includes("test:native-field-recovery") &&
    packageSrc.includes("test:native-field-recovery") &&
    selfSrc.includes("openDisposableTestDatabase") &&
    selfSrc.includes('namePrefix: "tbbt_native_field_recovery"'),
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
    todayIds.includes(assignedJob.id) &&
      todayIds.includes(travelJob.id) &&
      today.workspace.membershipId === memberMem.id,
  );

  const openJob = await loadNativeAssignedJob(prisma, access, assignedJob.id);
  check(
    "Job screen can load the assigned job before Start",
    openJob?.id === assignedJob.id &&
      openJob.startAction.available === true &&
      openJob.status === "SCHEDULED",
  );

  const started = await startNativeAssignedJob(prisma, access, assignedJob.id);
  const startedDetail = started.ok
    ? await loadNativeAssignedJob(prisma, access, assignedJob.id)
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
    where: { id: assignedJob.id },
    data: { assignedMembershipId: otherMem.id },
  });
  await prisma.job.update({
    where: { id: travelJob.id },
    data: { assignedMembershipId: otherMem.id },
  });

  const afterReassignRead = await loadNativeAssignedJob(prisma, access, assignedJob.id);
  const afterReassignStart = await startNativeAssignedJob(prisma, access, assignedJob.id);
  const afterReassignComplete = await completeNativeAssignedJob(prisma, access, assignedJob.id);
  const afterReassignTravel = await startNativeAssignedActivityTime(
    prisma,
    access,
    travelJob.id,
    "TRAVEL",
  );
  const reassignedRow = await prisma.job.findFirst({
    where: { id: assignedJob.id, businessId: business.id },
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

if (failures > 0) {
  console.error(`\n${failures} native field recovery check(s) failed.`);
  process.exit(1);
}

console.log("\nNative field recovery checks passed.");
