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
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { hashPassword } = await import("@/lib/auth-crypto");
const { ForbiddenError } = await import("@/lib/authorization");
const { resolveNativeFieldAccess, revokeNativeSession, signInNativeField } = await import(
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
  NONEXISTENT_CIVIL_TIME_ERROR,
  weekRange,
} = await import("@/lib/time-cards");
const {
  approveTimesheetWeek,
  requestTimeCorrection,
  TIME_CORRECTION_DURATION_TOO_LONG_ERROR,
  TIME_CORRECTION_END_IN_FUTURE_ERROR,
} = await import("@/lib/time-card-ops");

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
await prisma.$executeRawUnsafe(`
  CREATE UNIQUE INDEX IF NOT EXISTS "TimeCorrectionRequest_timeEntryId_pending_key"
  ON "TimeCorrectionRequest" ("timeEntryId")
  WHERE status = 'PENDING'
`);

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

function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 3_600_000);
}

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise.then((result) => ({ timedOut: false, result })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true, result: null }), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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

function makeMemberAccess(business, membership) {
  return {
    businessId: business.id,
    workspace: {
      role: "MEMBER",
      membership: { id: membership.id },
      business,
    },
    scope: { businessId: business.id },
    assertOwned(record) {
      if (!record || record.businessId !== business.id) {
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
    opsSrc.includes("active: true") &&
    opsSrc.includes("owned.membershipId !== access.membershipId") &&
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
  "Native ownership check is independent of the canonical membership compare",
  opsSrc.includes("owned.membershipId !== access.membershipId") &&
    !opsSrc.includes("entry.membershipId !== actorMembershipId"),
);
check(
  "Canonical ownership check is independent of the native pre-read",
  requestFnSrc.includes("entry.membershipId !== actorMembershipId") &&
    !requestFnSrc.includes("owned.membershipId !== access.membershipId"),
);
check(
  "Active-membership FOR UPDATE runs inside the canonical write transaction",
  requestFnSrc.includes("exactActiveMembershipHeld") &&
    requestFnSrc.slice(requestFnSrc.indexOf("$transaction")).includes("exactActiveMembershipHeld") &&
    requestFnSrc.includes("PrismaClient lock is released immediately") &&
    !opsSrc.includes("exactActiveMembershipHeld"),
);
check(
  "Canonical request bounds proposed end, duration, and start floor before the week walk",
  requestFnSrc.includes("assertProposedTimeCorrectionBounds") &&
    requestFnSrc.indexOf("assertProposedTimeCorrectionBounds") <
      requestFnSrc.indexOf("$transaction") &&
    timeCardOpsSrc.includes("TIME_CORRECTION_MAX_DURATION_MS = 24") &&
    timeCardOpsSrc.includes("TIME_CORRECTION_FUTURE_SLACK_MS = 5") &&
    timeCardOpsSrc.includes("TIME_CORRECTION_START_LOOKBACK_MS = 90"),
);
check(
  "List gate passes the loaded week status into canRequestTimeCorrection",
  opsSrc.includes("weekStatus: week?.status") &&
    !/canRequestTimeCorrection\(\{\s*entryStatus:[^}]*weekStatus:\s*null/s.test(opsSrc),
);
check(
  "RUNNING and approved-week gates stay in canRequestTimeCorrection and the write",
  /entryStatus === "RUNNING"/.test(readRepo("src/lib/time-cards.ts")) &&
    requestFnSrc.includes("assertCorrectionWeeksEditable") &&
    requestFnSrc.includes("overlappingEntries") &&
    requestFnSrc.includes("status: \"PENDING\"") &&
    requestFnSrc.includes("DUPLICATE_PENDING_CORRECTION_ERROR") &&
    requestFnSrc.includes("const pending = await tx.timeCorrectionRequest.findFirst"),
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

  console.log("\nLIVE — Proposed-time sanity bounds");
  async function createRecordedEntry(input) {
    const job = await createAssignedJob({
      businessId: input.businessId ?? businessA.id,
      assignedMembershipId: input.membershipId,
      customerName: input.customerName,
    });
    return prisma.timeEntry.create({
      data: {
        businessId: input.businessId ?? businessA.id,
        membershipId: input.membershipId,
        jobId: job.id,
        activityType: input.activityType ?? "JOB",
        status: input.status ?? "READY",
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        source: "CLOCK",
        note: input.note ?? input.customerName,
      },
    });
  }

  const boundEntry = await createRecordedEntry({
    membershipId: memberMem.id,
    customerName: "Bounds Canary",
    startedAt: hoursAgo(20),
    endedAt: hoursAgo(18),
  });
  const boundStart = hoursAgo(19.5);
  const boundEnd = hoursAgo(18.5);

  async function proposeOn(entry, start, end, reason = "bound check") {
    return requestNativeTimeCorrection(prisma, memberAccess.access, {
      timeEntryId: entry.id,
      reason,
      proposedStartDate: formatDateInput(start, NY),
      proposedStartTime: formatTimeInput(start, NY),
      proposedEndDate: formatDateInput(end, NY),
      proposedEndTime: formatTimeInput(end, NY),
    });
  }

  const far2099 = await withTimeout(
    proposeOn(boundEntry, new Date("2026-09-16T13:00:00.000Z"), new Date("2099-01-01T13:00:00.000Z"), "2099 end"),
    1000,
  );
  const far9999 = far2099.timedOut
    ? { timedOut: true, result: null }
    : await withTimeout(
        proposeOn(
          boundEntry,
          new Date("2026-09-16T13:00:00.000Z"),
          new Date("9999-12-31T13:00:00.000Z"),
          "9999 end",
        ),
        1000,
      );
  const plus3Days = await proposeOn(boundEntry, hoursAgo(2), hoursFromNow(72), "three days ahead");
  const longDuration = await proposeOn(boundEntry, hoursAgo(40), hoursAgo(3.5), "36.5 hours");
  const boundRequests = await prisma.timeCorrectionRequest.count({
    where: { timeEntryId: boundEntry.id, businessId: businessA.id },
  });
  check(
    "Far-future 2099-01-01 end returns 400 in under 1s and writes no request",
    far2099.timedOut === false &&
      far2099.result?.ok === false &&
      far2099.result?.status === 400 &&
      far2099.result?.error === TIME_CORRECTION_END_IN_FUTURE_ERROR,
  );
  check(
    "Far-future 9999-12-31 end returns 400 in under 1s and writes no request",
    far9999.timedOut === false &&
      far9999.result?.ok === false &&
      far9999.result?.status === 400 &&
      far9999.result?.error === TIME_CORRECTION_END_IN_FUTURE_ERROR,
  );
  check(
    "Proposed end 3 days ahead is refused with 400",
    plus3Days.ok === false &&
      plus3Days.status === 400 &&
      plus3Days.error === TIME_CORRECTION_END_IN_FUTURE_ERROR,
  );
  check(
    "36.5 hour duration is refused with 400",
    longDuration.ok === false &&
      longDuration.status === 400 &&
      longDuration.error === TIME_CORRECTION_DURATION_TOO_LONG_ERROR,
  );
  const validBound = await proposeOn(boundEntry, boundStart, boundEnd, "same-day valid");
  check(
    "Valid same-day correction is still PENDING",
    validBound.ok === true &&
      validBound.request.status === "PENDING" &&
      boundRequests === 0 &&
      (await prisma.timeCorrectionRequest.count({
        where: { timeEntryId: boundEntry.id, businessId: businessA.id },
      })) === 1,
  );

  console.log("\nLIVE — Ownership layers, overlap, RUNNING, duplicate, DST, midnight");
  const canonicalOther = await requestTimeCorrection(
    prisma,
    makeMemberAccess(businessA, otherMem),
    {
      timeEntryId: boundEntry.id,
      reason: "canonical other worker",
      proposedStartedAt: hoursAgo(7.25),
      proposedEndedAt: hoursAgo(6.25),
      timeZone: NY,
    },
  ).then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error }),
  );
  check(
    "Canonical ownership check alone refuses another worker",
    canonicalOther.ok === false && canonicalOther.error instanceof ForbiddenError,
  );
  const nativeOther = await requestNativeTimeCorrection(prisma, otherAccess.access, {
    timeEntryId: boundEntry.id,
    reason: "native other worker",
    proposedStartDate: formatDateInput(hoursAgo(7.25), NY),
    proposedStartTime: formatTimeInput(hoursAgo(7.25), NY),
    proposedEndDate: formatDateInput(hoursAgo(6.25), NY),
    proposedEndTime: formatTimeInput(hoursAgo(6.25), NY),
  });
  check(
    "Native ownership check refuses another worker before a write",
    nativeOther.ok === false && nativeOther.status === 403,
  );

  const overlapNeighbor = await createRecordedEntry({
    membershipId: memberMem.id,
    customerName: "Overlap Neighbor",
    startedAt: hoursAgo(5.5),
    endedAt: hoursAgo(4.5),
  });
  const overlapTarget = await createRecordedEntry({
    membershipId: memberMem.id,
    customerName: "Overlap Target",
    startedAt: hoursAgo(4),
    endedAt: hoursAgo(3),
  });
  const overlapRequest = await proposeOn(
    overlapTarget,
    hoursAgo(5.25),
    hoursAgo(4.75),
    "would overlap neighbor",
  );
  check(
    "Overlap check refuses a proposed clock that hits another own entry",
    overlapRequest.ok === false &&
      overlapRequest.status === 409 &&
      /overlap/i.test(overlapRequest.error) &&
      (await prisma.timeCorrectionRequest.count({
        where: { timeEntryId: overlapTarget.id, businessId: businessA.id },
      })) === 0,
  );
  void overlapNeighbor;

  const runningEntry = await createRecordedEntry({
    membershipId: memberMem.id,
    customerName: "Running Canary",
    status: "RUNNING",
    startedAt: hoursAgo(1),
    endedAt: null,
  });
  const runningGate = canRequestTimeCorrection({
    entryStatus: "RUNNING",
    endedAt: new Date(),
  });
  const runningRequest = await proposeOn(runningEntry, hoursAgo(1), hoursAgo(0.25), "running");
  const runningList = await loadNativeTimeCards(prisma, memberAccess.access);
  check(
    "RUNNING status is not requestable even when an end instant is present on the gate",
    runningGate.ok === false && /Stop the clock/i.test(runningGate.error ?? ""),
  );
  check(
    "RUNNING entry is refused on the write and omitted or blocked on the list",
    runningRequest.ok === false &&
      (runningRequest.status === 400 || runningRequest.status === 409) &&
      /Stop the clock/i.test(runningRequest.error) &&
      runningList.entries.every((entry) => entry.id !== runningEntry.id || entry.canRequest === false),
  );

  const duplicateEntry = await createRecordedEntry({
    membershipId: memberMem.id,
    customerName: "Duplicate Canary",
    startedAt: hoursAgo(10),
    endedAt: hoursAgo(9),
  });
  const firstDup = await proposeOn(duplicateEntry, hoursAgo(9.75), hoursAgo(9.25), "first pending");
  const secondDup = await proposeOn(duplicateEntry, hoursAgo(9.7), hoursAgo(9.2), "second pending");
  check(
    "Duplicate pending request is refused and leaves one PENDING row",
    firstDup.ok === true &&
      secondDup.ok === false &&
      secondDup.status === 409 &&
      /already waiting/i.test(secondDup.error) &&
      (await prisma.timeCorrectionRequest.count({
        where: { timeEntryId: duplicateEntry.id, businessId: businessA.id, status: "PENDING" },
      })) === 1,
  );

  const parallelEntry = await createRecordedEntry({
    membershipId: memberMem.id,
    customerName: "Parallel Canary",
    startedAt: hoursAgo(12),
    endedAt: hoursAgo(11),
  });
  const parallelResults = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      proposeOn(
        parallelEntry,
        hoursAgo(11.75),
        hoursAgo(11.25),
        `parallel ${index}`,
      ),
    ),
  );
  const parallelOk = parallelResults.filter((row) => row.ok === true);
  const parallelConflict = parallelResults.filter(
    (row) => row.ok === false && row.status === 409 && /already waiting/i.test(row.error),
  );
  const parallelPending = await prisma.timeCorrectionRequest.count({
    where: { timeEntryId: parallelEntry.id, businessId: businessA.id, status: "PENDING" },
  });
  check(
    "Six parallel submits yield exactly 1 PENDING and 5 clean 409s",
    parallelOk.length === 1 && parallelConflict.length === 5 && parallelPending === 1,
  );

  const dstEntry = await createRecordedEntry({
    membershipId: memberMem.id,
    customerName: "DST Canary",
    startedAt: hoursAgo(14),
    endedAt: hoursAgo(13),
  });
  const dstRequest = await requestNativeTimeCorrection(prisma, memberAccess.access, {
    timeEntryId: dstEntry.id,
    reason: "spring forward gap",
    proposedStartDate: "2026-03-08",
    proposedStartTime: "02:30",
    proposedEndDate: "2026-03-08",
    proposedEndTime: "04:00",
  });
  check(
    "DST spring-forward nonexistent time is refused with 400",
    dstRequest.ok === false &&
      dstRequest.status === 400 &&
      dstRequest.error === NONEXISTENT_CIVIL_TIME_ERROR &&
      (await prisma.timeCorrectionRequest.count({
        where: { timeEntryId: dstEntry.id, businessId: businessA.id },
      })) === 0,
  );

  const midnightStart = new Date("2026-09-30T02:00:00.000Z");
  const midnightEnd = new Date("2026-09-30T06:00:00.000Z");
  const midnightEntry = await createRecordedEntry({
    membershipId: memberMem.id,
    customerName: "Midnight Canary",
    startedAt: midnightStart,
    endedAt: midnightEnd,
  });
  const midnightRequest = await requestNativeTimeCorrection(prisma, memberAccess.access, {
    timeEntryId: midnightEntry.id,
    reason: "crossed midnight",
    proposedStartDate: "2026-09-29",
    proposedStartTime: "22:00",
    proposedEndDate: "2026-09-30",
    proposedEndTime: "02:00",
  });
  check(
    "Midnight-crossing same-duration correction is accepted as PENDING",
    midnightRequest.ok === true &&
      midnightRequest.request.status === "PENDING" &&
      formatDateInput(midnightStart, NY) === "2026-09-29" &&
      formatTimeInput(midnightStart, NY) === "22:00",
  );

  const readyOnApprovedWeek = await createRecordedEntry({
    membershipId: memberMem.id,
    customerName: "Ready On Approved Week",
    startedAt: hoursAgo(3.5),
    endedAt: hoursAgo(2.5),
  });
  await prisma.timesheetWeek.upsert({
    where: {
      businessId_membershipId_weekStartedAt: {
        businessId: businessA.id,
        membershipId: memberMem.id,
        weekStartedAt: weekRange(readyOnApprovedWeek.startedAt, NY).start,
      },
    },
    update: { status: "APPROVED" },
    create: {
      businessId: businessA.id,
      membershipId: memberMem.id,
      weekStartedAt: weekRange(readyOnApprovedWeek.startedAt, NY).start,
      status: "APPROVED",
      approvedHours: new Prisma.Decimal(0),
      approvedHourlyWage: new Prisma.Decimal(20),
      approvedLaborCost: new Prisma.Decimal(0),
    },
  });
  const weekStatusList = await loadNativeTimeCards(prisma, memberAccess.access);
  const weekStatusCard = weekStatusList.entries.find((entry) => entry.id === readyOnApprovedWeek.id);
  check(
    "List passes weekStatus so an APPROVED week blocks a still-READY entry",
    weekStatusCard?.canRequest === false &&
      /approved/i.test(weekStatusCard?.blockedReason ?? "") &&
      canRequestTimeCorrection({
        entryStatus: "READY",
        endedAt: readyOnApprovedWeek.endedAt,
        weekStatus: "APPROVED",
      }).ok === false &&
      canRequestTimeCorrection({
        entryStatus: "READY",
        endedAt: readyOnApprovedWeek.endedAt,
        weekStatus: null,
      }).ok === true,
  );

  console.log("\nLIVE — Deactivated and revoked workers");
  const deactivateUser = await prisma.user.create({
    data: {
      name: "Dee Deactivate",
      email: `dee-${randomUUID()}@native-time-cards.example`,
      passwordHash,
    },
  });
  const deactivateMem = await prisma.membership.create({
    data: {
      userId: deactivateUser.id,
      businessId: businessA.id,
      role: "MEMBER",
      hourlyWage: new Prisma.Decimal(16),
    },
  });
  const deactivateEntry = await createRecordedEntry({
    membershipId: deactivateMem.id,
    customerName: "Deactivate Canary",
    startedAt: hoursAgo(8),
    endedAt: hoursAgo(6),
  });
  const deactivateSignIn = await signInNativeField(prisma, {
    email: deactivateUser.email,
    password,
  });
  if (!deactivateSignIn.ok) throw new Error("Deactivate fixture sign-in failed.");
  const deactivateAccess = await resolveNativeFieldAccess(prisma, { token: deactivateSignIn.token });
  if (!deactivateAccess.ok) throw new Error("Deactivate fixture access failed.");
  await prisma.membership.update({
    where: { id: deactivateMem.id },
    data: { active: false },
  });
  const deactivatedRequest = await requestNativeTimeCorrection(prisma, deactivateAccess.access, {
    timeEntryId: deactivateEntry.id,
    reason: "already deactivated",
    proposedStartDate: formatDateInput(hoursAgo(7.5), NY),
    proposedStartTime: formatTimeInput(hoursAgo(7.5), NY),
    proposedEndDate: formatDateInput(hoursAgo(6.5), NY),
    proposedEndTime: formatTimeInput(hoursAgo(6.5), NY),
  });
  check(
    "Already-deactivated worker is refused by the active:true pre-read",
    deactivatedRequest.ok === false &&
      deactivatedRequest.status === 404 &&
      (await prisma.timeCorrectionRequest.count({
        where: { timeEntryId: deactivateEntry.id, businessId: businessA.id },
      })) === 0,
  );

  const raceUser = await prisma.user.create({
    data: {
      name: "Ray Race",
      email: `ray-${randomUUID()}@native-time-cards.example`,
      passwordHash,
    },
  });
  const raceMem = await prisma.membership.create({
    data: {
      userId: raceUser.id,
      businessId: businessA.id,
      role: "MEMBER",
      hourlyWage: new Prisma.Decimal(16),
    },
  });
  const raceEntry = await createRecordedEntry({
    membershipId: raceMem.id,
    customerName: "Race Canary",
    startedAt: hoursAgo(8),
    endedAt: hoursAgo(6),
  });
  const raceSignIn = await signInNativeField(prisma, { email: raceUser.email, password });
  if (!raceSignIn.ok) throw new Error("Race fixture sign-in failed.");
  const raceResolved = await resolveNativeFieldAccess(prisma, { token: raceSignIn.token });
  if (!raceResolved.ok) throw new Error("Race fixture access failed.");
  const raceRequest = await requestNativeTimeCorrection(
    prisma,
    raceResolved.access,
    {
      timeEntryId: raceEntry.id,
      reason: "deactivate between check and write",
      proposedStartDate: formatDateInput(hoursAgo(7.5), NY),
      proposedStartTime: formatTimeInput(hoursAgo(7.5), NY),
      proposedEndDate: formatDateInput(hoursAgo(6.5), NY),
      proposedEndTime: formatTimeInput(hoursAgo(6.5), NY),
    },
    {
      afterInitialRead: async () => {
        await prisma.membership.update({
          where: { id: raceMem.id },
          data: { active: false },
        });
      },
    },
  );
  const raceMembership = await prisma.membership.findUnique({
    where: { id: raceMem.id },
    select: { active: true },
  });
  check(
    "Deactivation between the pre-read and the write refuses and writes no PENDING request",
    raceRequest.ok === false &&
      raceMembership?.active === false &&
      (await prisma.timeCorrectionRequest.count({
        where: { timeEntryId: raceEntry.id, businessId: businessA.id },
      })) === 0,
  );

  const revoked = await revokeNativeSession(prisma, memberSignIn.token);
  const afterRevoke = await resolveNativeFieldAccess(prisma, { token: memberSignIn.token });
  check(
    "Revoked worker cannot obtain field access for a later correction",
    revoked === true && afterRevoke.ok === false && afterRevoke.status === 401,
  );
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

if (!process.env.NATIVE_TIME_CARD_MUTATION_CHILD) {
  console.log("\nMUTATION — Revert each guard and require a failing child run");
  const childScript = fileURLToPath(new URL("./check-native-time-cards.mjs", import.meta.url));
  const mutations = [
    {
      label: "B1 proposed-time bounds",
      file: "src/lib/time-card-ops.ts",
      search: "assertProposedTimeCorrectionBounds({",
      replace: "void ({",
      all: true,
    },
    {
      label: "native ownership check",
      file: "src/lib/native-time-cards.ts",
      search: "owned.membershipId !== access.membershipId",
      replace: "false",
    },
    {
      label: "canonical ownership check",
      file: "src/lib/time-card-ops.ts",
      search: "entry.membershipId !== actorMembershipId",
      replace: "false",
    },
    {
      label: "exactActiveMembershipHeld",
      file: "src/lib/time-card-ops.ts",
      search:
        "    // FOR UPDATE must run on this transaction client. A pre-transaction\n    // PrismaClient lock is released immediately and does not serialize\n    // a deactivation that lands before this write.\n    if (\n      !(await exactActiveMembershipHeld(tx, {\n        businessId: access.businessId,\n        membershipId: actorMembershipId,\n      }))\n    ) {\n      throw new ForbiddenError();\n    }",
      replace: "    if (false) {\n      throw new ForbiddenError();\n    }",
    },
    {
      label: "active:true pre-read",
      file: "src/lib/native-time-cards.ts",
      search: "        active: true,",
      replace: "        id: access.membershipId,",
    },
    {
      label: "assertCorrectionWeeksEditable",
      file: "src/lib/time-card-ops.ts",
      search:
        "      await assertCorrectionWeeksEditable(\n        tx,\n        access.businessId,\n        entry.membershipId,\n        [\n          { startedAt: entry.startedAt, endedAt: entry.endedAt },\n          { startedAt: input.proposedStartedAt, endedAt: input.proposedEndedAt },\n        ],\n        timeZone,\n      );",
      replace: "      void 0;",
    },
    {
      label: "overlap check",
      file: "src/lib/time-card-ops.ts",
      search:
        "      input.proposedStartedAt,\n      input.proposedEndedAt,\n      entry.id,\n    );\n    if (overlaps.length > 0) {\n      throw new TimeCardError(\"That correction would overlap another entry.\");\n    }",
      replace:
        "      input.proposedStartedAt,\n      input.proposedEndedAt,\n      entry.id,\n    );\n    if (false && overlaps.length > 0) {\n      throw new TimeCardError(\"That correction would overlap another entry.\");\n    }",
    },
    {
      label: "duplicate pending findFirst",
      file: "src/lib/time-card-ops.ts",
      search: "const pending = await tx.timeCorrectionRequest.findFirst",
      replace: "const pending = false && await tx.timeCorrectionRequest.findFirst",
    },
    {
      label: "RUNNING gate",
      file: "src/lib/time-cards.ts",
      search: 'if (input.entryStatus === "RUNNING" || input.endedAt == null)',
      replace: "if (input.endedAt == null && input.entryStatus === \"NEVER\")",
    },
    {
      label: "weekStatus:null on the list",
      file: "src/lib/native-time-cards.ts",
      search: "weekStatus: week?.status",
      replace: "weekStatus: null",
    },
  ];

  for (const mutation of mutations) {
    const target = fileURLToPath(new URL(`../${mutation.file}`, import.meta.url));
    const original = readFileSync(target, "utf8");
    if (!original.includes(mutation.search)) {
      check(`mutation setup finds ${mutation.label}`, false);
      continue;
    }
    writeFileSync(
      target,
      mutation.all
        ? original.split(mutation.search).join(mutation.replace)
        : original.replace(mutation.search, mutation.replace),
    );
    try {
      const child = spawnSync(process.execPath, ["--experimental-strip-types", childScript], {
        env: { ...process.env, NATIVE_TIME_CARD_MUTATION_CHILD: "1" },
        encoding: "utf8",
        timeout: 120_000,
      });
      const failed = child.status !== 0;
      check(`Mutation ${mutation.label} fails a test`, failed);
      if (!failed) {
        console.error(child.stdout.slice(-2000));
      }
    } finally {
      writeFileSync(target, original);
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} native time-card check(s) failed.`);
  process.exit(1);
}

console.log("\nNative time-card correction checks passed.");
