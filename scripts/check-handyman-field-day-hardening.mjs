/**
 * Founder Handyman field-day hardening regressions.
 *
 * Does not replay the full operations/launch happy path. Those verifiers
 * already prove intake → estimate → approval → job → schedule → confirm
 * → native start/time/photos → materials → change order → complete →
 * invoice → payment. This script concentrates on the remaining gaps
 * between modules:
 *   web Field start vs native time coupling
 *   reassignment / deactivation while a JOB clock is RUNNING
 *   stale start / schedule / owner-confirm writes
 *   field-complete → owner invoice handoff
 *
 * Reuses canonical production writes. Does not invent new workflow.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-handyman-field-day-hardening.mjs
 */
import { register } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  assertLocalDatabaseUrl,
  openDisposableTestDatabase,
} from "./disposable-test-database.mjs";

register(new URL("./estimate-options-test-loader.mjs", import.meta.url), import.meta.url);

process.env.TZ = process.env.TZ || "America/New_York";
process.env.TBBT_CUSTOMER_MESSAGING_ADAPTER =
  process.env.TBBT_CUSTOMER_MESSAGING_ADAPTER || "fake";

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
  return ok;
}

function demand(label, ok) {
  if (!check(label, ok)) {
    throw new Error(label);
  }
}

function form(fields) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value != null) data.set(key, String(value));
  }
  return data;
}

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

function createHoldRelease() {
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  let signalAcquired;
  const acquired = new Promise((resolve) => {
    signalAcquired = resolve;
  });
  return {
    release() {
      release();
    },
    released,
    signalAcquired,
    acquired,
  };
}

async function waitForBlockedContenders(observer, minCount, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await observer.$queryRaw`
      SELECT DISTINCT a.pid
      FROM pg_stat_activity a
      JOIN pg_locks l ON l.pid = a.pid
      WHERE a.datname = current_database()
        AND NOT l.granted
        AND a.pid <> pg_backend_pid()
    `;
    if (rows.length >= minCount) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${minCount} blocked contenders`);
}

async function waitForUngrantedAdvisoryLocks(observer, lockKey, expected, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await observer.$queryRaw`
      SELECT COUNT(*)::int AS n
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND granted = false
        AND objsubid = 1
        AND classid = CASE WHEN hashtext(${lockKey}) < 0 THEN -1 ELSE 0 END
        AND objid = hashtext(${lockKey})
    `;
    if (Number(rows[0]?.n ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${expected} ungranted advisory locks on ${lockKey}`);
}

async function followRedirect(fn) {
  try {
    const result = await fn();
    return { redirected: false, url: null, result };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("NEXT_REDIRECT:")) {
      return {
        redirected: true,
        url: error.message.slice("NEXT_REDIRECT:".length),
        result: null,
      };
    }
    throw error;
  }
}

/**
 * Cross-module field-day facts this script just wrote. Mutation tests
 * flip one field so a vacuous always-true checker cannot stay green.
 */
function fieldDayHardeningHolds(state) {
  if (!state.businessId || !state.jobId || !state.workerMembershipId) return false;
  if (state.webStartJobStatus !== "IN_PROGRESS") return false;
  if (state.webStartRunningCount !== 1) return false;
  if (state.webStartRunningMembershipId !== state.workerMembershipId) return false;
  if (state.replayBackfilledRunningCount !== 1) return false;
  if (state.previousWorkerRunningAfterReassign !== 0) return false;
  if (state.newWorkerRunningAfterStart !== 1) return false;
  if (state.oldWorkerNativeStopAfterReassignOk !== false) return false;
  if (state.deactivatedRunningCount !== 0) return false;
  if (state.deactivatedMembershipActive !== false) return false;
  if (state.startJobResurrectedCompleted !== false) return false;
  if (state.scheduleJobMovedCompleted !== false) return false;
  if (state.staleOwnerConfirmBoundOldProposal !== false) return false;
  if (state.deactivateRaceRunningCount !== 0) return false;
  if (state.deactivateRaceMembershipActive !== false) return false;
  if (state.reassignRaceNonAssigneeRunning !== 0) return false;
  if (state.scheduleRaceScheduledAtUnchanged !== true) return false;
  if (state.scheduleRaceReturnedCompletedError !== true) return false;
  if (state.fieldCompleteInvoiceKind !== "ORIGINAL") return false;
  if (state.fieldCompleteInvoiceCount !== 1) return false;
  if (state.fieldCompleteInvoiceStatus !== "SENT") return false;
  if (state.otherBusinessJobCount !== 0) return false;
  return true;
}

console.log("\nSTATIC — gap verifier reuses canonical modules, not a parallel lifecycle");
const selfSrc = readRepo("scripts/check-handyman-field-day-hardening.mjs");
const fieldJobOpsSrc = readRepo("src/lib/field-job-ops.ts");
const jobActionSrc = readRepo("src/app/actions/job.ts");
const teamSrc = readRepo("src/app/actions/team.ts");
const startFieldFnSrc = fieldJobOpsSrc.slice(
  fieldJobOpsSrc.indexOf("export async function startAssignedFieldJob"),
);
check(
  "Verifier reuses the disposable harness and local-database guard",
  selfSrc.includes('from "./disposable-test-database.mjs"') &&
    selfSrc.includes("openDisposableTestDatabase") &&
    selfSrc.includes("assertLocalDatabaseUrl"),
);
check(
  "Web Field start calls the canonical running-time write",
  startFieldFnSrc.includes("startJobWithRunningTimeSafetyInTransaction") &&
    !startFieldFnSrc.includes("data: { status: lifecycle.nextStatus }"),
);
const assignOpsSrc = readRepo("src/lib/job-assignment-ops.ts");
check(
  "assignJobMember closes the previous worker's RUNNING JOB time",
  jobActionSrc.includes("writeAssignedMembershipAndLaneWindows") &&
    assignOpsSrc.includes("stopRunningAssignedJobTimeInTransaction") &&
    assignOpsSrc.includes("JOB_REASSIGNMENT_TIME_CLOSED_REASON"),
);
check(
  "startJob / scheduleJob / owner confirm writes are status- or proposal-guarded",
  jobActionSrc.includes("jobWriteTestHooks") &&
    jobActionSrc.includes("updateMany") &&
    jobActionSrc.includes("status: job.status") &&
    jobActionSrc.includes("appointmentProposalId: job.appointmentProposalId") &&
    jobActionSrc.includes("A completed job cannot be rescheduled."),
);
const scheduleFnSrc = jobActionSrc.slice(
  jobActionSrc.indexOf("export async function scheduleJob"),
  jobActionSrc.indexOf("export async function assignJobMember"),
);
const scheduleTxSrc = scheduleFnSrc.slice(
  scheduleFnSrc.indexOf("await prisma.$transaction"),
  scheduleFnSrc.indexOf("if (completedDuringWrite)"),
);
const writeAssignSrc = assignOpsSrc.slice(
  assignOpsSrc.indexOf("export async function writeAssignedMembershipAndLaneWindows"),
);
check(
  "scheduleJob locks the Job row after the schedule-reservation advisory lock",
  scheduleTxSrc.includes("lockBusinessScheduleReservation") &&
    scheduleTxSrc.includes("lockTenantOwnedJob") &&
    scheduleTxSrc.indexOf("lockBusinessScheduleReservation") <
      scheduleTxSrc.indexOf("lockTenantOwnedJob") &&
    scheduleTxSrc.includes("current.status === \"COMPLETED\"") &&
    !scheduleTxSrc.includes("tx.job.findFirst"),
);
check(
  "assignJobMember locks the Job after the advisory lock and closes the locked assignee",
  writeAssignSrc.indexOf("lockBusinessScheduleReservation") >= 0 &&
    writeAssignSrc.indexOf("lockTenantOwnedJob") >
      writeAssignSrc.indexOf("lockBusinessScheduleReservation") &&
    assignOpsSrc.includes("previousAssignee = input.lockedJob.assignedMembershipId") &&
    assignOpsSrc.includes("membershipId: previousAssignee") &&
    !assignOpsSrc.includes("membershipId: job.assignedMembershipId"),
);
const deactivateFnSrc = teamSrc.slice(
  teamSrc.indexOf("export async function setTeamMemberActive"),
);
check(
  "Deactivation locks the Membership row before closing time or flipping active",
  deactivateFnSrc.includes('SELECT id FROM "Membership"') &&
    deactivateFnSrc.includes("FOR UPDATE") &&
    deactivateFnSrc.indexOf("FOR UPDATE") <
      deactivateFnSrc.indexOf("closeRunningTimeForMembershipInTransaction") &&
    deactivateFnSrc.indexOf("closeRunningTimeForMembershipInTransaction") <
      deactivateFnSrc.indexOf("data: { active }") &&
    teamSrc.includes("MEMBERSHIP_DEACTIVATED_TIME_CLOSED_REASON"),
);
check(
  "This verifier imports those production modules instead of a parallel fake",
  selfSrc.includes('await import("@/lib/field-job-ops")') &&
    selfSrc.includes('await import("@/app/actions/job")') &&
    selfSrc.includes('await import("@/app/actions/team")') &&
    selfSrc.includes('await import("@/lib/native-field-ops")') &&
    selfSrc.includes('await import("@/app/actions/invoice")'),
);
check(
  "Barrier proofs hold the lock on a second connection, queue the writers, then release",
  selfSrc.includes("waitForBlockedContenders") &&
    selfSrc.includes("waitForUngrantedAdvisoryLocks") &&
    selfSrc.includes("pg_advisory_xact_lock") &&
    selfSrc.includes('SELECT id FROM "Membership"') &&
    selfSrc.includes('SELECT id FROM "Job"'),
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "handyman-field-day-hardening disposable database");

const session = await openDisposableTestDatabase({
  databaseUrl: baseUrl,
  namePrefix: "tbbt_handyman_field_day_hard",
  setProcessEnv: true,
});

/** @type {import("@prisma/client").PrismaClient | undefined} */
let locker;
/** @type {import("@prisma/client").PrismaClient | undefined} */
let observer;

try {
  const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
  const { ForbiddenError } = await import("@/lib/authorization");
  const {
    scheduleJob,
    assignJobMember,
    startJob,
    recordOwnerAppointmentConfirmation,
  } = await import("@/app/actions/job");
  const { setTeamMemberActive } = await import("@/app/actions/team");
  const { startAssignedFieldJob } = await import("@/lib/field-job-ops");
  const {
    startNativeAssignedJob,
    stopNativeAssignedJobRunningTime,
    completeNativeAssignedJob,
  } = await import("@/lib/native-field-ops");
  const { issueNativeSession, resolveNativeFieldAccess } = await import(
    "@/lib/native-session"
  );
  const { completeJobWithRunningTimeSafety } = await import("@/lib/time-card-ops");
  const { createInvoiceFromJob } = await import("@/app/actions/invoice");
  const { confirmAppointment } = await import("@/app/actions/public-appointment");
  const { jobWriteTestHooks } = await import("@/lib/job-write-test-hooks");
  const { setTestAccess } = await import("./estimate-options-test-access.mjs");
  const { prisma } = await import("@/lib/prisma");
  const { Prisma, PrismaClient } = await import("@prisma/client");
  const { businessScheduleReservationLockKey } = await import(
    "@/lib/schedule-reservation"
  );
  locker = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  observer = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });

  function makeAccess(business, role, membership) {
    return {
      businessId: business.id,
      workspace: {
        role,
        membership: { id: membership.id },
        user: { id: membership.userId },
        business: {
          id: business.id,
          name: business.name,
          slug: business.slug,
          tradeCode: business.tradeCode,
          timezone: business.timezone,
        },
      },
      scope: businessScope(business.id),
      assertOwned(record) {
        return assertBusinessRecord(record, business.id);
      },
      assertAttachable(record) {
        return assertBusinessRecord(record, business.id);
      },
    };
  }

  async function scheduleWithAck(jobId, fields) {
    let result = await scheduleJob({}, form({ jobId, ...fields }));
    if (result?.warning && result.conflictAck) {
      result = await scheduleJob(
        {},
        form({ jobId, ...fields, confirmOverlapAck: result.conflictAck }),
      );
    }
    return result;
  }

  async function createJob(business, customer, extras = {}) {
    return prisma.job.create({
      data: {
        businessId: business.id,
        customerId: customer.id,
        projectToken: randomUUID(),
        status: "UNSCHEDULED",
        ...extras,
      },
    });
  }

  async function confirmCurrentAppointment(jobId) {
    const job = await prisma.job.findFirst({
      where: { id: jobId },
      select: { projectToken: true, appointmentProposalId: true },
    });
    return confirmAppointment(
      {},
      form({
        projectToken: job.projectToken,
        appointmentProposalId: String(job.appointmentProposalId),
        accessMethod: "CUSTOMER_PRESENT",
      }),
    );
  }

  async function runningJobTime(businessId, jobId, membershipId) {
    return prisma.timeEntry.findMany({
      where: {
        businessId,
        jobId,
        membershipId,
        activityType: "JOB",
        status: "RUNNING",
        endedAt: null,
      },
    });
  }

  const suffix = randomUUID().slice(0, 8);
  const NY = "America/New_York";
  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Field Day Hardening",
      slug: `alpha-field-hard-${suffix}`,
      tradeCode: "HANDYMAN",
      timezone: NY,
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Field Day Hardening",
      slug: `beta-field-hard-${suffix}`,
      tradeCode: "HANDYMAN",
      timezone: NY,
    },
  });

  const ownerUser = await prisma.user.create({
    data: { name: "Owner A", email: `owner-a-hard-${suffix}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Member A", email: `member-a-hard-${suffix}@example.com`, passwordHash: "x" },
  });
  const otherMemberUser = await prisma.user.create({
    data: { name: "Member A2", email: `member-a2-hard-${suffix}@example.com`, passwordHash: "x" },
  });
  const deactivateUser = await prisma.user.create({
    data: {
      name: "Deactivate A",
      email: `deactivate-a-hard-${suffix}@example.com`,
      passwordHash: "x",
    },
  });
  const raceDeactivateUser = await prisma.user.create({
    data: {
      name: "Race Deactivate A",
      email: `race-deactivate-a-hard-${suffix}@example.com`,
      passwordHash: "x",
    },
  });
  const assignCUser = await prisma.user.create({
    data: {
      name: "Assign C",
      email: `assign-c-hard-${suffix}@example.com`,
      passwordHash: "x",
    },
  });
  const betaOwnerUser = await prisma.user.create({
    data: { name: "Owner B", email: `owner-b-hard-${suffix}@example.com`, passwordHash: "x" },
  });

  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const otherMemberMem = await prisma.membership.create({
    data: { userId: otherMemberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const deactivateMem = await prisma.membership.create({
    data: { userId: deactivateUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const raceDeactivateMem = await prisma.membership.create({
    data: { userId: raceDeactivateUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const assignCMem = await prisma.membership.create({
    data: { userId: assignCUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const betaOwnerMem = await prisma.membership.create({
    data: { userId: betaOwnerUser.id, businessId: businessB.id, role: "OWNER" },
  });

  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Ada Field" },
  });
  const customerB = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Field" },
  });

  const ownerA = makeAccess(businessA, "OWNER", ownerMem);
  const memberA = makeAccess(businessA, "MEMBER", memberMem);
  const ownerB = makeAccess(businessB, "OWNER", betaOwnerMem);

  const workerSession = await issueNativeSession(prisma, memberUser.id, {
    userAgent: "field-day-hardening",
  });
  const workerAccess = await resolveNativeFieldAccess(prisma, { token: workerSession.token });
  demand("Assigned worker native session resolves", workerAccess.ok === true);
  const otherSession = await issueNativeSession(prisma, otherMemberUser.id, {
    userAgent: "field-day-hardening-other",
  });
  const otherAccess = await resolveNativeFieldAccess(prisma, { token: otherSession.token });
  demand("Second worker native session resolves", otherAccess.ok === true);

  console.log("\nBEHAVIOR — web Field start opens JOB time; replay backfills after owner start");

  setTestAccess(ownerA);
  const webJob = await createJob(businessA, customerA);
  const webScheduled = await scheduleWithAck(webJob.id, {
    date: "2027-07-06",
    time: "08:00",
    durationPreset: "60",
  });
  demand("Web-start job schedules", !webScheduled?.error);
  const webAssigned = await assignJobMember(
    {},
    form({ jobId: webJob.id, membershipId: memberMem.id }),
  );
  demand("Web-start job assigns the MEMBER", !webAssigned?.error);
  const webConfirmed = await confirmCurrentAppointment(webJob.id);
  demand("Customer confirmed the web-start appointment", webConfirmed.status === "CONFIRMED");

  setTestAccess(ownerB);
  const foreignStart = await startAssignedFieldJob(
    prisma,
    { businessId: businessB.id, membershipId: betaOwnerMem.id },
    webJob.id,
  );
  check("Tenant B cannot start tenant A's assigned Field job", foreignStart.ok === false);

  setTestAccess(ownerA);
  const webStarted = await startAssignedFieldJob(
    prisma,
    { businessId: businessA.id, membershipId: memberMem.id },
    webJob.id,
  );
  demand("Assigned MEMBER web Field start succeeds", webStarted.ok === true);
  const webJobAfter = await prisma.job.findFirst({
    where: { id: webJob.id, businessId: businessA.id },
  });
  const webRunning = await runningJobTime(businessA.id, webJob.id, memberMem.id);
  check(
    "Web Field start moved the job to IN_PROGRESS and opened one RUNNING JOB card",
    webJobAfter?.status === "IN_PROGRESS" &&
      webRunning.length === 1 &&
      webRunning[0].membershipId === memberMem.id,
  );
  const webReplay = await startAssignedFieldJob(
    prisma,
    { businessId: businessA.id, membershipId: memberMem.id },
    webJob.id,
  );
  const webRunningAfterReplay = await runningJobTime(businessA.id, webJob.id, memberMem.id);
  check(
    "Replayed web Field start does not open a second time card",
    webReplay.ok === true &&
      webReplay.alreadyStarted === true &&
      webRunningAfterReplay.length === 1,
  );

  const ownerStartJob = await createJob(businessA, customerA);
  const ownerStartScheduled = await scheduleWithAck(ownerStartJob.id, {
    date: "2027-07-06",
    time: "10:00",
    durationPreset: "60",
  });
  demand("Owner-start job schedules", !ownerStartScheduled?.error);
  const ownerStartAssigned = await assignJobMember(
    {},
    form({ jobId: ownerStartJob.id, membershipId: memberMem.id }),
  );
  demand("Owner-start job assigns the MEMBER", !ownerStartAssigned?.error);
  const ownerStartConfirmed = await confirmCurrentAppointment(ownerStartJob.id);
  demand("Customer confirmed the owner-start appointment", ownerStartConfirmed.status === "CONFIRMED");
  const ownerStarted = await startJob({}, form({ jobId: ownerStartJob.id }));
  demand("OWNER startJob opens the work order", !ownerStarted?.error);
  const afterOwnerStartTime = await runningJobTime(
    businessA.id,
    ownerStartJob.id,
    memberMem.id,
  );
  check(
    "Owner work-order start still does not invent a worker clock",
    afterOwnerStartTime.length === 0,
  );
  const backfill = await startAssignedFieldJob(
    prisma,
    { businessId: businessA.id, membershipId: memberMem.id },
    ownerStartJob.id,
  );
  const backfilled = await runningJobTime(businessA.id, ownerStartJob.id, memberMem.id);
  check(
    "Web Field start on an already IN_PROGRESS job backfills the missing JOB clock",
    backfill.ok === true && backfill.alreadyStarted === true && backfilled.length === 1,
  );

  console.log("\nBEHAVIOR — reassignment closes the previous clock; deactivation closes leftover time");

  const raceJob = await createJob(businessA, customerA);
  const raceScheduled = await scheduleWithAck(raceJob.id, {
    date: "2027-07-07",
    time: "08:00",
    durationPreset: "60",
  });
  demand("Reassign job schedules", !raceScheduled?.error);
  const raceAssigned = await assignJobMember(
    {},
    form({ jobId: raceJob.id, membershipId: memberMem.id }),
  );
  demand("Reassign job assigns worker A", !raceAssigned?.error);
  const raceConfirmed = await confirmCurrentAppointment(raceJob.id);
  demand("Customer confirmed the reassign appointment", raceConfirmed.status === "CONFIRMED");
  const nativeStarted = await startNativeAssignedJob(prisma, workerAccess.access, raceJob.id);
  demand("Worker A native start opened the visit", nativeStarted.ok === true);
  const beforeReassign = await runningJobTime(businessA.id, raceJob.id, memberMem.id);
  demand("Worker A has one RUNNING JOB card before reassignment", beforeReassign.length === 1);

  setTestAccess(memberA);
  let memberAssignError = null;
  try {
    await assignJobMember(
      {},
      form({ jobId: raceJob.id, membershipId: otherMemberMem.id }),
    );
  } catch (error) {
    memberAssignError = error;
  }
  check(
    "Assigned MEMBER cannot reassign the job",
    memberAssignError instanceof ForbiddenError,
  );

  setTestAccess(ownerA);
  const reassigned = await assignJobMember(
    {},
    form({ jobId: raceJob.id, membershipId: otherMemberMem.id }),
  );
  demand("OWNER reassigned the in-progress job to worker B", !reassigned?.error);
  const previousAfterReassign = await runningJobTime(businessA.id, raceJob.id, memberMem.id);
  check(
    "Reassignment closed worker A's RUNNING JOB time",
    previousAfterReassign.length === 0,
  );
  const oldStop = await stopNativeAssignedJobRunningTime(
    prisma,
    workerAccess.access,
    raceJob.id,
  );
  check(
    "Previous assignee cannot native-stop after losing the assignment",
    oldStop.ok === false,
  );
  const newStart = await startNativeAssignedJob(prisma, otherAccess.access, raceJob.id);
  demand("Worker B can start after receiving the assignment", newStart.ok === true);
  const newRunning = await runningJobTime(businessA.id, raceJob.id, otherMemberMem.id);
  const allRunningOnJob = await prisma.timeEntry.count({
    where: {
      businessId: businessA.id,
      jobId: raceJob.id,
      activityType: "JOB",
      status: "RUNNING",
    },
  });
  check(
    "Only the current assignee has RUNNING JOB time after reassignment",
    newRunning.length === 1 && allRunningOnJob === 1,
  );

  const deactivateJob = await createJob(businessA, customerA);
  const deactivateScheduled = await scheduleWithAck(deactivateJob.id, {
    date: "2027-07-07",
    time: "11:00",
    durationPreset: "60",
  });
  demand("Deactivate job schedules", !deactivateScheduled?.error);
  const deactivateAssigned = await assignJobMember(
    {},
    form({ jobId: deactivateJob.id, membershipId: deactivateMem.id }),
  );
  demand("Deactivate job assigns the soon-removed MEMBER", !deactivateAssigned?.error);
  const deactivateConfirmed = await confirmCurrentAppointment(deactivateJob.id);
  demand("Customer confirmed the deactivate appointment", deactivateConfirmed.status === "CONFIRMED");
  const deactivateStart = await startAssignedFieldJob(
    prisma,
    { businessId: businessA.id, membershipId: deactivateMem.id },
    deactivateJob.id,
  );
  demand("Soon-removed MEMBER started the assigned job", deactivateStart.ok === true);
  const deactivateRunningBefore = await runningJobTime(
    businessA.id,
    deactivateJob.id,
    deactivateMem.id,
  );
  demand("Soon-removed MEMBER has RUNNING JOB time", deactivateRunningBefore.length === 1);
  const deactivated = await setTeamMemberActive(
    {},
    form({ membershipId: deactivateMem.id, active: "0" }),
  );
  demand("OWNER deactivated the assigned MEMBER", !deactivated?.error);
  const deactivateRunningAfter = await prisma.timeEntry.count({
    where: {
      businessId: businessA.id,
      membershipId: deactivateMem.id,
      status: "RUNNING",
    },
  });
  const deactivateRow = await prisma.membership.findFirst({
    where: { id: deactivateMem.id, businessId: businessA.id },
    select: { active: true },
  });
  check(
    "Deactivation closed leftover RUNNING time and flipped active",
    deactivateRunningAfter === 0 && deactivateRow?.active === false,
  );
  setTestAccess(ownerB);
  const foreignDeactivate = await setTeamMemberActive(
    {},
    form({ membershipId: deactivateMem.id, active: "1" }),
  );
  const stillInactive = await prisma.membership.findFirst({
    where: { id: deactivateMem.id, businessId: businessA.id },
    select: { active: true },
  });
  check(
    "Tenant B cannot reactivate tenant A's member",
    Boolean(foreignDeactivate?.error) && stillInactive?.active === false,
  );

  console.log("\nBEHAVIOR — stale start / schedule / owner-confirm cannot rewrite later state");

  setTestAccess(ownerA);
  const staleStartJob = await createJob(businessA, customerA);
  const staleStartScheduled = await scheduleWithAck(staleStartJob.id, {
    date: "2027-07-08",
    time: "08:00",
    durationPreset: "60",
  });
  demand("Stale-start job schedules", !staleStartScheduled?.error);
  const staleStartConfirmed = await confirmCurrentAppointment(staleStartJob.id);
  demand("Customer confirmed the stale-start appointment", staleStartConfirmed.status === "CONFIRMED");
  jobWriteTestHooks.afterStartJobRead = async (jobId) => {
    await prisma.job.update({
      where: { id: jobId },
      data: { status: "IN_PROGRESS" },
    });
    const completed = await completeJobWithRunningTimeSafety(prisma, {
      businessId: businessA.id,
      jobId,
      actorMembershipId: ownerMem.id,
    });
    if (!completed.ok) {
      throw new Error(completed.error);
    }
  };
  const staleStart = await startJob({}, form({ jobId: staleStartJob.id }));
  jobWriteTestHooks.afterStartJobRead = undefined;
  const staleStartRow = await prisma.job.findFirst({
    where: { id: staleStartJob.id, businessId: businessA.id },
    select: { status: true },
  });
  check(
    "Stale startJob cannot resurrect a COMPLETED job to IN_PROGRESS",
    Boolean(staleStart?.error) &&
      /completed job cannot be started/i.test(String(staleStart.error)) &&
      staleStartRow?.status === "COMPLETED",
  );

  const staleScheduleJob = await createJob(businessA, customerA);
  const staleScheduleScheduled = await scheduleWithAck(staleScheduleJob.id, {
    date: "2027-07-08",
    time: "10:00",
    durationPreset: "60",
  });
  demand("Stale-schedule job schedules", !staleScheduleScheduled?.error);
  const scheduledAtBeforeStale = (
    await prisma.job.findFirst({
      where: { id: staleScheduleJob.id, businessId: businessA.id },
      select: { scheduledAt: true },
    })
  )?.scheduledAt;
  await prisma.job.update({
    where: { id: staleScheduleJob.id },
    data: { status: "IN_PROGRESS" },
  });
  jobWriteTestHooks.afterScheduleJobRead = async (jobId) => {
    const completed = await completeJobWithRunningTimeSafety(prisma, {
      businessId: businessA.id,
      jobId,
      actorMembershipId: ownerMem.id,
    });
    if (!completed.ok) {
      throw new Error(completed.error);
    }
  };
  const staleSchedule = await scheduleWithAck(staleScheduleJob.id, {
    date: "2027-07-09",
    time: "09:00",
    durationPreset: "60",
  });
  jobWriteTestHooks.afterScheduleJobRead = undefined;
  const staleScheduleRow = await prisma.job.findFirst({
    where: { id: staleScheduleJob.id, businessId: businessA.id },
    select: { status: true, scheduledAt: true },
  });
  check(
    "Stale scheduleJob cannot move a job that completed after the initial read",
    Boolean(staleSchedule?.error) &&
      /completed job cannot be rescheduled/i.test(String(staleSchedule.error)) &&
      staleScheduleRow?.status === "COMPLETED" &&
      staleScheduleRow.scheduledAt?.getTime() === scheduledAtBeforeStale?.getTime(),
  );

  const staleConfirmJob = await createJob(businessA, customerA);
  const firstConfirmSchedule = await scheduleWithAck(staleConfirmJob.id, {
    date: "2027-07-10",
    time: "08:00",
    durationPreset: "60",
  });
  demand("Owner-confirm job schedules", !firstConfirmSchedule?.error);
  const beforeReschedule = await prisma.job.findFirst({
    where: { id: staleConfirmJob.id, businessId: businessA.id },
    select: { appointmentProposalId: true, scheduledAt: true },
  });
  jobWriteTestHooks.afterOwnerConfirmRead = async (jobId) => {
    setTestAccess(ownerA);
    const moved = await scheduleWithAck(jobId, {
      date: "2027-07-10",
      time: "11:00",
      durationPreset: "60",
    });
    if (moved?.error) {
      throw new Error(moved.error);
    }
  };
  const staleConfirm = await recordOwnerAppointmentConfirmation(
    {},
    form({
      jobId: staleConfirmJob.id,
      confirmationMethod: "OWNER_PHONE",
      accessMethod: "CUSTOMER_PRESENT",
    }),
  );
  jobWriteTestHooks.afterOwnerConfirmRead = undefined;
  const afterStaleConfirm = await prisma.job.findFirst({
    where: { id: staleConfirmJob.id, businessId: businessA.id },
    select: {
      appointmentProposalId: true,
      appointmentConfirmationStatus: true,
      appointmentConfirmedForProposalId: true,
    },
  });
  check(
    "Stale owner confirmation does not bind CONFIRMED to the old proposal",
    Boolean(staleConfirm?.error) &&
      /appointment time has changed/i.test(String(staleConfirm.error)) &&
      afterStaleConfirm?.appointmentProposalId !== beforeReschedule?.appointmentProposalId &&
      afterStaleConfirm?.appointmentConfirmationStatus !== "CONFIRMED" &&
      afterStaleConfirm?.appointmentConfirmedForProposalId !==
        beforeReschedule?.appointmentProposalId,
  );

  console.log("\nBEHAVIOR — concurrent lock barriers (hold, queue, release)");

  setTestAccess(ownerA);
  const deactivateRaceJob = await createJob(businessA, customerA);
  const deactivateRaceScheduled = await scheduleWithAck(deactivateRaceJob.id, {
    date: "2027-07-12",
    time: "08:00",
    durationPreset: "60",
  });
  demand("Deactivate-race job schedules", !deactivateRaceScheduled?.error);
  const deactivateRaceAssigned = await assignJobMember(
    {},
    form({ jobId: deactivateRaceJob.id, membershipId: raceDeactivateMem.id }),
  );
  demand("Deactivate-race job assigns the MEMBER", !deactivateRaceAssigned?.error);
  const deactivateRaceConfirmed = await confirmCurrentAppointment(deactivateRaceJob.id);
  demand(
    "Customer confirmed the deactivate-race appointment",
    deactivateRaceConfirmed.status === "CONFIRMED",
  );
  const deactivateHold = createHoldRelease();
  const deactivateHoldTx = locker.$transaction(
    async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM "Membership"
        WHERE id = ${raceDeactivateMem.id}
          AND "businessId" = ${businessA.id}
        FOR UPDATE
      `;
      deactivateHold.signalAcquired();
      await deactivateHold.released;
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
  await deactivateHold.acquired;
  const queuedDeactivateStart = startAssignedFieldJob(
    prisma,
    { businessId: businessA.id, membershipId: raceDeactivateMem.id },
    deactivateRaceJob.id,
  );
  const queuedDeactivate = setTeamMemberActive(
    {},
    form({ membershipId: raceDeactivateMem.id, active: "0" }),
  );
  await waitForBlockedContenders(observer, 2);
  deactivateHold.release();
  await Promise.all([queuedDeactivateStart, queuedDeactivate]);
  await deactivateHoldTx;
  const deactivateRaceRunning = await prisma.timeEntry.count({
    where: {
      businessId: businessA.id,
      membershipId: raceDeactivateMem.id,
      status: "RUNNING",
    },
  });
  const deactivateRaceRow = await prisma.membership.findFirst({
    where: { id: raceDeactivateMem.id, businessId: businessA.id },
    select: { active: true },
  });
  check(
    "Membership lock barrier leaves no RUNNING time for an inactive member",
    deactivateRaceRow?.active === false && deactivateRaceRunning === 0,
  );

  const reassignRaceJob = await createJob(businessA, customerA);
  const reassignRaceScheduled = await scheduleWithAck(reassignRaceJob.id, {
    date: "2027-07-13",
    time: "08:00",
    durationPreset: "60",
  });
  demand("Reassign-race job schedules", !reassignRaceScheduled?.error);
  const reassignRaceAssigned = await assignJobMember(
    {},
    form({ jobId: reassignRaceJob.id, membershipId: memberMem.id }),
  );
  demand("Reassign-race job assigns worker A", !reassignRaceAssigned?.error);
  const reassignRaceConfirmed = await confirmCurrentAppointment(reassignRaceJob.id);
  demand(
    "Customer confirmed the reassign-race appointment",
    reassignRaceConfirmed.status === "CONFIRMED",
  );
  const scheduleLockKey = businessScheduleReservationLockKey(businessA.id);
  const reassignHold = createHoldRelease();
  const reassignHoldTx = locker.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${scheduleLockKey}))`;
      reassignHold.signalAcquired();
      await reassignHold.released;
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
  await reassignHold.acquired;
  const queuedAssignC = assignJobMember(
    {},
    form({ jobId: reassignRaceJob.id, membershipId: assignCMem.id }),
  );
  await waitForUngrantedAdvisoryLocks(observer, scheduleLockKey, 1);
  await prisma.job.update({
    where: { id: reassignRaceJob.id },
    data: { assignedMembershipId: otherMemberMem.id },
  });
  const midflightBStart = await startNativeAssignedJob(
    prisma,
    otherAccess.access,
    reassignRaceJob.id,
  );
  demand("Worker B native-started while assign-to-C waited on the advisory lock", midflightBStart.ok === true);
  const bRunningBeforeRelease = await runningJobTime(
    businessA.id,
    reassignRaceJob.id,
    otherMemberMem.id,
  );
  demand("Worker B has RUNNING JOB time before the assign lock releases", bRunningBeforeRelease.length === 1);
  reassignHold.release();
  const assignCResult = await queuedAssignC;
  await reassignHoldTx;
  demand("OWNER assign-to-C finished after the advisory lock released", !assignCResult?.error);
  const reassignRaceJobRow = await prisma.job.findFirst({
    where: { id: reassignRaceJob.id, businessId: businessA.id },
    select: { assignedMembershipId: true },
  });
  const nonAssigneeRunning = await prisma.timeEntry.count({
    where: {
      businessId: businessA.id,
      jobId: reassignRaceJob.id,
      activityType: "JOB",
      status: "RUNNING",
      membershipId: { not: assignCMem.id },
    },
  });
  check(
    "Reassign lock barrier leaves no RUNNING JOB time for any non-assignee",
    reassignRaceJobRow?.assignedMembershipId === assignCMem.id &&
      nonAssigneeRunning === 0,
  );

  const scheduleRaceJob = await createJob(businessA, customerA);
  const scheduleRaceFirst = await scheduleWithAck(scheduleRaceJob.id, {
    date: "2027-07-14",
    time: "08:00",
    durationPreset: "60",
  });
  demand("Schedule-race job schedules", !scheduleRaceFirst?.error);
  const scheduledAtBeforeRace = (
    await prisma.job.findFirst({
      where: { id: scheduleRaceJob.id, businessId: businessA.id },
      select: { scheduledAt: true, status: true },
    })
  )?.scheduledAt;
  demand("Schedule-race job has a scheduledAt before the barrier", Boolean(scheduledAtBeforeRace));
  const scheduleHold = createHoldRelease();
  const scheduleHoldTx = locker.$transaction(
    async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM "Job"
        WHERE id = ${scheduleRaceJob.id}
          AND "businessId" = ${businessA.id}
        FOR UPDATE
      `;
      scheduleHold.signalAcquired();
      await scheduleHold.released;
      await tx.job.update({
        where: { id: scheduleRaceJob.id },
        data: { status: "COMPLETED" },
      });
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
  await scheduleHold.acquired;
  const queuedSchedule = scheduleWithAck(scheduleRaceJob.id, {
    date: "2027-07-15",
    time: "09:00",
    durationPreset: "60",
  });
  await waitForBlockedContenders(observer, 1);
  scheduleHold.release();
  const scheduleRaceResult = await queuedSchedule;
  await scheduleHoldTx;
  const scheduleRaceRow = await prisma.job.findFirst({
    where: { id: scheduleRaceJob.id, businessId: businessA.id },
    select: { status: true, scheduledAt: true },
  });
  check(
    "Job lock barrier refuses scheduleJob after concurrent completion and keeps scheduledAt",
    Boolean(scheduleRaceResult?.error) &&
      /completed job cannot be rescheduled/i.test(String(scheduleRaceResult.error)) &&
      scheduleRaceRow?.status === "COMPLETED" &&
      scheduleRaceRow.scheduledAt?.getTime() === scheduledAtBeforeRace?.getTime(),
  );

  console.log("\nBEHAVIOR — field complete then owner invoice creates one ORIGINAL");

  const invoiceEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "APPROVED",
      total: new Prisma.Decimal(185),
      publicToken: randomUUID(),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: businessA.id,
      estimateId: invoiceEstimate.id,
      description: "Window blind installation",
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(185),
      total: new Prisma.Decimal(185),
      type: "LABOR",
    },
  });
  const invoiceJob = await createJob(businessA, customerA, {
    estimateId: invoiceEstimate.id,
  });
  const invoiceScheduled = await scheduleWithAck(invoiceJob.id, {
    date: "2027-07-11",
    time: "08:00",
    durationPreset: "60",
  });
  demand("Invoice-handoff job schedules", !invoiceScheduled?.error);
  const invoiceAssigned = await assignJobMember(
    {},
    form({ jobId: invoiceJob.id, membershipId: otherMemberMem.id }),
  );
  demand("Invoice-handoff job assigns worker B", !invoiceAssigned?.error);
  const invoiceConfirmed = await confirmCurrentAppointment(invoiceJob.id);
  demand("Customer confirmed the invoice-handoff appointment", invoiceConfirmed.status === "CONFIRMED");
  const invoiceStarted = await startNativeAssignedJob(
    prisma,
    otherAccess.access,
    invoiceJob.id,
  );
  demand("Worker B started the invoice-handoff job", invoiceStarted.ok === true);
  const invoiceCompleted = await completeNativeAssignedJob(
    prisma,
    otherAccess.access,
    invoiceJob.id,
  );
  demand("Worker B field-completed the visit", invoiceCompleted.ok === true);
  const invoicesAfterField = await prisma.invoice.count({
    where: { businessId: businessA.id, jobId: invoiceJob.id },
  });
  check("Field complete still does not create an invoice", invoicesAfterField === 0);
  setTestAccess(ownerA);
  const createdInvoice = await followRedirect(() => createInvoiceFromJob(invoiceJob.id));
  demand(
    "OWNER createInvoiceFromJob after field complete opened the invoice",
    createdInvoice.redirected === true && createdInvoice.url?.startsWith("/invoices/"),
  );
  const invoices = await prisma.invoice.findMany({
    where: { businessId: businessA.id, jobId: invoiceJob.id },
  });
  check(
    "Field-complete handoff created exactly one SENT ORIGINAL invoice",
    invoices.length === 1 &&
      invoices[0].kind === "ORIGINAL" &&
      invoices[0].status === "SENT",
  );
  const replayInvoice = await followRedirect(() => createInvoiceFromJob(invoiceJob.id));
  const invoicesAfterReplay = await prisma.invoice.findMany({
    where: { businessId: businessA.id, jobId: invoiceJob.id },
  });
  check(
    "Replayed createInvoiceFromJob reuses that invoice",
    replayInvoice.redirected === true &&
      replayInvoice.url === `/invoices/${invoices[0].id}` &&
      invoicesAfterReplay.length === 1,
  );

  const otherBusinessJobCount = await prisma.job.count({
    where: { businessId: businessB.id },
  });

  const graph = {
    businessId: businessA.id,
    jobId: webJob.id,
    workerMembershipId: memberMem.id,
    webStartJobStatus: webJobAfter?.status,
    webStartRunningCount: webRunning.length,
    webStartRunningMembershipId: webRunning[0]?.membershipId,
    replayBackfilledRunningCount: backfilled.length,
    previousWorkerRunningAfterReassign: previousAfterReassign.length,
    newWorkerRunningAfterStart: newRunning.length,
    oldWorkerNativeStopAfterReassignOk: oldStop.ok,
    deactivatedRunningCount: deactivateRunningAfter,
    deactivatedMembershipActive: deactivateRow?.active,
    startJobResurrectedCompleted: staleStartRow?.status === "IN_PROGRESS",
    scheduleJobMovedCompleted: Boolean(
      staleScheduleRow?.status === "COMPLETED" && staleSchedule?.error == null,
    ),
    staleOwnerConfirmBoundOldProposal:
      afterStaleConfirm?.appointmentConfirmedForProposalId ===
      beforeReschedule?.appointmentProposalId,
    deactivateRaceRunningCount: deactivateRaceRunning,
    deactivateRaceMembershipActive: deactivateRaceRow?.active,
    reassignRaceNonAssigneeRunning: nonAssigneeRunning,
    scheduleRaceScheduledAtUnchanged:
      scheduleRaceRow?.scheduledAt?.getTime() === scheduledAtBeforeRace?.getTime(),
    scheduleRaceReturnedCompletedError: Boolean(
      scheduleRaceResult?.error &&
        /completed job cannot be rescheduled/i.test(String(scheduleRaceResult.error)),
    ),
    fieldCompleteInvoiceKind: invoices[0]?.kind,
    fieldCompleteInvoiceCount: invoicesAfterReplay.length,
    fieldCompleteInvoiceStatus: invoices[0]?.status,
    otherBusinessJobCount,
  };
  demand("Field-day gap facts reconcile", fieldDayHardeningHolds(graph));

  console.log("\nMUTATION — each gap rule fails when its fact is the vulnerable behavior");
  const mutations = [
    ["web start left IN_PROGRESS with no time", { webStartRunningCount: 0 }],
    ["web start time on another worker", { webStartRunningMembershipId: "other" }],
    ["replay did not backfill time", { replayBackfilledRunningCount: 0 }],
    ["previous assignee still RUNNING after reassign", { previousWorkerRunningAfterReassign: 1 }],
    ["two RUNNING clocks after reassignment start", { newWorkerRunningAfterStart: 2 }],
    ["old worker could still native-stop", { oldWorkerNativeStopAfterReassignOk: true }],
    ["deactivation left RUNNING time", { deactivatedRunningCount: 1 }],
    ["deactivation left membership active", { deactivatedMembershipActive: true }],
    ["stale start resurrected COMPLETED", { startJobResurrectedCompleted: true }],
    ["stale schedule moved a completed job", { scheduleJobMovedCompleted: true }],
    ["stale owner confirm bound the old proposal", { staleOwnerConfirmBoundOldProposal: true }],
    ["deactivate race left RUNNING time", { deactivateRaceRunningCount: 1 }],
    ["deactivate race left membership active", { deactivateRaceMembershipActive: true }],
    ["reassign race left non-assignee RUNNING", { reassignRaceNonAssigneeRunning: 1 }],
    ["schedule race rewrote scheduledAt", { scheduleRaceScheduledAtUnchanged: false }],
    ["schedule race missed completed error", { scheduleRaceReturnedCompletedError: false }],
    ["field complete created no invoice", { fieldCompleteInvoiceCount: 0 }],
    ["field complete invoice stayed DRAFT", { fieldCompleteInvoiceStatus: "DRAFT" }],
    ["other tenant received a job", { otherBusinessJobCount: 1 }],
    ["empty graph", {}],
  ];
  for (const [label, patch] of mutations) {
    if (label === "empty graph") {
      check(`MUTATION — ${label} is not consistent`, fieldDayHardeningHolds({}) === false);
    } else {
      check(
        `MUTATION — ${label} is not consistent`,
        fieldDayHardeningHolds({ ...graph, ...patch }) === false,
      );
    }
  }
} catch (error) {
  failed += 1;
  console.error("FAIL - handyman field-day hardening proofs crashed");
  console.error(error);
} finally {
  await locker?.$disconnect();
  await observer?.$disconnect();
  await session.cleanup();
}

console.log(
  failed === 0
    ? `\nAll handyman field-day hardening checks passed (${passed}).`
    : `\n${failed} handyman field-day hardening check(s) failed; ${passed} passed.`,
);
process.exit(failed === 0 ? 0 : 1);
