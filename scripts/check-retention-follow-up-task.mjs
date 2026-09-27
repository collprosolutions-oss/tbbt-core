/**
 * OWNER-explicit retention follow-up task proofs.
 *
 * Authorization, same-business isolation, and idempotency against a
 * dedicated database. The write records CustomerFollowUp only.
 *
 * Run with:
 *   npm run test:retention-follow-up-task
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
  console.error("Failed to generate Prisma client for retention follow-up checks.");
  process.exit(generateEarly.status ?? 1);
}

const { ForbiddenError } = await import("@/lib/authorization");
const { APP_NAV } = await import("@/lib/nav");
const { businessScope, assertBusinessRecord } = await import("@/lib/access-scope");
const {
  RETENTION_FOLLOW_UP_FOREIGN_CUSTOMER_MESSAGE,
  RETENTION_FOLLOW_UP_FOREIGN_JOB_MESSAGE,
  RETENTION_FOLLOW_UP_JOB_CUSTOMER_MISMATCH_MESSAGE,
  RETENTION_FOLLOW_UP_JOB_NOT_COMPLETED_MESSAGE,
  RETENTION_FOLLOW_UP_OWNER_ONLY_MESSAGE,
  RETENTION_FOLLOW_UP_RECORDED_MESSAGE,
  RETENTION_FOLLOW_UP_STALE_FINDING_MESSAGE,
  RETENTION_FOLLOW_UP_UNKNOWN_FINDING_MESSAGE,
  RETENTION_FOLLOW_UP_UPDATED_MESSAGE,
  RETENTION_OWNER_FOLLOW_UP_MESSAGE,
  RETENTION_ROUTE,
  loadRetentionRecoveryCenter,
  recordRetentionFollowUpTask,
  RetentionFollowUpError,
  retentionFollowUpWriteAllowed,
} = await import("@/lib/growth/retention");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function readSrc(relative) {
  return readFileSync(join(root, relative), "utf8");
}

const featureFiles = [
  "src/lib/growth/retention/record-follow-up.ts",
  "src/lib/growth/retention/access.ts",
  "src/lib/growth/retention/constants.ts",
  "src/app/actions/retention.ts",
  "src/app/(app)/growth/retention/page.tsx",
  "src/components/growth/retention/retention-center.tsx",
];
const featureSource = featureFiles.map(readSrc).join("\n");
const writeSrc = readSrc("src/lib/growth/retention/record-follow-up.ts");
const actionSrc = readSrc("src/app/actions/retention.ts");
const uiSrc = readSrc("src/components/growth/retention/retention-center.tsx");
const loadSrc = readSrc("src/lib/growth/retention/load.ts");
const navSrc = readSrc("src/lib/nav.ts");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_retention_follow_up_task_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for retention follow-up test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
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

function daysAgo(days, now = new Date()) {
  return new Date(now.getTime() - days * 86_400_000);
}

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      business: { id: businessId, name: "Retention Follow-up Co" },
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
  console.log("\nSTATIC — owner write, no send, no nav, no intent");
  check("Dedicated route stays /growth/retention", RETENTION_ROUTE === "/growth/retention");
  check(
    "OWNER-only write gate",
    retentionFollowUpWriteAllowed("OWNER") === true &&
      retentionFollowUpWriteAllowed("ADMIN") === false &&
      retentionFollowUpWriteAllowed("MEMBER") === false,
  );
  check(
    "Owner copy does not send SMS or email",
    /does not send SMS or email/.test(RETENTION_OWNER_FOLLOW_UP_MESSAGE) &&
      /does not send SMS or email/.test(RETENTION_FOLLOW_UP_RECORDED_MESSAGE) === false &&
      /has not been sent/.test(RETENTION_FOLLOW_UP_RECORDED_MESSAGE) &&
      /has not been sent/.test(RETENTION_FOLLOW_UP_UPDATED_MESSAGE),
  );
  check(
    "Write path does not call the sending follow-up helpers",
    !/createCustomerFollowUp|sendCustomerFollowUp|attemptJobFollowUpSms|attemptRepeatFollowUpSms|attemptOwnedCustomerEmail|emitAndProcessBusinessEvent/.test(
      writeSrc,
    ) && !/sendCustomerFollowUp|attemptJobFollowUpSms|emitAndProcessBusinessEvent/.test(actionSrc),
  );
  check(
    "UI has no send or message-body controls",
    uiSrc.includes("recordRetentionFollowUpTaskAction") &&
      !/Send via connected|Mark sent|requestText|messageBody|lastEmailStatus|lastSmsStatus/.test(uiSrc),
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
      /mutationsOnLoad: false/.test(loadSrc),
  );
  check(
    "No invented customer intent",
    !/likely to buy|ready to rebook|churn risk|customer owes us a review|call today/i.test(featureSource),
  );
  check(
    "Owner-only copy is available for authorization failures",
    RETENTION_FOLLOW_UP_OWNER_ONLY_MESSAGE.includes("business owner"),
  );
  check(
    "Page load still uses requireManagementPageAccess before listing",
    readSrc("src/app/(app)/growth/retention/page.tsx").includes("requireManagementPageAccess()"),
  );

  const now = new Date("2026-09-27T16:00:00.000Z");
  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Follow-up",
      slug: `alpha-fu-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: "America/Los_Angeles",
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Follow-up",
      slug: `beta-fu-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: "America/New_York",
    },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia", email: `owner-fu-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Ava", email: `admin-fu-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia", email: `member-fu-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Bea", email: `beta-fu-${randomUUID()}@example.com`, passwordHash: "x" },
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
  const otherLocal = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Other Owen" },
  });
  const betaCustomer = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Secret" },
  });

  const completedNoReview = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
      createdAt: daysAgo(40, now),
    },
  });
  const otherLocalJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: otherLocal.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
      createdAt: daysAgo(12, now),
    },
  });
  const scheduledJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "SCHEDULED",
      projectToken: randomUUID(),
      createdAt: daysAgo(2, now),
    },
  });
  const betaJob = await prisma.job.create({
    data: {
      businessId: businessB.id,
      customerId: betaCustomer.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
      createdAt: daysAgo(5, now),
    },
  });

  await prisma.businessEvent.create({
    data: {
      businessId: businessA.id,
      type: "JOB_COMPLETED",
      subjectType: "JOB",
      subjectId: completedNoReview.id,
      occurredAt: daysAgo(40, now),
      idempotencyKey: `JOB_COMPLETED:${completedNoReview.id}`,
    },
  });

  console.log("\nTEST — authorization");
  await expectError(
    "ADMIN cannot record a follow-up task",
    () =>
      recordRetentionFollowUpTask(prisma, adminA, {
        customerId: customer.id,
        jobId: completedNoReview.id,
        group: "NO_REVIEW_REQUEST",
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot record a follow-up task",
    () =>
      recordRetentionFollowUpTask(prisma, memberA, {
        customerId: customer.id,
        jobId: completedNoReview.id,
        group: "NO_REVIEW_REQUEST",
      }),
    (error) => error instanceof ForbiddenError,
  );
  check(
    "Unauthorized roles created no rows",
    (await prisma.customerFollowUp.count({ where: { businessId: businessA.id } })) === 0,
  );

  console.log("\nTEST — foreign-customer and same-business isolation");
  await expectError(
    "Foreign customer id is rejected",
    () =>
      recordRetentionFollowUpTask(prisma, ownerA, {
        customerId: betaCustomer.id,
        jobId: completedNoReview.id,
        group: "NO_REVIEW_REQUEST",
      }),
    (error) =>
      error instanceof RetentionFollowUpError &&
      error.message === RETENTION_FOLLOW_UP_FOREIGN_CUSTOMER_MESSAGE,
  );
  await expectError(
    "Foreign completed job is rejected",
    () =>
      recordRetentionFollowUpTask(prisma, ownerA, {
        customerId: customer.id,
        jobId: betaJob.id,
        group: "NO_REVIEW_REQUEST",
      }),
    (error) =>
      error instanceof RetentionFollowUpError && error.message === RETENTION_FOLLOW_UP_FOREIGN_JOB_MESSAGE,
  );
  await expectError(
    "Same-business job for a different customer is rejected",
    () =>
      recordRetentionFollowUpTask(prisma, ownerA, {
        customerId: customer.id,
        jobId: otherLocalJob.id,
        group: "NO_REVIEW_REQUEST",
      }),
    (error) =>
      error instanceof RetentionFollowUpError &&
      error.message === RETENTION_FOLLOW_UP_JOB_CUSTOMER_MISMATCH_MESSAGE,
  );
  await expectError(
    "Beta owner cannot write Alpha customer",
    () =>
      recordRetentionFollowUpTask(prisma, ownerB, {
        customerId: customer.id,
        jobId: completedNoReview.id,
        group: "NO_REVIEW_REQUEST",
      }),
    (error) =>
      error instanceof RetentionFollowUpError &&
      error.message === RETENTION_FOLLOW_UP_FOREIGN_CUSTOMER_MESSAGE,
  );
  await expectError(
    "Scheduled job is not a completed-job finding",
    () =>
      recordRetentionFollowUpTask(prisma, ownerA, {
        customerId: customer.id,
        jobId: scheduledJob.id,
        group: "NO_REVIEW_REQUEST",
      }),
    (error) =>
      error instanceof RetentionFollowUpError &&
      error.message === RETENTION_FOLLOW_UP_JOB_NOT_COMPLETED_MESSAGE,
  );
  await expectError(
    "Unknown finding group is rejected",
    () =>
      recordRetentionFollowUpTask(prisma, ownerA, {
        customerId: customer.id,
        jobId: completedNoReview.id,
        group: "INCOMPLETE_JOURNEY",
      }),
    (error) =>
      error instanceof RetentionFollowUpError &&
      error.message === RETENTION_FOLLOW_UP_UNKNOWN_FINDING_MESSAGE,
  );
  check(
    "Isolation failures created no Alpha or Beta follow-up rows",
    (await prisma.customerFollowUp.count({
      where: { businessId: { in: [businessA.id, businessB.id] } },
    })) === 0,
  );

  console.log("\nTEST — OWNER create, reload, and no send");
  const communicationsBefore = await prisma.customerCommunication.count({
    where: { businessId: businessA.id },
  });
  const dueEventsBefore = await prisma.businessEvent.count({
    where: { businessId: businessA.id, type: "CUSTOMER_FOLLOW_UP_DUE" },
  });
  const created = await recordRetentionFollowUpTask(prisma, ownerA, {
    customerId: customer.id,
    jobId: completedNoReview.id,
    group: "NO_REVIEW_REQUEST",
  });
  check(
    "OWNER create writes one OPEN CustomerFollowUp",
    created.outcome === "CREATED" &&
      created.followUp.status === "OPEN" &&
      created.followUp.kind === "JOB_COMPLETE" &&
      created.followUp.businessId === businessA.id &&
      created.followUp.customerId === customer.id &&
      created.followUp.jobId === completedNoReview.id,
  );

  const reloaded = await loadRetentionRecoveryCenter(prisma, {
    businessId: businessA.id,
    role: "OWNER",
    now,
  });
  const recorded = reloaded.groups.recordedFollowUp.find((row) => row.followUpId === created.followUp.id);
  const candidate = reloaded.groups.noReviewRequest.find(
    (row) => row.lastCompletedJobId === completedNoReview.id,
  );
  check(
    "Reload shows the recorded follow-up status",
    recorded?.status === "OPEN" &&
      recorded.statusLabel === "OPEN" &&
      recorded.customerId === customer.id &&
      candidate?.lastFollowUpStatus === "OPEN" &&
      candidate.lastFollowUpKind === "JOB_COMPLETE",
  );
  check(
    "Write did not send SMS or email",
    created.followUp.status !== "SENT" &&
      (await prisma.customerCommunication.count({ where: { businessId: businessA.id } })) ===
        communicationsBefore &&
      (await prisma.businessEvent.count({
        where: { businessId: businessA.id, type: "CUSTOMER_FOLLOW_UP_DUE" },
      })) === dueEventsBefore &&
      (await prisma.customerFollowUp.findFirst({
        where: { id: created.followUp.id },
        select: { lastEmailStatus: true, lastSmsStatus: true, sentAt: true },
      }))?.sentAt == null,
  );

  console.log("\nTEST — idempotency");
  const second = await recordRetentionFollowUpTask(prisma, ownerA, {
    customerId: customer.id,
    jobId: completedNoReview.id,
    group: "NO_REVIEW_REQUEST",
  });
  check(
    "Second OWNER click updates the same row",
    second.outcome === "UPDATED" &&
      second.followUp.id === created.followUp.id &&
      second.followUp.status === "OPEN",
  );
  check(
    "No duplicate CustomerFollowUp for the same finding",
    (await prisma.customerFollowUp.count({
      where: { businessId: businessA.id, customerId: customer.id, jobId: completedNoReview.id },
    })) === 1,
  );

  const failedExisting = await prisma.customerFollowUp.update({
    where: { id: created.followUp.id },
    data: { status: "FAILED" },
  });
  const reopened = await recordRetentionFollowUpTask(prisma, ownerA, {
    customerId: customer.id,
    jobId: completedNoReview.id,
    group: "NO_REVIEW_REQUEST",
  });
  check(
    "FAILED row is updated back to OPEN without a duplicate",
    failedExisting.status === "FAILED" &&
      reopened.outcome === "UPDATED" &&
      reopened.followUp.id === created.followUp.id &&
      reopened.followUp.status === "OPEN" &&
      (await prisma.customerFollowUp.count({
        where: { businessId: businessA.id, customerId: customer.id, jobId: completedNoReview.id },
      })) === 1,
  );

  await prisma.customerFollowUp.update({
    where: { id: created.followUp.id },
    data: { status: "SENT", sentAt: now },
  });
  const sentAgain = await recordRetentionFollowUpTask(prisma, ownerA, {
    customerId: customer.id,
    jobId: completedNoReview.id,
    group: "NO_REVIEW_REQUEST",
  });
  check(
    "Existing SENT row is reused and not rewritten to a new send",
    sentAgain.outcome === "UPDATED" &&
      sentAgain.followUp.id === created.followUp.id &&
      sentAgain.followUp.status === "SENT" &&
      (await prisma.customerFollowUp.count({
        where: { businessId: businessA.id, customerId: customer.id, jobId: completedNoReview.id },
      })) === 1,
  );

  console.log("\nTEST — stale finding and no-later-job kind");
  const pastCustomer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Past Pat" },
  });
  const pastJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: pastCustomer.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
      createdAt: daysAgo(90, now),
    },
  });
  const repeat = await recordRetentionFollowUpTask(prisma, ownerA, {
    customerId: pastCustomer.id,
    jobId: pastJob.id,
    group: "NO_LATER_JOB",
  });
  check(
    "NO_LATER_JOB records a REPEAT CustomerFollowUp",
    repeat.outcome === "CREATED" &&
      repeat.followUp.kind === "REPEAT" &&
      repeat.followUp.status === "OPEN" &&
      repeat.followUp.customerId === pastCustomer.id,
  );
  const pastReload = await loadRetentionRecoveryCenter(prisma, {
    businessId: businessA.id,
    role: "OWNER",
    customerId: pastCustomer.id,
    now,
  });
  check(
    "Reload for that customer shows the REPEAT task",
    pastReload.groups.recordedFollowUp.some(
      (row) => row.followUpId === repeat.followUp.id && row.kind === "REPEAT" && row.status === "OPEN",
    ),
  );

  await prisma.reviewRequest.create({
    data: {
      businessId: businessA.id,
      customerId: otherLocal.id,
      jobId: otherLocalJob.id,
      status: "SENT",
      createdByMembershipId: ownerMem.id,
    },
  });
  await expectError(
    "Stale no-review finding is rejected",
    () =>
      recordRetentionFollowUpTask(prisma, ownerA, {
        customerId: otherLocal.id,
        jobId: otherLocalJob.id,
        group: "NO_REVIEW_REQUEST",
      }),
    (error) =>
      error instanceof RetentionFollowUpError && error.message === RETENTION_FOLLOW_UP_STALE_FINDING_MESSAGE,
  );
  check(
    "Stale finding did not create a follow-up",
    (await prisma.customerFollowUp.count({
      where: { businessId: businessA.id, customerId: otherLocal.id, jobId: otherLocalJob.id },
    })) === 0,
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
  console.error(`\n${failures} retention follow-up task check(s) failed.`);
  process.exit(1);
}
console.log("\nRetention follow-up task checks passed.");
