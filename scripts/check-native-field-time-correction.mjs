/**
 * Native assigned-job time-correction requests — reuse
 * `requestTimeCorrection`, assigned-job isolation, OWNER-only decide,
 * approved-week refusal, and duplicate PENDING protection.
 *
 * Imports the REAL production helpers from src/lib/native-field.ts,
 * src/lib/native-field-time-correction.ts, and src/lib/time-card-ops.ts.
 * Uses a disposable sibling Postgres database.
 *
 * Run with:
 *   npm run test:native-field-time-correction
 */
import { createRequire, register } from "node:module";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { withDisposableTestDatabase } = await import("./disposable-test-database.mjs");
const { hashPassword } = await import("@/lib/auth-crypto");
const { CAPABILITIES, ForbiddenError, roleHasCapability } = await import(
  "@/lib/authorization"
);
const { NATIVE_JOB_NOT_AVAILABLE } = await import("@/lib/native-field-ops");
const { loadNativeAssignedJob } = await import("@/lib/native-field");
const {
  NATIVE_TIME_CORRECTION_ENTRY_MISSING,
  NATIVE_TIME_CORRECTION_INVALID,
  NATIVE_TIME_CORRECTION_JSON_MAX_BYTES,
  NATIVE_TIME_CORRECTION_LIMIT,
  parseNativeTimeCorrectionJson,
  readNativeAssignedJobTimeCorrections,
  requestNativeAssignedJobTimeCorrection,
} = await import("@/lib/native-field-time-correction");
const { resolveNativeFieldAccess, signInNativeField } = await import(
  "@/lib/native-session"
);
const { readCappedRequestText } = await import("@/lib/native-session-limits");
const { SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE } = await import(
  "@/lib/saas-billing/messages"
);
const { weekRange } = await import("@/lib/time-cards");
const { decideTimeCorrectionRequest, requestTimeCorrection } = await import(
  "@/lib/time-card-ops"
);

const NY = "America/New_York";

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

async function expectError(label, fn, predicate) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

function readRepo(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: { role, membership: { id: membershipId }, business: { timezone: NY } },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 3_600_000);
}

const correctionOpsSrc = readRepo("src/lib/native-field-time-correction.ts");
const nativeFieldSrc = readRepo("src/lib/native-field.ts");
const routeSrc = readRepo("src/app/api/native/v1/jobs/[jobId]/time-corrections/route.ts");
const jobScreenSrc = readRepo("apps/native/src/screens/JobScreen.tsx");
const sectionSrc = readRepo("apps/native/src/screens/JobTimeCorrectionSection.tsx");
const nativeApiSrc = readRepo("apps/native/src/api.ts");
const nativeTypesSrc = readRepo("apps/native/src/types.ts");
const docsSrc = readRepo("docs/NATIVE_FIELD.md");
const packageSrc = readRepo("package.json");
const timeCardOpsSrc = readRepo("src/lib/time-card-ops.ts");

console.log("\nSTATIC — Canonical request write, assigned-job lock, and Job-screen reload");
check(
  "Native time-correction write reuses requestTimeCorrection and assigned-job scope",
  correctionOpsSrc.includes("requestTimeCorrection") &&
    correctionOpsSrc.includes("nativeAssignedJobWhere") &&
    correctionOpsSrc.includes("lockTenantOwnedJob") &&
    correctionOpsSrc.includes("assignmentStillHeld") &&
    correctionOpsSrc.includes("exactActiveMembershipHeld") &&
    correctionOpsSrc.includes("afterInitialRead") &&
    correctionOpsSrc.includes("requireSaasOperatingEntitlement") &&
    routeSrc.includes("requestNativeAssignedJobTimeCorrection") &&
    routeSrc.includes("readNativeAssignedJobTimeCorrections") &&
    !correctionOpsSrc.includes("decideTimeCorrectionRequest") &&
    !routeSrc.includes("decideTimeCorrectionRequest") &&
    !correctionOpsSrc.includes("completeJobAndSendInvoice"),
);
check(
  "Native time-correction never rewrites TimeEntry times itself",
  !/timeEntry\.update\(/.test(correctionOpsSrc) &&
    timeCardOpsSrc.includes("export async function requestTimeCorrection") &&
    !/export async function requestTimeCorrection[\s\S]*timeEntry\.update\([\s\S]*status: "NEEDS_REVIEW"/.test(
      timeCardOpsSrc.slice(timeCardOpsSrc.indexOf("export async function requestTimeCorrection")),
    ),
);
check(
  "Job detail and native Job screen expose only the caller's correctable time",
  nativeFieldSrc.includes("timeCorrections") &&
    nativeFieldSrc.includes("loadNativeAssignedJobTimeCorrections") &&
    jobScreenSrc.includes("JobTimeCorrectionSection") &&
    sectionSrc.includes("requestNativeJobTimeCorrection") &&
    sectionSrc.includes("Request correction") &&
    nativeApiSrc.includes("/time-corrections") &&
    nativeTypesSrc.includes("NativeTimeCorrectionEntry") &&
    nativeTypesSrc.includes("timeCorrections"),
);
check(
  "Docs describe assignment-scoped request and keep OWNER decide on the web",
  docsSrc.includes("Time correction") &&
    docsSrc.includes("requestTimeCorrection") &&
    docsSrc.includes("decideTimeCorrectionRequest") &&
    docsSrc.includes("test:native-field-time-correction") &&
    packageSrc.includes("test:native-field-time-correction"),
);
check(
  "ADMIN and MEMBER do not have DECIDE_TIME_CORRECTIONS",
  roleHasCapability("OWNER", CAPABILITIES.DECIDE_TIME_CORRECTIONS) &&
    !roleHasCapability("ADMIN", CAPABILITIES.DECIDE_TIME_CORRECTIONS) &&
    !roleHasCapability("MEMBER", CAPABILITIES.DECIDE_TIME_CORRECTIONS),
);

const emptyJson = parseNativeTimeCorrectionJson("{}");
const missingReason = parseNativeTimeCorrectionJson(
  JSON.stringify({ timeEntryId: "entry_1", proposedStartedAt: "2026-10-01T12:00:00.000Z" }),
);
const validJson = parseNativeTimeCorrectionJson(
  JSON.stringify({
    timeEntryId: "entry_1",
    reason: "Forgot to stop on time",
    proposedStartedAt: "2026-10-01T12:00:00.000Z",
    proposedEndedAt: "2026-10-01T14:00:00.000Z",
  }),
);
check(
  "Time-correction JSON requires an entry id and a reason",
  emptyJson.ok === false &&
    emptyJson.error === NATIVE_TIME_CORRECTION_INVALID &&
    missingReason.ok === false &&
    validJson.ok === true &&
    validJson.input.timeEntryId === "entry_1",
);

const oversizedBody = await readCappedRequestText(
  new Request("http://native.test/api/native/v1/jobs/job/time-corrections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "x".repeat(NATIVE_TIME_CORRECTION_JSON_MAX_BYTES + 1),
  }),
  NATIVE_TIME_CORRECTION_JSON_MAX_BYTES,
);
check(
  "Oversized time-correction JSON body is rejected before parse",
  oversizedBody.ok === false && oversizedBody.status === 413,
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

await withDisposableTestDatabase({ databaseUrl: baseUrl, namePrefix: "tbbt_native_time_corr" }, async ({ prisma }) => {
  const onboardingDone = new Date();
  const completedOnboarding = {
    firstRunSetupCompletedAt: onboardingDone,
    starterServicesSetupCompletedAt: onboardingDone,
    starterServicesSetupChoice: "SKIPPED",
    websiteSetupCompletedAt: onboardingDone,
    websiteSetupChoice: "SKIPPED",
  };
  const password = "native-time-corr-pass-9";
  const passwordHash = await hashPassword(password);

  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Native Time Correction",
      slug: `alpha-native-time-corr-${randomUUID()}`,
      tradeCode: "HANDYMAN",
      timezone: NY,
      ...completedOnboarding,
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Native Time Correction",
      slug: `beta-native-time-corr-${randomUUID()}`,
      tradeCode: "HANDYMAN",
      timezone: NY,
      ...completedOnboarding,
    },
  });
  const blockedBusiness = await prisma.business.create({
    data: {
      name: "Blocked Native Time Correction",
      slug: `blocked-native-time-corr-${randomUUID()}`,
      tradeCode: "HANDYMAN",
      timezone: NY,
      ...completedOnboarding,
    },
  });

  const ownerUser = await prisma.user.create({
    data: {
      name: "Olivia Owner",
      email: `owner-${randomUUID()}@native-time-corr.example`,
      passwordHash,
    },
  });
  const adminUser = await prisma.user.create({
    data: {
      name: "Ava Admin",
      email: `admin-${randomUUID()}@native-time-corr.example`,
      passwordHash,
    },
  });
  const memberUser = await prisma.user.create({
    data: {
      name: "Mia Member",
      email: `mia-${randomUUID()}@native-time-corr.example`,
      passwordHash,
    },
  });
  const otherUser = await prisma.user.create({
    data: {
      name: "Max Other",
      email: `max-${randomUUID()}@native-time-corr.example`,
      passwordHash,
    },
  });
  const betaUser = await prisma.user.create({
    data: {
      name: "Bree Beta",
      email: `bree-${randomUUID()}@beta-time-corr.example`,
      passwordHash,
    },
  });
  const blockedUser = await prisma.user.create({
    data: {
      name: "Blocked Member",
      email: `blocked-${randomUUID()}@native-time-corr.example`,
      passwordHash,
    },
  });

  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const adminMem = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: businessA.id, role: "ADMIN" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const otherMem = await prisma.membership.create({
    data: { userId: otherUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const betaMem = await prisma.membership.create({
    data: { userId: betaUser.id, businessId: businessB.id, role: "MEMBER" },
  });
  const blockedMem = await prisma.membership.create({
    data: { userId: blockedUser.id, businessId: blockedBusiness.id, role: "MEMBER" },
  });

  await prisma.businessSaasSubscription.create({
    data: { businessId: businessA.id, status: "active", planCode: "FOUNDER", legacyExempt: true },
  });
  await prisma.businessSaasSubscription.create({
    data: { businessId: businessB.id, status: "active", planCode: "FOUNDER", legacyExempt: true },
  });
  const endedTrial = new Date(Date.now() - 60_000);
  await prisma.businessSaasSubscription.create({
    data: {
      businessId: blockedBusiness.id,
      status: "canceled",
      planCode: "FOUNDER",
      legacyExempt: false,
      trialStartedAt: new Date(endedTrial.getTime() - 14 * 24 * 60 * 60 * 1000),
      trialEndsAt: endedTrial,
      founderEligibilityEndedAt: endedTrial,
    },
  });

  async function createJob(input) {
    const customer = await prisma.customer.create({
      data: {
        businessId: input.businessId,
        name: input.customerName ?? "Time Correction Customer",
        phone: "555-0142",
      },
    });
    return prisma.job.create({
      data: {
        businessId: input.businessId,
        customerId: customer.id,
        assignedMembershipId: input.assignedMembershipId ?? null,
        projectToken: randomUUID(),
        status: input.status ?? "IN_PROGRESS",
        scheduledAt: new Date(),
      },
    });
  }

  async function createEndedTime(input) {
    return prisma.timeEntry.create({
      data: {
        businessId: input.businessId,
        membershipId: input.membershipId,
        jobId: input.jobId,
        activityType: input.activityType ?? "JOB",
        status: input.status ?? "READY",
        startedAt: input.startedAt ?? hoursAgo(3),
        endedAt: input.endedAt ?? hoursAgo(1),
        source: "CLOCK",
      },
    });
  }

  const memberJob = await createJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Member Correction Canary",
  });
  const otherJob = await createJob({
    businessId: businessA.id,
    assignedMembershipId: otherMem.id,
    customerName: "Other Worker Canary",
  });
  const unassignedJob = await createJob({
    businessId: businessA.id,
    customerName: "Unassigned Correction Canary",
  });
  const betaJob = await createJob({
    businessId: businessB.id,
    assignedMembershipId: betaMem.id,
    customerName: "Beta Correction Canary",
  });
  const adminJob = await createJob({
    businessId: businessA.id,
    assignedMembershipId: adminMem.id,
    customerName: "Admin Correction Canary",
  });
  const blockedJob = await createJob({
    businessId: blockedBusiness.id,
    assignedMembershipId: blockedMem.id,
    customerName: "Blocked Correction Canary",
  });
  const raceJob = await createJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Reassign Correction Canary",
  });
  const limitJob = await createJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Limit Correction Canary",
  });

  const memberEntry = await createEndedTime({
    businessId: businessA.id,
    membershipId: memberMem.id,
    jobId: memberJob.id,
    startedAt: hoursAgo(12),
    endedAt: hoursAgo(10),
  });
  const memberTravel = await createEndedTime({
    businessId: businessA.id,
    membershipId: memberMem.id,
    jobId: memberJob.id,
    activityType: "TRAVEL",
    startedAt: hoursAgo(14),
    endedAt: hoursAgo(13),
  });
  const runningEntry = await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: memberMem.id,
      jobId: memberJob.id,
      activityType: "JOB",
      status: "RUNNING",
      startedAt: hoursAgo(0.25),
      source: "CLOCK",
    },
  });
  const otherOnSameJob = await createEndedTime({
    businessId: businessA.id,
    membershipId: otherMem.id,
    jobId: memberJob.id,
    startedAt: hoursAgo(12),
    endedAt: hoursAgo(10),
  });
  const memberOtherJobEntry = await createEndedTime({
    businessId: businessA.id,
    membershipId: memberMem.id,
    jobId: otherJob.id,
    startedAt: hoursAgo(16),
    endedAt: hoursAgo(15),
  });
  const otherEntry = await createEndedTime({
    businessId: businessA.id,
    membershipId: otherMem.id,
    jobId: otherJob.id,
    startedAt: hoursAgo(6),
    endedAt: hoursAgo(5),
  });
  const betaEntry = await createEndedTime({
    businessId: businessB.id,
    membershipId: betaMem.id,
    jobId: betaJob.id,
    startedAt: hoursAgo(6),
    endedAt: hoursAgo(5),
  });
  const adminEntry = await createEndedTime({
    businessId: businessA.id,
    membershipId: adminMem.id,
    jobId: adminJob.id,
    startedAt: hoursAgo(6),
    endedAt: hoursAgo(5),
  });
  const blockedEntry = await createEndedTime({
    businessId: blockedBusiness.id,
    membershipId: blockedMem.id,
    jobId: blockedJob.id,
    startedAt: hoursAgo(6),
    endedAt: hoursAgo(5),
  });
  const raceEntry = await createEndedTime({
    businessId: businessA.id,
    membershipId: memberMem.id,
    jobId: raceJob.id,
    startedAt: hoursAgo(8),
    endedAt: hoursAgo(7),
  });
  const approvedEntry = await createEndedTime({
    businessId: businessA.id,
    membershipId: memberMem.id,
    jobId: memberJob.id,
    startedAt: hoursAgo(24 * 10 + 4),
    endedAt: hoursAgo(24 * 10 + 2),
    status: "APPROVED",
  });
  await prisma.timesheetWeek.create({
    data: {
      businessId: businessA.id,
      membershipId: memberMem.id,
      weekStartedAt: weekRange(approvedEntry.startedAt, NY).start,
      status: "APPROVED",
      approvedAt: new Date(),
      approvedByMembershipId: ownerMem.id,
    },
  });

  const limitEntries = [];
  for (let index = 0; index < NATIVE_TIME_CORRECTION_LIMIT + 1; index += 1) {
    const startHoursAgo = 40 + index * 2;
    limitEntries.push(
      await createEndedTime({
        businessId: businessA.id,
        membershipId: memberMem.id,
        jobId: limitJob.id,
        startedAt: hoursAgo(startHoursAgo + 1),
        endedAt: hoursAgo(startHoursAgo),
      }),
    );
  }

  async function signInAccess(email) {
    const signed = await signInNativeField(prisma, { email, password });
    if (!signed.ok) {
      throw new Error(`Native sign-in failed for ${email}: ${signed.error}`);
    }
    const resolved = await resolveNativeFieldAccess(prisma, { token: signed.token });
    if (!resolved.ok) {
      throw new Error(`Native access failed for ${email}: ${resolved.error}`);
    }
    return resolved.access;
  }

  const memberAccess = await signInAccess(memberUser.email);
  const adminAccess = await signInAccess(adminUser.email);
  const otherAccess = await signInAccess(otherUser.email);
  const betaAccess = await signInAccess(betaUser.email);
  const blockedAccess = await signInAccess(blockedUser.email);

  const proposedStart = new Date(memberEntry.startedAt.getTime() + 15 * 60_000);
  const proposedEnd = new Date(memberEntry.endedAt.getTime() + 15 * 60_000);

  const listed = await readNativeAssignedJobTimeCorrections(prisma, memberAccess, memberJob.id);
  const listedIds = listed.ok ? listed.timeCorrections.entries.map((entry) => entry.id) : [];
  const detail = await loadNativeAssignedJob(prisma, memberAccess, memberJob.id);
  check(
    "GET lists only the caller's ended entries on the assigned job",
    listed.ok === true &&
      listedIds.includes(memberEntry.id) &&
      listedIds.includes(memberTravel.id) &&
      !listedIds.includes(runningEntry.id) &&
      !listedIds.includes(otherOnSameJob.id) &&
      !listedIds.includes(memberOtherJobEntry.id) &&
      !listedIds.includes(betaEntry.id) &&
      detail?.timeCorrections.entries.some((entry) => entry.id === memberEntry.id) === true,
  );
  check(
    "Listed entries omit wages, invoices, and other members",
    listed.ok === true &&
      listed.timeCorrections.entries.every(
        (entry) =>
          !("approvedHours" in entry) &&
          !("wage" in entry) &&
          !("invoice" in entry) &&
          !("hourlyWage" in entry),
      ),
  );

  const otherRead = await readNativeAssignedJobTimeCorrections(prisma, otherAccess, memberJob.id);
  const betaRead = await readNativeAssignedJobTimeCorrections(prisma, betaAccess, memberJob.id);
  const unassignedRead = await readNativeAssignedJobTimeCorrections(
    prisma,
    memberAccess,
    unassignedJob.id,
  );
  check(
    "GET refuses another worker, another tenant, and an unassigned job",
    otherRead.ok === false &&
      otherRead.status === 404 &&
      betaRead.ok === false &&
      betaRead.status === 404 &&
      unassignedRead.ok === false &&
      unassignedRead.status === 404,
  );

  const limited = await readNativeAssignedJobTimeCorrections(prisma, memberAccess, limitJob.id);
  check(
    "Recorded-time list is capped and reports truncation",
    limited.ok === true &&
      limited.timeCorrections.entries.length === NATIVE_TIME_CORRECTION_LIMIT &&
      limited.timeCorrections.truncated === true &&
      limited.timeCorrections.limit === NATIVE_TIME_CORRECTION_LIMIT &&
      typeof limited.timeCorrections.truncatedNotice === "string",
  );

  const requested = await requestNativeAssignedJobTimeCorrection(
    prisma,
    memberAccess,
    memberJob.id,
    {
      timeEntryId: memberEntry.id,
      reason: "Phone died before I could stop the clock.",
      proposedStartedAt: proposedStart.toISOString(),
      proposedEndedAt: proposedEnd.toISOString(),
    },
  );
  const entryAfterRequest = await prisma.timeEntry.findFirst({
    where: { id: memberEntry.id, businessId: businessA.id },
  });
  const pendingRow = await prisma.timeCorrectionRequest.findFirst({
    where: { timeEntryId: memberEntry.id, businessId: businessA.id, status: "PENDING" },
  });
  const pendingOnJob = requested.ok
    ? requested.job.timeCorrections.entries.find((entry) => entry.id === memberEntry.id)
    : null;
  check(
    "Assigned MEMBER can request a correction on their own ended job time",
    requested.ok === true &&
      pendingRow?.status === "PENDING" &&
      pendingRow?.reason === "Phone died before I could stop the clock." &&
      pendingOnJob?.requestStatus === "PENDING" &&
      pendingOnJob?.canRequest === false,
  );
  check(
    "TimeEntry times stay unchanged until an OWNER accepts",
    entryAfterRequest?.startedAt.getTime() === memberEntry.startedAt.getTime() &&
      entryAfterRequest?.endedAt?.getTime() === memberEntry.endedAt.getTime() &&
      entryAfterRequest?.status === "READY",
  );

  const duplicate = await requestNativeAssignedJobTimeCorrection(
    prisma,
    memberAccess,
    memberJob.id,
    {
      timeEntryId: memberEntry.id,
      reason: "Trying again",
      proposedStartedAt: proposedStart.toISOString(),
      proposedEndedAt: proposedEnd.toISOString(),
    },
  );
  const pendingCount = await prisma.timeCorrectionRequest.count({
    where: { timeEntryId: memberEntry.id, businessId: businessA.id, status: "PENDING" },
  });
  check(
    "Duplicate PENDING request is refused and leaves one row",
    duplicate.ok === false &&
      duplicate.status === 409 &&
      /already waiting/i.test(duplicate.error ?? "") &&
      pendingCount === 1,
  );

  const ownerAccess = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const adminDecideAccess = makeAccess(businessA.id, "ADMIN", adminMem.id);
  const memberDecideAccess = makeAccess(businessA.id, "MEMBER", memberMem.id);
  await expectError(
    "ADMIN cannot decide a time-correction request",
    () =>
      decideTimeCorrectionRequest(prisma, adminDecideAccess, {
        requestId: pendingRow?.id ?? "missing-request",
        decision: "ACCEPTED",
        timeZone: NY,
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot decide a time-correction request",
    () =>
      decideTimeCorrectionRequest(prisma, memberDecideAccess, {
        requestId: pendingRow?.id ?? "missing-request",
        decision: "ACCEPTED",
        timeZone: NY,
      }),
    (error) => error instanceof ForbiddenError,
  );
  const stillPending = pendingRow
    ? await prisma.timeCorrectionRequest.findFirst({
        where: { id: pendingRow.id, businessId: businessA.id },
        select: { status: true },
      })
    : null;
  const stillUnchanged = await prisma.timeEntry.findFirst({
    where: { id: memberEntry.id, businessId: businessA.id },
    select: { startedAt: true, endedAt: true },
  });
  check(
    "Refused ADMIN/MEMBER decide leaves the PENDING request and original clock",
    stillPending?.status === "PENDING" &&
      stillUnchanged?.startedAt.getTime() === memberEntry.startedAt.getTime() &&
      stillUnchanged?.endedAt?.getTime() === memberEntry.endedAt.getTime(),
  );

  const otherWorker = await requestNativeAssignedJobTimeCorrection(
    prisma,
    otherAccess,
    memberJob.id,
    {
      timeEntryId: memberEntry.id,
      reason: "Not my job",
      proposedStartedAt: proposedStart.toISOString(),
      proposedEndedAt: proposedEnd.toISOString(),
    },
  );
  const otherOwnOnMemberJob = await requestNativeAssignedJobTimeCorrection(
    prisma,
    memberAccess,
    memberJob.id,
    {
      timeEntryId: otherOnSameJob.id,
      reason: "Someone else's clock",
      proposedStartedAt: proposedStart.toISOString(),
      proposedEndedAt: proposedEnd.toISOString(),
    },
  );
  const crossJob = await requestNativeAssignedJobTimeCorrection(prisma, memberAccess, memberJob.id, {
    timeEntryId: memberOtherJobEntry.id,
    reason: "Wrong job",
    proposedStartedAt: proposedStart.toISOString(),
    proposedEndedAt: proposedEnd.toISOString(),
  });
  const betaCross = await requestNativeAssignedJobTimeCorrection(prisma, memberAccess, betaJob.id, {
    timeEntryId: betaEntry.id,
    reason: "Other tenant",
    proposedStartedAt: proposedStart.toISOString(),
    proposedEndedAt: proposedEnd.toISOString(),
  });
  const unassignedWrite = await requestNativeAssignedJobTimeCorrection(
    prisma,
    memberAccess,
    unassignedJob.id,
    {
      timeEntryId: memberEntry.id,
      reason: "Unassigned",
      proposedStartedAt: proposedStart.toISOString(),
      proposedEndedAt: proposedEnd.toISOString(),
    },
  );
  check(
    "Another worker, another job, another tenant, and an unassigned job are refused",
    otherWorker.ok === false &&
      otherWorker.status === 404 &&
      otherOwnOnMemberJob.ok === false &&
      otherOwnOnMemberJob.status === 404 &&
      otherOwnOnMemberJob.error === NATIVE_TIME_CORRECTION_ENTRY_MISSING &&
      crossJob.ok === false &&
      crossJob.status === 404 &&
      betaCross.ok === false &&
      betaCross.status === 404 &&
      betaCross.error === NATIVE_JOB_NOT_AVAILABLE &&
      unassignedWrite.ok === false &&
      unassignedWrite.status === 404,
  );

  const runningWrite = await requestNativeAssignedJobTimeCorrection(
    prisma,
    memberAccess,
    memberJob.id,
    {
      timeEntryId: runningEntry.id,
      reason: "Still running",
      proposedStartedAt: proposedStart.toISOString(),
      proposedEndedAt: proposedEnd.toISOString(),
    },
  );
  const approvedWrite = await requestNativeAssignedJobTimeCorrection(
    prisma,
    memberAccess,
    memberJob.id,
    {
      timeEntryId: approvedEntry.id,
      reason: "Approved week",
      proposedStartedAt: new Date(approvedEntry.startedAt.getTime() + 60_000).toISOString(),
      proposedEndedAt: new Date(approvedEntry.endedAt.getTime() + 60_000).toISOString(),
    },
  );
  check(
    "Running clocks and approved weeks cannot be requested from native",
    runningWrite.ok === false &&
      runningWrite.status === 404 &&
      approvedWrite.ok === false &&
      approvedWrite.status === 409 &&
      /approved/i.test(approvedWrite.error ?? ""),
  );

  const adminRequested = await requestNativeAssignedJobTimeCorrection(prisma, adminAccess, adminJob.id, {
    timeEntryId: adminEntry.id,
    reason: "Admin recorded time needs a fix",
    proposedStartedAt: new Date(adminEntry.startedAt.getTime() + 60_000).toISOString(),
    proposedEndedAt: new Date(adminEntry.endedAt.getTime() + 60_000).toISOString(),
  });
  check(
    "Assigned ADMIN can request their own correction but native still has no decide path",
    adminRequested.ok === true &&
      !correctionOpsSrc.includes("decideTimeCorrectionRequest") &&
      !routeSrc.includes("DECIDE_TIME_CORRECTIONS"),
  );

  const blockedWrite = await requestNativeAssignedJobTimeCorrection(
    prisma,
    blockedAccess,
    blockedJob.id,
    {
      timeEntryId: blockedEntry.id,
      reason: "Blocked workspace",
      proposedStartedAt: new Date(blockedEntry.startedAt.getTime() + 60_000).toISOString(),
      proposedEndedAt: new Date(blockedEntry.endedAt.getTime() + 60_000).toISOString(),
    },
  );
  check(
    "Ended SaaS trial refuses the native correction write",
    blockedWrite.ok === false &&
      blockedWrite.status === 403 &&
      blockedWrite.error === SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE,
  );

  const race = await requestNativeAssignedJobTimeCorrection(
    prisma,
    memberAccess,
    raceJob.id,
    {
      timeEntryId: raceEntry.id,
      reason: "Reassigned mid-request",
      proposedStartedAt: new Date(raceEntry.startedAt.getTime() + 60_000).toISOString(),
      proposedEndedAt: new Date(raceEntry.endedAt.getTime() + 60_000).toISOString(),
    },
    {
      afterInitialRead: async () => {
        await prisma.job.update({
          where: { id: raceJob.id },
          data: { assignedMembershipId: otherMem.id },
        });
      },
    },
  );
  const raceAfter = await prisma.timeCorrectionRequest.count({
    where: { timeEntryId: raceEntry.id, businessId: businessA.id },
  });
  const raceEntryAfter = await prisma.timeEntry.findFirst({
    where: { id: raceEntry.id, businessId: businessA.id },
    select: { startedAt: true, endedAt: true },
  });
  check(
    "Assignment change after the initial read refuses the correction",
    race.ok === false && race.status === 404 && race.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Reassigned Job after the initial read leaves TimeEntry and requests unchanged",
    raceAfter === 0 &&
      raceEntryAfter?.startedAt.getTime() === raceEntry.startedAt.getTime() &&
      raceEntryAfter?.endedAt?.getTime() === raceEntry.endedAt.getTime(),
  );

  const deactivateUser = await prisma.user.create({
    data: {
      name: "Deactivate Correction Worker",
      email: `deactivate-${randomUUID()}@native-time-corr.example`,
      passwordHash,
    },
  });
  const deactivateMem = await prisma.membership.create({
    data: { userId: deactivateUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const deactivateAccess = await signInAccess(deactivateUser.email);
  const deactivateJob = await createJob({
    businessId: businessA.id,
    assignedMembershipId: deactivateMem.id,
    customerName: "Deactivate Correction",
  });
  const deactivateEntry = await createEndedTime({
    businessId: businessA.id,
    membershipId: deactivateMem.id,
    jobId: deactivateJob.id,
  });
  const deactivateWrite = await requestNativeAssignedJobTimeCorrection(
    prisma,
    deactivateAccess,
    deactivateJob.id,
    {
      timeEntryId: deactivateEntry.id,
      reason: "Deactivated mid-request",
      proposedStartedAt: new Date(deactivateEntry.startedAt.getTime() + 60_000).toISOString(),
      proposedEndedAt: new Date(deactivateEntry.endedAt.getTime() + 60_000).toISOString(),
    },
    {
      afterInitialRead: async () => {
        await prisma.membership.update({
          where: { id: deactivateMem.id },
          data: { active: false },
        });
      },
    },
  );
  const deactivateRequests = await prisma.timeCorrectionRequest.count({
    where: { timeEntryId: deactivateEntry.id, businessId: businessA.id },
  });
  check(
    "Deactivated membership after the initial read refuses the correction",
    deactivateWrite.ok === false &&
      deactivateWrite.status === 404 &&
      deactivateWrite.error === NATIVE_JOB_NOT_AVAILABLE &&
      deactivateRequests === 0,
  );

  const accepted = pendingRow
    ? await decideTimeCorrectionRequest(prisma, ownerAccess, {
        requestId: pendingRow.id,
        decision: "ACCEPTED",
        timeZone: NY,
      })
    : { request: { status: "MISSING" } };
  const entryAfterAccept = await prisma.timeEntry.findFirst({
    where: { id: memberEntry.id, businessId: businessA.id },
    select: { startedAt: true, endedAt: true, status: true },
  });
  check(
    "OWNER web accept is the path that applies proposed times",
    accepted.request.status === "ACCEPTED" &&
      entryAfterAccept?.startedAt.getTime() === proposedStart.getTime() &&
      entryAfterAccept?.endedAt?.getTime() === proposedEnd.getTime(),
  );

  const otherFinal = await prisma.timeEntry.findFirst({
    where: { id: otherEntry.id, businessId: businessA.id },
    select: { startedAt: true, endedAt: true },
  });
  const betaFinal = await prisma.timeEntry.findFirst({
    where: { id: betaEntry.id, businessId: businessB.id },
    select: { startedAt: true, endedAt: true },
  });
  check(
    "Native correction writes never mutate another worker or tenant",
    otherFinal?.startedAt.getTime() === otherEntry.startedAt.getTime() &&
      otherFinal?.endedAt?.getTime() === otherEntry.endedAt.getTime() &&
      betaFinal?.startedAt.getTime() === betaEntry.startedAt.getTime() &&
      betaFinal?.endedAt?.getTime() === betaEntry.endedAt.getTime(),
  );

  // Keep the imported web request helper referenced so the check stays
  // coupled to the merged operation, not a native rewrite.
  check(
    "Merged requestTimeCorrection remains the write used by native",
    typeof requestTimeCorrection === "function",
  );
});

console.log(
  failures === 0
    ? "\nNative field time-correction check passed: request reuse, isolation, limits, and OWNER-only decide held."
    : `\n${failures} native field time-correction check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
