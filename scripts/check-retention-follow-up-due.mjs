/**
 * OWNER-set RETENTION_TASK due dates and bounded due/overdue view.
 *
 * Authorization, same-business isolation, business-timezone date
 * boundaries, DONE/CANCELLED history, and no message or due event
 * against a dedicated database. COMMUNICATION follow-ups stay separate.
 *
 * Run with:
 *   npm run test:retention-follow-up-due
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
  console.error("Failed to generate Prisma client for retention follow-up due checks.");
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
  DUE_OR_OVERDUE_FACT,
  RETENTION_CANDIDATE_LIMIT,
  RETENTION_FOLLOW_UP_DUE_CLEARED_MESSAGE,
  RETENTION_FOLLOW_UP_DUE_UNCHANGED_MESSAGE,
  RETENTION_FOLLOW_UP_DUE_UPDATED_MESSAGE,
  RETENTION_FOLLOW_UP_INVALID_DUE_DATE_MESSAGE,
  RETENTION_FOLLOW_UP_NOT_TASK_MESSAGE,
  RETENTION_FOLLOW_UP_SENT_NOT_DONE_MESSAGE,
  RETENTION_FOLLOW_UP_UNKNOWN_TASK_MESSAGE,
  RETENTION_OWNER_DUE_DATE_MESSAGE,
  RETENTION_ROUTE,
  loadRetentionRecoveryCenter,
  parseRetentionFollowUpDueOn,
  recordRetentionFollowUpTask,
  resolveRetentionFollowUpTaskStatus,
  RetentionFollowUpError,
  retentionFollowUpDueState,
  retentionFollowUpWriteAllowed,
  updateRetentionFollowUpDueOn,
} = await import("@/lib/growth/retention");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function readSrc(relative) {
  return readFileSync(join(root, relative), "utf8");
}

const recordSrc = readSrc("src/lib/growth/retention/record-follow-up.ts");
const updateDueSrc = readSrc("src/lib/growth/retention/update-due.ts");
const actionSrc = readSrc("src/app/actions/retention.ts");
const uiSrc = readSrc("src/components/growth/retention/retention-center.tsx");
const pageSrc = readSrc("src/app/(app)/growth/retention/page.tsx");
const loadSrc = readSrc("src/lib/growth/retention/load.ts");
const dueSrc = readSrc("src/lib/growth/retention/due.ts");
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

const testDbName = "tbbt_retention_follow_up_due_test";
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
  console.error("Failed to push schema for retention follow-up due test database.");
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
      business: { id: businessId, name: "Retention Due Co" },
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

async function seedCompletedJob(businessId, customerId, createdAt) {
  return prisma.job.create({
    data: {
      businessId,
      customerId,
      status: "COMPLETED",
      projectToken: randomUUID(),
      createdAt,
    },
  });
}

try {
  console.log("\nSTATIC — optional due date, OWNER-only, no send, automation untouched");
  check("Dedicated route stays /growth/retention", RETENTION_ROUTE === "/growth/retention");
  check(
    "OWNER-only due-date write gate",
    retentionFollowUpWriteAllowed("OWNER") === true &&
      retentionFollowUpWriteAllowed("ADMIN") === false &&
      retentionFollowUpWriteAllowed("MEMBER") === false,
  );
  check(
    "Owner copy does not send SMS or email",
    /does not send SMS or email/.test(RETENTION_OWNER_DUE_DATE_MESSAGE) &&
      /has not been sent/.test(RETENTION_FOLLOW_UP_DUE_UPDATED_MESSAGE) &&
      /has not been sent/.test(RETENTION_FOLLOW_UP_DUE_CLEARED_MESSAGE) &&
      /has not been sent/.test(RETENTION_FOLLOW_UP_DUE_UNCHANGED_MESSAGE),
  );
  check(
    "Due-date paths never write SENT or sentAt",
    updateDueSrc.includes("data: { dueOn }") &&
      !/status:\s*"SENT"/.test(updateDueSrc) &&
      !/sentAt/.test(updateDueSrc) &&
      !/lastEmailStatus|lastSmsStatus/.test(updateDueSrc) &&
      !/status:\s*"OPEN"/.test(updateDueSrc),
  );
  check(
    "Record and due-date paths do not call send or communication helpers",
    !/createCustomerFollowUp|sendCustomerFollowUp|markCustomerFollowUpSentManually|cancelCustomerFollowUp|attemptJobFollowUpSms|attemptRepeatFollowUpSms|attemptOwnedCustomerEmail|emitAndProcessBusinessEvent|emitBusinessEvent/.test(
      recordSrc,
    ) &&
      !/createCustomerFollowUp|sendCustomerFollowUp|emitAndProcessBusinessEvent|emitBusinessEvent/.test(
        updateDueSrc,
      ) &&
      !/sendCustomerFollowUp|attemptJobFollowUpSms|emitAndProcessBusinessEvent/.test(actionSrc),
  );
  check(
    "COMMUNICATION create/send helpers stay in referral-ops",
    referralOpsSrc.includes("export async function createCustomerFollowUp") &&
      referralOpsSrc.includes("export async function sendCustomerFollowUp") &&
      referralOpsSrc.includes("CUSTOMER_FOLLOW_UP_DUE") &&
      !referralOpsSrc.includes("dueOn"),
  );
  check(
    "Due view and scan stay separate",
    loadSrc.includes("CUSTOMER_FOLLOW_UP_ORIGINS.RETENTION_TASK") &&
      loadSrc.includes('status: "OPEN"') &&
      loadSrc.includes("startOfZonedDay") &&
      scanSrc.includes("customerFollowUpDueScanWhere") &&
      processorSrc.includes("isRetentionFollowUpTask") &&
      emailSrc.includes("isRetentionFollowUpTask"),
  );
  check(
    "Due parsing uses the business timezone, not UTC midnight",
    dueSrc.includes("parseCivilDateInTimeZone") &&
      dueSrc.includes("startOfZonedDay") &&
      !dueSrc.includes("toISOString().slice(0, 10)"),
  );
  check(
    "UI offers an optional due date and not Mark sent",
    uiSrc.includes("updateRetentionFollowUpDueOnAction") &&
      uiSrc.includes('name="dueOn"') &&
      uiSrc.includes("Due or overdue follow-up tasks") &&
      !/Mark sent|Send via connected|requestText|messageBody|lastEmailStatus|lastSmsStatus/.test(uiSrc),
  );
  check(
    "Page still uses management access and OWNER write gate",
    pageSrc.includes("requireManagementPageAccess()") &&
      pageSrc.includes("canUpdateDueOn") &&
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
      loadSrc.includes("dueOn: true") &&
      loadSrc.includes("take: RETENTION_CANDIDATE_LIMIT"),
  );
  check("Due/overdue fact is not a send queue", /not a send queue/.test(DUE_OR_OVERDUE_FACT));

  const now = new Date("2026-09-28T06:30:00.000Z");
  check(
    "Civil-day parser accepts a real date and rejects Feb 30",
    parseRetentionFollowUpDueOn("2026-09-27", "America/Los_Angeles").ok === true &&
      parseRetentionFollowUpDueOn("2026-02-30", "America/Los_Angeles").ok === false &&
      parseRetentionFollowUpDueOn("tomorrow", "America/Los_Angeles").ok === false &&
      parseRetentionFollowUpDueOn("", "America/Los_Angeles").ok === true &&
      parseRetentionFollowUpDueOn("", "America/Los_Angeles").dueOn === null,
  );
  check(
    "06:30Z is still Sep 27 in Los Angeles and already Sep 28 in New York",
    retentionFollowUpDueState(
      parseRetentionFollowUpDueOn("2026-09-27", "America/Los_Angeles").dueOn,
      now,
      "America/Los_Angeles",
    ) === "due_today" &&
      retentionFollowUpDueState(
        parseRetentionFollowUpDueOn("2026-09-27", "America/New_York").dueOn,
        now,
        "America/New_York",
      ) === "overdue" &&
      retentionFollowUpDueState(
        parseRetentionFollowUpDueOn("2026-09-28", "America/Los_Angeles").dueOn,
        now,
        "America/Los_Angeles",
      ) === "upcoming",
  );

  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Due",
      slug: `alpha-due-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: "America/Los_Angeles",
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Due",
      slug: `beta-due-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: "America/New_York",
    },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia", email: `owner-due-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Ava", email: `admin-due-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia", email: `member-due-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Bea", email: `beta-due-${randomUUID()}@example.com`, passwordHash: "x" },
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
  const overdueCustomer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Owen Overdue" },
  });
  const upcomingCustomer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Uma Upcoming" },
  });
  const doneCustomer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Dana Done" },
  });
  const cancelCustomer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Cara Cancel" },
  });
  const betaCustomer = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Secret" },
  });

  const completedJob = await seedCompletedJob(businessA.id, customer.id, daysAgo(20, now));
  const overdueJob = await seedCompletedJob(businessA.id, overdueCustomer.id, daysAgo(18, now));
  const upcomingJob = await seedCompletedJob(businessA.id, upcomingCustomer.id, daysAgo(16, now));
  const doneJob = await seedCompletedJob(businessA.id, doneCustomer.id, daysAgo(14, now));
  const cancelJob = await seedCompletedJob(businessA.id, cancelCustomer.id, daysAgo(12, now));
  const betaJob = await seedCompletedJob(businessB.id, betaCustomer.id, daysAgo(8, now));

  console.log("\nTEST — authorization");
  await expectError(
    "ADMIN cannot record a due date",
    () =>
      recordRetentionFollowUpTask(prisma, adminA, {
        customerId: customer.id,
        jobId: completedJob.id,
        group: "NO_REVIEW_REQUEST",
        dueOn: "2026-09-27",
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot record a due date",
    () =>
      recordRetentionFollowUpTask(prisma, memberA, {
        customerId: customer.id,
        jobId: completedJob.id,
        group: "NO_REVIEW_REQUEST",
        dueOn: "2026-09-27",
      }),
    (error) => error instanceof ForbiddenError,
  );
  check(
    "Unauthorized roles created no follow-up rows",
    (await prisma.customerFollowUp.count({ where: { businessId: businessA.id } })) === 0,
  );

  console.log("\nTEST — OWNER record with optional due date and no send");
  const communicationsBefore = await prisma.customerCommunication.count({
    where: { businessId: businessA.id },
  });
  const dueEventsBefore = await prisma.businessEvent.count({
    where: { businessId: businessA.id, type: "CUSTOMER_FOLLOW_UP_DUE" },
  });
  const createdToday = await recordRetentionFollowUpTask(prisma, ownerA, {
    customerId: customer.id,
    jobId: completedJob.id,
    group: "NO_REVIEW_REQUEST",
    dueOn: "2026-09-27",
  });
  const createdOverdue = await recordRetentionFollowUpTask(prisma, ownerA, {
    customerId: overdueCustomer.id,
    jobId: overdueJob.id,
    group: "NO_REVIEW_REQUEST",
    dueOn: "2026-09-26",
  });
  const createdUpcoming = await recordRetentionFollowUpTask(prisma, ownerA, {
    customerId: upcomingCustomer.id,
    jobId: upcomingJob.id,
    group: "NO_REVIEW_REQUEST",
    dueOn: "2026-09-28",
  });
  const createdDone = await recordRetentionFollowUpTask(prisma, ownerA, {
    customerId: doneCustomer.id,
    jobId: doneJob.id,
    group: "NO_REVIEW_REQUEST",
    dueOn: "2026-09-26",
  });
  const createdCancel = await recordRetentionFollowUpTask(prisma, ownerA, {
    customerId: cancelCustomer.id,
    jobId: cancelJob.id,
    group: "NO_REVIEW_REQUEST",
    dueOn: "2026-09-26",
  });
  const betaTask = await recordRetentionFollowUpTask(prisma, ownerB, {
    customerId: betaCustomer.id,
    jobId: betaJob.id,
    group: "NO_REVIEW_REQUEST",
    dueOn: "2026-09-27",
  });
  check(
    "OWNER create stores the civil due date and stays OPEN",
    createdToday.outcome === "CREATED" &&
      createdToday.followUp.origin === CUSTOMER_FOLLOW_UP_ORIGINS.RETENTION_TASK &&
      createdToday.followUp.status === "OPEN" &&
      createdToday.followUp.dueOn != null &&
      createdToday.followUp.dueOn.getTime() ===
        parseRetentionFollowUpDueOn("2026-09-27", "America/Los_Angeles").dueOn.getTime(),
  );
  check(
    "Record with a due date did not send or emit CUSTOMER_FOLLOW_UP_DUE",
    (await prisma.customerCommunication.count({ where: { businessId: businessA.id } })) ===
      communicationsBefore &&
      (await prisma.businessEvent.count({
        where: { businessId: businessA.id, type: "CUSTOMER_FOLLOW_UP_DUE" },
      })) === dueEventsBefore &&
      (await prisma.customerFollowUp.findFirst({
        where: { id: createdToday.followUp.id },
        select: { sentAt: true, lastEmailStatus: true, lastSmsStatus: true },
      }))?.sentAt == null,
  );

  await expectError(
    "Invalid due date is rejected",
    () =>
      recordRetentionFollowUpTask(prisma, ownerA, {
        customerId: customer.id,
        jobId: completedJob.id,
        group: "NO_REVIEW_REQUEST",
        dueOn: "2026-02-30",
      }),
    (error) =>
      error instanceof RetentionFollowUpError &&
      error.message === RETENTION_FOLLOW_UP_INVALID_DUE_DATE_MESSAGE,
  );
  const afterInvalid = await prisma.customerFollowUp.findUniqueOrThrow({
    where: { id: createdToday.followUp.id },
  });
  check(
    "Rejected invalid date left the existing due date and status unchanged",
    afterInvalid.status === "OPEN" &&
      afterInvalid.dueOn?.getTime() === createdToday.followUp.dueOn.getTime(),
  );

  console.log("\nTEST — isolation and COMMUNICATION stay separate");
  const communication = await prisma.customerFollowUp.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      jobId: completedJob.id,
      kind: "JOB_COMPLETE",
      status: "OPEN",
      origin: CUSTOMER_FOLLOW_UP_ORIGINS.COMMUNICATION,
      dueOn: parseRetentionFollowUpDueOn("2026-09-26", "America/Los_Angeles").dueOn,
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
      dueOn: parseRetentionFollowUpDueOn("2026-09-26", "America/Los_Angeles").dueOn,
      createdByMembershipId: ownerMem.id,
    },
  });
  await expectError(
    "ADMIN cannot update a due date",
    () =>
      updateRetentionFollowUpDueOn(prisma, adminA, {
        followUpId: createdToday.followUp.id,
        dueOn: "2026-09-26",
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot update a due date",
    () =>
      updateRetentionFollowUpDueOn(prisma, memberA, {
        followUpId: createdToday.followUp.id,
        dueOn: "2026-09-26",
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "Foreign follow-up id is rejected",
    () =>
      updateRetentionFollowUpDueOn(prisma, ownerA, {
        followUpId: betaTask.followUp.id,
        dueOn: "2026-09-26",
      }),
    (error) =>
      error instanceof RetentionFollowUpError && error.message === RETENTION_FOLLOW_UP_UNKNOWN_TASK_MESSAGE,
  );
  await expectError(
    "Beta owner cannot update an Alpha due date",
    () =>
      updateRetentionFollowUpDueOn(prisma, ownerB, {
        followUpId: createdToday.followUp.id,
        dueOn: "2026-09-26",
      }),
    (error) =>
      error instanceof RetentionFollowUpError && error.message === RETENTION_FOLLOW_UP_UNKNOWN_TASK_MESSAGE,
  );
  await expectError(
    "COMMUNICATION follow-up cannot receive a retention due date here",
    () =>
      updateRetentionFollowUpDueOn(prisma, ownerA, {
        followUpId: communication.id,
        dueOn: "2026-09-27",
      }),
    (error) =>
      error instanceof RetentionFollowUpError && error.message === RETENTION_FOLLOW_UP_NOT_TASK_MESSAGE,
  );
  await expectError(
    "SENT retention task cannot have its due date rewritten here",
    () =>
      updateRetentionFollowUpDueOn(prisma, ownerA, {
        followUpId: sentTask.id,
        dueOn: "2026-09-27",
      }),
    (error) =>
      error instanceof RetentionFollowUpError && error.message === RETENTION_FOLLOW_UP_SENT_NOT_DONE_MESSAGE,
  );
  const communicationAfter = await prisma.customerFollowUp.findUniqueOrThrow({
    where: { id: communication.id },
  });
  const sentAfter = await prisma.customerFollowUp.findUniqueOrThrow({ where: { id: sentTask.id } });
  const betaAfter = await prisma.customerFollowUp.findUniqueOrThrow({
    where: { id: betaTask.followUp.id },
  });
  check(
    "Isolation failures left COMMUNICATION, SENT, and Beta rows unchanged",
    communicationAfter.origin === CUSTOMER_FOLLOW_UP_ORIGINS.COMMUNICATION &&
      communicationAfter.status === "OPEN" &&
      communicationAfter.sentAt == null &&
      sentAfter.status === "SENT" &&
      sentAfter.sentAt != null &&
      betaAfter.businessId === businessB.id &&
      betaAfter.status === "OPEN",
  );

  console.log("\nTEST — business-timezone due/overdue view");
  const workspace = await loadRetentionRecoveryCenter(prisma, {
    businessId: businessA.id,
    role: "OWNER",
    now,
  });
  const dueIds = workspace.groups.dueOrOverdue.map((row) => row.followUpId);
  const todayRow = workspace.groups.dueOrOverdue.find((row) => row.followUpId === createdToday.followUp.id);
  const overdueRow = workspace.groups.dueOrOverdue.find(
    (row) => row.followUpId === createdOverdue.followUp.id,
  );
  check("Workspace uses the business timezone", workspace.timeZone === "America/Los_Angeles");
  check(
    "Due today in Los Angeles is in the due/overdue view",
    todayRow?.dueState === "due_today" && todayRow.dueStateLabel === "Due today" && todayRow.status === "OPEN",
  );
  check(
    "Yesterday in Los Angeles is overdue",
    overdueRow?.dueState === "overdue" && overdueRow.dueStateLabel === "Overdue",
  );
  check(
    "Tomorrow in Los Angeles is excluded from the due/overdue view",
    !dueIds.includes(createdUpcoming.followUp.id) &&
      workspace.groups.recordedFollowUp.some(
        (row) => row.followUpId === createdUpcoming.followUp.id && row.dueState === "upcoming",
      ),
  );
  check(
    "COMMUNICATION row with a stuffed due date is excluded",
    !dueIds.includes(communication.id),
  );
  check(
    "Beta due task is not visible on Alpha",
    !dueIds.includes(betaTask.followUp.id) &&
      !workspace.groups.recordedFollowUp.some((row) => row.followUpId === betaTask.followUp.id),
  );
  check(
    "Due/overdue view is bounded",
    workspace.groups.dueOrOverdue.length <= RETENTION_CANDIDATE_LIMIT &&
      workspace.candidateLimit === 50,
  );

  const betaWorkspace = await loadRetentionRecoveryCenter(prisma, {
    businessId: businessB.id,
    role: "OWNER",
    now,
  });
  const betaDue = betaWorkspace.groups.dueOrOverdue.find((row) => row.followUpId === betaTask.followUp.id);
  check(
    "The same UTC instant is overdue in New York for a Sep 27 due date",
    betaWorkspace.timeZone === "America/New_York" &&
      betaDue?.dueState === "overdue" &&
      !betaWorkspace.groups.dueOrOverdue.some((row) => row.followUpId === createdToday.followUp.id),
  );

  console.log("\nTEST — DONE/CANCELLED history is preserved");
  const markedDone = await resolveRetentionFollowUpTaskStatus(prisma, ownerA, {
    followUpId: createdDone.followUp.id,
    status: "DONE",
  });
  const markedCancel = await resolveRetentionFollowUpTaskStatus(prisma, ownerA, {
    followUpId: createdCancel.followUp.id,
    status: "CANCELLED",
  });
  const doneRow = await prisma.customerFollowUp.findUniqueOrThrow({
    where: { id: createdDone.followUp.id },
  });
  const cancelRow = await prisma.customerFollowUp.findUniqueOrThrow({
    where: { id: createdCancel.followUp.id },
  });
  check(
    "Done and Cancelled keep their recorded due dates",
    markedDone.followUp.status === "DONE" &&
      markedDone.followUp.dueOn?.getTime() === createdDone.followUp.dueOn.getTime() &&
      doneRow.dueOn?.getTime() === createdDone.followUp.dueOn.getTime() &&
      markedCancel.followUp.status === "CANCELLED" &&
      cancelRow.cancelledAt != null &&
      cancelRow.dueOn?.getTime() === createdCancel.followUp.dueOn.getTime(),
  );

  const afterStatus = await loadRetentionRecoveryCenter(prisma, {
    businessId: businessA.id,
    role: "OWNER",
    now,
  });
  check(
    "DONE/CANCELLED stay in recorded history and leave the due/overdue view",
    afterStatus.groups.recordedFollowUp.some(
      (row) => row.followUpId === createdDone.followUp.id && row.status === "DONE" && row.dueState === "overdue",
    ) &&
      afterStatus.groups.recordedFollowUp.some(
        (row) =>
          row.followUpId === createdCancel.followUp.id &&
          row.status === "CANCELLED" &&
          row.dueState === "overdue",
      ) &&
      !afterStatus.groups.dueOrOverdue.some((row) => row.followUpId === createdDone.followUp.id) &&
      !afterStatus.groups.dueOrOverdue.some((row) => row.followUpId === createdCancel.followUp.id),
  );

  const dueUpdatedOnDone = await updateRetentionFollowUpDueOn(prisma, ownerA, {
    followUpId: createdDone.followUp.id,
    dueOn: "2026-09-27",
  });
  const doneAfterDue = await prisma.customerFollowUp.findUniqueOrThrow({
    where: { id: createdDone.followUp.id },
  });
  check(
    "Due-date update on DONE does not reopen or send",
    dueUpdatedOnDone.outcome === "UPDATED" &&
      dueUpdatedOnDone.followUp.status === "DONE" &&
      dueUpdatedOnDone.followUp.status !== "SENT" &&
      doneAfterDue.status === "DONE" &&
      doneAfterDue.cancelledAt == null &&
      doneAfterDue.sentAt == null,
  );

  const dueUpdatedOnCancel = await updateRetentionFollowUpDueOn(prisma, ownerA, {
    followUpId: createdCancel.followUp.id,
    dueOn: "2026-09-27",
  });
  const cancelAfterDue = await prisma.customerFollowUp.findUniqueOrThrow({
    where: { id: createdCancel.followUp.id },
  });
  check(
    "Due-date update on CANCELLED keeps cancelledAt and does not send",
    dueUpdatedOnCancel.followUp.status === "CANCELLED" &&
      cancelAfterDue.cancelledAt?.getTime() === cancelRow.cancelledAt?.getTime() &&
      cancelAfterDue.sentAt == null,
  );

  const rerecordDone = await recordRetentionFollowUpTask(prisma, ownerA, {
    customerId: doneCustomer.id,
    jobId: doneJob.id,
    group: "NO_REVIEW_REQUEST",
    dueOn: "2026-09-26",
  });
  const rerecordedDone = await prisma.customerFollowUp.findUniqueOrThrow({
    where: { id: createdDone.followUp.id },
  });
  check(
    "Re-recording a DONE task can change dueOn without rewriting status",
    rerecordDone.outcome === "UPDATED" &&
      rerecordDone.followUp.id === createdDone.followUp.id &&
      rerecordDone.followUp.status === "DONE" &&
      rerecordedDone.status === "DONE" &&
      rerecordedDone.dueOn?.getTime() ===
        parseRetentionFollowUpDueOn("2026-09-26", "America/Los_Angeles").dueOn.getTime(),
  );
  const rerecordWithoutDate = await recordRetentionFollowUpTask(prisma, ownerA, {
    customerId: doneCustomer.id,
    jobId: doneJob.id,
    group: "NO_REVIEW_REQUEST",
  });
  const keptDue = await prisma.customerFollowUp.findUniqueOrThrow({
    where: { id: createdDone.followUp.id },
  });
  check(
    "Re-recording without a due date keeps the existing date and DONE status",
    rerecordWithoutDate.followUp.status === "DONE" &&
      keptDue.dueOn?.getTime() === rerecordedDone.dueOn?.getTime(),
  );

  const cleared = await updateRetentionFollowUpDueOn(prisma, ownerA, {
    followUpId: createdUpcoming.followUp.id,
    dueOn: "",
  });
  check(
    "Empty due date clears the recorded date without sending",
    cleared.outcome === "UPDATED" &&
      cleared.followUp.dueOn == null &&
      cleared.followUp.status === "OPEN" &&
      cleared.followUp.status !== "SENT",
  );
  const unchanged = await updateRetentionFollowUpDueOn(prisma, ownerA, {
    followUpId: createdUpcoming.followUp.id,
    dueOn: "",
  });
  check("Clearing an already-empty due date is unchanged", unchanged.outcome === "UNCHANGED");

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
    "Enabled-rule scan emits for COMMUNICATION and never for dated retention tasks",
    dueAfterScan.some((row) => row.subjectId === communication.id) &&
      !dueAfterScan.some((row) => row.subjectId === createdToday.followUp.id) &&
      !dueAfterScan.some((row) => row.subjectId === createdOverdue.followUp.id) &&
      !dueAfterScan.some((row) => row.subjectId === createdDone.followUp.id),
  );
  await processPendingAutomationRuns(prisma, businessA.id);
  const retentionAfterScan = await prisma.customerFollowUp.findUniqueOrThrow({
    where: { id: createdToday.followUp.id },
  });
  check(
    "Enabled-rule processing does not send a dated retention task",
    retentionAfterScan.status === "OPEN" &&
      retentionAfterScan.sentAt == null &&
      (await prisma.customerCommunication.count({
        where: { businessId: businessA.id, relatedType: "CUSTOMER_FOLLOW_UP", relatedId: createdToday.followUp.id },
      })) === 0 &&
      (await prisma.customerCommunication.count({ where: { businessId: businessA.id } })) >= commBeforeScan,
  );

  console.log("\nTEST — bounded due/overdue discovery");
  const extra = [];
  for (let i = 0; i < 51; i += 1) {
    extra.push(
      (async () => {
        const extraCustomer = await prisma.customer.create({
          data: { businessId: businessA.id, name: `Bound ${i}` },
        });
        const extraJob = await seedCompletedJob(businessA.id, extraCustomer.id, daysAgo(30 + i, now));
        return recordRetentionFollowUpTask(prisma, ownerA, {
          customerId: extraCustomer.id,
          jobId: extraJob.id,
          group: "NO_REVIEW_REQUEST",
          dueOn: "2026-09-01",
        });
      })(),
    );
  }
  const extraResults = await Promise.all(extra);
  const bounded = await loadRetentionRecoveryCenter(prisma, {
    businessId: businessA.id,
    role: "OWNER",
    now,
  });
  check(
    "Due/overdue discovery is bounded to 50",
    bounded.groups.dueOrOverdue.length === RETENTION_CANDIDATE_LIMIT &&
      extraResults.length === 51,
  );
  const omitted = extraResults.find(
    (row) => !bounded.groups.dueOrOverdue.some((item) => item.followUpId === row.followUp.id),
  );
  check(
    "A due task outside the displayed window still exists as an exact row",
    omitted != null &&
      (await prisma.customerFollowUp.findUnique({ where: { id: omitted.followUp.id } }))?.status ===
        "OPEN",
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
  console.error(`\n${failures} retention follow-up due check(s) failed.`);
  process.exit(1);
}
console.log("\nRetention follow-up due checks passed.");
