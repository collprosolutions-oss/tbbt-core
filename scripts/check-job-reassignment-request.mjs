/**
 * Worker-requested reassignment of one currently assigned upcoming job.
 *
 * Dedicated local disposable database (name prefix tbbt_job_reassignment_req).
 *
 * Proves MEMBER self-scoping, OWNER-only accept/decline, tenant isolation,
 * duplicate pending requests, accept-vs-reassignment races, refusal of
 * stale/completed/cancelled/foreign/already-reassigned jobs, and that
 * request/decline never change assignment or schedule and never send a
 * customer message. Accept unassigns only through the canonical assignment
 * write under the schedule-reservation lock order.
 *
 * Run with:
 *   npm run test:job-reassignment-request
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
  console.error("Failed to generate Prisma client for job-reassignment-request checks.");
  process.exit(generateEarly.status ?? 1);
}

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { DEFAULT_BUSINESS_TIMEZONE } = await import("@/lib/business-timezone");
const { CAPABILITIES, ForbiddenError, roleHasCapability } = await import("@/lib/authorization");
const { writeAssignedMembershipAndLaneWindows } = await import("@/lib/job-assignment-ops");
const {
  JOB_REASSIGNMENT_REQUEST_ALREADY_REASSIGNED_MESSAGE,
  JOB_REASSIGNMENT_REQUEST_CANCELLED_MESSAGE,
  JOB_REASSIGNMENT_REQUEST_COMPLETED_MESSAGE,
  JOB_REASSIGNMENT_REQUEST_INACTIVE_MESSAGE,
  JOB_REASSIGNMENT_REQUEST_NOT_UPCOMING_MESSAGE,
  JOB_REASSIGNMENT_REQUEST_UNAVAILABLE_MESSAGE,
  JOB_REASSIGNMENT_REQUEST_PENDING_EXISTS_MESSAGE,
  JOB_REASSIGNMENT_REQUEST_PENDING_LIST_LIMIT,
  JOB_REASSIGNMENT_REQUEST_REASON_MESSAGE,
  JOB_REASSIGNMENT_REQUEST_RECENT_LIST_LIMIT,
  JOB_REASSIGNMENT_REQUEST_SELF_LIST_LIMIT,
  JOB_REASSIGNMENT_REQUEST_STALE_MESSAGE,
  JobReassignmentRequestError,
  missingJobReassignmentRequestSchema,
} = await import("@/lib/job-reassignment-request");
const {
  decideJobReassignmentRequestOp,
  jobReassignmentRequestErrorMessage,
  jobReassignmentRequestTestHooks,
  loadOwnedJobReassignmentRequests,
  loadSelfJobReassignmentRequests,
  requestJobReassignmentOp,
} = await import("@/lib/job-reassignment-request-ops");

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

async function expectError(label, fn, predicate) {
  try {
    await fn();
    failed += 1;
    console.error(`FAIL - ${label} (no error thrown)`);
  } catch (error) {
    if (predicate(error)) {
      passed += 1;
      console.log(`  ok  - ${label}`);
    } else {
      failed += 1;
      console.error(`FAIL - ${label}`, error);
    }
  }
}

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

function createCountBarrier(count) {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let arrivedCount = 0;
  let allArrived;
  const waiting = new Promise((resolve) => {
    allArrived = resolve;
  });
  return {
    wait: async () => {
      arrivedCount += 1;
      if (arrivedCount >= count) allArrived();
      await held;
    },
    arrived: waiting,
    release: () => release(),
  };
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const opsSrc = readRepo("src/lib/job-reassignment-request-ops.ts");
const assignOpsSrc = readRepo("src/lib/job-assignment-ops.ts");
const actionSrc = readRepo("src/app/actions/job-reassignment-request.ts");
const fieldUi = readRepo("src/components/field/job-reassignment-request-form.tsx");
const teamUi = readRepo("src/components/team/job-reassignment-requests.tsx");
const fieldPage = readRepo("src/app/field/page.tsx");
const fieldJobPage = readRepo("src/app/field/jobs/[jobId]/page.tsx");
const teamPage = readRepo("src/app/(app)/team/page.tsx");
const navSrc = readRepo("src/lib/nav.ts");
const schema = readRepo("prisma/schema.prisma");
const migration = readRepo("prisma/migrations/20261001194700_job_reassignment_request/migration.sql");
const checkSrc = readRepo("scripts/check-job-reassignment-request.mjs");
const requestFnSrc = opsSrc.slice(
  opsSrc.indexOf("export async function requestJobReassignmentOp"),
  opsSrc.indexOf("export async function decideJobReassignmentRequestOp"),
);
const acceptFnSrc = opsSrc.slice(opsSrc.indexOf("export async function decideJobReassignmentRequestOp"));
const afterJobLockedSrc = acceptFnSrc.slice(Math.max(0, acceptFnSrc.indexOf("afterJobLocked")));

console.log("\nSTATIC — Request is not an assignment write, no customer message, no nav change");

check(
  "Request model is separate from Job assignment columns",
  schema.includes("model JobReassignmentRequest") &&
    schema.includes("Request create never") &&
    schema.includes("These rows never send customer messages") &&
    !migration.includes('ALTER TABLE "Job"'),
);
check(
  "Migration is additive, uniquely named, and pending-unique on jobId",
  migration.includes('CREATE TABLE IF NOT EXISTS "JobReassignmentRequest"') &&
    migration.includes("WHERE \"status\" = 'PENDING'") &&
    migration.includes("20261001194700") &&
    migration.includes("20261001180000_job_aftercare_instruction") &&
    !migration.includes("20261001180000_job_reassignment") &&
    !migration.includes("20261001190000_job_reassignment") &&
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migration),
);
check(
  "Request create never assigns, reschedules, cancels, or messages Jobs",
  !requestFnSrc.includes("job.update") &&
    !requestFnSrc.includes("job.create") &&
    !requestFnSrc.includes("assignedMembershipId: null") &&
    !requestFnSrc.includes("notifyCustomer") &&
    !requestFnSrc.includes("emitAndProcessBusinessEvent") &&
    !requestFnSrc.includes("lockBusinessScheduleReservation") &&
    requestFnSrc.includes("lockTenantOwnedJob") &&
    requestFnSrc.includes("membershipId: { not: membership.id }") &&
    requestFnSrc.includes("membershipId: membership.id") &&
    requestFnSrc.includes("jobReassignmentRequest.create"),
);
const applyAssignSrc = assignOpsSrc.slice(
  assignOpsSrc.indexOf("export async function applyAssignedMembershipChangeInTransaction"),
);
check(
  "Assignment write supersedes other workers' PENDING reassignment requests",
  applyAssignSrc.includes(`to_regclass('"JobReassignmentRequest"')`) &&
    applyAssignSrc.includes('status: "DECLINED"') &&
    applyAssignSrc.includes("membershipId: { not:") &&
    applyAssignSrc.includes("decidedAt: new Date()") &&
    applyAssignSrc.indexOf("tx.job.update") < applyAssignSrc.indexOf("to_regclass") &&
    applyAssignSrc.indexOf("to_regclass") < applyAssignSrc.indexOf("jobReassignmentRequest.updateMany") &&
    applyAssignSrc.indexOf("previousAssignee !== nextAssignee") <
      applyAssignSrc.indexOf("to_regclass"),
);
check(
  "Accept rechecks the upcoming window after Job lock before claiming",
  acceptFnSrc.includes("afterJobLocked") &&
    afterJobLockedSrc.includes("isRequestableUpcomingAssignedJob") &&
    afterJobLockedSrc.includes("JOB_REASSIGNMENT_REQUEST_NOT_UPCOMING_MESSAGE") &&
    afterJobLockedSrc.includes("scheduledAt: true") &&
    afterJobLockedSrc.includes("status: true") &&
    afterJobLockedSrc.indexOf("isRequestableUpcomingAssignedJob") >
      afterJobLockedSrc.indexOf("jobReassignmentRefusalMessage") &&
    afterJobLockedSrc.indexOf("isRequestableUpcomingAssignedJob") <
      afterJobLockedSrc.indexOf("beforeDecideClaims") &&
    afterJobLockedSrc.indexOf("isRequestableUpcomingAssignedJob") <
      afterJobLockedSrc.indexOf("jobReassignmentRequest.updateMany") &&
    afterJobLockedSrc.indexOf("tx.job.findFirst") <
      afterJobLockedSrc.indexOf("isRequestableUpcomingAssignedJob"),
);
check(
  "Loaders degrade on missing JobReassignmentRequest schema; writes fail closed",
  opsSrc.includes("missingJobReassignmentRequestSchema") &&
    opsSrc.includes("if (missingJobReassignmentRequestSchema(error)) return []") &&
    opsSrc.includes("JOB_REASSIGNMENT_REQUEST_UNAVAILABLE_MESSAGE") &&
    missingJobReassignmentRequestSchema({ code: "P2021" }) &&
    missingJobReassignmentRequestSchema({ code: "P2022" }) &&
    !missingJobReassignmentRequestSchema({ code: "P2002" }) &&
    jobReassignmentRequestErrorMessage({ code: "P2021" }, "fallback") ===
      JOB_REASSIGNMENT_REQUEST_UNAVAILABLE_MESSAGE,
);
check(
  "OWNER accept uses canonical assignment under reservation then Job lock",
  acceptFnSrc.includes("writeAssignedMembershipAndLaneWindows") &&
    acceptFnSrc.includes("afterJobLocked") &&
    acceptFnSrc.includes("nextAssignedMembershipId: null") &&
    assignOpsSrc.includes("lockBusinessScheduleReservation") &&
    assignOpsSrc.includes("lockTenantOwnedJob") &&
    assignOpsSrc.indexOf("lockBusinessScheduleReservation") <
      assignOpsSrc.indexOf("lockTenantOwnedJob") &&
    assignOpsSrc.includes("await input.afterJobLocked") &&
    assignOpsSrc.includes("JOB_REASSIGNMENT_TIME_CLOSED_REASON") &&
    !assignOpsSrc.includes("notifyCustomer") &&
    !assignOpsSrc.includes("emitAndProcessBusinessEvent"),
);
check(
  "Owner and self lists are bounded in the query, not sliced in memory",
  opsSrc.includes("take: JOB_REASSIGNMENT_REQUEST_PENDING_LIST_LIMIT") &&
    opsSrc.includes("take: JOB_REASSIGNMENT_REQUEST_RECENT_LIST_LIMIT") &&
    opsSrc.includes("take: JOB_REASSIGNMENT_REQUEST_SELF_LIST_LIMIT") &&
    JOB_REASSIGNMENT_REQUEST_PENDING_LIST_LIMIT === 100 &&
    JOB_REASSIGNMENT_REQUEST_RECENT_LIST_LIMIT === 20 &&
    JOB_REASSIGNMENT_REQUEST_SELF_LIST_LIMIT === 50 &&
    !opsSrc.includes(".slice(0, 20)"),
);
check(
  "Field /team surfaces exist and global nav is unchanged",
  fieldPage.includes("JobReassignmentRequestForm") &&
    fieldJobPage.includes("JobReassignmentRequestForm") &&
    teamPage.includes("JobReassignmentRequestsPanel") &&
    fieldUi.includes("The job assignment and schedule stay") &&
    teamUi.includes("does not send a customer message") &&
    actionSrc.includes("No customer message was sent") &&
    !navSrc.includes("reassignment") &&
    !navSrc.includes("Reassignment"),
);
check(
  "Test harness refuses a non-localhost DATABASE_URL before connecting",
  checkSrc.includes("assertLocalDatabaseUrl") &&
    checkSrc.includes("openDisposableTestDatabase") &&
    checkSrc.includes("tbbt_job_reassignment_req") &&
    checkSrc.includes("Dedicated local disposable database"),
);
check(
  "MEMBER still cannot manage jobs",
  !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_JOBS),
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run job-reassignment-request Prisma checks.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "job-reassignment-request dedicated local database");

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: { role, membership: { id: membershipId } },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

const NOW = new Date("2026-10-01T16:00:00.000Z");
const upcomingAt = new Date("2026-10-08T16:00:00.000Z");
const pendingUniqueSql = [
  `CREATE UNIQUE INDEX IF NOT EXISTS "JobReassignmentRequest_pending_jobId_key"`,
  `  ON "JobReassignmentRequest"("jobId")`,
  `  WHERE "status" = 'PENDING'`,
].join("\n");

let session = null;
try {
  session = await openDisposableTestDatabase({
    databaseUrl: baseUrl,
    namePrefix: "tbbt_job_reassignment_req",
  });
  const prisma = session.prisma;
  check(
    "Dedicated local disposable database opened",
    Boolean(session.testDbName?.startsWith("tbbt_job_reassignment_req_")),
  );

  await prisma.$executeRawUnsafe(pendingUniqueSql);
  check(
    "Applied the migration pending-unique index after db push",
    migration.includes(pendingUniqueSql.split("\n")[0]),
  );

  console.log("\nPRISMA — MEMBER request, OWNER decide, isolation, races, no customer message");

  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Reassignment",
      slug: `alpha-reassign-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: DEFAULT_BUSINESS_TIMEZONE,
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Reassignment",
      slug: `beta-reassign-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: "America/Los_Angeles",
    },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-re-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Ada Admin", email: `admin-re-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-re-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const helperUser = await prisma.user.create({
    data: { name: "Ned Helper", email: `helper-re-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaOwner = await prisma.user.create({
    data: { name: "Bea Owner", email: `beta-re-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaMember = await prisma.user.create({
    data: { name: "Ben Member", email: `beta-mem-re-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const adminMem = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: businessA.id, role: "ADMIN" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER", schedulingActive: true },
  });
  const helperMem = await prisma.membership.create({
    data: { userId: helperUser.id, businessId: businessA.id, role: "MEMBER", schedulingActive: true },
  });
  const betaOwnerMem = await prisma.membership.create({
    data: { userId: betaOwner.id, businessId: businessB.id, role: "OWNER" },
  });
  const betaMemberMem = await prisma.membership.create({
    data: { userId: betaMember.id, businessId: businessB.id, role: "MEMBER", schedulingActive: true },
  });
  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const helperA = makeAccess(businessA.id, "MEMBER", helperMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaOwnerMem.id);
  const memberB = makeAccess(businessB.id, "MEMBER", betaMemberMem.id);

  await prisma.businessSaasSubscription.create({
    data: { businessId: businessA.id, status: "active", planCode: "FOUNDER", legacyExempt: true },
  });
  await prisma.businessSaasSubscription.create({
    data: { businessId: businessB.id, status: "active", planCode: "FOUNDER", legacyExempt: true },
  });

  const customer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Alpha Customer" },
  });
  const betaCustomer = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Customer" },
  });

  async function createAssignedJob(input) {
    return prisma.job.create({
      data: {
        businessId: input.businessId,
        customerId: input.customerId,
        projectToken: randomUUID(),
        status: input.status ?? "SCHEDULED",
        scheduledAt: input.scheduledAt ?? upcomingAt,
        scheduledDurationMinutes: 120,
        assignedMembershipId: input.assignedMembershipId,
      },
    });
  }

  const job = await createAssignedJob({
    businessId: businessA.id,
    customerId: customer.id,
    assignedMembershipId: memberMem.id,
  });
  const helperJob = await createAssignedJob({
    businessId: businessA.id,
    customerId: customer.id,
    assignedMembershipId: helperMem.id,
  });
  const completedJob = await createAssignedJob({
    businessId: businessA.id,
    customerId: customer.id,
    assignedMembershipId: memberMem.id,
    status: "COMPLETED",
  });
  const cancelledJob = await createAssignedJob({
    businessId: businessA.id,
    customerId: customer.id,
    assignedMembershipId: memberMem.id,
    status: "CANCELLED",
  });
  const todayJob = await createAssignedJob({
    businessId: businessA.id,
    customerId: customer.id,
    assignedMembershipId: memberMem.id,
    scheduledAt: new Date("2026-10-01T18:00:00.000Z"),
  });
  const betaJob = await createAssignedJob({
    businessId: businessB.id,
    customerId: betaCustomer.id,
    assignedMembershipId: betaMemberMem.id,
  });

  await expectError(
    "OWNER cannot use the worker request path",
    () => requestJobReassignmentOp(prisma, ownerA, { jobId: job.id, reason: "Busy", now: NOW }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "ADMIN cannot use the worker request path",
    () => requestJobReassignmentOp(prisma, adminA, { jobId: job.id, reason: "Busy", now: NOW }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot request another worker's job",
    () => requestJobReassignmentOp(prisma, memberA, { jobId: helperJob.id, reason: "Busy", now: NOW }),
    (error) =>
      error instanceof JobReassignmentRequestError &&
      error.message === JOB_REASSIGNMENT_REQUEST_ALREADY_REASSIGNED_MESSAGE,
  );
  await expectError(
    "MEMBER cannot request a foreign-tenant job",
    () => requestJobReassignmentOp(prisma, memberA, { jobId: betaJob.id, reason: "Busy", now: NOW }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "Completed job is refused",
    () => requestJobReassignmentOp(prisma, memberA, { jobId: completedJob.id, reason: "Busy", now: NOW }),
    (error) =>
      error instanceof JobReassignmentRequestError &&
      error.message === JOB_REASSIGNMENT_REQUEST_COMPLETED_MESSAGE,
  );
  await expectError(
    "Cancelled job is refused",
    () => requestJobReassignmentOp(prisma, memberA, { jobId: cancelledJob.id, reason: "Busy", now: NOW }),
    (error) =>
      error instanceof JobReassignmentRequestError &&
      error.message === JOB_REASSIGNMENT_REQUEST_CANCELLED_MESSAGE,
  );
  await expectError(
    "Today / not-upcoming job is refused",
    () => requestJobReassignmentOp(prisma, memberA, { jobId: todayJob.id, reason: "Busy", now: NOW }),
    (error) =>
      error instanceof JobReassignmentRequestError &&
      error.message === JOB_REASSIGNMENT_REQUEST_NOT_UPCOMING_MESSAGE,
  );
  await expectError(
    "Empty reason is refused",
    () => requestJobReassignmentOp(prisma, memberA, { jobId: job.id, reason: "   ", now: NOW }),
    (error) =>
      error instanceof JobReassignmentRequestError &&
      error.message === JOB_REASSIGNMENT_REQUEST_REASON_MESSAGE,
  );

  const requested = await requestJobReassignmentOp(prisma, memberA, {
    jobId: job.id,
    reason: "Truck is in the shop",
    now: NOW,
  });
  const jobAfterRequest = await prisma.job.findFirst({
    where: { id: job.id, businessId: businessA.id },
  });
  const eventsAfterRequest = await prisma.jobAppointmentEvent.count({
    where: { businessId: businessA.id },
  });
  check("MEMBER can request reassignment of their upcoming job", requested.status === "PENDING");
  check(
    "Pending request does not change assignment or schedule",
    jobAfterRequest?.assignedMembershipId === memberMem.id &&
      jobAfterRequest?.status === "SCHEDULED" &&
      jobAfterRequest?.scheduledAt?.getTime() === upcomingAt.getTime() &&
      jobAfterRequest?.appointmentNotificationStatus == null,
  );
  check("Pending request does not write a customer appointment event", eventsAfterRequest === 0);

  await expectError(
    "Duplicate pending request for the same job is rejected",
    () => requestJobReassignmentOp(prisma, memberA, { jobId: job.id, reason: "Still busy", now: NOW }),
    (error) =>
      error instanceof JobReassignmentRequestError &&
      error.message === JOB_REASSIGNMENT_REQUEST_PENDING_EXISTS_MESSAGE,
  );

  const selfLoaded = await loadSelfJobReassignmentRequests(prisma, {
    businessId: businessA.id,
    membershipId: memberMem.id,
  });
  const helperLoaded = await loadSelfJobReassignmentRequests(prisma, {
    businessId: businessA.id,
    membershipId: helperMem.id,
  });
  const betaSelf = await loadSelfJobReassignmentRequests(prisma, {
    businessId: businessB.id,
    membershipId: betaMemberMem.id,
  });
  check("Self loader returns only the worker's own requests", selfLoaded.some((row) => row.id === requested.id));
  check("Self loader does not leak another worker's requests", helperLoaded.length === 0);
  check("Self loader is tenant-scoped", betaSelf.length === 0);

  const owned = await loadOwnedJobReassignmentRequests(prisma, ownerA);
  const adminOwned = await loadOwnedJobReassignmentRequests(prisma, adminA);
  check("OWNER sees the pending request in a bounded queue", owned.pending.some((row) => row.id === requested.id));
  check("OWNER can decide", owned.canDecide === true);
  check("ADMIN can see the queue but cannot decide", adminOwned.canDecide === false);
  await expectError(
    "MEMBER cannot load the owner queue",
    () => loadOwnedJobReassignmentRequests(prisma, memberA),
    (error) => error instanceof ForbiddenError,
  );
  const ownerBQueue = await loadOwnedJobReassignmentRequests(prisma, ownerB);
  check("Foreign OWNER queue is empty for business A requests", ownerBQueue.pending.length === 0);

  await expectError(
    "ADMIN cannot accept or decline",
    () =>
      decideJobReassignmentRequestOp(prisma, adminA, {
        requestId: requested.id,
        decision: "ACCEPT",
        expectedUpdatedAt: requested.updatedAt,
        now: NOW,
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot decide",
    () =>
      decideJobReassignmentRequestOp(prisma, memberA, {
        requestId: requested.id,
        decision: "DECLINE",
        expectedUpdatedAt: requested.updatedAt,
        now: NOW,
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "Foreign OWNER cannot decide a business A request",
    () =>
      decideJobReassignmentRequestOp(prisma, ownerB, {
        requestId: requested.id,
        decision: "ACCEPT",
        expectedUpdatedAt: requested.updatedAt,
        now: NOW,
      }),
    (error) => error instanceof ForbiddenError,
  );

  const declinedJob = await createAssignedJob({
    businessId: businessA.id,
    customerId: customer.id,
    assignedMembershipId: memberMem.id,
  });
  const declineRequest = await requestJobReassignmentOp(prisma, memberA, {
    jobId: declinedJob.id,
    reason: "Need the afternoon off",
    now: NOW,
  });
  const declined = await decideJobReassignmentRequestOp(prisma, ownerA, {
    requestId: declineRequest.id,
    decision: "DECLINE",
    expectedUpdatedAt: declineRequest.updatedAt,
    now: NOW,
  });
  const jobAfterDecline = await prisma.job.findFirst({
    where: { id: declinedJob.id, businessId: businessA.id },
  });
  check("Decline records DECLINED", declined.request.status === "DECLINED");
  check(
    "Decline leaves assignment and schedule unchanged",
    jobAfterDecline?.assignedMembershipId === memberMem.id &&
      jobAfterDecline?.scheduledAt?.getTime() === upcomingAt.getTime() &&
      jobAfterDecline?.appointmentNotificationStatus == null,
  );

  const accepted = await decideJobReassignmentRequestOp(prisma, ownerA, {
    requestId: requested.id,
    decision: "ACCEPT",
    expectedUpdatedAt: requested.updatedAt,
    now: NOW,
  });
  const jobAfterAccept = await prisma.job.findFirst({
    where: { id: job.id, businessId: businessA.id },
  });
  const eventsAfterAccept = await prisma.jobAppointmentEvent.count({
    where: { businessId: businessA.id },
  });
  check("Accept records ACCEPTED", accepted.request.status === "ACCEPTED");
  check(
    "Accept unassigns through canonical assignment and does not reschedule",
    jobAfterAccept?.assignedMembershipId === null &&
      jobAfterAccept?.status === "SCHEDULED" &&
      jobAfterAccept?.scheduledAt?.getTime() === upcomingAt.getTime() &&
      jobAfterAccept?.appointmentNotificationStatus == null,
  );
  check("Accept does not write a customer appointment event", eventsAfterAccept === 0);

  await expectError(
    "Stale accept after a completed decision is refused",
    () =>
      decideJobReassignmentRequestOp(prisma, ownerA, {
        requestId: requested.id,
        decision: "ACCEPT",
        expectedUpdatedAt: requested.updatedAt,
        now: NOW,
      }),
    (error) =>
      error instanceof JobReassignmentRequestError &&
      error.message === JOB_REASSIGNMENT_REQUEST_STALE_MESSAGE,
  );

  const staleJob = await createAssignedJob({
    businessId: businessA.id,
    customerId: customer.id,
    assignedMembershipId: memberMem.id,
  });
  const staleRequest = await requestJobReassignmentOp(prisma, memberA, {
    jobId: staleJob.id,
    reason: "Schedule conflict",
    now: NOW,
  });
  await prisma.job.update({
    where: { id: staleJob.id },
    data: { status: "COMPLETED" },
  });
  await expectError(
    "Accept refuses a job completed after the request",
    () =>
      decideJobReassignmentRequestOp(prisma, ownerA, {
        requestId: staleRequest.id,
        decision: "ACCEPT",
        expectedUpdatedAt: staleRequest.updatedAt,
        now: NOW,
      }),
    (error) =>
      error instanceof JobReassignmentRequestError &&
      error.message === JOB_REASSIGNMENT_REQUEST_COMPLETED_MESSAGE,
  );
  const staleJobAfter = await prisma.job.findFirst({
    where: { id: staleJob.id, businessId: businessA.id },
  });
  check(
    "Refused completed accept leaves assignment unchanged",
    staleJobAfter?.assignedMembershipId === memberMem.id &&
      staleJobAfter?.status === "COMPLETED",
  );

  const cancelledAfterJob = await createAssignedJob({
    businessId: businessA.id,
    customerId: customer.id,
    assignedMembershipId: memberMem.id,
  });
  const cancelledAfterRequest = await requestJobReassignmentOp(prisma, memberA, {
    jobId: cancelledAfterJob.id,
    reason: "Family",
    now: NOW,
  });
  await prisma.job.update({
    where: { id: cancelledAfterJob.id },
    data: { status: "CANCELLED" },
  });
  await expectError(
    "Accept refuses a job cancelled after the request",
    () =>
      decideJobReassignmentRequestOp(prisma, ownerA, {
        requestId: cancelledAfterRequest.id,
        decision: "ACCEPT",
        expectedUpdatedAt: cancelledAfterRequest.updatedAt,
        now: NOW,
      }),
    (error) =>
      error instanceof JobReassignmentRequestError &&
      error.message === JOB_REASSIGNMENT_REQUEST_CANCELLED_MESSAGE,
  );

  const raceJob = await createAssignedJob({
    businessId: businessA.id,
    customerId: customer.id,
    assignedMembershipId: memberMem.id,
  });
  const raceRequest = await requestJobReassignmentOp(prisma, memberA, {
    jobId: raceJob.id,
    reason: "Need coverage",
    now: NOW,
  });
  const acceptBarrier = createCountBarrier(1);
  jobReassignmentRequestTestHooks.beforeAcceptAssignment = acceptBarrier.wait;
  const acceptClient = session.createClient();
  const assignClient = session.createClient();
  let acceptRace;
  try {
    const acceptPromise = decideJobReassignmentRequestOp(acceptClient, ownerA, {
      requestId: raceRequest.id,
      decision: "ACCEPT",
      expectedUpdatedAt: raceRequest.updatedAt,
      now: NOW,
    });
    await withTimeout(acceptBarrier.arrived, 4000, "accept reached assignment lock");
    const assigned = await writeAssignedMembershipAndLaneWindows(assignClient, {
      businessId: businessA.id,
      job: raceJob,
      nextAssignedMembershipId: helperMem.id,
      actorMembershipId: ownerMem.id,
    });
    check("Concurrent reassignment write succeeded before accept locked", !assigned?.error);
    acceptBarrier.release();
    acceptRace = await Promise.allSettled([acceptPromise]);
  } finally {
    acceptBarrier.release();
    jobReassignmentRequestTestHooks.beforeAcceptAssignment = undefined;
    await acceptClient.$disconnect();
    await assignClient.$disconnect();
  }
  const raceJobAfter = await prisma.job.findFirst({
    where: { id: raceJob.id, businessId: businessA.id },
  });
  const raceRequestAfter = await prisma.jobReassignmentRequest.findFirst({
    where: { id: raceRequest.id, businessId: businessA.id },
  });
  const eventsAfterRace = await prisma.jobAppointmentEvent.count({
    where: { jobId: raceJob.id, businessId: businessA.id },
  });
  check(
    "Accept-vs-reassignment race refuses stale assignment and leaves the later assignee",
    acceptRace[0].status === "rejected" &&
      acceptRace[0].reason instanceof JobReassignmentRequestError &&
      acceptRace[0].reason.message === JOB_REASSIGNMENT_REQUEST_ALREADY_REASSIGNED_MESSAGE &&
      raceJobAfter?.assignedMembershipId === helperMem.id &&
      raceRequestAfter?.status === "DECLINED" &&
      raceRequestAfter?.decidedByMembershipId == null &&
      raceRequestAfter?.decidedAt instanceof Date &&
      eventsAfterRace === 0,
  );

  const decideJob = await createAssignedJob({
    businessId: businessA.id,
    customerId: customer.id,
    assignedMembershipId: memberMem.id,
  });
  const decideRequest = await requestJobReassignmentOp(prisma, memberA, {
    jobId: decideJob.id,
    reason: "Double-booked",
    now: NOW,
  });
  const decideBarrier = createCountBarrier(2);
  jobReassignmentRequestTestHooks.beforeDecideClaims = decideBarrier.wait;
  const decideA = session.createClient();
  const decideB = session.createClient();
  let decideRace;
  try {
    const first = decideJobReassignmentRequestOp(decideA, ownerA, {
      requestId: decideRequest.id,
      decision: "DECLINE",
      expectedUpdatedAt: decideRequest.updatedAt,
      now: NOW,
    });
    const second = decideJobReassignmentRequestOp(decideB, ownerA, {
      requestId: decideRequest.id,
      decision: "DECLINE",
      expectedUpdatedAt: decideRequest.updatedAt,
      now: NOW,
    });
    await withTimeout(decideBarrier.arrived, 4000, "both decides read PENDING");
    decideBarrier.release();
    decideRace = await Promise.allSettled([first, second]);
  } finally {
    decideBarrier.release();
    jobReassignmentRequestTestHooks.beforeDecideClaims = undefined;
    await decideA.$disconnect();
    await decideB.$disconnect();
  }
  const decideWon = decideRace.filter((row) => row.status === "fulfilled");
  const decideLost = decideRace.filter(
    (row) =>
      row.status === "rejected" &&
      row.reason instanceof JobReassignmentRequestError &&
      row.reason.message === JOB_REASSIGNMENT_REQUEST_STALE_MESSAGE,
  );
  check(
    "Exactly one concurrent decide wins; the other is stale",
    decideWon.length === 1 && decideLost.length === 1,
  );

  const createJobRow = await createAssignedJob({
    businessId: businessA.id,
    customerId: customer.id,
    assignedMembershipId: helperMem.id,
  });
  const createBarrier = createCountBarrier(2);
  jobReassignmentRequestTestHooks.beforeRequestCreate = createBarrier.wait;
  const createA = session.createClient();
  const createB = session.createClient();
  let createRace;
  try {
    const first = requestJobReassignmentOp(createA, helperA, {
      jobId: createJobRow.id,
      reason: "Need help",
      now: NOW,
    });
    const second = requestJobReassignmentOp(createB, helperA, {
      jobId: createJobRow.id,
      reason: "Need help too",
      now: NOW,
    });
    await withTimeout(createBarrier.arrived, 4000, "both creates passed the pending lookup");
    createBarrier.release();
    createRace = await Promise.allSettled([first, second]);
  } finally {
    createBarrier.release();
    jobReassignmentRequestTestHooks.beforeRequestCreate = undefined;
    await createA.$disconnect();
    await createB.$disconnect();
  }
  const createWon = createRace.filter((row) => row.status === "fulfilled");
  const createLost = createRace.filter(
    (row) =>
      row.status === "rejected" &&
      row.reason instanceof JobReassignmentRequestError &&
      row.reason.message === JOB_REASSIGNMENT_REQUEST_PENDING_EXISTS_MESSAGE,
  );
  const createRows = await prisma.jobReassignmentRequest.findMany({
    where: { jobId: createJobRow.id, businessId: businessA.id, status: "PENDING" },
  });
  check(
    "Exactly one concurrent duplicate create wins against the pending-unique index",
    createWon.length === 1 && createLost.length === 1 && createRows.length === 1,
  );

  async function assignMember(job, membershipId) {
    return writeAssignedMembershipAndLaneWindows(prisma, {
      businessId: businessA.id,
      job,
      nextAssignedMembershipId: membershipId,
      actorMembershipId: ownerMem.id,
    });
  }

  async function proveStaleRequestCleared({ label, afterRequest, bRequest }) {
    const job = await createAssignedJob({
      businessId: businessA.id,
      customerId: customer.id,
      assignedMembershipId: memberMem.id,
    });
    const request = await requestJobReassignmentOp(prisma, memberA, {
      jobId: job.id,
      reason: `Stale ${label}`,
      now: NOW,
    });
    await afterRequest?.(job);
    const assigned = await assignMember(job, helperMem.id);
    check(`${label}: reassignment write succeeds`, !assigned?.error);
    const stale = await prisma.jobReassignmentRequest.findFirst({
      where: { id: request.id, businessId: businessA.id },
    });
    check(
      `${label}: A's row is DECLINED with no decider and a decidedAt`,
      stale?.status === "DECLINED" &&
        stale.decidedByMembershipId == null &&
        stale.decidedAt instanceof Date,
    );
    const ownedQueue = await loadOwnedJobReassignmentRequests(prisma, ownerA);
    check(
      `${label}: owner pending queue no longer lists A's row`,
      !ownedQueue.pending.some((row) => row.id === request.id),
    );
    const selfA = await loadSelfJobReassignmentRequests(prisma, {
      businessId: businessA.id,
      membershipId: memberMem.id,
    });
    check(
      `${label}: A's field row is no longer PENDING`,
      !selfA.some((row) => row.id === request.id && row.status === "PENDING"),
    );
    if (bRequest === "ok") {
      const created = await requestJobReassignmentOp(prisma, helperA, {
        jobId: job.id,
        reason: `Current ${label}`,
        now: NOW,
      });
      check(
        `${label}: current assignee B can request`,
        created.status === "PENDING" && created.membershipId === helperMem.id,
      );
    } else {
      const expected =
        bRequest === "completed"
          ? JOB_REASSIGNMENT_REQUEST_COMPLETED_MESSAGE
          : JOB_REASSIGNMENT_REQUEST_NOT_UPCOMING_MESSAGE;
      await expectError(
        `${label}: B is refused only by the real ${bRequest} rule`,
        () =>
          requestJobReassignmentOp(prisma, helperA, {
            jobId: job.id,
            reason: `Current ${label}`,
            now: NOW,
          }),
        (error) =>
          error instanceof JobReassignmentRequestError && error.message === expected,
      );
    }
    await expectError(
      `${label}: Accept on A's old row refuses`,
      () =>
        decideJobReassignmentRequestOp(prisma, ownerA, {
          requestId: request.id,
          decision: "ACCEPT",
          expectedUpdatedAt: stale.updatedAt,
          now: NOW,
        }),
      (error) =>
        error instanceof JobReassignmentRequestError &&
        (error.message === JOB_REASSIGNMENT_REQUEST_STALE_MESSAGE ||
          error.message === JOB_REASSIGNMENT_REQUEST_ALREADY_REASSIGNED_MESSAGE),
    );
    const jobAfterAccept = await prisma.job.findFirst({
      where: { id: job.id, businessId: businessA.id },
    });
    const events = await prisma.jobAppointmentEvent.count({
      where: { jobId: job.id, businessId: businessA.id },
    });
    const comms = await prisma.customerCommunication.count({
      where: { businessId: businessA.id, relatedId: job.id },
    });
    check(
      `${label}: B stays assigned; no customer appointment or communication rows`,
      jobAfterAccept?.assignedMembershipId === helperMem.id && events === 0 && comms === 0,
    );
  }

  await proveStaleRequestCleared({
    label: "manual reassign",
    bRequest: "ok",
  });
  await proveStaleRequestCleared({
    label: "cancel-reopen",
    afterRequest: async (job) => {
      await prisma.job.update({
        where: { id: job.id },
        data: { status: "CANCELLED" },
      });
      await prisma.job.update({
        where: { id: job.id },
        data: { status: "SCHEDULED" },
      });
    },
    bRequest: "ok",
  });
  await proveStaleRequestCleared({
    label: "deactivate",
    afterRequest: async () => {
      await prisma.membership.update({
        where: { id: memberMem.id },
        data: { active: false },
      });
    },
    bRequest: "ok",
  });
  await prisma.membership.update({
    where: { id: memberMem.id },
    data: { active: true },
  });
  await proveStaleRequestCleared({
    label: "unassign-then-assign",
    afterRequest: async (job) => {
      const cleared = await assignMember(job, null);
      check("unassign-then-assign: unassign write succeeds", !cleared?.error);
    },
    bRequest: "ok",
  });
  const completedJob = await createAssignedJob({
    businessId: businessA.id,
    customerId: customer.id,
    assignedMembershipId: memberMem.id,
  });
  const completedRequest = await requestJobReassignmentOp(prisma, memberA, {
    jobId: completedJob.id,
    reason: "Completed after request",
    now: NOW,
  });
  await prisma.job.update({
    where: { id: completedJob.id },
    data: { status: "COMPLETED" },
  });
  const completedAssign = await assignMember(completedJob, helperMem.id);
  check(
    "complete: assignment write is refused after the job completes",
    completedAssign?.error === "A completed job cannot be assigned.",
  );
  const completedPending = await prisma.jobReassignmentRequest.findFirst({
    where: { id: completedRequest.id, businessId: businessA.id },
  });
  check(
    "complete: pending request stays until the owner tries to accept",
    completedPending?.status === "PENDING" && completedPending.decidedAt == null,
  );
  await expectError(
    "complete: B is refused only by the real completed rule",
    () =>
      requestJobReassignmentOp(prisma, helperA, {
        jobId: completedJob.id,
        reason: "Current complete",
        now: NOW,
      }),
    (error) =>
      error instanceof JobReassignmentRequestError &&
      error.message === JOB_REASSIGNMENT_REQUEST_COMPLETED_MESSAGE,
  );
  await expectError(
    "complete: Accept on A's old row refuses",
    () =>
      decideJobReassignmentRequestOp(prisma, ownerA, {
        requestId: completedRequest.id,
        decision: "ACCEPT",
        expectedUpdatedAt: completedPending.updatedAt,
        now: NOW,
      }),
    (error) =>
      error instanceof JobReassignmentRequestError &&
      error.message === JOB_REASSIGNMENT_REQUEST_COMPLETED_MESSAGE,
  );
  const completedAfter = await prisma.job.findFirst({
    where: { id: completedJob.id, businessId: businessA.id },
  });
  check(
    "complete: A stays assigned; no customer appointment or communication rows",
    completedAfter?.assignedMembershipId === memberMem.id &&
      completedAfter?.status === "COMPLETED" &&
      (await prisma.jobAppointmentEvent.count({
        where: { jobId: completedJob.id, businessId: businessA.id },
      })) === 0 &&
      (await prisma.customerCommunication.count({
        where: { businessId: businessA.id, relatedId: completedJob.id },
      })) === 0,
  );
  await proveStaleRequestCleared({
    label: "today",
    afterRequest: async (job) => {
      await prisma.job.update({
        where: { id: job.id },
        data: { scheduledAt: new Date("2026-10-01T18:00:00.000Z") },
      });
    },
    bRequest: "not-upcoming",
  });

  const sameAssigneeJob = await createAssignedJob({
    businessId: businessA.id,
    customerId: customer.id,
    assignedMembershipId: memberMem.id,
  });
  const sameAssigneeRequest = await requestJobReassignmentOp(prisma, memberA, {
    jobId: sameAssigneeJob.id,
    reason: "Keep my own pending",
    now: NOW,
  });
  const sameAssigneeWrite = await assignMember(sameAssigneeJob, memberMem.id);
  const sameAssigneeAfter = await prisma.jobReassignmentRequest.findFirst({
    where: { id: sameAssigneeRequest.id, businessId: businessA.id },
  });
  check(
    "Re-saving the same assignee leaves that worker's PENDING row alone",
    !sameAssigneeWrite?.error &&
      sameAssigneeAfter?.status === "PENDING" &&
      sameAssigneeAfter.decidedAt == null &&
      sameAssigneeAfter.decidedByMembershipId == null,
  );

  await prisma.membership.update({
    where: { id: helperMem.id },
    data: { active: false },
  });
  await expectError(
    "Inactive worker cannot request reassignment",
    () =>
      requestJobReassignmentOp(prisma, helperA, {
        jobId: createJobRow.id,
        reason: "Still need help",
        now: NOW,
      }),
    (error) =>
      error instanceof JobReassignmentRequestError &&
      error.message === JOB_REASSIGNMENT_REQUEST_INACTIVE_MESSAGE,
  );

  const messageCount = await prisma.jobAppointmentEvent.count({
    where: { businessId: { in: [businessA.id, businessB.id] } },
  });
  check("No automatic customer appointment message was written", messageCount === 0);

  const inProgressJob = await createAssignedJob({
    businessId: businessA.id,
    customerId: customer.id,
    assignedMembershipId: memberMem.id,
  });
  const inProgressRequest = await requestJobReassignmentOp(prisma, memberA, {
    jobId: inProgressJob.id,
    reason: "Started after I asked",
    now: NOW,
  });
  await prisma.job.update({
    where: { id: inProgressJob.id },
    data: { status: "IN_PROGRESS" },
  });
  const runningEntry = await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: memberMem.id,
      jobId: inProgressJob.id,
      activityType: "JOB",
      status: "RUNNING",
      startedAt: NOW,
      source: "CLOCK",
    },
  });
  await expectError(
    "Accept refuses after the worker starts and clocks in",
    () =>
      decideJobReassignmentRequestOp(prisma, ownerA, {
        requestId: inProgressRequest.id,
        decision: "ACCEPT",
        expectedUpdatedAt: inProgressRequest.updatedAt,
        now: NOW,
      }),
    (error) =>
      error instanceof JobReassignmentRequestError &&
      error.message === JOB_REASSIGNMENT_REQUEST_NOT_UPCOMING_MESSAGE,
  );
  const inProgressAfter = await prisma.job.findFirst({
    where: { id: inProgressJob.id, businessId: businessA.id },
  });
  const runningAfter = await prisma.timeEntry.findFirst({
    where: { id: runningEntry.id, businessId: businessA.id },
  });
  check(
    "IN_PROGRESS accept refusal leaves assignment and running time untouched",
    inProgressAfter?.assignedMembershipId === memberMem.id &&
      inProgressAfter?.status === "IN_PROGRESS" &&
      runningAfter?.status === "RUNNING" &&
      runningAfter?.endedAt == null,
  );

  const todayMovedJob = await createAssignedJob({
    businessId: businessA.id,
    customerId: customer.id,
    assignedMembershipId: memberMem.id,
  });
  const todayMovedRequest = await requestJobReassignmentOp(prisma, memberA, {
    jobId: todayMovedJob.id,
    reason: "Moved to today",
    now: NOW,
  });
  await prisma.job.update({
    where: { id: todayMovedJob.id },
    data: { scheduledAt: new Date("2026-10-01T18:00:00.000Z") },
  });
  await expectError(
    "Accept refuses after the job is rescheduled to later today",
    () =>
      decideJobReassignmentRequestOp(prisma, ownerA, {
        requestId: todayMovedRequest.id,
        decision: "ACCEPT",
        expectedUpdatedAt: todayMovedRequest.updatedAt,
        now: NOW,
      }),
    (error) =>
      error instanceof JobReassignmentRequestError &&
      error.message === JOB_REASSIGNMENT_REQUEST_NOT_UPCOMING_MESSAGE,
  );
  const todayMovedAfter = await prisma.job.findFirst({
    where: { id: todayMovedJob.id, businessId: businessA.id },
  });
  check(
    "Today-reschedule accept refusal leaves assignment and schedule untouched",
    todayMovedAfter?.assignedMembershipId === memberMem.id &&
      todayMovedAfter?.scheduledAt?.getTime() === new Date("2026-10-01T18:00:00.000Z").getTime() &&
      todayMovedAfter?.status === "SCHEDULED",
  );

  console.log("\nMISSING SCHEMA — loaders degrade; writes fail closed");
  const missingWriteJob = await createAssignedJob({
    businessId: businessA.id,
    customerId: customer.id,
    assignedMembershipId: memberMem.id,
  });
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "JobReassignmentRequest" CASCADE`);
  const missingTables = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'JobReassignmentRequest'
  `;
  check("JobReassignmentRequest is absent after the drop", missingTables.length === 0);

  let selfMissingError = null;
  let selfMissing = "threw";
  try {
    selfMissing = await loadSelfJobReassignmentRequests(prisma, {
      businessId: businessA.id,
      membershipId: memberMem.id,
    });
  } catch (error) {
    selfMissingError = error;
  }
  let ownedMissingError = null;
  let ownedMissing = "threw";
  try {
    ownedMissing = await loadOwnedJobReassignmentRequests(prisma, ownerA);
  } catch (error) {
    ownedMissingError = error;
  }
  check(
    "Self loader returns an empty list when the table is missing",
    Array.isArray(selfMissing) && selfMissing.length === 0 && selfMissingError === null,
  );
  check(
    "Owner loader returns empty queues when the table is missing",
    ownedMissing !== "threw" &&
      ownedMissing.pending.length === 0 &&
      ownedMissing.recent.length === 0 &&
      ownedMissingError === null,
  );
  await expectError(
    "Request write fail-closes with a clean unavailable message when the table is missing",
    () =>
      requestJobReassignmentOp(prisma, memberA, {
        jobId: missingWriteJob.id,
        reason: "Table is gone",
        now: NOW,
      }),
    (error) =>
      error instanceof JobReassignmentRequestError &&
      error.message === JOB_REASSIGNMENT_REQUEST_UNAVAILABLE_MESSAGE,
  );
  await expectError(
    "Decide write fail-closes with a clean unavailable message when the table is missing",
    () =>
      decideJobReassignmentRequestOp(prisma, ownerA, {
        requestId: requested.id,
        decision: "ACCEPT",
        expectedUpdatedAt: requested.updatedAt,
        now: NOW,
      }),
    (error) =>
      error instanceof JobReassignmentRequestError &&
      error.message === JOB_REASSIGNMENT_REQUEST_UNAVAILABLE_MESSAGE,
  );
  const missingWriteJobAfterDrop = await prisma.job.findFirst({
    where: { id: missingWriteJob.id, businessId: businessA.id },
  });
  check(
    "Missing-table write refusals do not change assignment",
    missingWriteJobAfterDrop?.assignedMembershipId === memberMem.id &&
      missingWriteJobAfterDrop?.scheduledAt?.getTime() === upcomingAt.getTime(),
  );
  const missingAssign = await writeAssignedMembershipAndLaneWindows(prisma, {
    businessId: businessA.id,
    job: missingWriteJob,
    nextAssignedMembershipId: helperMem.id,
    actorMembershipId: ownerMem.id,
  });
  const missingAssignAfter = await prisma.job.findFirst({
    where: { id: missingWriteJob.id, businessId: businessA.id },
  });
  check(
    "Assignment write still succeeds when JobReassignmentRequest is missing",
    !missingAssign?.error && missingAssignAfter?.assignedMembershipId === helperMem.id,
  );
} catch (error) {
  failed += 1;
  console.error("FAIL - job-reassignment-request Prisma harness threw", error);
} finally {
  jobReassignmentRequestTestHooks.beforeRequestCreate = undefined;
  jobReassignmentRequestTestHooks.beforeAcceptAssignment = undefined;
  jobReassignmentRequestTestHooks.beforeDecideClaims = undefined;
  if (session) {
    await session.cleanup();
  }
}

console.log(
  failed === 0
    ? `\nAll job-reassignment-request checks passed (${passed}).`
    : `\n${failed} job-reassignment-request check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
