/**
 * Native worker time-card correction requests — reuse the canonical
 * requestTimeCorrection write, worker ownership, tenant isolation,
 * approved-week refusal, and Time-cards-screen reload.
 *
 * Imports the REAL production helpers from src/lib/native-time-cards.ts
 * and src/lib/time-card-ops.ts. Uses a disposable sibling Postgres
 * database (`tbbt_native_time_cards_test`).
 *
 * Run with:
 *   npm run test:native-time-cards
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { hashPassword } = await import("@/lib/auth-crypto");
const { ForbiddenError } = await import("@/lib/authorization");
const { resolveNativeFieldAccess, signInNativeField } = await import(
  "@/lib/native-session"
);
const { readCappedRequestText } = await import("@/lib/native-session-limits");
const {
  NATIVE_TIME_CARD_JSON_MAX_BYTES,
  NATIVE_TIME_CORRECTION_PENDING_REASON,
  NATIVE_TIME_CORRECTION_REQUESTED,
  NATIVE_TIME_ENTRY_NOT_AVAILABLE,
  loadNativeTimeCards,
  parseNativeTimeCorrectionJson,
  requestNativeTimeCorrection,
} = await import("@/lib/native-time-cards");
const { addDays } = await import("@/lib/schedule");
const {
  canRequestTimeCorrection,
  formatDateInput,
  formatTimeInput,
  weekRange,
} = await import("@/lib/time-cards");
const { approveTimesheetWeek, requestTimeCorrection } = await import(
  "@/lib/time-card-ops"
);

const NY = "America/New_York";
const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const parsed = new URL(baseUrl);
if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
  console.error(
    "Refusing to run: DATABASE_URL host must be localhost or 127.0.0.1 because this script runs prisma db push --accept-data-loss.",
  );
  process.exit(1);
}

const testDbName = "tbbt_native_time_cards_test";
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const adminUrl = new URL(baseUrl);
adminUrl.search = "";
const createDb = spawnSync("psql", [adminUrl.toString(), "-c", `CREATE DATABASE "${testDbName}"`], {
  encoding: "utf8",
});
if (createDb.status !== 0 && !/already exists/i.test(`${createDb.stderr}${createDb.stdout}`)) {
  console.warn(createDb.stderr || createDb.stdout);
}

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for native time-cards test database.");
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

function readRepo(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 3_600_000);
}

function makeOwnerAccess(businessId, membershipId) {
  return {
    businessId,
    workspace: { role: "OWNER", membership: { id: membershipId }, business: { timezone: NY } },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

const opsSrc = readRepo("src/lib/native-time-cards.ts");
const getRouteSrc = readRepo("src/app/api/native/v1/time-cards/route.ts");
const postRouteSrc = readRepo("src/app/api/native/v1/time-cards/corrections/route.ts");
const timeCardsScreenSrc = readRepo("apps/native/src/screens/TimeCardsScreen.tsx");
const todayScreenSrc = readRepo("apps/native/src/screens/TodayScreen.tsx");
const nativeApiSrc = readRepo("apps/native/src/api.ts");
const nativeTypesSrc = readRepo("apps/native/src/types.ts");
const appSrc = readRepo("apps/native/App.tsx");
const docsSrc = readRepo("docs/NATIVE_FIELD.md");
const timeCardOpsSrc = readRepo("src/lib/time-card-ops.ts");

console.log("\nSTATIC — Canonical request write, owner surface, and Time-cards reload");
check(
  "Native time-card write reuses requestTimeCorrection and own-entry scope",
  opsSrc.includes("requestTimeCorrection") &&
    opsSrc.includes("canRequestTimeCorrection") &&
    opsSrc.includes("exactActiveMembershipHeld") &&
    opsSrc.includes('membershipId: access.membershipId') &&
    opsSrc.includes("businessId: access.businessId") &&
    getRouteSrc.includes("loadNativeTimeCards") &&
    postRouteSrc.includes("requestNativeTimeCorrection") &&
    postRouteSrc.includes("parseNativeTimeCorrectionJson") &&
    !opsSrc.includes("decideTimeCorrectionRequest") &&
    !opsSrc.includes("correctTimeEntry") &&
    !opsSrc.includes("approveTimesheetWeek") &&
    !opsSrc.includes("createPayrollRun") &&
    !opsSrc.includes("authorizePayrollRun"),
);
const requestFnSrc = timeCardOpsSrc.slice(
  timeCardOpsSrc.indexOf("export async function requestTimeCorrection"),
  timeCardOpsSrc.indexOf("export async function decideTimeCorrectionRequest"),
);
check(
  "Canonical request does not rewrite the TimeEntry",
  timeCardOpsSrc.includes("itself is not rewritten here") &&
    requestFnSrc.includes('action: "CORRECTION_REQUEST"') &&
    requestFnSrc.includes("return { request, entry: unchanged }") &&
    !requestFnSrc.includes("timeEntry.update") &&
    !requestFnSrc.includes("timeEntry.updateMany"),
);
check(
  "Native time-card routes use Bearer helpers, cap JSON, and never use cookies()",
  getRouteSrc.includes("readBearerToken") &&
    postRouteSrc.includes("readBearerToken") &&
    postRouteSrc.includes("readCappedRequestText") &&
    !getRouteSrc.includes("cookies(") &&
    !postRouteSrc.includes("cookies(") &&
    !opsSrc.includes("cookies("),
);
check(
  "Native time-card JSON is capped at 4 KB",
  opsSrc.includes("NATIVE_TIME_CARD_JSON_MAX_BYTES = 4096") &&
    NATIVE_TIME_CARD_JSON_MAX_BYTES === 4096,
);
check(
  "Time cards screen requests a correction, then reloads recorded status",
  timeCardsScreenSrc.includes("requestNativeTimeCorrection") &&
    timeCardsScreenSrc.includes("reloadTimeCards") &&
    timeCardsScreenSrc.includes("Request correction") &&
    timeCardsScreenSrc.includes("requestStatusLabel") &&
    !timeCardsScreenSrc.includes("Accept") &&
    !timeCardsScreenSrc.includes("Decline") &&
    todayScreenSrc.includes("onOpenTimeCards") &&
    todayScreenSrc.includes("Time cards") &&
    appSrc.includes("TimeCardsScreen") &&
    nativeApiSrc.includes("/api/native/v1/time-cards") &&
    nativeApiSrc.includes("/api/native/v1/time-cards/corrections") &&
    nativeTypesSrc.includes("NativeTimeCardEntry") &&
    nativeTypesSrc.includes("requestStatus"),
);
check(
  "Docs keep OWNER decisions on the existing owner surface",
  docsSrc.includes("Time-card correction") &&
    docsSrc.includes("requestTimeCorrection") &&
    docsSrc.includes("test:native-time-cards") &&
    docsSrc.includes("existing Time Cards surface") &&
    docsSrc.includes("does not expose accept/decline"),
);

const emptyJson = parseNativeTimeCorrectionJson("{}");
const validJson = parseNativeTimeCorrectionJson(
  JSON.stringify({
    timeEntryId: "entry-1",
    reason: "Forgot I started earlier",
    proposedStartDate: "2026-09-20",
    proposedStartTime: "08:00",
    proposedEndDate: "2026-09-20",
    proposedEndTime: "10:00",
  }),
);
check(
  "Correction JSON requires an entry, reason, and proposed civil times",
  emptyJson.ok === false &&
    validJson.ok === true &&
    validJson.input.timeEntryId === "entry-1" &&
    validJson.input.reason === "Forgot I started earlier",
);

const oversizedBody = await readCappedRequestText(
  new Request("http://native.test/api/native/v1/time-cards/corrections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "x".repeat(NATIVE_TIME_CARD_JSON_MAX_BYTES + 1),
  }),
  NATIVE_TIME_CARD_JSON_MAX_BYTES,
);
check(
  "Oversized time-card JSON body is rejected before parse",
  oversizedBody.ok === false && oversizedBody.status === 413,
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
  const password = "native-time-cards-pass-9";
  const passwordHash = await hashPassword(password);

  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Native Time Cards",
      slug: `alpha-native-time-cards-${randomUUID()}`,
      tradeCode: "HANDYMAN",
      timezone: NY,
      ...completedOnboarding,
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Native Time Cards",
      slug: `beta-native-time-cards-${randomUUID()}`,
      tradeCode: "HANDYMAN",
      timezone: NY,
      ...completedOnboarding,
    },
  });

  const ownerUser = await prisma.user.create({
    data: {
      name: "Olivia Owner",
      email: `owner-${randomUUID()}@native-time-cards.example`,
      passwordHash,
    },
  });
  const memberUser = await prisma.user.create({
    data: {
      name: "Mia Member",
      email: `mia-${randomUUID()}@native-time-cards.example`,
      passwordHash,
    },
  });
  const otherUser = await prisma.user.create({
    data: {
      name: "Max Other",
      email: `max-${randomUUID()}@native-time-cards.example`,
      passwordHash,
    },
  });
  const betaUser = await prisma.user.create({
    data: {
      name: "Bree Beta",
      email: `bree-${randomUUID()}@beta-time-cards.example`,
      passwordHash,
    },
  });

  const ownerMem = await prisma.membership.create({
    data: {
      userId: ownerUser.id,
      businessId: businessA.id,
      role: "OWNER",
      hourlyWage: new Prisma.Decimal(30),
    },
  });
  const memberMem = await prisma.membership.create({
    data: {
      userId: memberUser.id,
      businessId: businessA.id,
      role: "MEMBER",
      hourlyWage: new Prisma.Decimal(20),
    },
  });
  const otherMem = await prisma.membership.create({
    data: {
      userId: otherUser.id,
      businessId: businessA.id,
      role: "MEMBER",
      hourlyWage: new Prisma.Decimal(18),
    },
  });
  const betaMem = await prisma.membership.create({
    data: {
      userId: betaUser.id,
      businessId: businessB.id,
      role: "MEMBER",
      hourlyWage: new Prisma.Decimal(22),
    },
  });

  await prisma.businessSaasSubscription.create({
    data: { businessId: businessA.id, status: "active", planCode: "FOUNDER", legacyExempt: true },
  });
  await prisma.businessSaasSubscription.create({
    data: { businessId: businessB.id, status: "active", planCode: "FOUNDER", legacyExempt: true },
  });

  async function createAssignedJob(input) {
    const customer = await prisma.customer.create({
      data: {
        businessId: input.businessId,
        name: input.customerName,
        phone: "555-0142",
      },
    });
    return prisma.job.create({
      data: {
        businessId: input.businessId,
        customerId: customer.id,
        assignedMembershipId: input.assignedMembershipId,
        projectToken: randomUUID(),
        status: "SCHEDULED",
        scheduledAt: new Date(),
      },
    });
  }

  const jobA = await createAssignedJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Mia Job Canary",
  });
  const otherJob = await createAssignedJob({
    businessId: businessA.id,
    assignedMembershipId: otherMem.id,
    customerName: "Other Job Canary",
  });
  const betaJob = await createAssignedJob({
    businessId: businessB.id,
    assignedMembershipId: betaMem.id,
    customerName: "Beta Job Canary",
  });
  const approvedJob = await createAssignedJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Approved Week Canary",
  });

  const memberStart = hoursAgo(8);
  const memberEnd = hoursAgo(6);
  const memberProposedStart = hoursAgo(8.5);
  const memberProposedEnd = hoursAgo(6.5);
  const memberEntry = await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: memberMem.id,
      jobId: jobA.id,
      activityType: "JOB",
      status: "READY",
      startedAt: memberStart,
      endedAt: memberEnd,
      source: "CLOCK",
      note: "Mia recorded 2h",
    },
  });
  const otherEntry = await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: otherMem.id,
      jobId: otherJob.id,
      activityType: "TRAVEL",
      status: "READY",
      startedAt: hoursAgo(5),
      endedAt: hoursAgo(4),
      source: "CLOCK",
      note: "Max travel",
    },
  });
  const betaEntry = await prisma.timeEntry.create({
    data: {
      businessId: businessB.id,
      membershipId: betaMem.id,
      jobId: betaJob.id,
      activityType: "JOB",
      status: "READY",
      startedAt: hoursAgo(8),
      endedAt: hoursAgo(7),
      source: "CLOCK",
      note: "Bree recorded 1h",
    },
  });
  const previousWeekStart = weekRange(addDays(new Date(), -7, NY), NY).start;
  const approvedStart = new Date(previousWeekStart.getTime() + 38 * 60 * 60 * 1000);
  const approvedEnd = new Date(approvedStart.getTime() + 2 * 60 * 60 * 1000);
  const approvedEntry = await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: memberMem.id,
      jobId: approvedJob.id,
      activityType: "JOB",
      status: "READY",
      startedAt: approvedStart,
      endedAt: approvedEnd,
      source: "CLOCK",
      note: "Approved-week entry",
    },
  });

  const memberSignIn = await signInNativeField(prisma, {
    email: memberUser.email,
    password,
  });
  const otherSignIn = await signInNativeField(prisma, {
    email: otherUser.email,
    password,
  });
  const betaSignIn = await signInNativeField(prisma, {
    email: betaUser.email,
    password,
  });
  check("Assigned worker can sign in", memberSignIn.ok === true);
  if (!memberSignIn.ok || !otherSignIn.ok || !betaSignIn.ok) {
    throw new Error("Native time-card fixture sign-in failed.");
  }

  const memberAccess = await resolveNativeFieldAccess(prisma, { token: memberSignIn.token });
  const otherAccess = await resolveNativeFieldAccess(prisma, { token: otherSignIn.token });
  const betaAccess = await resolveNativeFieldAccess(prisma, { token: betaSignIn.token });
  if (!memberAccess.ok || !otherAccess.ok || !betaAccess.ok) {
    throw new Error("Native time-card fixture access failed.");
  }

  console.log("\nLIVE — Worker ownership and tenant isolation");
  const memberCards = await loadNativeTimeCards(prisma, memberAccess.access);
  const otherCards = await loadNativeTimeCards(prisma, otherAccess.access);
  const betaCards = await loadNativeTimeCards(prisma, betaAccess.access);
  check(
    "Worker list includes only the caller's own recorded entries",
    memberCards.entries.some((entry) => entry.id === memberEntry.id) &&
      memberCards.entries.some((entry) => entry.id === approvedEntry.id) &&
      !memberCards.entries.some((entry) => entry.id === otherEntry.id) &&
      !memberCards.entries.some((entry) => entry.id === betaEntry.id) &&
      otherCards.entries.every((entry) => entry.id === otherEntry.id) &&
      betaCards.entries.every((entry) => entry.id === betaEntry.id),
  );
  check(
    "Own recorded time is requestable before a pending correction",
    memberCards.entries.find((entry) => entry.id === memberEntry.id)?.canRequest === true &&
      memberCards.entries.find((entry) => entry.id === memberEntry.id)?.requestStatus === null,
  );

  const requested = await requestNativeTimeCorrection(prisma, memberAccess.access, {
    timeEntryId: memberEntry.id,
    reason: "Forgot I started earlier",
    proposedStartDate: formatDateInput(memberProposedStart, NY),
    proposedStartTime: formatTimeInput(memberProposedStart, NY),
    proposedEndDate: formatDateInput(memberProposedEnd, NY),
    proposedEndTime: formatTimeInput(memberProposedEnd, NY),
  });
  const afterRequest = await prisma.timeEntry.findUnique({ where: { id: memberEntry.id } });
  const storedRequest = requested.ok
    ? await prisma.timeCorrectionRequest.findUnique({ where: { id: requested.request.id } })
    : null;
  check(
    "Assigned worker can request a correction on their own recorded time",
    requested.ok === true &&
      requested.request.status === "PENDING" &&
      requested.request.timeEntryId === memberEntry.id &&
      requested.message === NATIVE_TIME_CORRECTION_REQUESTED &&
      storedRequest?.status === "PENDING" &&
      storedRequest.reason === "Forgot I started earlier",
  );
  check(
    "Original TimeEntry is unchanged after the native request",
    afterRequest?.startedAt.getTime() === memberStart.getTime() &&
      afterRequest?.endedAt.getTime() === memberEnd.getTime() &&
      afterRequest?.note === "Mia recorded 2h" &&
      afterRequest?.status === "READY" &&
      afterRequest?.approvedHours == null,
  );

  console.log("\nLIVE — Reload shows the recorded request status");
  const writePayloadEntry = requested.ok
    ? requested.timeCards.entries.find((entry) => entry.id === memberEntry.id)
    : null;
  const reloaded = await loadNativeTimeCards(prisma, memberAccess.access);
  const reloadedEntry = reloaded.entries.find((entry) => entry.id === memberEntry.id);
  check(
    "Successful write returns reloaded time cards with PENDING status",
    writePayloadEntry?.requestStatus === "PENDING" &&
      writePayloadEntry?.requestStatusLabel === "Pending owner" &&
      writePayloadEntry?.canRequest === false &&
      writePayloadEntry?.blockedReason === NATIVE_TIME_CORRECTION_PENDING_REASON &&
      writePayloadEntry?.requestReason === "Forgot I started earlier",
  );
  check(
    "A later loadNativeTimeCards reload shows the same recorded status",
    reloadedEntry?.requestStatus === "PENDING" &&
      reloadedEntry?.requestStatusLabel === "Pending owner" &&
      reloadedEntry?.canRequest === false &&
      reloadedEntry?.blockedReason === NATIVE_TIME_CORRECTION_PENDING_REASON &&
      reloadedEntry?.clockLabel === writePayloadEntry?.clockLabel,
  );

  const otherOnMember = await requestNativeTimeCorrection(prisma, otherAccess.access, {
    timeEntryId: memberEntry.id,
    reason: "not mine",
    proposedStartDate: formatDateInput(memberProposedStart, NY),
    proposedStartTime: formatTimeInput(memberProposedStart, NY),
    proposedEndDate: formatDateInput(memberProposedEnd, NY),
    proposedEndTime: formatTimeInput(memberProposedEnd, NY),
  });
  check(
    "Same-business worker cannot request on another worker's entry",
    otherOnMember.ok === false &&
      otherOnMember.status === 403 &&
      otherOnMember.error === new ForbiddenError().message,
  );

  const betaOnAlpha = await requestNativeTimeCorrection(prisma, betaAccess.access, {
    timeEntryId: memberEntry.id,
    reason: "cross tenant",
    proposedStartDate: formatDateInput(memberProposedStart, NY),
    proposedStartTime: formatTimeInput(memberProposedStart, NY),
    proposedEndDate: formatDateInput(memberProposedEnd, NY),
    proposedEndTime: formatTimeInput(memberProposedEnd, NY),
  });
  const alphaOnBeta = await requestNativeTimeCorrection(prisma, memberAccess.access, {
    timeEntryId: betaEntry.id,
    reason: "cross tenant",
    proposedStartDate: formatDateInput(hoursAgo(8.25), NY),
    proposedStartTime: formatTimeInput(hoursAgo(8.25), NY),
    proposedEndDate: formatDateInput(hoursAgo(7.25), NY),
    proposedEndTime: formatTimeInput(hoursAgo(7.25), NY),
  });
  const betaVisible = await prisma.timeCorrectionRequest.findFirst({
    where: { id: requested.ok ? requested.request.id : "missing", businessId: businessB.id },
  });
  check(
    "Other-tenant worker cannot request on this tenant's entry",
    betaOnAlpha.ok === false &&
      betaOnAlpha.status === 404 &&
      betaOnAlpha.error === NATIVE_TIME_ENTRY_NOT_AVAILABLE,
  );
  check(
    "Worker cannot request on another tenant's entry",
    alphaOnBeta.ok === false &&
      alphaOnBeta.status === 404 &&
      alphaOnBeta.error === NATIVE_TIME_ENTRY_NOT_AVAILABLE,
  );
  check("Tenant B cannot load tenant A's request by id + businessId", betaVisible == null);

  console.log("\nLIVE — Approved-week refusal");
  await approveTimesheetWeek(prisma, makeOwnerAccess(businessA.id, ownerMem.id), {
    membershipId: memberMem.id,
    weekStartedAt: weekRange(approvedStart, NY).start,
    timeZone: NY,
  });
  const approvedCards = await loadNativeTimeCards(prisma, memberAccess.access);
  const approvedCard = approvedCards.entries.find((entry) => entry.id === approvedEntry.id);
  const approvedGate = canRequestTimeCorrection({
    entryStatus: "READY",
    endedAt: approvedEnd,
    weekStatus: "APPROVED",
  });
  const approvedRequest = await requestNativeTimeCorrection(prisma, memberAccess.access, {
    timeEntryId: approvedEntry.id,
    reason: "Need to fix approved week",
    proposedStartDate: formatDateInput(new Date(approvedStart.getTime() - 30 * 60 * 1000), NY),
    proposedStartTime: formatTimeInput(new Date(approvedStart.getTime() - 30 * 60 * 1000), NY),
    proposedEndDate: formatDateInput(new Date(approvedEnd.getTime() - 30 * 60 * 1000), NY),
    proposedEndTime: formatTimeInput(new Date(approvedEnd.getTime() - 30 * 60 * 1000), NY),
  });
  const approvedAfter = await prisma.timeEntry.findUnique({ where: { id: approvedEntry.id } });
  const approvedRequests = await prisma.timeCorrectionRequest.findMany({
    where: { timeEntryId: approvedEntry.id, businessId: businessA.id },
  });
  check(
    "Approved week is not requestable on the native time-card list",
    approvedCard?.canRequest === false &&
      typeof approvedCard?.blockedReason === "string" &&
      /approved/i.test(approvedCard.blockedReason) &&
      approvedGate.ok === false,
  );
  check(
    "Native request on an approved week is refused and leaves time and payroll snapshots alone",
    approvedRequest.ok === false &&
      approvedRequest.status === 409 &&
      /approved/i.test(approvedRequest.error) &&
      approvedAfter?.startedAt.getTime() === approvedStart.getTime() &&
      approvedAfter?.endedAt.getTime() === approvedEnd.getTime() &&
      approvedAfter?.note === "Approved-week entry" &&
      approvedRequests.length === 0,
  );

  const stillPending = await prisma.timeCorrectionRequest.findUnique({
    where: { id: requested.ok ? requested.request.id : "missing" },
  });
  check(
    "Approved-week refusal does not change the earlier pending request",
    stillPending?.status === "PENDING" && stillPending.timeEntryId === memberEntry.id,
  );

  const ownerDecideLeak = /decideTimeCorrectionRequest|DECIDE_TIME_CORRECTIONS/.test(opsSrc);
  check("Native time-card module does not decide corrections", ownerDecideLeak === false);
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
}

if (failures > 0) {
  console.error(`\n${failures} native time-card check(s) failed.`);
  process.exit(1);
}

console.log("\nNative time-card correction checks passed.");
