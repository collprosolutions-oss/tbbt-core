/**
 * OWNER-recorded RETENTION_TASK due-date proofs.
 *
 * Authorization, tenant isolation, business-timezone date boundaries,
 * DONE/CANCELLED history, and no-send behavior against a dedicated
 * database. COMMUNICATION follow-ups and CUSTOMER_FOLLOW_UP_DUE sending
 * stay separate.
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
  emitBusinessEvent,
  processPendingAutomationRuns,
  queueAutomationRunsForEvent,
  scanScheduledBusinessEvents,
} = await import("@/lib/automation");
const { CUSTOMER_FOLLOW_UP_ORIGINS } = await import("@/lib/customer-follow-up-origin");
const {
  DUE_OR_OVERDUE_FACT,
  RETENTION_CANDIDATE_LIMIT,
  RETENTION_FOLLOW_UP_INVALID_DUE_DATE_MESSAGE,
  RETENTION_FOLLOW_UP_OWNER_ONLY_MESSAGE,
  RETENTION_GROUP_TITLES,
  RETENTION_OWNER_FOLLOW_UP_MESSAGE,
  RETENTION_ROUTE,
  loadRetentionRecoveryCenter,
  parseRetentionFollowUpDueOn,
  recordRetentionFollowUpTask,
  resolveRetentionFollowUpTaskStatus,
  RetentionFollowUpError,
  retentionFollowUpDueState,
  retentionFollowUpDueViewWhere,
  retentionFollowUpWriteAllowed,
} = await import("@/lib/growth/retention");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function readSrc(relative) {
  return readFileSync(join(root, relative), "utf8");
}

const writeSrc = readSrc("src/lib/growth/retention/record-follow-up.ts");
const dueSrc = readSrc("src/lib/growth/retention/due.ts");
const resolveSrc = readSrc("src/lib/growth/retention/resolve-follow-up.ts");
const actionSrc = readSrc("src/app/actions/retention.ts");
const uiSrc = readSrc("src/components/growth/retention/retention-center.tsx");
const loadSrc = readSrc("src/lib/growth/retention/load.ts");
const navSrc = readSrc("src/lib/nav.ts");
const scanSrc = readSrc("src/lib/automation/scan.ts");
const processorSrc = readSrc("src/lib/automation/processor.ts");
const emailSrc = readSrc("src/lib/automation/email.ts");
const originSrc = readSrc("src/lib/customer-follow-up-origin.ts");

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

async function completedJob(businessId, customerId, createdAt) {
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
  console.log("\nSTATIC — optional due date, business timezone, no send");
  check("Dedicated route stays /growth/retention", RETENTION_ROUTE === "/growth/retention");
  check(
    "OWNER-only write gate",
    retentionFollowUpWriteAllowed("OWNER") === true &&
      retentionFollowUpWriteAllowed("ADMIN") === false &&
      retentionFollowUpWriteAllowed("MEMBER") === false,
  );
  check(
    "Owner copy still does not send SMS or email",
    /does not send SMS or email/.test(RETENTION_OWNER_FOLLOW_UP_MESSAGE) &&
      RETENTION_OWNER_FOLLOW_UP_MESSAGE.includes("optional due date") &&
      RETENTION_FOLLOW_UP_OWNER_ONLY_MESSAGE.includes("business owner"),
  );
  check(
    "Due-date parser and view helpers use the business timezone",
    dueSrc.includes("parseCivilDateInTimeZone") &&
      dueSrc.includes("startOfZonedDay") &&
      dueSrc.includes("retentionFollowUpDueViewWhere") &&
      dueSrc.includes("CUSTOMER_FOLLOW_UP_ORIGINS.RETENTION_TASK") &&
      dueSrc.includes('status: "OPEN"') &&
      !dueSrc.includes("emitBusinessEvent") &&
      !dueSrc.includes("sendCustomerFollowUp"),
  );
  check(
    "Write path stores dueAt without sending or changing DONE/CANCELLED status",
    writeSrc.includes("dueAt") &&
      writeSrc.includes("parseRetentionFollowUpDueOn") &&
      writeSrc.includes("loadRetentionBusinessTimeZone") &&
      !/status:\s*"SENT"/.test(writeSrc) &&
      !/sentAt/.test(writeSrc) &&
      !/createCustomerFollowUp|sendCustomerFollowUp|emitAndProcessBusinessEvent|emitBusinessEvent/.test(
        writeSrc,
      ),
  );
  check(
    "Resolve path keeps dueAt and never writes SENT",
    resolveSrc.includes("dueAt: true") &&
      resolveSrc.includes('status: "DONE"') &&
      resolveSrc.includes('status: "CANCELLED"') &&
      !/status:\s*"SENT"/.test(resolveSrc) &&
      !/sentAt/.test(resolveSrc),
  );
  check(
    "Due view query is bounded OPEN RETENTION_TASK only",
    loadSrc.includes("retentionFollowUpDueViewWhere") &&
      loadSrc.includes("take: RETENTION_CANDIDATE_LIMIT") &&
      loadSrc.includes('group: "DUE_OR_OVERDUE"') &&
      !/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/.test(loadSrc) &&
      /mutationsOnLoad: false/.test(loadSrc),
  );
  check(
    "Due scan still excludes RETENTION_TASK and ignores dueAt",
    scanSrc.includes("customerFollowUpDueScanWhere") &&
      originSrc.includes("origin: { not: CUSTOMER_FOLLOW_UP_ORIGINS.RETENTION_TASK }") &&
      originSrc.includes("dueAt is only for the retention") &&
      !originSrc.includes("dueAt:") &&
      processorSrc.includes("isRetentionFollowUpTask") &&
      emailSrc.includes("isRetentionFollowUpTask"),
  );
  check(
    "UI offers an optional due date and a due/overdue view without send controls",
    uiSrc.includes('name="dueOn"') &&
      uiSrc.includes('type="date"') &&
      uiSrc.includes("DueOrOverdueGroup") &&
      uiSrc.includes(RETENTION_GROUP_TITLES.DUE_OR_OVERDUE) &&
      !/Mark sent|Send via connected|requestText|messageBody|lastEmailStatus|lastSmsStatus/.test(uiSrc),
  );
  check(
    "Action forwards dueOn and does not send",
    actionSrc.includes('readString(formData, "dueOn")') &&
      !/sendCustomerFollowUp|attemptJobFollowUpSms|emitAndProcessBusinessEvent/.test(actionSrc),
  );
  check(
    "Global navigation is unchanged",
    APP_NAV.every((item) => item.href !== RETENTION_ROUTE) &&
      !navSrc.includes("/growth/retention") &&
      !navSrc.includes("Customer retention"),
  );
  check("Due/overdue fact is not a send", DUE_OR_OVERDUE_FACT.includes("This is not a send."));

  const now = new Date("2026-09-27T06:30:00.000Z");
  const dueTodayLa = parseRetentionFollowUpDueOn("2026-09-26", "America/Los_Angeles");
  const overdueLa = parseRetentionFollowUpDueOn("2026-09-25", "America/Los_Angeles");
  const upcomingLa = parseRetentionFollowUpDueOn("2026-09-27", "America/Los_Angeles");
  const dueTodayNy = parseRetentionFollowUpDueOn("2026-09-27", "America/New_York");
  const overdueNy = parseRetentionFollowUpDueOn("2026-09-26", "America/New_York");
  check(
    "Invalid civil dates are rejected",
    parseRetentionFollowUpDueOn("2026-02-31", "America/Los_Angeles") === "invalid" &&
      parseRetentionFollowUpDueOn("09/26/2026", "America/Los_Angeles") === "invalid" &&
      parseRetentionFollowUpDueOn("not-a-date", "America/Los_Angeles") === "invalid" &&
      parseRetentionFollowUpDueOn("   ", "America/Los_Angeles") === null,
  );
  check(
    "LA 06:30Z is still the prior evening, so 2026-09-26 is due today",
    dueTodayLa instanceof Date &&
      retentionFollowUpDueState(dueTodayLa, now, "America/Los_Angeles") === "DUE_TODAY" &&
      overdueLa instanceof Date &&
      retentionFollowUpDueState(overdueLa, now, "America/Los_Angeles") === "OVERDUE" &&
      upcomingLa instanceof Date &&
      retentionFollowUpDueState(upcomingLa, now, "America/Los_Angeles") === "UPCOMING",
  );
  check(
    "NY 06:30Z is already 2026-09-27, so 2026-09-26 is overdue",
    dueTodayNy instanceof Date &&
      retentionFollowUpDueState(dueTodayNy, now, "America/New_York") === "DUE_TODAY" &&
      overdueNy instanceof Date &&
      retentionFollowUpDueState(overdueNy, now, "America/New_York") === "OVERDUE",
  );
  const laCutoff = retentionFollowUpDueViewWhere("biz-a", now, "America/Los_Angeles").dueAt.lt;
  const nyCutoff = retentionFollowUpDueViewWhere("biz-b", now, "America/New_York").dueAt.lt;
  check(
    "Due-view cutoff is start of the next business-timezone day",
    laCutoff instanceof Date &&
      nyCutoff instanceof Date &&
      upcomingLa instanceof Date &&
      upcomingLa.getTime() >= laCutoff.getTime() &&
      dueTodayLa instanceof Date &&
      dueTodayLa.getTime() < laCutoff.getTime() &&
      dueTodayNy instanceof Date &&
      dueTodayNy.getTime() < nyCutoff.getTime(),
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
  const betaCustomer = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Secret" },
  });
  const commCustomer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Comm Cara" },
  });
  const doneCustomer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Done Dana" },
  });
  const cancelCustomer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Cancel Cal" },
  });
  const upcomingCustomer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Upcoming Uma" },
  });
  const noneCustomer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "None Nora" },
  });

  const dueTodayJob = await completedJob(businessA.id, customer.id, daysAgo(20, now));
  const overdueJob = await completedJob(businessA.id, customer.id, daysAgo(21, now));
  const upcomingJob = await completedJob(businessA.id, upcomingCustomer.id, daysAgo(8, now));
  const noneJob = await completedJob(businessA.id, noneCustomer.id, daysAgo(9, now));
  const doneJob = await completedJob(businessA.id, doneCustomer.id, daysAgo(11, now));
  const cancelJob = await completedJob(businessA.id, cancelCustomer.id, daysAgo(12, now));
  const commJob = await completedJob(businessA.id, commCustomer.id, daysAgo(13, now));
  const betaJob = await completedJob(businessB.id, betaCustomer.id, daysAgo(14, now));

  console.log("\nTEST — authorization");
  await expectError(
    "ADMIN cannot record a due-dated follow-up task",
    () =>
      recordRetentionFollowUpTask(prisma, adminA, {
        customerId: customer.id,
        jobId: dueTodayJob.id,
        group: "NO_REVIEW_REQUEST",
        dueOn: "2026-09-26",
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot record a due-dated follow-up task",
    () =>
      recordRetentionFollowUpTask(prisma, memberA, {
        customerId: customer.id,
        jobId: dueTodayJob.id,
        group: "NO_REVIEW_REQUEST",
        dueOn: "2026-09-26",
      }),
    (error) => error instanceof ForbiddenError,
  );
  check(
    "Unauthorized roles created no rows",
    (await prisma.customerFollowUp.count({ where: { businessId: businessA.id } })) === 0,
  );

  console.log("\nTEST — tenant isolation");
  await expectError(
    "Foreign customer id is rejected even with a due date",
    () =>
      recordRetentionFollowUpTask(prisma, ownerA, {
        customerId: betaCustomer.id,
        jobId: dueTodayJob.id,
        group: "NO_REVIEW_REQUEST",
        dueOn: "2026-09-26",
      }),
    (error) => error instanceof RetentionFollowUpError,
  );
  await expectError(
    "Beta owner cannot write Alpha customer with a due date",
    () =>
      recordRetentionFollowUpTask(prisma, ownerB, {
        customerId: customer.id,
        jobId: dueTodayJob.id,
        group: "NO_REVIEW_REQUEST",
        dueOn: "2026-09-26",
      }),
    (error) => error instanceof RetentionFollowUpError,
  );
  check(
    "Isolation failures created no Alpha or Beta follow-up rows",
    (await prisma.customerFollowUp.count({
      where: { businessId: { in: [businessA.id, businessB.id] } },
    })) === 0,
  );

  console.log("\nTEST — invalid due dates do not write");
  await expectError(
    "Impossible calendar day is rejected",
    () =>
      recordRetentionFollowUpTask(prisma, ownerA, {
        customerId: customer.id,
        jobId: dueTodayJob.id,
        group: "NO_REVIEW_REQUEST",
        dueOn: "2026-02-31",
      }),
    (error) =>
      error instanceof RetentionFollowUpError &&
      error.message === RETENTION_FOLLOW_UP_INVALID_DUE_DATE_MESSAGE,
  );
  await expectError(
    "Non-ISO due date is rejected",
    () =>
      recordRetentionFollowUpTask(prisma, ownerA, {
        customerId: customer.id,
        jobId: dueTodayJob.id,
        group: "NO_REVIEW_REQUEST",
        dueOn: "09/26/2026",
      }),
    (error) =>
      error instanceof RetentionFollowUpError &&
      error.message === RETENTION_FOLLOW_UP_INVALID_DUE_DATE_MESSAGE,
  );
  check(
    "Invalid dates created no follow-up rows",
    (await prisma.customerFollowUp.count({ where: { businessId: businessA.id } })) === 0,
  );

  console.log("\nTEST — OWNER due dates, date boundaries, and history");
  const communicationsBefore = await prisma.customerCommunication.count({
    where: { businessId: businessA.id },
  });
  const dueEventsBefore = await prisma.businessEvent.count({
    where: { businessId: businessA.id, type: "CUSTOMER_FOLLOW_UP_DUE" },
  });

  const createdDueToday = await recordRetentionFollowUpTask(prisma, ownerA, {
    customerId: customer.id,
    jobId: dueTodayJob.id,
    group: "NO_REVIEW_REQUEST",
    dueOn: "2026-09-26",
  });
  const createdOverdue = await recordRetentionFollowUpTask(prisma, ownerA, {
    customerId: customer.id,
    jobId: overdueJob.id,
    group: "NO_REVIEW_REQUEST",
    dueOn: "2026-09-25",
  });
  const createdUpcoming = await recordRetentionFollowUpTask(prisma, ownerA, {
    customerId: upcomingCustomer.id,
    jobId: upcomingJob.id,
    group: "NO_REVIEW_REQUEST",
    dueOn: "2026-09-27",
  });
  const createdNone = await recordRetentionFollowUpTask(prisma, ownerA, {
    customerId: noneCustomer.id,
    jobId: noneJob.id,
    group: "NO_REVIEW_REQUEST",
  });
  const createdDone = await recordRetentionFollowUpTask(prisma, ownerA, {
    customerId: doneCustomer.id,
    jobId: doneJob.id,
    group: "NO_REVIEW_REQUEST",
    dueOn: "2026-09-25",
  });
  const createdCancel = await recordRetentionFollowUpTask(prisma, ownerA, {
    customerId: cancelCustomer.id,
    jobId: cancelJob.id,
    group: "NO_REVIEW_REQUEST",
    dueOn: "2026-09-25",
  });
  const createdBeta = await recordRetentionFollowUpTask(prisma, ownerB, {
    customerId: betaCustomer.id,
    jobId: betaJob.id,
    group: "NO_REVIEW_REQUEST",
    dueOn: "2026-09-26",
  });
  const communication = await prisma.customerFollowUp.create({
    data: {
      businessId: businessA.id,
      customerId: commCustomer.id,
      jobId: commJob.id,
      kind: "JOB_COMPLETE",
      status: "OPEN",
      origin: CUSTOMER_FOLLOW_UP_ORIGINS.COMMUNICATION,
      dueAt: overdueLa instanceof Date ? overdueLa : now,
      createdByMembershipId: ownerMem.id,
    },
  });

  check(
    "OWNER create stores business-timezone midnight for the due date",
    createdDueToday.outcome === "CREATED" &&
      createdDueToday.followUp.origin === CUSTOMER_FOLLOW_UP_ORIGINS.RETENTION_TASK &&
      createdDueToday.followUp.status === "OPEN" &&
      createdDueToday.followUp.dueAt?.getTime() === dueTodayLa.getTime() &&
      createdOverdue.followUp.dueAt?.getTime() === overdueLa.getTime() &&
      createdUpcoming.followUp.dueAt?.getTime() === upcomingLa.getTime() &&
      createdNone.followUp.dueAt == null,
  );

  const markedDone = await resolveRetentionFollowUpTaskStatus(prisma, ownerA, {
    followUpId: createdDone.followUp.id,
    status: "DONE",
  });
  const markedCancel = await resolveRetentionFollowUpTaskStatus(prisma, ownerA, {
    followUpId: createdCancel.followUp.id,
    status: "CANCELLED",
  });
  check(
    "DONE and CANCELLED keep their owner-set due dates",
    markedDone.followUp.status === "DONE" &&
      markedDone.followUp.dueAt?.getTime() === overdueLa.getTime() &&
      markedCancel.followUp.status === "CANCELLED" &&
      markedCancel.followUp.dueAt?.getTime() === overdueLa.getTime(),
  );

  const reRecordDone = await recordRetentionFollowUpTask(prisma, ownerA, {
    customerId: doneCustomer.id,
    jobId: doneJob.id,
    group: "NO_REVIEW_REQUEST",
    dueOn: "2026-09-26",
  });
  check(
    "Re-recording a DONE task can update dueAt without reopening or sending",
    reRecordDone.outcome === "UPDATED" &&
      reRecordDone.followUp.id === createdDone.followUp.id &&
      reRecordDone.followUp.status === "DONE" &&
      reRecordDone.followUp.dueAt?.getTime() === dueTodayLa.getTime(),
  );
  const reRecordEmpty = await recordRetentionFollowUpTask(prisma, ownerA, {
    customerId: customer.id,
    jobId: dueTodayJob.id,
    group: "NO_REVIEW_REQUEST",
  });
  check(
    "Re-recording without a due date leaves the existing dueAt and OPEN status",
    reRecordEmpty.outcome === "UPDATED" &&
      reRecordEmpty.followUp.id === createdDueToday.followUp.id &&
      reRecordEmpty.followUp.status === "OPEN" &&
      reRecordEmpty.followUp.dueAt?.getTime() === dueTodayLa.getTime(),
  );

  const workspace = await loadRetentionRecoveryCenter(prisma, {
    businessId: businessA.id,
    role: "OWNER",
    now,
  });
  const dueIds = workspace.groups.dueOrOverdue.map((row) => row.followUpId);
  check(
    "Due/overdue view includes OPEN due-today and overdue RETENTION_TASK rows",
    dueIds.includes(createdDueToday.followUp.id) &&
      dueIds.includes(createdOverdue.followUp.id) &&
      workspace.groups.dueOrOverdue.find((row) => row.followUpId === createdDueToday.followUp.id)
        ?.dueState === "DUE_TODAY" &&
      workspace.groups.dueOrOverdue.find((row) => row.followUpId === createdOverdue.followUp.id)
        ?.dueState === "OVERDUE",
  );
  check(
    "Upcoming, undated, DONE, CANCELLED, and COMMUNICATION rows stay out of the due view",
    !dueIds.includes(createdUpcoming.followUp.id) &&
      !dueIds.includes(createdNone.followUp.id) &&
      !dueIds.includes(createdDone.followUp.id) &&
      !dueIds.includes(createdCancel.followUp.id) &&
      !dueIds.includes(communication.id) &&
      !dueIds.includes(createdBeta.followUp.id),
  );
  check(
    "Recorded follow-up history still lists DONE and CANCELLED with their due dates",
    workspace.groups.recordedFollowUp.some(
      (row) =>
        row.followUpId === createdDone.followUp.id &&
        row.status === "DONE" &&
        row.dueState === "DUE_TODAY" &&
        row.dueAt?.getTime() === dueTodayLa.getTime(),
    ) &&
      workspace.groups.recordedFollowUp.some(
        (row) =>
          row.followUpId === createdCancel.followUp.id &&
          row.status === "CANCELLED" &&
          row.dueState === "OVERDUE",
      ) &&
      workspace.groups.recordedFollowUp.some(
        (row) => row.followUpId === createdUpcoming.followUp.id && row.dueState === "UPCOMING",
      ),
  );
  check(
    "Beta overdue task is visible only in the Beta workspace",
    workspace.groups.dueOrOverdue.every((row) => row.customerId !== betaCustomer.id) &&
      !JSON.stringify(workspace.groups).includes(betaCustomer.id),
  );
  const betaWorkspace = await loadRetentionRecoveryCenter(prisma, {
    businessId: businessB.id,
    role: "OWNER",
    now,
  });
  check(
    "Beta due view uses America/New_York so 2026-09-26 is overdue and excludes Alpha rows",
    betaWorkspace.timeZone === "America/New_York" &&
      betaWorkspace.groups.dueOrOverdue.length === 1 &&
      betaWorkspace.groups.dueOrOverdue[0].followUpId === createdBeta.followUp.id &&
      betaWorkspace.groups.dueOrOverdue[0].dueState === "OVERDUE" &&
      !JSON.stringify(betaWorkspace.groups).includes(customer.id),
  );

  console.log("\nTEST — no-send behavior");
  check(
    "Recording due dates did not send SMS or email",
    createdDueToday.followUp.status !== "SENT" &&
      (await prisma.customerCommunication.count({ where: { businessId: businessA.id } })) ===
        communicationsBefore &&
      (await prisma.businessEvent.count({
        where: { businessId: businessA.id, type: "CUSTOMER_FOLLOW_UP_DUE" },
      })) === dueEventsBefore &&
      (await prisma.customerFollowUp.findFirst({
        where: { id: createdDueToday.followUp.id },
        select: { sentAt: true, lastEmailStatus: true, lastSmsStatus: true },
      }))?.sentAt == null,
  );

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
  await scanScheduledBusinessEvents(prisma, businessA.id);
  const dueAfterScan = await prisma.businessEvent.findMany({
    where: { businessId: businessA.id, type: "CUSTOMER_FOLLOW_UP_DUE" },
    select: { subjectId: true },
  });
  check(
    "Enabled-rule scan emits a due event for COMMUNICATION only",
    dueAfterScan.some((row) => row.subjectId === communication.id) &&
      !dueAfterScan.some((row) => row.subjectId === createdDueToday.followUp.id) &&
      !dueAfterScan.some((row) => row.subjectId === createdOverdue.followUp.id) &&
      !dueAfterScan.some((row) => row.subjectId === createdDone.followUp.id) &&
      !dueAfterScan.some((row) => row.subjectId === createdCancel.followUp.id),
  );
  await processPendingAutomationRuns(prisma, businessA.id);
  const retentionAfterScan = await prisma.customerFollowUp.findUniqueOrThrow({
    where: { id: createdDueToday.followUp.id },
  });
  check(
    "Enabled-rule processing does not send an overdue retention task",
    retentionAfterScan.status === "OPEN" &&
      retentionAfterScan.sentAt == null &&
      retentionAfterScan.lastEmailStatus == null &&
      retentionAfterScan.lastSmsStatus == null &&
      (await prisma.customerCommunication.count({
        where: {
          businessId: businessA.id,
          relatedType: "CUSTOMER_FOLLOW_UP",
          relatedId: createdDueToday.followUp.id,
        },
      })) === 0,
  );

  const forcedDue = await emitBusinessEvent(prisma, {
    businessId: businessA.id,
    type: "CUSTOMER_FOLLOW_UP_DUE",
    subjectType: "CUSTOMER_FOLLOW_UP",
    subjectId: createdOverdue.followUp.id,
    payload: {
      customerId: customer.id,
      jobId: overdueJob.id,
      followUpId: createdOverdue.followUp.id,
      businessName: "Alpha Due",
    },
    idempotencyKey: `CUSTOMER_FOLLOW_UP_DUE:${createdOverdue.followUp.id}`,
  });
  await queueAutomationRunsForEvent(prisma, businessA.id, forcedDue.event);
  await processPendingAutomationRuns(prisma, businessA.id);
  const overdueAfterForced = await prisma.customerFollowUp.findUniqueOrThrow({
    where: { id: createdOverdue.followUp.id },
  });
  check(
    "A forced due event still does not send a retention-task message",
    overdueAfterForced.status === "OPEN" &&
      overdueAfterForced.sentAt == null &&
      (await prisma.customerCommunication.count({
        where: {
          businessId: businessA.id,
          relatedType: "CUSTOMER_FOLLOW_UP",
          relatedId: createdOverdue.followUp.id,
        },
      })) === 0,
  );
  const communicationAfter = await prisma.customerFollowUp.findUniqueOrThrow({
    where: { id: communication.id },
  });
  check(
    "COMMUNICATION follow-up remains a communication row after retention due writes",
    communicationAfter.origin === CUSTOMER_FOLLOW_UP_ORIGINS.COMMUNICATION &&
      communicationAfter.id === communication.id,
  );

  console.log("\nTEST — bounded due/overdue discovery");
  const extraCustomer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Bounded Bea" },
  });
  const extraJobs = [];
  for (let i = 0; i < 55; i += 1) {
    extraJobs.push(
      completedJob(businessA.id, extraCustomer.id, daysAgo(30 + i, now)).then((job) =>
        prisma.customerFollowUp.create({
          data: {
            businessId: businessA.id,
            customerId: extraCustomer.id,
            jobId: job.id,
            kind: "JOB_COMPLETE",
            status: "OPEN",
            origin: CUSTOMER_FOLLOW_UP_ORIGINS.RETENTION_TASK,
            dueAt: parseRetentionFollowUpDueOn(
              `2026-08-${String(Math.max(1, 28 - (i % 27))).padStart(2, "0")}`,
              "America/Los_Angeles",
            ),
            createdByMembershipId: ownerMem.id,
          },
        }),
      ),
    );
  }
  const extraRows = await Promise.all(extraJobs);
  const extraIds = extraRows.map((row) => row.id);
  const bounded = await loadRetentionRecoveryCenter(prisma, {
    businessId: businessA.id,
    role: "OWNER",
    customerId: extraCustomer.id,
    now,
  });
  check(
    "Due/overdue discovery is bounded to 50",
    bounded.groups.dueOrOverdue.length <= RETENTION_CANDIDATE_LIMIT &&
      bounded.candidateLimit === 50 &&
      bounded.groups.dueOrOverdue.every((row) => extraIds.includes(row.followUpId)),
  );
  check(
    "Customer-scoped due view does not include other-business or COMMUNICATION rows",
    bounded.groups.dueOrOverdue.every(
      (row) =>
        row.customerId === extraCustomer.id &&
        row.origin === CUSTOMER_FOLLOW_UP_ORIGINS.RETENTION_TASK &&
        row.status === "OPEN",
    ),
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
