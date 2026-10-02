/**
 * OWNER deactivate vs OWNER reassign must not 40P01, and both commit
 * orders must leave no RUNNING time for an inactive worker, a
 * non-assignee, or a completed job.
 *
 * Uses the #251 lock order (schedule-reservation, then Job, then
 * Membership) and real two-connection barriers. Does not invent a new
 * workflow.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-deactivate-reassign-deadlock.mjs
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

function isPostgresDeadlock(error) {
  if (!error) return false;
  const code = error.code ?? error.meta?.code;
  const message = String(error.message ?? error);
  return (
    code === "40P01" ||
    code === "P2034" ||
    /40P01/i.test(message) ||
    /deadlock detected/i.test(message)
  );
}

console.log("\nSTATIC — deactivate and reassign share one lock order");
const selfSrc = readRepo("scripts/check-deactivate-reassign-deadlock.mjs");
const teamSrc = readRepo("src/app/actions/team.ts");
const activeOpsSrc = readRepo("src/lib/team-member-active-ops.ts");
const assignOpsSrc = readRepo("src/lib/job-assignment-ops.ts");
const membershipSrc = readRepo("src/lib/exact-active-membership.ts");
const timeCardOpsSrc = readRepo("src/lib/time-card-ops.ts");
const writeAssignSrc = assignOpsSrc.slice(
  assignOpsSrc.indexOf("export async function writeAssignedMembershipAndLaneWindows"),
);
const applyAssignSrc = assignOpsSrc.slice(
  assignOpsSrc.indexOf("export async function applyAssignedMembershipChangeInTransaction"),
);
const writeActiveSrc = activeOpsSrc.slice(
  activeOpsSrc.indexOf("export async function writeTeamMemberActive"),
);

check(
  "Verifier reuses the disposable harness and local-database guard",
  selfSrc.includes('from "./disposable-test-database.mjs"') &&
    selfSrc.includes("openDisposableTestDatabase") &&
    selfSrc.includes("assertLocalDatabaseUrl"),
);
check(
  "Both commit orders use a second-connection Membership hold and wait for ungranted locks",
  selfSrc.includes("waitForBlockedContenders") &&
    selfSrc.includes("createHoldRelease") &&
    selfSrc.includes('SELECT id FROM "Membership"') &&
    selfSrc.includes("FOR UPDATE") &&
    selfSrc.includes("deactivate-first") &&
    selfSrc.includes("reassign-first"),
);
check(
  "setTeamMemberActive delegates to the shared write, not a parallel deactivate path",
  teamSrc.includes("writeTeamMemberActive") &&
    !teamSrc.includes("closeRunningTimeForMembershipInTransaction") &&
    !/SELECT id FROM "Membership"/.test(teamSrc),
);
check(
  "Deactivate lock order is reservation, then Jobs, then Memberships, then close time",
  writeActiveSrc.includes("lockBusinessScheduleReservation") &&
    writeActiveSrc.includes("lockJobsForMembershipClockClose") &&
    writeActiveSrc.includes("lockTenantOwnedMemberships") &&
    writeActiveSrc.indexOf("lockBusinessScheduleReservation") <
      writeActiveSrc.indexOf("lockJobsForMembershipClockClose") &&
    writeActiveSrc.indexOf("lockJobsForMembershipClockClose") <
      writeActiveSrc.indexOf("lockTenantOwnedMemberships") &&
    writeActiveSrc.indexOf("lockTenantOwnedMemberships") <
      writeActiveSrc.indexOf("closeRunningTimeForMembershipInTransaction"),
);
check(
  "Reassign lock order is reservation, then Job, then Memberships, then close time",
  writeAssignSrc.indexOf("lockBusinessScheduleReservation") >= 0 &&
    writeAssignSrc.indexOf("lockTenantOwnedJob") >
      writeAssignSrc.indexOf("lockBusinessScheduleReservation") &&
    applyAssignSrc.indexOf("lockTenantOwnedMemberships") >= 0 &&
    applyAssignSrc.indexOf("lockTenantOwnedMemberships") <
      applyAssignSrc.indexOf("assignedMembershipId: nextAssignee") &&
    applyAssignSrc.indexOf("assignedMembershipId: nextAssignee") <
      applyAssignSrc.indexOf("stopRunningAssignedJobTimeInTransaction"),
);
check(
  "Membership locks are taken in sorted id order after Job locks",
  membershipSrc.includes("lockTenantOwnedMemberships") &&
    membershipSrc.includes("].sort()") &&
    timeCardOpsSrc.includes("lockJobsForMembershipClockClose") &&
    timeCardOpsSrc.includes("].sort()"),
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "deactivate-reassign-deadlock disposable database");

const session = await openDisposableTestDatabase({
  databaseUrl: baseUrl,
  namePrefix: "tbbt_deact_reassign_deadlock",
  setProcessEnv: true,
});

/** @type {import("@prisma/client").PrismaClient | undefined} */
let locker;
/** @type {import("@prisma/client").PrismaClient | undefined} */
let observer;

try {
  const { writeTeamMemberActive } = await import("@/lib/team-member-active-ops");
  const { writeAssignedMembershipAndLaneWindows } = await import(
    "@/lib/job-assignment-ops"
  );
  const { prisma } = await import("@/lib/prisma");
  const { PrismaClient } = await import("@prisma/client");
  locker = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  observer = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });

  async function seedClockedInWorker(label) {
    const suffix = `${label}-${randomUUID().slice(0, 8)}`;
    const business = await prisma.business.create({
      data: {
        name: `Deadlock ${label}`,
        slug: `deadlock-${suffix}`,
        tradeCode: "HANDYMAN",
        timezone: "America/New_York",
      },
    });
    const deactivateOwnerUser = await prisma.user.create({
      data: {
        name: `Deactivate Owner ${label}`,
        email: `deact-owner-${suffix}@example.com`,
        passwordHash: "x",
      },
    });
    const reassignOwnerUser = await prisma.user.create({
      data: {
        name: `Reassign Owner ${label}`,
        email: `reassign-owner-${suffix}@example.com`,
        passwordHash: "x",
      },
    });
    const workerUser = await prisma.user.create({
      data: {
        name: `Clocked Worker ${label}`,
        email: `worker-${suffix}@example.com`,
        passwordHash: "x",
      },
    });
    const replacementUser = await prisma.user.create({
      data: {
        name: `Replacement ${label}`,
        email: `replacement-${suffix}@example.com`,
        passwordHash: "x",
      },
    });
    const deactivateOwner = await prisma.membership.create({
      data: {
        userId: deactivateOwnerUser.id,
        businessId: business.id,
        role: "OWNER",
      },
    });
    const reassignOwner = await prisma.membership.create({
      data: {
        userId: reassignOwnerUser.id,
        businessId: business.id,
        role: "OWNER",
      },
    });
    const worker = await prisma.membership.create({
      data: { userId: workerUser.id, businessId: business.id, role: "MEMBER" },
    });
    const replacement = await prisma.membership.create({
      data: {
        userId: replacementUser.id,
        businessId: business.id,
        role: "MEMBER",
      },
    });
    const customer = await prisma.customer.create({
      data: { businessId: business.id, name: `Customer ${label}` },
    });
    const startedAt = new Date(Date.now() - 3_600_000);
    const completedStartedAt = new Date(Date.now() - 86_400_000);
    const job = await prisma.job.create({
      data: {
        businessId: business.id,
        customerId: customer.id,
        projectToken: randomUUID(),
        status: "IN_PROGRESS",
        scheduledAt: startedAt,
        assignedMembershipId: worker.id,
      },
    });
    await prisma.timeEntry.create({
      data: {
        businessId: business.id,
        membershipId: worker.id,
        jobId: job.id,
        activityType: "JOB",
        status: "RUNNING",
        startedAt,
        endedAt: null,
        source: "CLOCK",
      },
    });
    const completedJob = await prisma.job.create({
      data: {
        businessId: business.id,
        customerId: customer.id,
        projectToken: randomUUID(),
        status: "COMPLETED",
        scheduledAt: completedStartedAt,
        assignedMembershipId: worker.id,
      },
    });
    await prisma.timeEntry.create({
      data: {
        businessId: business.id,
        membershipId: worker.id,
        jobId: completedJob.id,
        activityType: "JOB",
        status: "RUNNING",
        startedAt: completedStartedAt,
        endedAt: null,
        source: "CLOCK",
      },
    });
    return {
      business,
      deactivateOwner,
      reassignOwner,
      worker,
      replacement,
      job,
      completedJob,
    };
  }

  async function runningFacts(fixture) {
    const workerRunning = await prisma.timeEntry.count({
      where: {
        businessId: fixture.business.id,
        membershipId: fixture.worker.id,
        status: "RUNNING",
        endedAt: null,
      },
    });
    const nonAssigneeRunning = await prisma.timeEntry.count({
      where: {
        businessId: fixture.business.id,
        jobId: fixture.job.id,
        activityType: "JOB",
        status: "RUNNING",
        endedAt: null,
        membershipId: { not: fixture.replacement.id },
      },
    });
    const completedRunning = await prisma.timeEntry.count({
      where: {
        businessId: fixture.business.id,
        jobId: fixture.completedJob.id,
        status: "RUNNING",
        endedAt: null,
      },
    });
    const membership = await prisma.membership.findFirst({
      where: { id: fixture.worker.id, businessId: fixture.business.id },
      select: { active: true },
    });
    const job = await prisma.job.findFirst({
      where: { id: fixture.job.id, businessId: fixture.business.id },
      select: { assignedMembershipId: true, status: true },
    });
    return {
      workerRunning,
      nonAssigneeRunning,
      completedRunning,
      workerActive: membership?.active,
      assignedMembershipId: job?.assignedMembershipId,
    };
  }

  function outcomeInvariant(facts, fixture) {
    return (
      facts.workerActive === false &&
      facts.workerRunning === 0 &&
      facts.nonAssigneeRunning === 0 &&
      facts.completedRunning === 0 &&
      facts.assignedMembershipId === fixture.replacement.id
    );
  }

  async function runBarrierOrder(label, queueFirst) {
    const fixture = await seedClockedInWorker(label);
    const hold = createHoldRelease();
    const holdTx = locker.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT id FROM "Membership"
          WHERE id = ${fixture.worker.id}
            AND "businessId" = ${fixture.business.id}
          FOR UPDATE
        `;
        hold.signalAcquired();
        await hold.released;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    await hold.acquired;

    const deactivate = () =>
      writeTeamMemberActive(prisma, {
        businessId: fixture.business.id,
        membershipId: fixture.worker.id,
        actorMembershipId: fixture.deactivateOwner.id,
        active: false,
      });
    const reassign = () =>
      writeAssignedMembershipAndLaneWindows(prisma, {
        businessId: fixture.business.id,
        job: {
          id: fixture.job.id,
          scheduledAt: fixture.job.scheduledAt,
          assignedMembershipId: fixture.worker.id,
          status: "IN_PROGRESS",
        },
        nextAssignedMembershipId: fixture.replacement.id,
        actorMembershipId: fixture.reassignOwner.id,
      });

    const first =
      queueFirst === "deactivate"
        ? deactivate()
        : reassign();
    await waitForBlockedContenders(observer, 1);
    const second =
      queueFirst === "deactivate"
        ? reassign()
        : deactivate();
    await waitForBlockedContenders(observer, 2);
    hold.release();
    const settled = await Promise.allSettled([first, second, holdTx]);
    const deadlock = settled.some(
      (result) =>
        result.status === "rejected" && isPostgresDeadlock(result.reason),
    );
    const writeRejected = settled
      .slice(0, 2)
      .filter((result) => result.status === "rejected");
    const writeErrors = settled
      .slice(0, 2)
      .filter(
        (result) =>
          result.status === "fulfilled" && result.value && result.value.error,
      );
    const facts = await runningFacts(fixture);
    return {
      fixture,
      deadlock,
      writeRejected,
      writeErrors,
      facts,
      settled,
    };
  }

  console.log("\nBEHAVIOR — deactivate-first two-connection barrier");
  const deactivateFirst = await runBarrierOrder("deactivate-first", "deactivate");
  check(
    "Deactivate-first barrier does not raise 40P01",
    deactivateFirst.deadlock === false &&
      deactivateFirst.writeRejected.length === 0,
  );
  if (deactivateFirst.writeRejected.length > 0) {
    console.error("  deactivate-first reject:", deactivateFirst.writeRejected[0].reason);
  }
  if (deactivateFirst.writeErrors.length > 0) {
    console.error("  deactivate-first write error:", deactivateFirst.writeErrors[0].value);
  }
  check(
    "Deactivate-first leaves no RUNNING time for an inactive worker, non-assignee, or completed job",
    outcomeInvariant(deactivateFirst.facts, deactivateFirst.fixture),
  );

  console.log("\nBEHAVIOR — reassign-first two-connection barrier");
  const reassignFirst = await runBarrierOrder("reassign-first", "reassign");
  check(
    "Reassign-first barrier does not raise 40P01",
    reassignFirst.deadlock === false && reassignFirst.writeRejected.length === 0,
  );
  if (reassignFirst.writeRejected.length > 0) {
    console.error("  reassign-first reject:", reassignFirst.writeRejected[0].reason);
  }
  if (reassignFirst.writeErrors.length > 0) {
    console.error("  reassign-first write error:", reassignFirst.writeErrors[0].value);
  }
  check(
    "Reassign-first leaves no RUNNING time for an inactive worker, non-assignee, or completed job",
    outcomeInvariant(reassignFirst.facts, reassignFirst.fixture),
  );

  console.log("\nMUTATION — flipping any leftover RUNNING fact fails the invariant");
  check(
    "Invariant refuses leftover RUNNING on the inactive worker",
    !outcomeInvariant(
      { ...deactivateFirst.facts, workerRunning: 1 },
      deactivateFirst.fixture,
    ),
  );
  check(
    "Invariant refuses leftover RUNNING for a non-assignee",
    !outcomeInvariant(
      { ...reassignFirst.facts, nonAssigneeRunning: 1 },
      reassignFirst.fixture,
    ),
  );
  check(
    "Invariant refuses leftover RUNNING on the completed job",
    !outcomeInvariant(
      { ...reassignFirst.facts, completedRunning: 1 },
      reassignFirst.fixture,
    ),
  );
} finally {
  await locker?.$disconnect();
  await observer?.$disconnect();
  await session.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
