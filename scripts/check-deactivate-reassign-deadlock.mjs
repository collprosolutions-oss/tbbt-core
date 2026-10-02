/**
 * OWNER deactivate vs OWNER reassign must not 40P01, and worker
 * clock-in must use the same Job-then-Membership order so it cannot
 * deadlock against either writer. Both deactivate/reassign commit
 * orders must leave no RUNNING time for an inactive worker, a
 * non-assignee, or a completed job.
 *
 * Real two-connection races: same-OWNER deactivate vs reassign (the
 * main 40P01), deactivate vs clock-in, and reassign vs clock-in.
 * Behavioral source mutations prove the reservation lock, Job locks,
 * reassign Membership locks, and id sorting. Does not invent a new
 * workflow.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-deactivate-reassign-deadlock.mjs
 */
import { register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

async function expectBlocked(observer, label) {
  try {
    await waitForBlockedContenders(observer, 1);
    check(label, true);
    return true;
  } catch (error) {
    check(label, false);
    console.error(`  ${label}:`, error.message);
    return false;
  }
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

function makeAccess(businessId, role, membershipId, timezone = "America/New_York") {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      business: { id: businessId, timezone },
    },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

function writesClean(settled, count = 2) {
  const slice = settled.slice(0, count);
  const deadlock = slice.some(
    (result) => result.status === "rejected" && isPostgresDeadlock(result.reason),
  );
  const writeRejected = slice.filter((result) => result.status === "rejected");
  return { deadlock, writeRejected };
}

console.log("\nSTATIC — verifier uses production writers and the disposable harness");
const selfSrc = readRepo("scripts/check-deactivate-reassign-deadlock.mjs");
check(
  "Verifier reuses the disposable harness and local-database guard",
  selfSrc.includes('from "./disposable-test-database.mjs"') &&
    selfSrc.includes("openDisposableTestDatabase") &&
    selfSrc.includes("assertLocalDatabaseUrl"),
);
check(
  "Races are two-connection barriers on the real writers",
  selfSrc.includes("waitForBlockedContenders") &&
    selfSrc.includes("createHoldRelease") &&
    selfSrc.includes("afterJobLocked") &&
    selfSrc.includes("afterJobsBeforeMembership") &&
    selfSrc.includes("clockInTime") &&
    selfSrc.includes("writeTeamMemberActive") &&
    selfSrc.includes("writeAssignedMembershipAndLaneWindows"),
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
  const { clockInTime } = await import("@/lib/time-card-ops");
  const { lockTenantOwnedMemberships } = await import(
    "@/lib/exact-active-membership"
  );
  const { lockBusinessScheduleReservation } = await import(
    "@/lib/schedule-reservation"
  );
  const { prisma } = await import("@/lib/prisma");
  const { PrismaClient } = await import("@prisma/client");
  locker = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  observer = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });

  async function seedClockedInWorker(label, { clockedIn = true } = {}) {
    const suffix = `${label}-${randomUUID().slice(0, 8)}`;
    const business = await prisma.business.create({
      data: {
        name: `Deadlock ${label}`,
        slug: `deadlock-${suffix}`,
        tradeCode: "HANDYMAN",
        timezone: "America/New_York",
      },
    });
    const ownerUser = await prisma.user.create({
      data: {
        name: `Owner ${label}`,
        email: `owner-${suffix}@example.com`,
        passwordHash: "x",
      },
    });
    const workerUser = await prisma.user.create({
      data: {
        name: `Worker ${label}`,
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
    const owner = await prisma.membership.create({
      data: { userId: ownerUser.id, businessId: business.id, role: "OWNER" },
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
    if (clockedIn) {
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
    }
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
      owner,
      worker,
      replacement,
      job,
      completedJob,
      memberAccess: makeAccess(business.id, "MEMBER", worker.id),
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

  function deactivate(fixture) {
    return writeTeamMemberActive(prisma, {
      businessId: fixture.business.id,
      membershipId: fixture.worker.id,
      actorMembershipId: fixture.owner.id,
      active: false,
    });
  }

  function reassign(fixture, afterJobLocked) {
    return writeAssignedMembershipAndLaneWindows(prisma, {
      businessId: fixture.business.id,
      job: {
        id: fixture.job.id,
        scheduledAt: fixture.job.scheduledAt,
        assignedMembershipId: fixture.worker.id,
        status: "IN_PROGRESS",
      },
      nextAssignedMembershipId: fixture.replacement.id,
      actorMembershipId: fixture.owner.id,
      afterJobLocked,
    });
  }

  function clockIn(fixture) {
    return clockInTime(prisma, fixture.memberAccess, {
      membershipId: fixture.worker.id,
      activityType: "JOB",
      jobId: fixture.job.id,
    });
  }

  console.log("\nBEHAVIOR — same-OWNER deactivate vs reassign (main 40P01)");
  {
    const fixture = await seedClockedInWorker("same-owner-reassign-first");
    const hold = createHoldRelease();
    const reassignP = reassign(fixture, async () => {
      hold.signalAcquired();
      await hold.released;
    });
    await hold.acquired;
    const deactivateP = deactivate(fixture);
    await expectBlocked(observer, "Deactivate waits while reassign holds the Job");
    hold.release();
    const settled = await Promise.allSettled([reassignP, deactivateP]);
    const { deadlock, writeRejected } = writesClean(settled);
    check(
      "Same-OWNER reassign-first (afterJobLocked) does not raise 40P01",
      deadlock === false && writeRejected.length === 0,
    );
    if (writeRejected.length > 0) {
      console.error("  same-owner reject:", writeRejected[0].reason);
    }
    const facts = await runningFacts(fixture);
    check(
      "Same-OWNER reassign-first leaves no RUNNING time for an inactive worker, non-assignee, or completed job",
      outcomeInvariant(facts, fixture),
    );

    console.log("\nMUTATION — flipping any leftover RUNNING fact fails the invariant");
    check(
      "Invariant refuses leftover RUNNING on the inactive worker",
      !outcomeInvariant({ ...facts, workerRunning: 1 }, fixture),
    );
    check(
      "Invariant refuses leftover RUNNING for a non-assignee",
      !outcomeInvariant({ ...facts, nonAssigneeRunning: 1 }, fixture),
    );
    check(
      "Invariant refuses leftover RUNNING on the completed job",
      !outcomeInvariant({ ...facts, completedRunning: 1 }, fixture),
    );
  }

  console.log("\nBEHAVIOR — same-OWNER deactivate-first vs reassign");
  {
    const fixture = await seedClockedInWorker("same-owner-deactivate-first");
    const hold = createHoldRelease();
    const deactivateP = writeTeamMemberActive(prisma, {
      businessId: fixture.business.id,
      membershipId: fixture.worker.id,
      actorMembershipId: fixture.owner.id,
      active: false,
      afterJobsBeforeMembership: async () => {
        hold.signalAcquired();
        await hold.released;
      },
    });
    await hold.acquired;
    const reassignP = reassign(fixture);
    await expectBlocked(observer, "Reassign waits while deactivate holds Jobs");
    hold.release();
    const settled = await Promise.allSettled([deactivateP, reassignP]);
    const { deadlock, writeRejected } = writesClean(settled);
    check(
      "Same-OWNER deactivate-first (afterJobsBeforeMembership) does not raise 40P01",
      deadlock === false && writeRejected.length === 0,
    );
    if (writeRejected.length > 0) {
      console.error("  deactivate-first reject:", writeRejected[0].reason);
    }
    check(
      "Same-OWNER deactivate-first leaves no RUNNING time for an inactive worker, non-assignee, or completed job",
      outcomeInvariant(await runningFacts(fixture), fixture),
    );
  }

  console.log("\nBEHAVIOR — deactivate vs worker clock-in");
  {
    const fixture = await seedClockedInWorker("clock-in-vs-deactivate", {
      clockedIn: false,
    });
    const hold = createHoldRelease();
    const deactivateP = writeTeamMemberActive(prisma, {
      businessId: fixture.business.id,
      membershipId: fixture.worker.id,
      actorMembershipId: fixture.owner.id,
      active: false,
      afterJobsBeforeMembership: async () => {
        hold.signalAcquired();
        await hold.released;
      },
    });
    await hold.acquired;
    const clockP = clockIn(fixture);
    await expectBlocked(observer, "Clock-in waits while deactivate holds the Job");
    hold.release();
    const settled = await Promise.allSettled([deactivateP, clockP]);
    const { deadlock } = writesClean(settled);
    const deactivateRejected =
      settled[0].status === "rejected" && !isPostgresDeadlock(settled[0].reason);
    check(
      "Deactivate vs clock-in (afterJobsBeforeMembership) does not raise 40P01",
      deadlock === false && deactivateRejected === false,
    );
    if (deadlock) {
      const reason = settled.find(
        (result) => result.status === "rejected" && isPostgresDeadlock(result.reason),
      )?.reason;
      console.error("  clock-in vs deactivate deadlock:", reason);
    }
  }

  console.log("\nBEHAVIOR — reassign vs previous-assignee clock-in");
  {
    const fixture = await seedClockedInWorker("clock-in-vs-reassign", {
      clockedIn: false,
    });
    const hold = createHoldRelease();
    const reassignP = reassign(fixture, async () => {
      hold.signalAcquired();
      await hold.released;
    });
    await hold.acquired;
    const clockP = clockIn(fixture);
    await expectBlocked(observer, "Clock-in waits while reassign holds the Job");
    hold.release();
    const settled = await Promise.allSettled([reassignP, clockP]);
    const { deadlock } = writesClean(settled);
    const reassignRejected =
      settled[0].status === "rejected" && !isPostgresDeadlock(settled[0].reason);
    check(
      "Reassign vs clock-in (afterJobLocked) does not raise 40P01",
      deadlock === false && reassignRejected === false,
    );
    if (deadlock) {
      const reason = settled.find(
        (result) => result.status === "rejected" && isPostgresDeadlock(result.reason),
      )?.reason;
      console.error("  clock-in vs reassign deadlock:", reason);
    }
  }

  console.log("\nBEHAVIOR — reservation lock-wait");
  {
    const fixture = await seedClockedInWorker("reservation-wait");
    const hold = createHoldRelease();
    const holdTx = locker.$transaction(
      async (tx) => {
        await lockBusinessScheduleReservation(tx, fixture.business.id);
        hold.signalAcquired();
        await hold.released;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    await hold.acquired;
    const deactivateP = deactivate(fixture);
    await expectBlocked(observer, "Deactivate waits on a held schedule-reservation lock");
    hold.release();
    const settled = await Promise.allSettled([deactivateP, holdTx]);
    const { deadlock, writeRejected } = writesClean(settled, 1);
    check(
      "Deactivate completes after the reservation is released",
      deadlock === false && writeRejected.length === 0,
    );
  }

  console.log("\nBEHAVIOR — reassign waits on previous-assignee Membership after Job");
  {
    const fixture = await seedClockedInWorker("reassign-membership-wait");
    const hold = createHoldRelease();
    const holdTx = locker.$transaction(
      async (tx) => {
        await lockTenantOwnedMemberships(tx, fixture.business.id, [
          fixture.worker.id,
        ]);
        hold.signalAcquired();
        await hold.released;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    await hold.acquired;
    const jobLocked = createHoldRelease();
    const reassignP = reassign(fixture, async () => {
      jobLocked.signalAcquired();
    });
    await jobLocked.acquired;
    await expectBlocked(
      observer,
      "Reassign blocks on the previous assignee Membership after the Job lock",
    );
    hold.release();
    const settled = await Promise.allSettled([reassignP, holdTx]);
    const { deadlock, writeRejected } = writesClean(settled, 1);
    check(
      "Reassign completes after the previous assignee Membership is released",
      deadlock === false && writeRejected.length === 0,
    );
  }

  console.log("\nBEHAVIOR — Membership id sorting");
  // Deactivate and reassign both take the schedule-reservation lock
  // first, so they never hold Membership locks at the same time.
  // End-to-end id sorting cannot be observed as a 40P01. Assert the
  // helper's lock order directly instead.
  {
    const fixture = await seedClockedInWorker("id-sort");
    const sortedIds = [
      fixture.owner.id,
      fixture.worker.id,
      fixture.replacement.id,
    ].sort();
    const reversedIds = [...sortedIds].reverse();
    const locked = await prisma.$transaction(
      async (tx) =>
        lockTenantOwnedMemberships(tx, fixture.business.id, reversedIds),
      { timeout: 20_000, maxWait: 10_000 },
    );
    check(
      "lockTenantOwnedMemberships locks Memberships in sorted id order",
      locked.map((row) => row.id).join(",") === sortedIds.join(","),
    );
  }
} catch (error) {
  failed += 1;
  console.error(error);
} finally {
  await locker?.$disconnect();
  await observer?.$disconnect();
  await session.cleanup();
}

if (!process.env.DEADLOCK_MUTATION_CHILD) {
  console.log(
    "\nMUTATION — revert each lock and require a failing child concurrency run",
  );
  const childScript = fileURLToPath(import.meta.url);
  const mutations = [
    {
      label: "reservation lock",
      file: "src/lib/team-member-active-ops.ts",
      search: "        await lockBusinessScheduleReservation(tx, input.businessId);\n",
      replace: "",
    },
    {
      label: "Job locks",
      file: "src/lib/team-member-active-ops.ts",
      search:
        "        const jobIds = await lockJobsForMembershipClockClose(\n          tx,\n          input.businessId,\n          input.membershipId,\n        );\n",
      replace: "        const jobIds = [];\n",
    },
    {
      label: "reassign Membership locks",
      file: "src/lib/job-assignment-ops.ts",
      search:
        "  await lockTenantOwnedMemberships(tx, input.businessId, [\n    previousAssignee,\n    nextAssignee,\n    input.actorMembershipId,\n  ]);\n",
      replace: "",
    },
    {
      label: "id sorting",
      file: "src/lib/exact-active-membership.ts",
      search:
        "  const ids = [\n    ...new Set(membershipIds.filter((id): id is string => Boolean(id))),\n  ].sort();\n",
      replace:
        "  const ids = [\n    ...new Set(membershipIds.filter((id): id is string => Boolean(id))),\n  ];\n",
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
      const child = spawnSync(
        process.execPath,
        ["--experimental-strip-types", childScript],
        {
          env: {
            ...process.env,
            DATABASE_URL: baseUrl,
            DEADLOCK_MUTATION_CHILD: "1",
          },
          encoding: "utf8",
          timeout: 180_000,
        },
      );
      const childFailed = child.status !== 0;
      check(`Mutation ${mutation.label} fails a real concurrency test`, childFailed);
      if (!childFailed) {
        console.error(child.stdout?.slice(-2000));
        console.error(child.stderr?.slice(-2000));
      }
    } finally {
      writeFileSync(target, original);
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
