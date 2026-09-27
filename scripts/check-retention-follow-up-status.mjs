/**
 * OWNER Done / Cancelled status proofs for origin: RETENTION_TASK.
 *
 * Authorization, same-business isolation, duplicate actions, and no
 * message or due event against a dedicated database. Done is never SENT.
 * COMMUNICATION follow-ups and automation send behavior stay untouched.
 *
 * Run with:
 *   npm run test:retention-follow-up-status
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for retention follow-up status checks.");
  process.exit(generateEarly.status ?? 1);
}

const { ForbiddenError } = await import("@/lib/authorization");
const { APP_NAV } = await import("@/lib/nav");
const { businessScope, assertBusinessRecord } = await import("@/lib/access-scope");
const {
  ensureDefaultAutomationRules,
  processPendingAutomationRuns,
  scanScheduledBusinessEvents,
} = await import("@/lib/automation");
const { CUSTOMER_FOLLOW_UP_ORIGINS } = await import("@/lib/customer-follow-up-origin");
const {
  CUSTOMER_FOLLOW_UP_STATUSES,
  RETENTION_FOLLOW_UP_CANCELLED_MESSAGE,
  RETENTION_FOLLOW_UP_DONE_MESSAGE,
  RETENTION_FOLLOW_UP_NOT_RESOLVABLE_MESSAGE,
  RETENTION_FOLLOW_UP_NOT_TASK_MESSAGE,
  RETENTION_FOLLOW_UP_SENT_NOT_DONE_MESSAGE,
  RETENTION_FOLLOW_UP_STATUS_UNCHANGED_MESSAGE,
  RETENTION_FOLLOW_UP_UNKNOWN_STATUS_MESSAGE,
  RETENTION_FOLLOW_UP_UNKNOWN_TASK_MESSAGE,
  RETENTION_OWNER_RESOLVE_FOLLOW_UP_MESSAGE,
  RETENTION_ROUTE,
  followUpStatusIsDeliveredRewrite,
  isRetentionFollowUpResolveStatus,
  loadRetentionRecoveryCenter,
  recordedFollowUpStatusLabel,
  recordRetentionFollowUpTask,
  resolveRetentionFollowUpTaskStatus,
  RetentionFollowUpError,
  retentionFollowUpWriteAllowed,
} = await import("@/lib/growth/retention");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function readSrc(relative) {
  return readFileSync(join(root, relative), "utf8");
}

const resolveSrc = readSrc("src/lib/growth/retention/resolve-follow-up.ts");
const actionSrc = readSrc("src/app/actions/retention.ts");
const uiSrc = readSrc("src/components/growth/retention/retention-center.tsx");
const pageSrc = readSrc("src/app/(app)/growth/retention/page.tsx");
const loadSrc = readSrc("src/lib/growth/retention/load.ts");
const navSrc = readSrc("src/lib/nav.ts");
const scanSrc = readSrc("src/lib/automation/scan.ts");
const processorSrc = readSrc("src/lib/automation/processor.ts");
const emailSrc = readSrc("src/lib/automation/email.ts");
const referralOpsSrc = readSrc("src/lib/referral-ops.ts");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_retention_follow_up_status_test";
const parsed = new URL(baseUrl);
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
  console.error("Failed to push schema for retention follow-up status test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });
await prisma.$executeRawUnsafe(`
  CREATE UNIQUE INDEX IF NOT EXISTS "CustomerFollowUp_retention_task_business_customer_job_key"
  ON "CustomerFollowUp"("businessId", "customerId", "jobId")
  WHERE "origin" = 'RETENTION_TASK' AND "jobId" IS NOT NULL
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

function daysAgo(days, now = new Date()) {
  return new Date(now.getTime() - days * 86_400_000);
}

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      business: { id: businessId, name: "Retention Status Co" },
    },
    scope: businessScope(businessId),
    assertOwned(record) {
      return assertBusinessRecord(record, businessId);
    },
    assertAttachable(record) {
      return assertBusinessRecord(record, businessId);
    },
  };
}

async function expectError(label, run, predicate) {
  try {
    await run();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

try {
  console.log("\nSTATIC — Done is not SENT, OWNER-only, no send, automation untouched");
  check("Dedicated route stays /growth/retention", RETENTION_ROUTE === "/growth/retention");
  check(
    "OWNER-only resolve gate",
    retentionFollowUpWriteAllowed("OWNER") === true &&
      retentionFollowUpWriteAllowed("ADMIN") === false &&
      retentionFollowUpWriteAllowed("MEMBER") === false,
  );
  check(
    "DONE is a recorded status and is not SENT",
    CUSTOMER_FOLLOW_UP_STATUSES.includes("DONE") &&
      recordedFollowUpStatusLabel("DONE") === "DONE" &&
      recordedFollowUpStatusLabel("DONE") !== "SENT" &&
      recordedFollowUpStatusLabel("SENT") === "SENT" &&
      followUpStatusIsDeliveredRewrite("DONE", recordedFollowUpStatusLabel("DONE")) === false &&
      isRetentionFollowUpResolveStatus("DONE") === true &&
      isRetentionFollowUpResolveStatus("CANCELLED") === true &&
      isRetentionFollowUpResolveStatus("SENT") === false &&
      isRetentionFollowUpResolveStatus("OPEN") === false,
  );
  check(
    "Owner copy does not send SMS or email",
    /does not send SMS or email/.test(RETENTION_OWNER_RESOLVE_FOLLOW_UP_MESSAGE) &&
      /has not been sent/.test(RETENTION_FOLLOW_UP_DONE_MESSAGE) &&
      /has not been sent/.test(RETENTION_FOLLOW_UP_CANCELLED_MESSAGE) &&
      /has not been sent/.test(RETENTION_FOLLOW_UP_STATUS_UNCHANGED_MESSAGE),
  );
  check(
    "Resolve path never writes SENT or sentAt",
    resolveSrc.includes('status: "DONE"') &&
      resolveSrc.includes('status: "CANCELLED"') &&
      !/status:\s*"SENT"/.test(resolveSrc) &&
      !/sentAt/.test(resolveSrc) &&
      !/lastEmailStatus|lastSmsStatus/.test(resolveSrc),
  );
  check(
    "DONE write always clears cancelledAt",
    /status:\s*"DONE"[\s\S]*cancelledAt:\s*null/.test(resolveSrc),
  );
  check(
    "Resolve path does not call send or communication helpers",
    !/createCustomerFollowUp|sendCustomerFollowUp|markCustomerFollowUpSentManually|cancelCustomerFollowUp|attemptJobFollowUpSms|attemptRepeatFollowUpSms|attemptOwnedCustomerEmail|emitAndProcessBusinessEvent|emitBusinessEvent/.test(
      resolveSrc,
    ) &&
      !/sendCustomerFollowUp|attemptJobFollowUpSms|emitAndProcessBusinessEvent/.test(actionSrc),
  );
  check(
    "COMMUNICATION cancel/send helpers stay in referral-ops",
    referralOpsSrc.includes("export async function cancelCustomerFollowUp") &&
      referralOpsSrc.includes("export async function sendCustomerFollowUp") &&
      referralOpsSrc.includes('status: "SENT"'),
  );
  check(
    "Automation scan and send still skip RETENTION_TASK only",
    scanSrc.includes("customerFollowUpDueScanWhere") &&
      processorSrc.includes("isRetentionFollowUpTask") &&
      emailSrc.includes("isRetentionFollowUpTask") &&
      !processorSrc.includes('status === "DONE"') &&
      !emailSrc.includes('status === "DONE"'),
  );
  check(
    "UI offers Done and Cancel for retention tasks, not Mark sent",
    uiSrc.includes("resolveRetentionFollowUpTaskStatusAction") &&
      uiSrc.includes("isRetentionFollowUpTask") &&
      uiSrc.includes('value="DONE"') &&
      uiSrc.includes('value="CANCELLED"') &&
      uiSrc.includes("Mark done") &&
      !/Mark sent|Send via connected|requestText|messageBody|lastEmailStatus|lastSmsStatus/.test(uiSrc),
  );
  check(
    "Page still uses management access and OWNER write gate",
    pageSrc.includes("requireManagementPageAccess()") &&
      pageSrc.includes("canResolveFollowUp") &&
      pageSrc.includes("retentionFollowUpWriteAllowed"),
  );
  check(
    "Global navigation is unchanged",
    APP_NAV.every((item) => item.href !== RETENTION_ROUTE) &&
      !navSrc.includes("/growth/retention") &&
      !navSrc.includes("Customer retention"),
  );
  check(
    "Loader stays mutation-free on page load",
    !/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/.test(loadSrc) &&
      /mutationsOnLoad: false/.test(loadSrc) &&
      loadSrc.includes("origin: true"),
  );

  const now = new Date("2026-09-27T18:00:00.000Z");
  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Status",
      slug: `alpha-status-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: "America/Los_Angeles",
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Status",
      slug: `beta-status-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: "America/New_York",
    },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia", email: `owner-status-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Ava", email: `admin-status-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia", email: `member-status-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Bea", email: `beta-status-${randomUUID()}@example.com`, passwordHash: "x" },
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
  const betaMem = await prisma.membership.create({
    data: { userId: betaUser.id, businessId: businessB.id, role: "OWNER" },
  });

  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaMem.id);

  const customer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Ada Homeowner" },
  });
  const cancelCustomer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Cara Cancel" },
  });
  const betaCustomer = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Secret" },
  });

  const completedJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
      createdAt: daysAgo(20, now),
    },
  });
  const cancelJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: cancelCustomer.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
      createdAt: daysAgo(18, now),
    },
  });
  const betaJob = await prisma.job.create({
    data: {
      businessId: businessB.id,
      customerId: betaCustomer.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
      createdAt: daysAgo(8, now),
    },
  });
  await prisma.businessEvent.create({
    data: {
      businessId: businessA.id,
      type: "JOB_COMPLETED",
      subjectType: "JOB",
      subjectId: completedJob.id,
      occurredAt: daysAgo(20, now),
      idempotencyKey: `JOB_COMPLETED:${completedJob.id}`,
    },
  });

  const created = await recordRetentionFollowUpTask(prisma, ownerA, {
    customerId: customer.id,
    jobId: completedJob.id,
    group: "NO_REVIEW_REQUEST",
  });
  const createdCancel = await recordRetentionFollowUpTask(prisma, ownerA, {
    customerId: cancelCustomer.id,
    jobId: cancelJob.id,
    group: "NO_REVIEW_REQUEST",
  });
  const betaTask = await recordRetentionFollowUpTask(prisma, ownerB, {
    customerId: betaCustomer.id,
    jobId: betaJob.id,
    group: "NO_REVIEW_REQUEST",
  });
  const communication = await prisma.customerFollowUp.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      jobId: completedJob.id,
      kind: "JOB_COMPLETE",
      status: "OPEN",
      origin: CUSTOMER_FOLLOW_UP_ORIGINS.COMMUNICATION,
      createdByMembershipId: ownerMem.id,
    },
  });
  const sentTask = await prisma.customerFollowUp.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      kind: "REPEAT",
      status: "SENT",
      origin: CUSTOMER_FOLLOW_UP_ORIGINS.RETENTION_TASK,
      sentAt: now,
      createdByMembershipId: ownerMem.id,
    },
  });
  const failedTask = await prisma.customerFollowUp.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      kind: "REPEAT",
      status: "FAILED",
      origin: CUSTOMER_FOLLOW_UP_ORIGINS.RETENTION_TASK,
      lastEmailStatus: "FAILED",
      createdByMembershipId: ownerMem.id,
    },
  });

  console.log("\nTEST — authorization");
  const authBefore = await prisma.customerFollowUp.findMany({
    where: { id: { in: [created.followUp.id, createdCancel.followUp.id] } },
    select: { id: true, status: true, updatedAt: true },
  });
  await expectError(
    "ADMIN cannot mark a retention task done",
    () =>
      resolveRetentionFollowUpTaskStatus(prisma, adminA, {
        followUpId: created.followUp.id,
        status: "DONE",
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot mark a retention task cancelled",
    () =>
      resolveRetentionFollowUpTaskStatus(prisma, memberA, {
        followUpId: createdCancel.followUp.id,
        status: "CANCELLED",
      }),
    (error) => error instanceof ForbiddenError,
  );
  const authAfter = await prisma.customerFollowUp.findMany({
    where: { id: { in: [created.followUp.id, createdCancel.followUp.id] } },
    select: { id: true, status: true, updatedAt: true },
  });
  check(
    "Unauthorized roles left recorded statuses unchanged",
    authAfter.every((row) => {
      const before = authBefore.find((item) => item.id === row.id);
      return before && row.status === "OPEN" && row.updatedAt.getTime() === before.updatedAt.getTime();
    }),
  );

  console.log("\nTEST — isolation");
  await expectError(
    "Foreign follow-up id is rejected",
    () =>
      resolveRetentionFollowUpTaskStatus(prisma, ownerA, {
        followUpId: betaTask.followUp.id,
        status: "DONE",
      }),
    (error) =>
      error instanceof RetentionFollowUpError && error.message === RETENTION_FOLLOW_UP_UNKNOWN_TASK_MESSAGE,
  );
  await expectError(
    "Beta owner cannot resolve an Alpha retention task",
    () =>
      resolveRetentionFollowUpTaskStatus(prisma, ownerB, {
        followUpId: created.followUp.id,
        status: "DONE",
      }),
    (error) =>
      error instanceof RetentionFollowUpError && error.message === RETENTION_FOLLOW_UP_UNKNOWN_TASK_MESSAGE,
  );
  await expectError(
    "COMMUNICATION follow-up cannot be marked done here",
    () =>
      resolveRetentionFollowUpTaskStatus(prisma, ownerA, {
        followUpId: communication.id,
        status: "DONE",
      }),
    (error) =>
      error instanceof RetentionFollowUpError && error.message === RETENTION_FOLLOW_UP_NOT_TASK_MESSAGE,
  );
  await expectError(
    "SENT retention task cannot be marked done",
    () =>
      resolveRetentionFollowUpTaskStatus(prisma, ownerA, {
        followUpId: sentTask.id,
        status: "DONE",
      }),
    (error) =>
      error instanceof RetentionFollowUpError && error.message === RETENTION_FOLLOW_UP_SENT_NOT_DONE_MESSAGE,
  );
  await expectError(
    "FAILED retention task cannot be rewritten here",
    () =>
      resolveRetentionFollowUpTaskStatus(prisma, ownerA, {
        followUpId: failedTask.id,
        status: "CANCELLED",
      }),
    (error) =>
      error instanceof RetentionFollowUpError &&
      error.message === RETENTION_FOLLOW_UP_NOT_RESOLVABLE_MESSAGE,
  );
  await expectError(
    "Unknown status is rejected",
    () =>
      resolveRetentionFollowUpTaskStatus(prisma, ownerA, {
        followUpId: created.followUp.id,
        status: "SENT",
      }),
    (error) =>
      error instanceof RetentionFollowUpError &&
      error.message === RETENTION_FOLLOW_UP_UNKNOWN_STATUS_MESSAGE,
  );
  const isolated = await prisma.customerFollowUp.findMany({
    where: {
      id: {
        in: [created.followUp.id, createdCancel.followUp.id, betaTask.followUp.id, communication.id, sentTask.id],
      },
    },
  });
  check(
    "Isolation failures left every compared row unchanged",
    isolated.find((row) => row.id === created.followUp.id)?.status === "OPEN" &&
      isolated.find((row) => row.id === createdCancel.followUp.id)?.status === "OPEN" &&
      isolated.find((row) => row.id === betaTask.followUp.id)?.status === "OPEN" &&
      isolated.find((row) => row.id === communication.id)?.status === "OPEN" &&
      isolated.find((row) => row.id === communication.id)?.origin ===
        CUSTOMER_FOLLOW_UP_ORIGINS.COMMUNICATION &&
      isolated.find((row) => row.id === sentTask.id)?.status === "SENT" &&
      isolated.find((row) => row.id === sentTask.id)?.sentAt != null,
  );

  console.log("\nTEST — OWNER Done, reload, and no send");
  const communicationsBefore = await prisma.customerCommunication.count({
    where: { businessId: businessA.id },
  });
  const dueEventsBefore = await prisma.businessEvent.count({
    where: { businessId: businessA.id, type: "CUSTOMER_FOLLOW_UP_DUE" },
  });
  const markedDone = await resolveRetentionFollowUpTaskStatus(prisma, ownerA, {
    followUpId: created.followUp.id,
    status: "DONE",
  });
  const doneRow = await prisma.customerFollowUp.findUniqueOrThrow({
    where: { id: created.followUp.id },
  });
  check(
    "OWNER Done writes DONE and never SENT",
    markedDone.outcome === "UPDATED" &&
      markedDone.followUp.id === created.followUp.id &&
      markedDone.followUp.status === "DONE" &&
      markedDone.followUp.status !== "SENT" &&
      markedDone.followUp.origin === CUSTOMER_FOLLOW_UP_ORIGINS.RETENTION_TASK &&
      doneRow.status === "DONE" &&
      doneRow.status !== "SENT" &&
      doneRow.sentAt == null &&
      doneRow.lastEmailStatus == null &&
      doneRow.lastSmsStatus == null &&
      doneRow.cancelledAt == null,
  );

  const reloaded = await loadRetentionRecoveryCenter(prisma, {
    businessId: businessA.id,
    role: "OWNER",
    now,
  });
  const recordedDone = reloaded.groups.recordedFollowUp.find((row) => row.followUpId === created.followUp.id);
  const candidate = reloaded.groups.noReviewRequest.find((row) => row.lastCompletedJobId === completedJob.id);
  check(
    "Reload shows the recorded DONE status",
    recordedDone?.status === "DONE" &&
      recordedDone.statusLabel === "DONE" &&
      recordedDone.statusLabel !== "SENT" &&
      recordedDone.origin === CUSTOMER_FOLLOW_UP_ORIGINS.RETENTION_TASK &&
      candidate?.lastFollowUpStatus === "DONE" &&
      candidate.lastFollowUpKind === "JOB_COMPLETE",
  );
  check(
    "Done did not send a message or emit a due event",
    (await prisma.customerCommunication.count({ where: { businessId: businessA.id } })) ===
      communicationsBefore &&
      (await prisma.businessEvent.count({
        where: { businessId: businessA.id, type: "CUSTOMER_FOLLOW_UP_DUE" },
      })) === dueEventsBefore &&
      (await prisma.customerCommunication.count({
        where: { businessId: businessA.id, relatedType: "CUSTOMER_FOLLOW_UP", relatedId: created.followUp.id },
      })) === 0,
  );

  console.log("\nTEST — duplicate Done and Cancelled");
  const doneAgain = await resolveRetentionFollowUpTaskStatus(prisma, ownerA, {
    followUpId: created.followUp.id,
    status: "DONE",
  });
  check(
    "Duplicate Done is idempotent and still not SENT",
    doneAgain.outcome === "UNCHANGED" &&
      doneAgain.followUp.id === created.followUp.id &&
      doneAgain.followUp.status === "DONE" &&
      doneAgain.followUp.status !== "SENT" &&
      (await prisma.customerFollowUp.count({
        where: {
          businessId: businessA.id,
          customerId: customer.id,
          jobId: completedJob.id,
          origin: CUSTOMER_FOLLOW_UP_ORIGINS.RETENTION_TASK,
        },
      })) === 1,
  );

  const markedCancelled = await resolveRetentionFollowUpTaskStatus(prisma, ownerA, {
    followUpId: createdCancel.followUp.id,
    status: "CANCELLED",
  });
  const cancelledRow = await prisma.customerFollowUp.findUniqueOrThrow({
    where: { id: createdCancel.followUp.id },
  });
  check(
    "OWNER Cancelled writes CANCELLED without sending",
    markedCancelled.outcome === "UPDATED" &&
      markedCancelled.followUp.status === "CANCELLED" &&
      cancelledRow.status === "CANCELLED" &&
      cancelledRow.status !== "SENT" &&
      cancelledRow.cancelledAt != null &&
      cancelledRow.sentAt == null,
  );
  const cancelledAgain = await resolveRetentionFollowUpTaskStatus(prisma, ownerA, {
    followUpId: createdCancel.followUp.id,
    status: "CANCELLED",
  });
  const cancelledRowAgain = await prisma.customerFollowUp.findUniqueOrThrow({
    where: { id: createdCancel.followUp.id },
  });
  check(
    "Duplicate Cancelled is idempotent",
    cancelledAgain.outcome === "UNCHANGED" &&
      cancelledAgain.followUp.status === "CANCELLED" &&
      cancelledRowAgain.cancelledAt?.getTime() === cancelledRow.cancelledAt?.getTime(),
  );
  const cancelledReload = await loadRetentionRecoveryCenter(prisma, {
    businessId: businessA.id,
    role: "OWNER",
    customerId: cancelCustomer.id,
    now,
  });
  check(
    "Reload shows the recorded CANCELLED status",
    cancelledReload.groups.recordedFollowUp.some(
      (row) =>
        row.followUpId === createdCancel.followUp.id &&
        row.status === "CANCELLED" &&
        row.statusLabel === "CANCELLED",
    ),
  );

  console.log("\nTEST — Cancelled to Done clears cancelledAt");
  const reopenCustomer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Dana Reopen" },
  });
  const reopenJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: reopenCustomer.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
      createdAt: daysAgo(14, now),
    },
  });
  const reopenCreated = await recordRetentionFollowUpTask(prisma, ownerA, {
    customerId: reopenCustomer.id,
    jobId: reopenJob.id,
    group: "NO_REVIEW_REQUEST",
  });
  const reopenCancelled = await resolveRetentionFollowUpTaskStatus(prisma, ownerA, {
    followUpId: reopenCreated.followUp.id,
    status: "CANCELLED",
  });
  const reopenCancelledRow = await prisma.customerFollowUp.findUniqueOrThrow({
    where: { id: reopenCreated.followUp.id },
  });
  check(
    "Fixture starts CANCELLED with cancelledAt set",
    reopenCancelled.followUp.status === "CANCELLED" &&
      reopenCancelledRow.cancelledAt != null &&
      reopenCancelledRow.sentAt == null,
  );
  const commsBeforeReopen = await prisma.customerCommunication.count({
    where: { businessId: businessA.id },
  });
  const dueBeforeReopen = await prisma.businessEvent.count({
    where: { businessId: businessA.id, type: "CUSTOMER_FOLLOW_UP_DUE" },
  });
  const reopenedDone = await resolveRetentionFollowUpTaskStatus(prisma, ownerA, {
    followUpId: reopenCreated.followUp.id,
    status: "DONE",
  });
  const reopenedRow = await prisma.customerFollowUp.findUniqueOrThrow({
    where: { id: reopenCreated.followUp.id },
  });
  check(
    "Cancelled to Done writes DONE without retaining cancelledAt or SENT",
    reopenedDone.outcome === "UPDATED" &&
      reopenedDone.followUp.id === reopenCreated.followUp.id &&
      reopenedDone.followUp.status === "DONE" &&
      reopenedDone.followUp.status !== "SENT" &&
      reopenedRow.status === "DONE" &&
      reopenedRow.cancelledAt == null &&
      reopenedRow.sentAt == null &&
      reopenedRow.lastEmailStatus == null &&
      reopenedRow.lastSmsStatus == null,
  );
  const reopenReload = await loadRetentionRecoveryCenter(prisma, {
    businessId: businessA.id,
    role: "OWNER",
    customerId: reopenCustomer.id,
    now,
  });
  check(
    "Reload after Cancelled to Done shows DONE with no cancelled leftover",
    reopenReload.groups.recordedFollowUp.some(
      (row) =>
        row.followUpId === reopenCreated.followUp.id &&
        row.status === "DONE" &&
        row.statusLabel === "DONE" &&
        row.statusLabel !== "SENT",
    ) && reopenedRow.cancelledAt == null,
  );
  check(
    "Cancelled to Done did not send a message or emit a due event",
    (await prisma.customerCommunication.count({ where: { businessId: businessA.id } })) ===
      commsBeforeReopen &&
      (await prisma.businessEvent.count({
        where: { businessId: businessA.id, type: "CUSTOMER_FOLLOW_UP_DUE" },
      })) === dueBeforeReopen,
  );

  const communicationAfter = await prisma.customerFollowUp.findUniqueOrThrow({
    where: { id: communication.id },
  });
  check(
    "COMMUNICATION follow-up is still OPEN and untouched",
    communicationAfter.status === "OPEN" &&
      communicationAfter.origin === CUSTOMER_FOLLOW_UP_ORIGINS.COMMUNICATION &&
      communicationAfter.sentAt == null &&
      communicationAfter.cancelledAt == null,
  );

  console.log("\nTEST — enabled-rule scan still skips retention tasks");
  await ensureDefaultAutomationRules(prisma, businessA.id);
  const jobFollowRule = await prisma.automationRule.findFirst({
    where: { businessId: businessA.id, eventType: "CUSTOMER_FOLLOW_UP_DUE", purpose: "JOB_FOLLOW_UP" },
  });
  const repeatFollowRule = await prisma.automationRule.findFirst({
    where: { businessId: businessA.id, eventType: "CUSTOMER_FOLLOW_UP_DUE", purpose: "REPEAT_FOLLOW_UP" },
  });
  await prisma.automationRule.update({
    where: { id: jobFollowRule.id },
    data: { enabled: true, channel: "SMS", kind: "COMMUNICATION", delayMinutes: 0 },
  });
  await prisma.automationRule.update({
    where: { id: repeatFollowRule.id },
    data: { enabled: true, channel: "SMS", kind: "COMMUNICATION", delayMinutes: 0 },
  });
  const commBeforeScan = await prisma.customerCommunication.count({
    where: { businessId: businessA.id },
  });
  await scanScheduledBusinessEvents(prisma, businessA.id);
  const dueAfterScan = await prisma.businessEvent.findMany({
    where: { businessId: businessA.id, type: "CUSTOMER_FOLLOW_UP_DUE" },
    select: { subjectId: true },
  });
  check(
    "Enabled-rule scan does not emit a due event for Done or Cancelled retention tasks",
    !dueAfterScan.some((row) => row.subjectId === created.followUp.id) &&
      !dueAfterScan.some((row) => row.subjectId === createdCancel.followUp.id) &&
      dueAfterScan.some((row) => row.subjectId === communication.id),
  );
  await processPendingAutomationRuns(prisma, businessA.id);
  const doneAfterScan = await prisma.customerFollowUp.findUniqueOrThrow({
    where: { id: created.followUp.id },
  });
  const cancelledAfterScan = await prisma.customerFollowUp.findUniqueOrThrow({
    where: { id: createdCancel.followUp.id },
  });
  check(
    "Enabled-rule processing does not send Done or Cancelled retention tasks",
    doneAfterScan.status === "DONE" &&
      doneAfterScan.sentAt == null &&
      cancelledAfterScan.status === "CANCELLED" &&
      cancelledAfterScan.sentAt == null &&
      (await prisma.customerCommunication.count({
        where: { businessId: businessA.id, relatedType: "CUSTOMER_FOLLOW_UP", relatedId: created.followUp.id },
      })) === 0 &&
      (await prisma.customerCommunication.count({ where: { businessId: businessA.id } })) >= commBeforeScan,
  );

  const concurrentCustomer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Concurrent Cam" },
  });
  const concurrentJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: concurrentCustomer.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
      createdAt: daysAgo(11, now),
    },
  });
  const concurrentCreated = await recordRetentionFollowUpTask(prisma, ownerA, {
    customerId: concurrentCustomer.id,
    jobId: concurrentJob.id,
    group: "NO_REVIEW_REQUEST",
  });
  const concurrentResults = await Promise.all([
    resolveRetentionFollowUpTaskStatus(prisma, ownerA, {
      followUpId: concurrentCreated.followUp.id,
      status: "DONE",
    }),
    resolveRetentionFollowUpTaskStatus(prisma, ownerA, {
      followUpId: concurrentCreated.followUp.id,
      status: "DONE",
    }),
    resolveRetentionFollowUpTaskStatus(prisma, ownerA, {
      followUpId: concurrentCreated.followUp.id,
      status: "DONE",
    }),
  ]);
  const concurrentRow = await prisma.customerFollowUp.findUniqueOrThrow({
    where: { id: concurrentCreated.followUp.id },
  });
  check(
    "Simultaneous Done actions leave one DONE row and no SENT rewrite",
    concurrentResults.every((row) => row.followUp.id === concurrentCreated.followUp.id) &&
      concurrentResults.every((row) => row.followUp.status === "DONE") &&
      concurrentRow.status === "DONE" &&
      concurrentRow.status !== "SENT" &&
      concurrentRow.sentAt == null &&
      (await prisma.customerFollowUp.count({
        where: {
          businessId: businessA.id,
          customerId: concurrentCustomer.id,
          jobId: concurrentJob.id,
          origin: CUSTOMER_FOLLOW_UP_ORIGINS.RETENTION_TASK,
        },
      })) === 1,
  );

  const followCountBeforeLoad = await prisma.customerFollowUp.count({ where: { businessId: businessA.id } });
  await loadRetentionRecoveryCenter(prisma, { businessId: businessA.id, role: "OWNER", now });
  check(
    "Reload still creates no follow-up rows",
    (await prisma.customerFollowUp.count({ where: { businessId: businessA.id } })) === followCountBeforeLoad,
  );
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
}

if (failures > 0) {
  console.error(`\n${failures} retention follow-up status check(s) failed.`);
  process.exit(1);
}
console.log("\nRetention follow-up status checks passed.");
