/**
 * OWNER-recorded Job milestones: ordered set, explicit complete,
 * customer-visible subset on the token-scoped project portal.
 *
 * Proves ordering, OWNER authorization, token and tenant isolation,
 * duplicate updates, and historical status on a dedicated DB.
 * Does not infer completion from Job status, invoice, or crew checklist,
 * and does not send messages.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-job-milestones.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for job-milestone checks.");
  process.exit(generateEarly.status ?? 1);
}

const { ForbiddenError } = await import("@/lib/authorization");
const {
  DUPLICATE_TITLE_MESSAGE,
  JOB_NOT_FOUND_MESSAGE,
  MAX_JOB_MILESTONES,
  MAX_MILESTONE_TITLE_LENGTH,
  MILESTONE_BOUND_MESSAGE,
  NO_AUTOMATIC_MESSAGE_MESSAGE,
  NO_INFERRED_COMPLETION_MESSAGE,
  TITLE_REQUIRED_MESSAGE,
  TITLE_TOO_LONG_MESSAGE,
  applyOwnerCustomerVisibleFlag,
  assertCanManageJobMilestones,
  canManageJobMilestones,
  customerVisibleMilestones,
  isolateSameBusinessMilestones,
  milestoneTitleKey,
  parseMilestoneTitle,
  parseMilestoneTitleSet,
  parseMilestoneTitlesFromText,
  resolveRecordedMilestoneStatus,
} = await import("@/lib/job-milestones");
const {
  JobMilestoneError,
  completeJobMilestone,
  listJobMilestoneHistory,
  listOwnerJobMilestones,
  loadCustomerVisibleMilestonesForProjectToken,
  loadWorkOrderMilestones,
  recordJobMilestones,
  setJobMilestoneCustomerVisible,
} = await import("@/lib/job-milestone-ops");
const { resolveProjectProgressStep } = await import("@/lib/project-progress");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_job_milestones_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

{
  const { PrismaClient: AdminPrisma } = createRequire(import.meta.url)("@prisma/client");
  const admin = new AdminPrisma({ datasourceUrl: baseUrl });
  await admin.$queryRawUnsafe(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    testDbName,
  );
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  await admin.$disconnect();
}

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for job-milestone test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");
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

async function expectError(label, fn, predicate) {
  try {
    await fn();
    console.error(`FAIL - ${label} (no error thrown)`);
    failures += 1;
  } catch (error) {
    if (predicate(error)) {
      console.log(`  ok  - ${label}`);
    } else {
      console.error(`FAIL - ${label}`, error);
      failures += 1;
    }
  }
}

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

function readRepo(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

async function createWorkspace(name) {
  const business = await prisma.business.create({
    data: { name, slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID()}` },
  });
  const ownerUser = await prisma.user.create({
    data: {
      email: `owner-${randomUUID()}@example.com`,
      passwordHash: "x",
      name: `${name} Owner`,
    },
  });
  const adminUser = await prisma.user.create({
    data: {
      email: `admin-${randomUUID()}@example.com`,
      passwordHash: "x",
      name: `${name} Admin`,
    },
  });
  const memberUser = await prisma.user.create({
    data: {
      email: `member-${randomUUID()}@example.com`,
      passwordHash: "x",
      name: `${name} Member`,
    },
  });
  const owner = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: business.id, role: "OWNER" },
  });
  const admin = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: business.id, role: "ADMIN" },
  });
  const member = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: business.id, role: "MEMBER" },
  });
  return { business, owner, admin, member };
}

async function createJob(businessId, status = "SCHEDULED") {
  return prisma.job.create({
    data: {
      businessId,
      projectToken: randomUUID(),
      status,
    },
  });
}

try {
  const schema = readRepo("prisma/schema.prisma");
  const migration = readRepo("prisma/migrations/20260929010000_job_milestones/migration.sql");
  const libSrc = readRepo("src/lib/job-milestones.ts");
  const opsSrc = readRepo("src/lib/job-milestone-ops.ts");
  const actionSrc = readRepo("src/app/actions/job-milestones.ts");
  const workOrderSrc = readRepo("src/app/(app)/jobs/[jobId]/page.tsx");
  const portalSrc = readRepo("src/app/p/[token]/page.tsx");
  const progressSrc = readRepo("src/lib/project-progress.ts");
  const packageSrc = readRepo("package.json");
  const jobModel = schema.slice(schema.indexOf("model Job {"), schema.indexOf("model JobAppointmentEvent {"));

  console.log("\nSTATIC — Job-schema collision, no inference, no auto-messages");
  check(
    "Migration creates milestone tables without altering Job columns",
    migration.includes('CREATE TABLE IF NOT EXISTS "JobMilestone"') &&
      migration.includes('CREATE TABLE IF NOT EXISTS "JobMilestoneEvent"') &&
      !migration.includes('ALTER TABLE "Job"') &&
      !/ADD COLUMN/.test(migration),
  );
  check(
    "Job model adds only milestone relations, not milestone columns",
    jobModel.includes("milestones              JobMilestone[]") &&
      jobModel.includes("milestoneEvents         JobMilestoneEvent[]") &&
      !jobModel.includes("milestoneTitle") &&
      !jobModel.includes("milestoneStatus") &&
      !jobModel.includes("customerVisibleMilestone"),
  );
  check(
    "Ops never write Job.status, Invoice, or crew checklist",
    !/job\.(update|updateMany)/.test(opsSrc) &&
      !/invoice\.(create|update|updateMany)/i.test(opsSrc) &&
      !opsSrc.includes("checklistJson") &&
      !opsSrc.includes("JobCrewVisit") &&
      opsSrc.includes("never writes Job.status"),
  );
  check(
    "Ops and actions never send messages or automation events",
    !/mail|sendSms|sendOwnerSms|notifyCustomer|emitAndProcessBusinessEvent|resend/i.test(
      `${opsSrc}\n${actionSrc}`,
    ) &&
      libSrc.includes("never send email or SMS") &&
      opsSrc.includes("NO_AUTOMATIC_MESSAGE_MESSAGE") &&
      libSrc.includes("CUSTOMER_HIDDEN_BY_DEFAULT_MESSAGE"),
  );
  check(
    "Locked portal progress still infers only from Job/Invoice status",
    progressSrc.includes('if (invoice)') &&
      progressSrc.includes('return "INVOICE_RECEIPT"') &&
      !progressSrc.includes("JobMilestone") &&
      !progressSrc.includes("customerVisible"),
  );
  check(
    "Work Order and portal wire OWNER records and token-scoped exposure",
    workOrderSrc.includes("JobMilestonesCard") &&
      workOrderSrc.includes("canManageJobMilestones") &&
      workOrderSrc.includes("loadWorkOrderMilestones") &&
      !workOrderSrc.includes("milestones:") &&
      portalSrc.includes("loadCustomerVisibleMilestonesForProjectToken") &&
      portalSrc.includes("ProjectMilestonesList") &&
      portalSrc.includes("customerMilestones.jobId === job.id"),
  );
  check("Dedicated test script is registered", packageSrc.includes("test:job-milestones"));
  check("OWNER-only write gate", canManageJobMilestones("OWNER") && !canManageJobMilestones("ADMIN") && !canManageJobMilestones("MEMBER"));
  check("Blank set is rejected", parseMilestoneTitlesFromText("  \n ").error === TITLE_REQUIRED_MESSAGE);
  check("Too-long title is rejected", parseMilestoneTitle("x".repeat(MAX_MILESTONE_TITLE_LENGTH + 1)).error === TITLE_TOO_LONG_MESSAGE);
  check("Submitted duplicates are rejected", parseMilestoneTitleSet(["Prep", "prep"]).error === DUPLICATE_TITLE_MESSAGE);
  check("Ordering parser keeps owner sequence", parseMilestoneTitlesFromText("Prep\nInstall\nCleanup").items.map((item) => item.title).join("|") === "Prep|Install|Cleanup");
  check("New items default hidden from the customer", parseMilestoneTitlesFromText("Prep").items[0].customerVisible === false);
  check("OWNER can opt a recorded set into customer visibility", applyOwnerCustomerVisibleFlag(parseMilestoneTitlesFromText("Prep").items, true)[0].customerVisible === true);
  check("Bound is 8", MAX_JOB_MILESTONES === 8);
  check(
    "Recorded status ignores Job/Invoice/checklist stand-ins",
    resolveRecordedMilestoneStatus({ status: "OPEN", completedAt: null }) === "OPEN" &&
      resolveProjectProgressStep({ status: "COMPLETED" }, { status: "PAID" }) === "INVOICE_RECEIPT",
  );

  const alpha = await createWorkspace("Alpha Milestones");
  const beta = await createWorkspace("Beta Milestones");
  const ownerA = makeAccess(alpha.business.id, "OWNER", alpha.owner.id);
  const adminA = makeAccess(alpha.business.id, "ADMIN", alpha.admin.id);
  const memberA = makeAccess(alpha.business.id, "MEMBER", alpha.member.id);
  const ownerB = makeAccess(beta.business.id, "OWNER", beta.owner.id);

  const jobA = await createJob(alpha.business.id, "UNSCHEDULED");
  const jobA2 = await createJob(alpha.business.id, "IN_PROGRESS");
  const jobB = await createJob(beta.business.id, "SCHEDULED");

  console.log("\nDEDICATED DB — Ordering and explicit complete");
  const recorded = await recordJobMilestones(prisma, ownerA, {
    jobId: jobA.id,
    items: [
      { title: "Materials ordered", customerVisible: true },
      { title: "Site prep", customerVisible: false },
      { title: "Install", customerVisible: true },
    ],
  });
  check(
    "OWNER records the ordered set",
    recorded.milestones.length === 3 &&
      recorded.milestones.map((row) => row.title).join("|") ===
        "Materials ordered|Site prep|Install" &&
      recorded.milestones.map((row) => row.sortOrder).join(",") === "0,1,2",
  );
  check(
    "New milestones stay OPEN until explicitly completed",
    recorded.milestones.every((row) => row.status === "OPEN" && row.completedAt == null),
  );
  check(
    "Only OWNER-chosen rows are customer visible",
    recorded.milestones[0].customerVisible === true &&
      recorded.milestones[1].customerVisible === false &&
      recorded.milestones[2].customerVisible === true,
  );
  check(
    "Recording tells the owner that no customer message is sent",
    recorded.message === NO_AUTOMATIC_MESSAGE_MESSAGE,
  );

  const listed = await listOwnerJobMilestones(prisma, ownerA, jobA.id);
  check(
    "Owner list keeps recorded order",
    listed.map((row) => row.title).join("|") === "Materials ordered|Site prep|Install",
  );
  const adminRead = await loadWorkOrderMilestones(prisma, adminA, jobA.id);
  check(
    "ADMIN can read the Work Order milestone list but not mutate it",
    adminRead.map((row) => row.title).join("|") === "Materials ordered|Site prep|Install",
  );

  const completed = await completeJobMilestone(prisma, ownerA, recorded.milestones[0].id);
  check("OWNER can explicitly mark a milestone complete", completed.alreadyComplete === false && completed.milestone.status === "COMPLETED");
  check("Completed timestamp is recorded", completed.milestone.completedAt instanceof Date);
  check("Complete does not send a customer message", completed.message === NO_AUTOMATIC_MESSAGE_MESSAGE);

  const firstCompletedAt = completed.milestone.completedAt?.getTime();
  const duplicateComplete = await completeJobMilestone(prisma, ownerA, recorded.milestones[0].id);
  check("Duplicate complete is idempotent", duplicateComplete.alreadyComplete === true);
  check(
    "Duplicate complete keeps the original completedAt and COMPLETED status",
    duplicateComplete.milestone.status === "COMPLETED" &&
      duplicateComplete.milestone.completedAt?.getTime() === firstCompletedAt,
  );
  check(
    "Duplicate complete restates that completion is not inferred",
    duplicateComplete.message === NO_INFERRED_COMPLETION_MESSAGE,
  );

  const eventsAfterDuplicate = await listJobMilestoneHistory(prisma, ownerA, jobA.id);
  const completedEvents = eventsAfterDuplicate.filter(
    (event) => event.milestoneId === recorded.milestones[0].id && event.eventType === "COMPLETED",
  );
  check(
    "Historical status keeps a single COMPLETED event after a duplicate update",
    completedEvents.length === 1 &&
      eventsAfterDuplicate.some((event) => event.eventType === "RECORDED" && event.status === "OPEN") &&
      completedEvents[0].status === "COMPLETED",
  );

  console.log("\nDEDICATED DB — Token isolation and customer exposure");
  const portalA = await loadCustomerVisibleMilestonesForProjectToken(prisma, jobA.projectToken);
  check(
    "Token-scoped portal sees only OWNER-exposed milestones for that job",
    portalA?.jobId === jobA.id &&
      portalA.businessId === alpha.business.id &&
      portalA.milestones.map((row) => row.title).join("|") === "Materials ordered|Install" &&
      portalA.milestones[0].status === "COMPLETED" &&
      portalA.milestones[1].status === "OPEN",
  );
  check(
    "Hidden milestone never appears on the customer token",
    !portalA?.milestones.some((row) => row.title === "Site prep"),
  );

  await recordJobMilestones(prisma, ownerA, {
    jobId: jobA2.id,
    items: [{ title: "Other job milestone", customerVisible: true }],
  });
  const otherToken = await loadCustomerVisibleMilestonesForProjectToken(prisma, jobA2.projectToken);
  const sameTokenStill = await loadCustomerVisibleMilestonesForProjectToken(prisma, jobA.projectToken);
  check(
    "A second job token cannot see the first job's milestones",
    otherToken?.jobId === jobA2.id &&
      otherToken.milestones.length === 1 &&
      otherToken.milestones[0].title === "Other job milestone" &&
      sameTokenStill?.milestones.every((row) => row.title !== "Other job milestone"),
  );
  const missingToken = await loadCustomerVisibleMilestonesForProjectToken(prisma, randomUUID());
  check("Unknown token returns no milestones", missingToken === null);
  const emptyToken = await loadCustomerVisibleMilestonesForProjectToken(prisma, "   ");
  check("Blank token returns no milestones", emptyToken === null);

  const isolated = isolateSameBusinessMilestones(
    [...listed, { businessId: beta.business.id, title: "foreign" }],
    alpha.business.id,
  );
  check(
    "Isolation helper drops foreign-business rows",
    isolated.every((row) => row.businessId === alpha.business.id),
  );
  check(
    "customerVisibleMilestones helper keeps owner order of exposed rows only",
    customerVisibleMilestones(listed).map((row) => row.title).join("|") === "Materials ordered|Install",
  );

  console.log("\nDEDICATED DB — Tenant isolation and authorization");
  await expectError(
    "ADMIN cannot record milestones",
    () =>
      recordJobMilestones(prisma, adminA, {
        jobId: jobA.id,
        items: [{ title: "Admin should fail" }],
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot record milestones",
    () =>
      recordJobMilestones(prisma, memberA, {
        jobId: jobA.id,
        items: [{ title: "Member should fail" }],
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "ADMIN cannot complete a milestone",
    () => completeJobMilestone(prisma, adminA, recorded.milestones[2].id),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot expose a milestone",
    () =>
      setJobMilestoneCustomerVisible(prisma, memberA, {
        milestoneId: recorded.milestones[1].id,
        customerVisible: true,
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "Owner B cannot record on Owner A's job",
    () =>
      recordJobMilestones(prisma, ownerB, {
        jobId: jobA.id,
        items: [{ title: "Cross tenant" }],
      }),
    (error) =>
      error instanceof Error &&
      error.message === "Record is not in the authorized business workspace.",
  );
  await expectError(
    "Owner B cannot complete Owner A's milestone",
    () => completeJobMilestone(prisma, ownerB, recorded.milestones[2].id),
    (error) =>
      error instanceof Error &&
      error.message === "Record is not in the authorized business workspace.",
  );
  await expectError(
    "Owner B cannot list Owner A's milestones",
    () => listOwnerJobMilestones(prisma, ownerB, jobA.id),
    (error) =>
      error instanceof Error &&
      error.message === "Record is not in the authorized business workspace.",
  );
  await expectError(
    "Owner A cannot use a foreign job id",
    () =>
      recordJobMilestones(prisma, ownerA, {
        jobId: jobB.id,
        items: [{ title: "Should not attach" }],
      }),
    (error) =>
      error instanceof Error &&
      (error.message === "Record is not in the authorized business workspace." ||
        error.message === JOB_NOT_FOUND_MESSAGE),
  );

  const recordedB = await recordJobMilestones(prisma, ownerB, {
    jobId: jobB.id,
    items: [{ title: "Beta only", customerVisible: true }],
  });
  const portalB = await loadCustomerVisibleMilestonesForProjectToken(prisma, jobB.projectToken);
  const portalAAfterB = await loadCustomerVisibleMilestonesForProjectToken(prisma, jobA.projectToken);
  check(
    "Beta token sees only Beta milestones",
    portalB?.jobId === jobB.id &&
      portalB.milestones.length === 1 &&
      portalB.milestones[0].title === "Beta only" &&
      !portalAAfterB?.milestones.some((row) => row.title === "Beta only"),
  );
  check("Alpha token still has its own exposed set", portalAAfterB?.milestones.length === 2);

  const betaRows = await prisma.jobMilestone.findMany({
    where: { businessId: beta.business.id },
  });
  check(
    "Tenant rows stay on their own businessId",
    betaRows.length === 1 &&
      betaRows[0].id === recordedB.milestones[0].id &&
      betaRows[0].jobId === jobB.id,
  );

  console.log("\nDEDICATED DB — Duplicate titles, bound, and no inferred completion");
  await expectError(
    "Duplicate title on the same job is rejected",
    () =>
      recordJobMilestones(prisma, ownerA, {
        jobId: jobA.id,
        items: [{ title: "materials ordered" }],
      }),
    (error) => error instanceof JobMilestoneError && error.message === DUPLICATE_TITLE_MESSAGE,
  );
  const extraTitles = Array.from({ length: MAX_JOB_MILESTONES }, (_, index) => ({
    title: `Overflow ${index + 1}`,
  }));
  await expectError(
    "Recording past the small ordered-set bound is rejected",
    () => recordJobMilestones(prisma, ownerA, { jobId: jobA.id, items: extraTitles }),
    (error) => error instanceof JobMilestoneError && error.message === MILESTONE_BOUND_MESSAGE,
  );

  const stillOpen = recorded.milestones[2];
  await prisma.job.update({
    where: { id: jobA.id },
    data: { status: "COMPLETED" },
  });
  await prisma.invoice.create({
    data: {
      businessId: alpha.business.id,
      jobId: jobA.id,
      status: "PAID",
      total: new Prisma.Decimal(100),
    },
  });
  await prisma.jobCrewVisit.create({
    data: {
      businessId: alpha.business.id,
      jobId: jobA.id,
      checklistJson: JSON.stringify([{ label: "All done", checked: true }]),
      outcomeStatus: "VISIT_COMPLETED",
    },
  });
  const afterInferred = await prisma.jobMilestone.findFirst({
    where: { id: stillOpen.id, businessId: alpha.business.id },
  });
  check(
    "Job COMPLETED + PAID invoice + crew checklist do not complete a milestone",
    afterInferred?.status === "OPEN" && afterInferred.completedAt == null,
  );
  check(
    "Inferred project progress can be COMPLETED/INVOICE while the milestone stays OPEN",
    resolveProjectProgressStep({ status: "COMPLETED" }, { status: "PAID" }) === "INVOICE_RECEIPT" &&
      resolveRecordedMilestoneStatus(afterInferred) === "OPEN",
  );

  const exposeHidden = await setJobMilestoneCustomerVisible(prisma, ownerA, {
    milestoneId: recorded.milestones[1].id,
    customerVisible: true,
  });
  check("OWNER can later expose a hidden milestone", exposeHidden.unchanged === false && exposeHidden.milestone.customerVisible === true);
  const exposeAgain = await setJobMilestoneCustomerVisible(prisma, ownerA, {
    milestoneId: recorded.milestones[1].id,
    customerVisible: true,
  });
  check("Duplicate visibility update is a no-op", exposeAgain.unchanged === true);

  const portalAfterExpose = await loadCustomerVisibleMilestonesForProjectToken(
    prisma,
    jobA.projectToken,
  );
  check(
    "Newly exposed milestone appears in recorded order on the same token",
    portalAfterExpose?.milestones.map((row) => row.title).join("|") ===
      "Materials ordered|Site prep|Install",
  );

  const history = await listJobMilestoneHistory(prisma, ownerA, jobA.id);
  check(
    "History keeps RECORDED, COMPLETED, and CUSTOMER_EXPOSED snapshots",
    history.some((event) => event.eventType === "RECORDED" && event.status === "OPEN") &&
      history.some((event) => event.eventType === "COMPLETED" && event.status === "COMPLETED") &&
      history.some((event) => event.eventType === "CUSTOMER_EXPOSED") &&
      history.every((event) => event.createdAt instanceof Date),
  );

  await expectError(
    "assertCanManageJobMilestones rejects ADMIN",
    async () => {
      assertCanManageJobMilestones(adminA);
    },
    (error) => error instanceof ForbiddenError,
  );

  const leftover = await prisma.jobMilestone.findMany({
    where: { jobId: jobA.id, businessId: alpha.business.id },
    orderBy: { sortOrder: "asc" },
  });
  check(
    "Same-job milestones remain the original ordered set",
    leftover.map((row) => row.title).join("|") === "Materials ordered|Site prep|Install",
  );
} finally {
  await prisma.$disconnect();
}

if (failures > 0) {
  console.error(`\n${failures} job-milestone check(s) failed.`);
  process.exit(1);
}
console.log("\nAll job-milestone checks passed.");
