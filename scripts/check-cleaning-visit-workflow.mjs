/**
 * Cleaning recurring-visit + crew-checklist workflow proofs.
 *
 * Dedicated database: tbbt_cleaning_visit_workflow_test
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-cleaning-visit-workflow.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for Cleaning visit checks.");
  process.exit(generateEarly.status ?? 1);
}

const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const { ForbiddenError } = await import("@/lib/authorization");
const {
  archivedIntakeSchema,
  currentIntakeSchema,
} = await import("@/lib/intake-schema");
const {
  CLEANING_PACK_CREW_CHECKLIST,
  CLEANING_VISIT_ONLY_MESSAGE,
  OWNER_SETS_CADENCE_MESSAGE,
  ASSIGNED_WORKER_ONLY_MESSAGE,
  START_BEFORE_COMPLETE_MESSAGE,
  cleaningVisitWorkflowEligible,
  ownerCadencePlan,
  parseRecordedVisitOutcome,
  parseVisitOutcomeStatus,
  resolveJobTradeCode,
  visitOutcomeLabel,
} = await import("@/lib/cleaning-visit-workflow");
const {
  attachCleaningCrewChecklist,
  cleaningVisitErrorMessage,
  countBusinessJobs,
  recordAssignedVisitOutcome,
  setAssignedChecklistItem,
  setCleaningVisitCadence,
} = await import("@/lib/cleaning-visit-ops");
const { loadAssignedCleaningVisitView, loadCleaningVisitView } = await import(
  "@/lib/cleaning-visit-data"
);
const { createOperatingProcedure, setOperatingProcedureApproval } = await import(
  "@/lib/operating-procedures-ops"
);
const { weekRange } = await import("@/lib/time-cards");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run the Cleaning visit workflow check.");
  process.exit(1);
}

const testDbName = "tbbt_cleaning_visit_workflow_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) process.exit(push.status ?? 1);

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

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

async function expectThrow(label, fn, predicate) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

function makeAccess(businessId, role, membershipId, userId) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      user: { id: userId, email: `${role.toLowerCase()}@example.com`, name: role },
      business: { id: businessId, name: "Visit Co", timezone: "America/New_York" },
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

const workflowFiles = [
  "src/lib/cleaning-visit-workflow.ts",
  "src/lib/cleaning-visit-ops.ts",
  "src/lib/cleaning-visit-data.ts",
  "src/app/actions/cleaning-visit.ts",
  "src/components/jobs/cleaning-visit-cadence-form.tsx",
  "src/components/field/cleaning-crew-checklist.tsx",
];
const workflowSrc = workflowFiles.map(read).join("\n");
const intakeSrc = read("src/lib/intake-schema.ts");
const handySrc = read("src/lib/handyman-starter-catalog.ts");
const migration = read("prisma/migrations/20260927180000_job_crew_visit/migration.sql");

const PRE_162_V1_FIELD_KEYS = [
  "selectedWork",
  "bedrooms",
  "bathrooms",
  "homeSize",
  "frequency",
  "addons",
  "pets",
  "petNotes",
  "accessNotes",
  "photos",
  "notes",
];
const V2_ONLY_FIELDS = ["propertyType", "occupancy", "condition", "visitContext"];

console.log("\nSTATIC — Reuses Jobs / scheduling / field records");
check(
  "Cadence writes existing Job recurrence columns, not a second schedule",
  read("src/lib/cleaning-visit-ops.ts").includes("recurrenceCadence") &&
    read("src/lib/cleaning-visit-ops.ts").includes("nextOccurrenceAt") &&
    !read("src/lib/cleaning-visit-ops.ts").includes("prisma.job.create") &&
    !workflowSrc.includes("job.create("),
);
check(
  "Checklist reuses OperatingProcedure or the Cleaning pack default",
  read("src/lib/cleaning-visit-ops.ts").includes("operatingProcedure.findFirst") &&
    read("src/lib/cleaning-visit-workflow.ts").includes("CLEANING_PACK_CREW_CHECKLIST") &&
    CLEANING_PACK_CREW_CHECKLIST.length === 6,
);
check(
  "Visit outcomes are exact recorded statuses",
  parseVisitOutcomeStatus("VISIT_COMPLETED") === "VISIT_COMPLETED" &&
    parseVisitOutcomeStatus("RE_CLEAN_REQUESTED") === "RE_CLEAN_REQUESTED" &&
    parseRecordedVisitOutcome("VISIT_COMPLETED") === "VISIT_COMPLETED" &&
    visitOutcomeLabel("RE_CLEAN_REQUESTED") === "Re-clean requested" &&
    visitOutcomeLabel("NONE") === "No visit outcome recorded",
);
check(
  "VISIT_COMPLETED writes the visit and Job complete in one transaction",
  read("src/lib/cleaning-visit-ops.ts").includes("$transaction") &&
    read("src/lib/cleaning-visit-ops.ts").includes(
      "completeJobWithRunningTimeSafetyInTransaction",
    ) &&
    !read("src/lib/cleaning-visit-ops.ts").includes("completeJobWithRunningTimeSafety(db"),
);
check(
  "Handyman jobs are not eligible; Cleaning recurrenceSupport is required",
  cleaningVisitWorkflowEligible("CLEANING") === true &&
    cleaningVisitWorkflowEligible("HANDYMAN") === false &&
    resolveJobTradeCode({ requestTradeCode: "CLEANING" }) === "CLEANING" &&
    resolveJobTradeCode({ catalogTradeCodes: ["HANDYMAN"] }) === "HANDYMAN",
);
check(
  "Owner cadence planner accepts weekly/biweekly/monthly and one-time",
  ownerCadencePlan("WEEKLY").ok === true &&
    ownerCadencePlan("WEEKLY").plan.serviceIntent === "RECURRING" &&
    ownerCadencePlan("ONE_TIME").plan.serviceIntent === "ONE_TIME" &&
    ownerCadencePlan("DAILY").ok === false,
);

console.log("\nSTATIC — No silent jobs, messages, certification, CRM, or payments");
check(
  "Workflow files never create jobs, invoices, payments, or customers",
  !/createInvoice|createCustomer|stripe|Payment\.create|invoice\.create|customer\.create/i.test(
    workflowSrc,
  ) &&
    !workflowSrc.includes("sendCustomer") &&
    !workflowSrc.includes("emitAndProcessBusinessEvent") &&
    !workflowSrc.includes("appointmentNotification") &&
    !workflowSrc.includes("resend") &&
    !workflowSrc.includes("twilio"),
);
check(
  "No invented quality stamp or fake customer claims",
  !/certified|certification|licensed and insured|#1|five-star/i.test(workflowSrc),
);
check(
  "Migration is additive and does not alter Business / Job / Membership columns",
  migration.includes('CREATE TABLE IF NOT EXISTS "JobCrewVisit"') &&
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migration) &&
    !/ALTER TABLE "(Job|Business|Membership)"/.test(migration) &&
    /ALTER TABLE "JobCrewVisit"/.test(migration),
);

console.log("\nSTATIC — Cleaning V1/V2 and Handyman intake history stay intact");
const archivedV1 = archivedIntakeSchema("cleaning.public", 1);
const cleaningV2 = currentIntakeSchema("CLEANING");
const handyV1 = currentIntakeSchema("HANDYMAN");
check(
  "Cleaning public V1 field set is unchanged",
  archivedV1?.version === 1 &&
    archivedV1.fields.map((field) => field.key).join(",") === PRE_162_V1_FIELD_KEYS.join(","),
);
check(
  "Cleaning public V2 remains current and still includes V2-only fields",
  cleaningV2.version === 2 &&
    V2_ONLY_FIELDS.every((key) => cleaningV2.fields.some((field) => field.key === key)),
);
check(
  "Handyman public V1 remains current",
  handyV1.key === "handyman.public" &&
    handyV1.version === 1 &&
    handyV1.fields.map((field) => field.key).join(",") ===
      "selectedWork,measurements,photos,notes,frequency",
);
check(
  "This workflow does not edit intake-schema or Handyman starter history",
  !workflowSrc.includes("CLEANING_PUBLIC_V1") &&
    !workflowSrc.includes("HANDYMAN_PUBLIC_V1") &&
    handySrc.includes("Standard Door Knob Replacement") &&
    !intakeSrc.includes("JobCrewVisit"),
);

try {
  console.log("\nLIVE — OWNER cadence, assigned checklist, exact outcomes, auth, isolation");
  const suffix = randomUUID().slice(0, 8);
  const ownerUser = await prisma.user.create({
    data: { name: "Clean Owner", email: `clean-owner-${suffix}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Clean Admin", email: `clean-admin-${suffix}@example.com`, passwordHash: "x" },
  });
  const workerUser = await prisma.user.create({
    data: { name: "Clean Worker", email: `clean-worker-${suffix}@example.com`, passwordHash: "x" },
  });
  const otherWorkerUser = await prisma.user.create({
    data: { name: "Other Worker", email: `clean-other-${suffix}@example.com`, passwordHash: "x" },
  });
  const ownerBUser = await prisma.user.create({
    data: { name: "Beta Owner", email: `beta-owner-${suffix}@example.com`, passwordHash: "x" },
  });
  const handyOwnerUser = await prisma.user.create({
    data: { name: "Handy Owner", email: `handy-owner-${suffix}@example.com`, passwordHash: "x" },
  });

  const cleanA = await prisma.business.create({
    data: { name: "Alpha Clean", slug: `alpha-visit-${suffix}`, tradeCode: "CLEANING" },
  });
  const cleanB = await prisma.business.create({
    data: { name: "Beta Clean", slug: `beta-visit-${suffix}`, tradeCode: "CLEANING" },
  });
  const handyC = await prisma.business.create({
    data: { name: "Gamma Handy", slug: `gamma-visit-${suffix}`, tradeCode: "HANDYMAN" },
  });

  const memOwnerA = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: cleanA.id, role: "OWNER" },
  });
  const memAdminA = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: cleanA.id, role: "ADMIN" },
  });
  const memWorkerA = await prisma.membership.create({
    data: { userId: workerUser.id, businessId: cleanA.id, role: "MEMBER" },
  });
  const memOtherA = await prisma.membership.create({
    data: { userId: otherWorkerUser.id, businessId: cleanA.id, role: "MEMBER" },
  });
  const memOwnerB = await prisma.membership.create({
    data: { userId: ownerBUser.id, businessId: cleanB.id, role: "OWNER" },
  });
  const memHandy = await prisma.membership.create({
    data: { userId: handyOwnerUser.id, businessId: handyC.id, role: "OWNER" },
  });

  const ownerA = makeAccess(cleanA.id, "OWNER", memOwnerA.id, ownerUser.id);
  const adminA = makeAccess(cleanA.id, "ADMIN", memAdminA.id, adminUser.id);
  const workerA = makeAccess(cleanA.id, "MEMBER", memWorkerA.id, workerUser.id);
  const ownerB = makeAccess(cleanB.id, "OWNER", memOwnerB.id, ownerBUser.id);
  const handyOwner = makeAccess(handyC.id, "OWNER", memHandy.id, handyOwnerUser.id);

  async function createTradeJob(businessId, tradeCode, assignedMembershipId) {
    const customer = await prisma.customer.create({
      data: { businessId, name: `${tradeCode} Customer`, email: `${tradeCode}-${randomUUID().slice(0, 6)}@example.com` },
    });
    const request = await prisma.serviceRequest.create({
      data: {
        businessId,
        customerId: customer.id,
        description: `${tradeCode} visit`,
        tradeCode,
        serviceIntent: "ONE_TIME",
      },
    });
    const estimate = await prisma.estimate.create({
      data: {
        businessId,
        customerId: customer.id,
        serviceRequestId: request.id,
        status: "APPROVED",
        publicToken: randomUUID(),
        total: 140,
      },
    });
    return prisma.job.create({
      data: {
        businessId,
        customerId: customer.id,
        estimateId: estimate.id,
        projectToken: randomUUID(),
        status: "SCHEDULED",
        scheduledAt: new Date("2026-09-28T14:00:00.000Z"),
        assignedMembershipId,
      },
    });
  }

  const jobA = await createTradeJob(cleanA.id, "CLEANING", memWorkerA.id);
  const jobA2 = await createTradeJob(cleanA.id, "CLEANING", memWorkerA.id);
  const jobB = await createTradeJob(cleanB.id, "CLEANING", memOwnerB.id);
  const handyJob = await createTradeJob(handyC.id, "HANDYMAN", memHandy.id);
  const jobsBeforeCadence = await countBusinessJobs(prisma, cleanA.id);

  await expectThrow(
    "ADMIN cannot set cadence",
    () => setCleaningVisitCadence(prisma, adminA, { jobId: jobA.id, cadence: "WEEKLY" }),
    (error) =>
      error instanceof ForbiddenError &&
      cleaningVisitErrorMessage(error, "") === OWNER_SETS_CADENCE_MESSAGE,
  );
  await expectThrow(
    "MEMBER cannot set cadence",
    () => setCleaningVisitCadence(prisma, workerA, { jobId: jobA.id, cadence: "WEEKLY" }),
    (error) => error instanceof ForbiddenError,
  );
  await expectThrow(
    "OWNER cannot set cadence on a Handyman job",
    () => setCleaningVisitCadence(prisma, handyOwner, { jobId: handyJob.id, cadence: "WEEKLY" }),
    (error) =>
      error instanceof Error && error.message === CLEANING_VISIT_ONLY_MESSAGE,
  );
  await expectThrow(
    "OWNER A cannot set cadence on business B job",
    () => setCleaningVisitCadence(prisma, ownerA, { jobId: jobB.id, cadence: "WEEKLY" }),
    (error) =>
      error instanceof Error &&
      error.message === "Record is not in the authorized business workspace.",
  );

  const weekly = await setCleaningVisitCadence(prisma, ownerA, {
    jobId: jobA.id,
    cadence: "WEEKLY",
  });
  const jobsAfterCadence = await countBusinessJobs(prisma, cleanA.id);
  const visitA = await prisma.jobCrewVisit.findFirst({
    where: { jobId: jobA.id, businessId: cleanA.id },
  });
  check(
    "OWNER sets WEEKLY on the existing Job and does not create later jobs",
    weekly.serviceIntent === "RECURRING" &&
      weekly.recurrenceCadence === "WEEKLY" &&
      weekly.recurrenceStatus === "ACTIVE" &&
      weekly.nextOccurrenceAt instanceof Date &&
      jobsAfterCadence === jobsBeforeCadence &&
      visitA?.outcomeStatus === "NONE",
  );

  const ownerView = await loadCleaningVisitView(prisma, ownerA, jobA.id);
  const handyView = await loadCleaningVisitView(prisma, handyOwner, handyJob.id);
  const leaked = await loadCleaningVisitView(prisma, ownerA, jobB.id);
  check(
    "Owner view is Cleaning-only and tenant-scoped",
    ownerView?.eligible === true &&
      ownerView.checklist.length === CLEANING_PACK_CREW_CHECKLIST.length &&
      handyView?.eligible === false &&
      leaked === null,
  );

  const assignedView = await loadAssignedCleaningVisitView(
    prisma,
    { businessId: cleanA.id, membershipId: memWorkerA.id },
    jobA.id,
  );
  const unassignedView = await loadAssignedCleaningVisitView(
    prisma,
    { businessId: cleanA.id, membershipId: memOtherA.id },
    jobA.id,
  );
  const crossView = await loadAssignedCleaningVisitView(
    prisma,
    { businessId: cleanB.id, membershipId: memOwnerB.id },
    jobA.id,
  );
  check(
    "Assigned worker sees the checklist; unassigned and cross-tenant do not",
    assignedView?.checklist.length === CLEANING_PACK_CREW_CHECKLIST.length &&
      assignedView.outcomeStatus === "NONE" &&
      unassignedView === null &&
      crossView === null,
  );

  await setAssignedChecklistItem(
    prisma,
    { businessId: cleanA.id, membershipId: memWorkerA.id },
    { jobId: jobA.id, itemKey: "kitchen", checked: true },
  );
  await expectThrow(
    "Unassigned worker cannot toggle the checklist",
    () =>
      setAssignedChecklistItem(
        prisma,
        { businessId: cleanA.id, membershipId: memOtherA.id },
        { jobId: jobA.id, itemKey: "kitchen", checked: false },
      ),
    (error) => error instanceof Error && error.message === ASSIGNED_WORKER_ONLY_MESSAGE,
  );
  await expectThrow(
    "Cross-tenant worker cannot toggle the checklist",
    () =>
      setAssignedChecklistItem(
        prisma,
        { businessId: cleanB.id, membershipId: memOwnerB.id },
        { jobId: jobA.id, itemKey: "kitchen", checked: false },
      ),
    (error) => error instanceof Error && error.message === ASSIGNED_WORKER_ONLY_MESSAGE,
  );
  const afterToggle = await prisma.jobCrewVisit.findFirst({
    where: { jobId: jobA.id, businessId: cleanA.id },
  });
  check(
    "Assigned worker checkmark is persisted only on the owned visit",
    JSON.parse(afterToggle.checklistJson).find((item) => item.key === "kitchen")?.checked === true,
  );

  await expectThrow(
    "Visit completed is refused before the job is started",
    () =>
      recordAssignedVisitOutcome(
        prisma,
        { businessId: cleanA.id, membershipId: memWorkerA.id },
        { jobId: jobA.id, outcomeStatus: "VISIT_COMPLETED" },
      ),
    (error) => error instanceof Error && error.message === START_BEFORE_COMPLETE_MESSAGE,
  );

  await prisma.job.update({
    where: { id: jobA.id },
    data: { status: "IN_PROGRESS" },
  });
  const reclean = await recordAssignedVisitOutcome(
    prisma,
    { businessId: cleanA.id, membershipId: memWorkerA.id },
    { jobId: jobA.id, outcomeStatus: "RE_CLEAN_REQUESTED" },
  );
  const jobsAfterReclean = await countBusinessJobs(prisma, cleanA.id);
  const jobAfterReclean = await prisma.job.findFirst({
    where: { id: jobA.id, businessId: cleanA.id },
  });
  check(
    "Requested re-clean records that exact status and does not complete or clone the job",
    reclean.visit.outcomeStatus === "RE_CLEAN_REQUESTED" &&
      reclean.visit.outcomeRecordedByMembershipId === memWorkerA.id &&
      reclean.visit.outcomeRecordedAt instanceof Date &&
      reclean.jobStatus === "IN_PROGRESS" &&
      jobAfterReclean?.status === "IN_PROGRESS" &&
      jobsAfterReclean === jobsBeforeCadence,
  );

  const completed = await recordAssignedVisitOutcome(
    prisma,
    { businessId: cleanA.id, membershipId: memWorkerA.id },
    { jobId: jobA.id, outcomeStatus: "VISIT_COMPLETED" },
  );
  const jobAfterComplete = await prisma.job.findFirst({
    where: { id: jobA.id, businessId: cleanA.id },
  });
  const jobsAfterComplete = await countBusinessJobs(prisma, cleanA.id);
  check(
    "Visit completed records that exact status and completes the existing Job only",
    completed.visit.outcomeStatus === "VISIT_COMPLETED" &&
      completed.jobStatus === "COMPLETED" &&
      jobAfterComplete?.status === "COMPLETED" &&
      jobsAfterComplete === jobsBeforeCadence &&
      jobAfterComplete.recurrenceCadence === "WEEKLY",
  );

  const jobAtomic = await createTradeJob(cleanA.id, "CLEANING", memWorkerA.id);
  await setCleaningVisitCadence(prisma, ownerA, {
    jobId: jobAtomic.id,
    cadence: "WEEKLY",
  });
  await prisma.job.update({
    where: { id: jobAtomic.id },
    data: { status: "IN_PROGRESS" },
  });
  const atomicStartedAt = new Date();
  await prisma.timeEntry.create({
    data: {
      businessId: cleanA.id,
      membershipId: memWorkerA.id,
      jobId: jobAtomic.id,
      activityType: "JOB",
      status: "RUNNING",
      startedAt: atomicStartedAt,
      source: "CLOCK",
    },
  });
  await prisma.timesheetWeek.create({
    data: {
      businessId: cleanA.id,
      membershipId: memWorkerA.id,
      weekStartedAt: weekRange(atomicStartedAt).start,
      status: "APPROVED",
      approvedAt: new Date(),
      approvedByMembershipId: memOwnerA.id,
    },
  });
  await expectThrow(
    "Approved-week running Job time refuses VISIT_COMPLETED",
    () =>
      recordAssignedVisitOutcome(
        prisma,
        { businessId: cleanA.id, membershipId: memWorkerA.id },
        { jobId: jobAtomic.id, outcomeStatus: "VISIT_COMPLETED" },
      ),
    (error) =>
      error instanceof Error &&
      /approved job time is still running/i.test(error.message),
  );
  const visitAfterAtomicFail = await prisma.jobCrewVisit.findFirst({
    where: { jobId: jobAtomic.id, businessId: cleanA.id },
  });
  const jobAfterAtomicFail = await prisma.job.findFirst({
    where: { id: jobAtomic.id, businessId: cleanA.id },
  });
  check(
    "Failed Job completion leaves neither the visit nor the Job completed",
    visitAfterAtomicFail?.outcomeStatus === "NONE" &&
      visitAfterAtomicFail?.outcomeRecordedAt == null &&
      visitAfterAtomicFail?.outcomeRecordedByMembershipId == null &&
      jobAfterAtomicFail?.status === "IN_PROGRESS",
  );

  const procedure = await createOperatingProcedure(prisma, ownerA, {
    title: "Alpha Standard Clean",
    tradeCode: "CLEANING",
    steps: [{ title: "Entry mats" }, { title: "Guest bath" }, { title: "Exit walkthrough" }],
  });
  await setOperatingProcedureApproval(prisma, ownerA, {
    procedureId: procedure.id,
    approvalState: "APPROVED",
  });
  const attached = await attachCleaningCrewChecklist(prisma, ownerA, {
    jobId: jobA2.id,
    procedureId: procedure.id,
  });
  await expectThrow(
    "OWNER B cannot attach a checklist to business A",
    () =>
      attachCleaningCrewChecklist(prisma, ownerB, {
        jobId: jobA2.id,
        procedureId: procedure.id,
      }),
    (error) =>
      error instanceof Error &&
      error.message === "Record is not in the authorized business workspace.",
  );
  const attachedView = await loadCleaningVisitView(prisma, ownerA, jobA2.id);
  check(
    "OWNER can attach an approved Cleaning procedure as the crew checklist",
    attached.procedureId === procedure.id &&
      attachedView?.procedureTitle === "Alpha Standard Clean" &&
      attachedView.checklist.map((item) => item.title).join("|") ===
        "Entry mats|Guest bath|Exit walkthrough",
  );

  const bVisit = await prisma.jobCrewVisit.findMany({ where: { businessId: cleanB.id } });
  const aVisits = await prisma.jobCrewVisit.findMany({ where: { businessId: cleanA.id } });
  check(
    "Visit records stay isolated by businessId",
    bVisit.length === 0 &&
      aVisits.every((row) => row.businessId === cleanA.id) &&
      aVisits.some((row) => row.jobId === jobA.id && row.outcomeStatus === "VISIT_COMPLETED"),
  );
} catch (error) {
  failed += 1;
  console.error("FAIL - live Cleaning visit workflow", error);
} finally {
  await prisma.$disconnect();
}

console.log(
  failed === 0
    ? `\nAll Cleaning visit workflow checks passed (${passed}).`
    : `\n${failed} Cleaning visit workflow check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
