/**
 * OWNER corrective Cleaning job after RE_CLEAN_REQUESTED.
 *
 * Dedicated database: tbbt_cleaning_corrective_clean_test
 *
 * Proves tenant isolation, OWNER authorization, business-timezone dates,
 * and concurrent duplicate-submit. Distinct from a regular next booking.
 * Does not invoice, charge, or message the customer.
 *
 * Run with:
 *   npm run test:cleaning-corrective-clean
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
  console.error("Failed to generate Prisma client for Cleaning corrective-clean checks.");
  process.exit(generateEarly.status ?? 1);
}

const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const { ForbiddenError } = await import("@/lib/authorization");
const { formatISODateInTimeZone } = await import("@/lib/business-timezone");
const { parseScheduleStart } = await import("@/lib/job-schedule");
const {
  CLEANING_CORRECTIVE_CLEAN_CONFIRM_REQUIRED_MESSAGE,
  CLEANING_CORRECTIVE_CLEAN_CUSTOMER_REQUIRED_MESSAGE,
  CLEANING_CORRECTIVE_CLEAN_DATE_REQUIRED_MESSAGE,
  CLEANING_CORRECTIVE_CLEAN_INVALID_DATE_MESSAGE,
  CLEANING_CORRECTIVE_CLEAN_ONLY_MESSAGE,
  CLEANING_CORRECTIVE_CLEAN_PROPERTY_REQUIRED_MESSAGE,
  CLEANING_CORRECTIVE_CLEAN_RE_CLEAN_REQUIRED_MESSAGE,
  CLEANING_CORRECTIVE_CLEAN_SCOPE_REQUIRED_MESSAGE,
  CLEANING_CORRECTIVE_CLEAN_CREATED_MESSAGE,
  DEFAULT_CORRECTIVE_CLEAN_TIME,
  OWNER_SCHEDULES_CORRECTIVE_CLEAN_MESSAGE,
  cleaningCorrectiveCleanEligible,
  correctiveCleanCivilDate,
  oneTimeCorrectiveCleanPlan,
  parseOwnerCorrectiveCleanConfirmation,
  parseOwnerCorrectiveCleanStart,
  visitRequestedReClean,
} = await import("@/lib/cleaning-corrective-clean");
const {
  cleaningCorrectiveCleanErrorMessage,
  countBusinessInvoices,
  countBusinessJobs,
  countBusinessPayments,
  scheduleCorrectiveCleanFromReCleanRequestedJob,
} = await import("@/lib/cleaning-corrective-clean-ops");
const { loadCleaningCorrectiveCleanReview } = await import(
  "@/lib/cleaning-corrective-clean-data"
);
const { createNextBookingFromCompletedCleaningJob } = await import(
  "@/lib/cleaning-next-booking-ops"
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run the Cleaning corrective-clean check.");
  process.exit(1);
}

const testDbName = "tbbt_cleaning_corrective_clean_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;

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

function makeAccess(businessId, role, membershipId, userId, timezone) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      user: { id: userId, email: `${role.toLowerCase()}@example.com`, name: role },
      business: { id: businessId, name: "Corrective Clean Co", timezone },
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

const featureFiles = [
  "src/lib/cleaning-corrective-clean.ts",
  "src/lib/cleaning-corrective-clean-ops.ts",
  "src/lib/cleaning-corrective-clean-data.ts",
  "src/app/actions/cleaning-corrective-clean.ts",
  "src/components/jobs/cleaning-corrective-clean-form.tsx",
  "src/app/(app)/jobs/[jobId]/page.tsx",
];
const featureSrc = featureFiles.map(read).join("\n");
const opsSrc = read("src/lib/cleaning-corrective-clean-ops.ts");
const actionSrc = read("src/app/actions/cleaning-corrective-clean.ts");
const dataSrc = read("src/lib/cleaning-corrective-clean-data.ts");
const formSrc = read("src/components/jobs/cleaning-corrective-clean-form.tsx");
const pageSrc = read("src/app/(app)/jobs/[jobId]/page.tsx");
const schemaSrc = read("prisma/schema.prisma");
const migrationSrc = read(
  "prisma/migrations/20260928145000_job_corrective_clean_source_unique/migration.sql",
);

console.log("\nSTATIC — one explicit corrective clean, distinct from next booking");
check(
  "OWNER-only gate and Cleaning RE_CLEAN_REQUESTED eligibility",
  OWNER_SCHEDULES_CORRECTIVE_CLEAN_MESSAGE.includes("business owner") &&
    cleaningCorrectiveCleanEligible("CLEANING") === true &&
    cleaningCorrectiveCleanEligible("HANDYMAN") === false &&
    visitRequestedReClean("RE_CLEAN_REQUESTED") === true &&
    visitRequestedReClean("VISIT_COMPLETED") === false &&
    visitRequestedReClean("NONE") === false &&
    oneTimeCorrectiveCleanPlan().serviceIntent === "ONE_TIME" &&
    oneTimeCorrectiveCleanPlan().recurrenceCadence === "" &&
    oneTimeCorrectiveCleanPlan().nextOccurrenceAt === null,
);
check(
  "Date and confirmation parsers require explicit values",
  parseOwnerCorrectiveCleanConfirmation("1") === true &&
    parseOwnerCorrectiveCleanConfirmation("") === false &&
    parseOwnerCorrectiveCleanConfirmation("no") === false &&
    parseOwnerCorrectiveCleanStart({ date: "", timeZone: "America/Los_Angeles" }) === null &&
    parseOwnerCorrectiveCleanStart({
      date: "2026-09-28",
      time: "18:00",
      timeZone: "America/Los_Angeles",
    })?.toISOString() === "2026-09-29T01:00:00.000Z",
);
check(
  "Write path creates exactly one Job and does not invoice, charge, or message",
  opsSrc.includes("tx.job.create") &&
    !opsSrc.includes("invoice.create") &&
    !opsSrc.includes("persistDraftInvoice") &&
    !opsSrc.includes("completeJobAndSendInvoice") &&
    !opsSrc.includes("payment.create") &&
    !opsSrc.includes("notifyCustomer") &&
    !opsSrc.includes("emitAndProcessBusinessEvent") &&
    !opsSrc.includes("projectRecurrenceOccurrences") &&
    !actionSrc.includes("invoice.create") &&
    !actionSrc.includes("notifyCustomer") &&
    !actionSrc.includes("emitAndProcessBusinessEvent"),
);
check(
  "Corrective job is ONE_TIME and unique on correctiveCleanSourceJobId, not next booking",
  opsSrc.includes("oneTimeCorrectiveCleanPlan") &&
    opsSrc.includes("correctiveCleanSourceJobId: fresh.id") &&
    opsSrc.includes("nextBookingSourceJobId: null") &&
    opsSrc.includes("recurrenceSourceJobId: null") &&
    schemaSrc.includes("correctiveCleanSourceJobId String? @unique") &&
    schemaSrc.includes("nextBookingSourceJobId String? @unique") &&
    !schemaSrc.includes("recurrenceSourceJobId String? @unique") &&
    schemaSrc.includes("@@index([recurrenceSourceJobId])") &&
    migrationSrc.includes('ADD COLUMN IF NOT EXISTS "correctiveCleanSourceJobId"') &&
    migrationSrc.includes("CREATE UNIQUE INDEX IF NOT EXISTS") &&
    migrationSrc.includes("Job_correctiveCleanSourceJobId_key") &&
    !migrationSrc.includes("Job_nextBookingSourceJobId_key") &&
    !migrationSrc.includes("Job_recurrenceSourceJobId_key") &&
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migrationSrc),
);
check(
  "Duplicate-submit reuses the existing corrective job via correctiveCleanSourceJobId",
  opsSrc.includes("alreadyExists") &&
    opsSrc.includes('error.code === "P2002"') &&
    opsSrc.includes("findExistingCorrectiveClean") &&
    opsSrc.includes("lockTenantOwnedJob"),
);
check(
  "Review loader is mutation-free and tenant-scoped",
  dataSrc.includes("...access.scope") &&
    dataSrc.includes("RE_CLEAN_REQUESTED") &&
    !/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/.test(dataSrc),
);
check(
  "Job page and form stay distinct from next booking and require date plus confirmation",
  pageSrc.includes("CleaningCorrectiveCleanForm") &&
    pageSrc.includes("Corrective clean") &&
    pageSrc.includes("not a next booking") &&
    formSrc.includes('id="cleaning-corrective-clean-date"') &&
    formSrc.includes('name="date"') &&
    formSrc.includes('name="confirmCreate"') &&
    formSrc.includes("next booking, invoice, charge, or customer message") &&
    formSrc.includes("scheduleCleaningCorrectiveCleanAction") &&
    !formSrc.includes("createCleaningNextBookingAction") &&
    actionSrc.includes("redirect(`/jobs/${created.id}`)") &&
    CLEANING_CORRECTIVE_CLEAN_CREATED_MESSAGE.includes("No next booking") &&
    featureSrc.includes("CleaningCorrectiveCleanForm") &&
    !opsSrc.includes("nextBookingSourceJobId: fresh.id"),
);
check(
  "Business-timezone helpers are the schedule start path",
  opsSrc.includes("parseOwnerCorrectiveCleanStart") &&
    opsSrc.includes("businessTimeZoneForCorrectiveClean") &&
    parseScheduleStart("2026-09-28", "18:00", "America/Los_Angeles")?.toISOString() ===
      "2026-09-29T01:00:00.000Z",
);

try {
  const suffix = randomUUID().slice(0, 8);
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia", email: `owner-cc-${suffix}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Ava", email: `admin-cc-${suffix}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia", email: `member-cc-${suffix}@example.com`, passwordHash: "x" },
  });
  const ownerBUser = await prisma.user.create({
    data: { name: "Bea", email: `beta-cc-${suffix}@example.com`, passwordHash: "x" },
  });
  const handyOwnerUser = await prisma.user.create({
    data: { name: "Hank", email: `handy-cc-${suffix}@example.com`, passwordHash: "x" },
  });

  const cleanA = await prisma.business.create({
    data: {
      name: "Alpha Clean",
      slug: `alpha-cc-${suffix}`,
      tradeCode: "CLEANING",
      timezone: "America/Los_Angeles",
    },
  });
  const cleanB = await prisma.business.create({
    data: {
      name: "Beta Clean",
      slug: `beta-cc-${suffix}`,
      tradeCode: "CLEANING",
      timezone: "America/New_York",
    },
  });
  const handyC = await prisma.business.create({
    data: {
      name: "Gamma Handy",
      slug: `gamma-cc-${suffix}`,
      tradeCode: "HANDYMAN",
      timezone: "America/Chicago",
    },
  });

  const memOwnerA = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: cleanA.id, role: "OWNER" },
  });
  const memAdminA = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: cleanA.id, role: "ADMIN" },
  });
  const memMemberA = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: cleanA.id, role: "MEMBER" },
  });
  const memOwnerB = await prisma.membership.create({
    data: { userId: ownerBUser.id, businessId: cleanB.id, role: "OWNER" },
  });
  const memHandy = await prisma.membership.create({
    data: { userId: handyOwnerUser.id, businessId: handyC.id, role: "OWNER" },
  });

  const ownerA = makeAccess(cleanA.id, "OWNER", memOwnerA.id, ownerUser.id, "America/Los_Angeles");
  const adminA = makeAccess(cleanA.id, "ADMIN", memAdminA.id, adminUser.id, "America/Los_Angeles");
  const memberA = makeAccess(cleanA.id, "MEMBER", memMemberA.id, memberUser.id, "America/Los_Angeles");
  const ownerB = makeAccess(cleanB.id, "OWNER", memOwnerB.id, ownerBUser.id, "America/New_York");
  const handyOwner = makeAccess(
    handyC.id,
    "OWNER",
    memHandy.id,
    handyOwnerUser.id,
    "America/Chicago",
  );

  async function createCleaningJob(businessId, options = {}) {
    const {
      status = "IN_PROGRESS",
      includeCustomer = true,
      includeProperty = true,
      includeScope = true,
      tradeCode = "CLEANING",
      scheduledAt = new Date("2026-09-20T16:00:00.000Z"),
    } = options;
    const customer = includeCustomer
      ? await prisma.customer.create({
          data: {
            businessId,
            name: `${tradeCode} Customer`,
            email: `${tradeCode}-${randomUUID().slice(0, 6)}@example.com`,
          },
        })
      : null;
    const property =
      includeProperty && customer
        ? await prisma.property.create({
            data: {
              businessId,
              customerId: customer.id,
              addressLine1: "100 Pine St",
              city: "Los Angeles",
              region: "CA",
              postalCode: "90012",
            },
          })
        : null;
    const request = await prisma.serviceRequest.create({
      data: {
        businessId,
        customerId: customer?.id,
        propertyId: property?.id,
        description: `${tradeCode} visit`,
        tradeCode,
        serviceIntent: "ONE_TIME",
      },
    });
    const estimate = await prisma.estimate.create({
      data: {
        businessId,
        customerId: customer?.id,
        propertyId: property?.id,
        serviceRequestId: request.id,
        status: "APPROVED",
        publicToken: randomUUID(),
        total: 180,
      },
    });
    let versionId = null;
    if (includeScope) {
      await prisma.lineItem.create({
        data: {
          businessId,
          estimateId: estimate.id,
          description: "Standard clean",
          quantity: 1,
          unitPrice: 180,
          total: 180,
          type: "LABOR",
        },
      });
      const version = await prisma.estimateVersion.create({
        data: {
          businessId,
          estimateId: estimate.id,
          versionNumber: 1,
          total: 180,
          laborMinimumWaived: false,
          laborMinimumAdjustment: 0,
          customerName: customer?.name,
          approvedAt: new Date("2026-09-19T16:00:00.000Z"),
        },
      });
      versionId = version.id;
      await prisma.estimateVersionLineItem.create({
        data: {
          businessId,
          estimateVersionId: version.id,
          description: "Standard clean",
          quantity: 1,
          unitPrice: 180,
          total: 180,
          type: "LABOR",
        },
      });
      await prisma.estimate.update({
        where: { id: estimate.id },
        data: { approvedVersionId: version.id },
      });
    }
    return prisma.job.create({
      data: {
        businessId,
        customerId: customer?.id,
        propertyId: property?.id,
        estimateId: estimate.id,
        approvedEstimateVersionId: versionId,
        projectToken: randomUUID(),
        status,
        scheduledAt,
        scheduledDurationMinutes: 120,
        serviceIntent: "RECURRING",
        recurrenceCadence: "WEEKLY",
        recurrenceStatus: "ACTIVE",
      },
    });
  }

  async function recordVisit(job, outcomeStatus) {
    return prisma.jobCrewVisit.create({
      data: {
        businessId: job.businessId,
        jobId: job.id,
        outcomeStatus,
        outcomeRecordedAt: new Date("2026-09-21T17:00:00.000Z"),
        outcomeRecordedByMembershipId: memOwnerA.id,
      },
    });
  }

  const jobA = await createCleaningJob(cleanA.id);
  await recordVisit(jobA, "RE_CLEAN_REQUESTED");
  const jobACompleted = await createCleaningJob(cleanA.id, { status: "COMPLETED" });
  await recordVisit(jobACompleted, "RE_CLEAN_REQUESTED");
  const jobAVisitCompleted = await createCleaningJob(cleanA.id);
  await recordVisit(jobAVisitCompleted, "VISIT_COMPLETED");
  const jobANoVisit = await createCleaningJob(cleanA.id);
  const jobANoCustomer = await createCleaningJob(cleanA.id, {
    includeCustomer: false,
    includeProperty: false,
  });
  await recordVisit(jobANoCustomer, "RE_CLEAN_REQUESTED");
  const jobANoProperty = await createCleaningJob(cleanA.id, { includeProperty: false });
  await recordVisit(jobANoProperty, "RE_CLEAN_REQUESTED");
  const jobANoScope = await createCleaningJob(cleanA.id, { includeScope: false });
  await recordVisit(jobANoScope, "RE_CLEAN_REQUESTED");
  const jobARace = await createCleaningJob(cleanA.id);
  await recordVisit(jobARace, "RE_CLEAN_REQUESTED");
  const jobB = await createCleaningJob(cleanB.id);
  await prisma.jobCrewVisit.create({
    data: {
      businessId: cleanB.id,
      jobId: jobB.id,
      outcomeStatus: "RE_CLEAN_REQUESTED",
      outcomeRecordedAt: new Date("2026-09-21T17:00:00.000Z"),
      outcomeRecordedByMembershipId: memOwnerB.id,
    },
  });
  const handyJob = await createCleaningJob(handyC.id, { tradeCode: "HANDYMAN" });
  await prisma.jobCrewVisit.create({
    data: {
      businessId: handyC.id,
      jobId: handyJob.id,
      outcomeStatus: "RE_CLEAN_REQUESTED",
      outcomeRecordedAt: new Date("2026-09-21T17:00:00.000Z"),
      outcomeRecordedByMembershipId: memHandy.id,
    },
  });
  const jobACompletedOnly = await createCleaningJob(cleanA.id, { status: "COMPLETED" });

  const invoicesBefore = await countBusinessInvoices(prisma, cleanA.id);
  const paymentsBefore = await countBusinessPayments(prisma, cleanA.id);
  const jobsBefore = await countBusinessJobs(prisma, cleanA.id);

  console.log("\nLIVE — authorization, isolation, date, concurrency");

  await expectThrow(
    "ADMIN cannot schedule the corrective clean",
    () =>
      scheduleCorrectiveCleanFromReCleanRequestedJob(prisma, adminA, {
        jobId: jobA.id,
        date: "2026-10-05",
        time: "09:00",
        confirmCreate: "1",
      }),
    (error) =>
      error instanceof ForbiddenError &&
      cleaningCorrectiveCleanErrorMessage(error, "") === OWNER_SCHEDULES_CORRECTIVE_CLEAN_MESSAGE,
  );
  await expectThrow(
    "MEMBER cannot schedule the corrective clean",
    () =>
      scheduleCorrectiveCleanFromReCleanRequestedJob(prisma, memberA, {
        jobId: jobA.id,
        date: "2026-10-05",
        time: "09:00",
        confirmCreate: "1",
      }),
    (error) =>
      error instanceof ForbiddenError &&
      cleaningCorrectiveCleanErrorMessage(error, "") === OWNER_SCHEDULES_CORRECTIVE_CLEAN_MESSAGE,
  );
  await expectThrow(
    "OWNER cannot schedule a corrective clean from a Handyman job",
    () =>
      scheduleCorrectiveCleanFromReCleanRequestedJob(prisma, handyOwner, {
        jobId: handyJob.id,
        date: "2026-10-05",
        confirmCreate: "1",
      }),
    (error) =>
      error instanceof Error && error.message === CLEANING_CORRECTIVE_CLEAN_ONLY_MESSAGE,
  );
  await expectThrow(
    "OWNER A cannot schedule a corrective clean from business B's job",
    () =>
      scheduleCorrectiveCleanFromReCleanRequestedJob(prisma, ownerA, {
        jobId: jobB.id,
        date: "2026-10-05",
        confirmCreate: "1",
      }),
    (error) =>
      error instanceof Error &&
      error.message === "Record is not in the authorized business workspace.",
  );
  await expectThrow(
    "VISIT_COMPLETED is not a corrective-clean source",
    () =>
      scheduleCorrectiveCleanFromReCleanRequestedJob(prisma, ownerA, {
        jobId: jobAVisitCompleted.id,
        date: "2026-10-05",
        confirmCreate: "1",
      }),
    (error) =>
      error instanceof Error &&
      error.message === CLEANING_CORRECTIVE_CLEAN_RE_CLEAN_REQUIRED_MESSAGE,
  );
  await expectThrow(
    "A job with no visit outcome cannot become a corrective clean",
    () =>
      scheduleCorrectiveCleanFromReCleanRequestedJob(prisma, ownerA, {
        jobId: jobANoVisit.id,
        date: "2026-10-05",
        confirmCreate: "1",
      }),
    (error) =>
      error instanceof Error &&
      error.message === CLEANING_CORRECTIVE_CLEAN_RE_CLEAN_REQUIRED_MESSAGE,
  );
  await expectThrow(
    "Date is required",
    () =>
      scheduleCorrectiveCleanFromReCleanRequestedJob(prisma, ownerA, {
        jobId: jobA.id,
        date: "",
        confirmCreate: "1",
      }),
    (error) =>
      error instanceof Error && error.message === CLEANING_CORRECTIVE_CLEAN_DATE_REQUIRED_MESSAGE,
  );
  await expectThrow(
    "Confirmation is required",
    () =>
      scheduleCorrectiveCleanFromReCleanRequestedJob(prisma, ownerA, {
        jobId: jobA.id,
        date: "2026-10-05",
        confirmCreate: "",
      }),
    (error) =>
      error instanceof Error &&
      error.message === CLEANING_CORRECTIVE_CLEAN_CONFIRM_REQUIRED_MESSAGE,
  );
  await expectThrow(
    "Invalid civil date is rejected",
    () =>
      scheduleCorrectiveCleanFromReCleanRequestedJob(prisma, ownerA, {
        jobId: jobA.id,
        date: "2026-13-40",
        confirmCreate: "1",
      }),
    (error) =>
      error instanceof Error && error.message === CLEANING_CORRECTIVE_CLEAN_INVALID_DATE_MESSAGE,
  );
  await expectThrow(
    "Same-business customer is required",
    () =>
      scheduleCorrectiveCleanFromReCleanRequestedJob(prisma, ownerA, {
        jobId: jobANoCustomer.id,
        date: "2026-10-05",
        confirmCreate: "1",
      }),
    (error) =>
      error instanceof Error &&
      error.message === CLEANING_CORRECTIVE_CLEAN_CUSTOMER_REQUIRED_MESSAGE,
  );
  await expectThrow(
    "Same-business property is required",
    () =>
      scheduleCorrectiveCleanFromReCleanRequestedJob(prisma, ownerA, {
        jobId: jobANoProperty.id,
        date: "2026-10-05",
        confirmCreate: "1",
      }),
    (error) =>
      error instanceof Error &&
      error.message === CLEANING_CORRECTIVE_CLEAN_PROPERTY_REQUIRED_MESSAGE,
  );
  await expectThrow(
    "Selected service scope is required",
    () =>
      scheduleCorrectiveCleanFromReCleanRequestedJob(prisma, ownerA, {
        jobId: jobANoScope.id,
        date: "2026-10-05",
        confirmCreate: "1",
      }),
    (error) =>
      error instanceof Error && error.message === CLEANING_CORRECTIVE_CLEAN_SCOPE_REQUIRED_MESSAGE,
  );

  const leakedReview = await loadCleaningCorrectiveCleanReview(prisma, ownerA, jobB.id);
  const handyReview = await loadCleaningCorrectiveCleanReview(prisma, handyOwner, handyJob.id);
  const completedVisitReview = await loadCleaningCorrectiveCleanReview(
    prisma,
    ownerA,
    jobAVisitCompleted.id,
  );
  const noVisitReview = await loadCleaningCorrectiveCleanReview(prisma, ownerA, jobANoVisit.id);
  const ownerReview = await loadCleaningCorrectiveCleanReview(prisma, ownerA, jobA.id);
  check(
    "Review loader is tenant-isolated, Cleaning-only, and RE_CLEAN_REQUESTED-only",
    leakedReview === null &&
      handyReview === null &&
      completedVisitReview === null &&
      noVisitReview === null &&
      ownerReview?.eligible === true &&
      ownerReview.visitOutcomeStatus === "RE_CLEAN_REQUESTED" &&
      ownerReview.visitOutcomeLabel === "Re-clean requested" &&
      ownerReview.customer?.id === jobA.customerId &&
      ownerReview.property?.id === jobA.propertyId &&
      ownerReview.scopeLines.some((line) => line.title === "Standard clean") &&
      ownerReview.canCreate === true,
  );

  const created = await scheduleCorrectiveCleanFromReCleanRequestedJob(prisma, ownerA, {
    jobId: jobA.id,
    date: "2026-09-28",
    time: "18:00",
    confirmCreate: "1",
  });
  const jobsAfterCreate = await countBusinessJobs(prisma, cleanA.id);
  const invoicesAfterCreate = await countBusinessInvoices(prisma, cleanA.id);
  const paymentsAfterCreate = await countBusinessPayments(prisma, cleanA.id);
  const createdRow = await prisma.job.findFirst({
    where: { id: created.id, businessId: cleanA.id },
    include: {
      invoices: true,
      payments: true,
      appointmentEvents: true,
      crewVisit: true,
    },
  });
  const sourceAfter = await prisma.job.findFirst({
    where: { id: jobA.id, businessId: cleanA.id },
    include: { crewVisit: true },
  });
  const seriesCount = await prisma.job.count({
    where: { businessId: cleanA.id, correctiveCleanSourceJobId: jobA.id },
  });
  const nextBookingCount = await prisma.job.count({
    where: { businessId: cleanA.id, nextBookingSourceJobId: jobA.id },
  });

  check(
    "OWNER schedules one SCHEDULED corrective job that carries customer, property, and scope",
    created.alreadyExists === false &&
      created.businessId === cleanA.id &&
      created.customerId === jobA.customerId &&
      created.propertyId === jobA.propertyId &&
      created.estimateId === jobA.estimateId &&
      created.approvedEstimateVersionId === jobA.approvedEstimateVersionId &&
      created.correctiveCleanSourceJobId === jobA.id &&
      created.nextBookingSourceJobId === null &&
      created.recurrenceSourceJobId === null &&
      created.status === "SCHEDULED" &&
      created.serviceIntent === "ONE_TIME" &&
      created.recurrenceCadence === "" &&
      created.recurrenceStatus === "" &&
      created.nextOccurrenceAt === null &&
      jobsAfterCreate === jobsBefore + 1 &&
      seriesCount === 1 &&
      nextBookingCount === 0,
  );
  check(
    "Business-timezone date is stored as Los Angeles civil 2026-09-28, not the UTC day",
    created.scheduledAt?.toISOString() === "2026-09-29T01:00:00.000Z" &&
      correctiveCleanCivilDate(created.scheduledAt, "America/Los_Angeles") === "2026-09-28" &&
      formatISODateInTimeZone(created.scheduledAt, "America/Los_Angeles") === "2026-09-28" &&
      formatISODateInTimeZone(created.scheduledAt, "UTC") === "2026-09-29" &&
      DEFAULT_CORRECTIVE_CLEAN_TIME === "09:00",
  );
  check(
    "Create path writes no invoice, payment, appointment message, crew visit, or next booking",
    invoicesAfterCreate === invoicesBefore &&
      paymentsAfterCreate === paymentsBefore &&
      createdRow?.invoices.length === 0 &&
      createdRow?.payments.length === 0 &&
      createdRow?.appointmentEvents.length === 0 &&
      createdRow?.crewVisit === null &&
      createdRow?.appointmentConfirmationStatus === "NONE" &&
      !createdRow?.appointmentNotificationStatus &&
      sourceAfter?.status === "IN_PROGRESS" &&
      sourceAfter?.crewVisit?.outcomeStatus === "RE_CLEAN_REQUESTED" &&
      sourceAfter?.serviceIntent === "RECURRING" &&
      sourceAfter?.recurrenceCadence === "WEEKLY",
  );

  const duplicate = await scheduleCorrectiveCleanFromReCleanRequestedJob(prisma, ownerA, {
    jobId: jobA.id,
    date: "2026-11-01",
    time: "10:00",
    confirmCreate: "1",
  });
  const jobsAfterDuplicate = await countBusinessJobs(prisma, cleanA.id);
  const seriesAfterDuplicate = await prisma.job.count({
    where: { businessId: cleanA.id, correctiveCleanSourceJobId: jobA.id },
  });
  check(
    "Duplicate submit returns the existing corrective job and does not change the date",
    duplicate.alreadyExists === true &&
      duplicate.id === created.id &&
      duplicate.scheduledAt?.toISOString() === created.scheduledAt?.toISOString() &&
      jobsAfterDuplicate === jobsAfterCreate &&
      seriesAfterDuplicate === 1,
  );

  const reviewAfter = await loadCleaningCorrectiveCleanReview(prisma, ownerA, jobA.id);
  check(
    "Review after create points at the existing corrective job and hides the form",
    reviewAfter?.existingCorrectiveClean?.id === created.id && reviewAfter.canCreate === false,
  );

  const jobsBeforeRace = await countBusinessJobs(prisma, cleanA.id);
  const [raceOne, raceTwo] = await Promise.all([
    scheduleCorrectiveCleanFromReCleanRequestedJob(prisma, ownerA, {
      jobId: jobARace.id,
      date: "2026-10-12",
      time: "09:00",
      confirmCreate: "1",
    }),
    scheduleCorrectiveCleanFromReCleanRequestedJob(prisma, ownerA, {
      jobId: jobARace.id,
      date: "2026-10-13",
      time: "11:00",
      confirmCreate: "1",
    }),
  ]);
  const jobsAfterRace = await countBusinessJobs(prisma, cleanA.id);
  const raceRows = await prisma.job.findMany({
    where: { businessId: cleanA.id, correctiveCleanSourceJobId: jobARace.id },
  });
  check(
    "Concurrent submits create one corrective job and return the same row",
    raceOne.id === raceTwo.id &&
      raceRows.length === 1 &&
      raceRows[0].id === raceOne.id &&
      [raceOne.alreadyExists, raceTwo.alreadyExists].some(Boolean) &&
      jobsAfterRace === jobsBeforeRace + 1 &&
      raceOne.scheduledAt?.toISOString() === raceTwo.scheduledAt?.toISOString(),
  );

  const isolated = await prisma.job.findFirst({
    where: { id: created.id, ...businessScope(cleanB.id) },
  });
  const ownerBSeesA = await loadCleaningCorrectiveCleanReview(prisma, ownerB, jobA.id);
  const ownerBSeesCreated = await prisma.job.findFirst({
    where: { id: created.id, businessId: cleanB.id },
  });
  check(
    "Corrective clean is invisible to the other tenant",
    isolated === null && ownerBSeesA === null && ownerBSeesCreated === null,
  );

  const createdB = await scheduleCorrectiveCleanFromReCleanRequestedJob(prisma, ownerB, {
    jobId: jobB.id,
    date: "2026-09-28",
    time: "18:00",
    confirmCreate: "1",
  });
  check(
    "Business B stores the same civil date in America/New_York, not Los Angeles",
    createdB.businessId === cleanB.id &&
      createdB.scheduledAt?.toISOString() === "2026-09-28T22:00:00.000Z" &&
      correctiveCleanCivilDate(createdB.scheduledAt, "America/New_York") === "2026-09-28" &&
      createdB.scheduledAt?.toISOString() !== created.scheduledAt?.toISOString(),
  );

  const aCannotReadB = await prisma.job.findFirst({
    where: { id: createdB.id, ...businessScope(cleanA.id) },
  });
  check("Owner A cannot read business B's corrective clean", aCannotReadB === null);

  const nextBookingFromCompleted = await createNextBookingFromCompletedCleaningJob(
    prisma,
    ownerA,
    {
      jobId: jobACompleted.id,
      date: "2026-10-20",
      time: "09:00",
      confirmCreate: "1",
    },
  );
  const correctiveFromCompleted = await scheduleCorrectiveCleanFromReCleanRequestedJob(
    prisma,
    ownerA,
    {
      jobId: jobACompleted.id,
      date: "2026-10-21",
      time: "10:00",
      confirmCreate: "1",
    },
  );
  const nextBookingRow = await prisma.job.findFirst({
    where: { id: nextBookingFromCompleted.id, businessId: cleanA.id },
    select: {
      id: true,
      nextBookingSourceJobId: true,
      correctiveCleanSourceJobId: true,
    },
  });
  const correctiveRow = await prisma.job.findFirst({
    where: { id: correctiveFromCompleted.id, businessId: cleanA.id },
    select: {
      id: true,
      nextBookingSourceJobId: true,
      correctiveCleanSourceJobId: true,
    },
  });
  check(
    "Corrective clean and next booking stay distinct on the same completed RE_CLEAN job",
    nextBookingFromCompleted.id !== correctiveFromCompleted.id &&
      nextBookingRow?.nextBookingSourceJobId === jobACompleted.id &&
      nextBookingRow?.correctiveCleanSourceJobId === null &&
      correctiveRow?.correctiveCleanSourceJobId === jobACompleted.id &&
      correctiveRow?.nextBookingSourceJobId === null,
  );

  await expectThrow(
    "A completed job without RE_CLEAN_REQUESTED cannot use the corrective-clean path",
    () =>
      scheduleCorrectiveCleanFromReCleanRequestedJob(prisma, ownerA, {
        jobId: jobACompletedOnly.id,
        date: "2026-10-22",
        confirmCreate: "1",
      }),
    (error) =>
      error instanceof Error &&
      error.message === CLEANING_CORRECTIVE_CLEAN_RE_CLEAN_REQUIRED_MESSAGE,
  );

  const nextOnly = await createNextBookingFromCompletedCleaningJob(prisma, ownerA, {
    jobId: jobACompletedOnly.id,
    date: "2026-10-22",
    confirmCreate: "1",
  });
  const nextOnlyRow = await prisma.job.findFirst({
    where: { id: nextOnly.id, businessId: cleanA.id },
    select: { nextBookingSourceJobId: true, correctiveCleanSourceJobId: true },
  });
  check(
    "Regular next booking still works without a requested re-clean",
    nextOnlyRow?.nextBookingSourceJobId === jobACompletedOnly.id &&
      nextOnlyRow?.correctiveCleanSourceJobId === null &&
      nextOnly.id !== created.id,
  );

  await expectThrow(
    "Two corrective jobs cannot share correctiveCleanSourceJobId",
    () =>
      prisma.job.create({
        data: {
          businessId: cleanA.id,
          customerId: jobA.customerId,
          propertyId: jobA.propertyId,
          estimateId: jobA.estimateId,
          projectToken: randomUUID(),
          status: "SCHEDULED",
          scheduledAt: new Date("2026-11-15T18:00:00.000Z"),
          correctiveCleanSourceJobId: jobA.id,
        },
      }),
    (error) => error?.code === "P2002",
  );
} catch (error) {
  failed += 1;
  console.error("FAIL - live Cleaning corrective-clean proofs crashed");
  console.error(error);
} finally {
  await prisma.$disconnect();
}

console.log(
  failed === 0
    ? `\nAll Cleaning corrective-clean checks passed (${passed}).`
    : `\n${failed} Cleaning corrective-clean check(s) failed; ${passed} passed.`,
);
process.exit(failed === 0 ? 0 : 1);
