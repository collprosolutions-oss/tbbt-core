/**
 * OWNER next booking from a completed Cleaning job.
 *
 * Dedicated database: tbbt_cleaning_next_booking_test
 *
 * Proves tenant isolation, duplicate-submit behavior, and
 * business-timezone dates. Does not create a recurring series,
 * invoice, or customer message.
 *
 * Run with:
 *   npm run test:cleaning-next-booking
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
  console.error("Failed to generate Prisma client for Cleaning next-booking checks.");
  process.exit(generateEarly.status ?? 1);
}

const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const { ForbiddenError } = await import("@/lib/authorization");
const { formatISODateInTimeZone } = await import("@/lib/business-timezone");
const { parseScheduleStart } = await import("@/lib/job-schedule");
const {
  CLEANING_NEXT_BOOKING_CONFIRM_REQUIRED_MESSAGE,
  CLEANING_NEXT_BOOKING_CUSTOMER_REQUIRED_MESSAGE,
  CLEANING_NEXT_BOOKING_DATE_REQUIRED_MESSAGE,
  CLEANING_NEXT_BOOKING_INVALID_DATE_MESSAGE,
  CLEANING_NEXT_BOOKING_NOT_COMPLETED_MESSAGE,
  CLEANING_NEXT_BOOKING_ONLY_MESSAGE,
  CLEANING_NEXT_BOOKING_PROPERTY_REQUIRED_MESSAGE,
  CLEANING_NEXT_BOOKING_SCOPE_REQUIRED_MESSAGE,
  CLEANING_NEXT_BOOKING_CREATED_MESSAGE,
  DEFAULT_NEXT_BOOKING_TIME,
  OWNER_CREATES_NEXT_BOOKING_MESSAGE,
  cleaningNextBookingEligible,
  nextBookingCivilDate,
  oneTimeNextBookingPlan,
  parseOwnerNextBookingConfirmation,
  parseOwnerNextBookingStart,
} = await import("@/lib/cleaning-next-booking");
const {
  cleaningNextBookingErrorMessage,
  countBusinessInvoices,
  countBusinessJobs,
  createNextBookingFromCompletedCleaningJob,
} = await import("@/lib/cleaning-next-booking-ops");
const { loadCleaningNextBookingReview } = await import(
  "@/lib/cleaning-next-booking-data"
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run the Cleaning next-booking check.");
  process.exit(1);
}

const testDbName = "tbbt_cleaning_next_booking_test";
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
      business: { id: businessId, name: "Next Booking Co", timezone },
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
  "src/lib/cleaning-next-booking.ts",
  "src/lib/cleaning-next-booking-ops.ts",
  "src/lib/cleaning-next-booking-data.ts",
  "src/app/actions/cleaning-next-booking.ts",
  "src/components/jobs/cleaning-next-booking-form.tsx",
  "src/app/(app)/jobs/[jobId]/page.tsx",
];
const featureSrc = featureFiles.map(read).join("\n");
const opsSrc = read("src/lib/cleaning-next-booking-ops.ts");
const actionSrc = read("src/app/actions/cleaning-next-booking.ts");
const dataSrc = read("src/lib/cleaning-next-booking-data.ts");
const formSrc = read("src/components/jobs/cleaning-next-booking-form.tsx");
const pageSrc = read("src/app/(app)/jobs/[jobId]/page.tsx");
const schemaSrc = read("prisma/schema.prisma");
const migrationSrc = read(
  "prisma/migrations/20260928020000_job_next_booking_source_unique/migration.sql",
);

console.log("\nSTATIC — one explicit next booking, no series / invoice / message");
check(
  "OWNER-only gate and Cleaning completed-job eligibility",
  OWNER_CREATES_NEXT_BOOKING_MESSAGE.includes("business owner") &&
    cleaningNextBookingEligible("CLEANING") === true &&
    cleaningNextBookingEligible("HANDYMAN") === false &&
    oneTimeNextBookingPlan().serviceIntent === "ONE_TIME" &&
    oneTimeNextBookingPlan().recurrenceCadence === "" &&
    oneTimeNextBookingPlan().nextOccurrenceAt === null,
);
check(
  "Date and confirmation parsers require explicit values",
  parseOwnerNextBookingConfirmation("1") === true &&
    parseOwnerNextBookingConfirmation("") === false &&
    parseOwnerNextBookingConfirmation("no") === false &&
    parseOwnerNextBookingStart({ date: "", timeZone: "America/Los_Angeles" }) === null &&
    parseOwnerNextBookingStart({
      date: "2026-09-28",
      time: "18:00",
      timeZone: "America/Los_Angeles",
    })?.toISOString() === "2026-09-29T01:00:00.000Z",
);
check(
  "Write path creates exactly one Job and does not invoice or message",
  opsSrc.includes("tx.job.create") &&
    !opsSrc.includes("invoice.create") &&
    !opsSrc.includes("persistDraftInvoice") &&
    !opsSrc.includes("completeJobAndSendInvoice") &&
    !opsSrc.includes("notifyCustomer") &&
    !opsSrc.includes("emitAndProcessBusinessEvent") &&
    !opsSrc.includes("projectRecurrenceOccurrences") &&
    !actionSrc.includes("invoice.create") &&
    !actionSrc.includes("notifyCustomer") &&
    !actionSrc.includes("emitAndProcessBusinessEvent"),
);
check(
  "New booking is ONE_TIME and unique on recurrenceSourceJobId",
  opsSrc.includes("oneTimeNextBookingPlan") &&
    opsSrc.includes("recurrenceSourceJobId: fresh.id") &&
    schemaSrc.includes("recurrenceSourceJobId String? @unique") &&
    migrationSrc.includes("CREATE UNIQUE INDEX IF NOT EXISTS") &&
    migrationSrc.includes("Job_recurrenceSourceJobId_key") &&
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migrationSrc),
);
check(
  "Duplicate-submit reuses the existing next booking (P2002 + pre-check)",
  opsSrc.includes("alreadyExists") &&
    opsSrc.includes('error.code === "P2002"') &&
    opsSrc.includes("findExistingNextBooking") &&
    opsSrc.includes("lockTenantOwnedJob"),
);
check(
  "Review loader is mutation-free and tenant-scoped",
  dataSrc.includes("...access.scope") &&
    !/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/.test(dataSrc),
);
check(
  "Job page and form require date plus confirmation",
  pageSrc.includes("CleaningNextBookingForm") &&
    pageSrc.includes("Create one next booking") &&
    formSrc.includes('name="date"') &&
    formSrc.includes('name="confirmCreate"') &&
    formSrc.includes("recurring series, invoice, or customer message") &&
    formSrc.includes("createCleaningNextBookingAction") &&
    actionSrc.includes("redirect(`/jobs/${created.id}`)") &&
    CLEANING_NEXT_BOOKING_CREATED_MESSAGE.includes("No recurring series"),
);
check(
  "Business-timezone helpers are the schedule start path",
  opsSrc.includes("parseOwnerNextBookingStart") &&
    opsSrc.includes("businessTimeZoneForNextBooking") &&
    parseScheduleStart("2026-09-28", "18:00", "America/Los_Angeles")?.toISOString() ===
      "2026-09-29T01:00:00.000Z",
);

try {
  const suffix = randomUUID().slice(0, 8);
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia", email: `owner-nb-${suffix}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Ava", email: `admin-nb-${suffix}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia", email: `member-nb-${suffix}@example.com`, passwordHash: "x" },
  });
  const ownerBUser = await prisma.user.create({
    data: { name: "Bea", email: `beta-nb-${suffix}@example.com`, passwordHash: "x" },
  });
  const handyOwnerUser = await prisma.user.create({
    data: { name: "Hank", email: `handy-nb-${suffix}@example.com`, passwordHash: "x" },
  });

  const cleanA = await prisma.business.create({
    data: {
      name: "Alpha Clean",
      slug: `alpha-nb-${suffix}`,
      tradeCode: "CLEANING",
      timezone: "America/Los_Angeles",
    },
  });
  const cleanB = await prisma.business.create({
    data: {
      name: "Beta Clean",
      slug: `beta-nb-${suffix}`,
      tradeCode: "CLEANING",
      timezone: "America/New_York",
    },
  });
  const handyC = await prisma.business.create({
    data: {
      name: "Gamma Handy",
      slug: `gamma-nb-${suffix}`,
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

  async function createCompletedCleaningJob(businessId, options = {}) {
    const {
      status = "COMPLETED",
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

  const jobA = await createCompletedCleaningJob(cleanA.id);
  const jobAOpen = await createCompletedCleaningJob(cleanA.id, { status: "IN_PROGRESS" });
  const jobANoCustomer = await createCompletedCleaningJob(cleanA.id, {
    includeCustomer: false,
    includeProperty: false,
  });
  const jobANoProperty = await createCompletedCleaningJob(cleanA.id, { includeProperty: false });
  const jobANoScope = await createCompletedCleaningJob(cleanA.id, { includeScope: false });
  const jobB = await createCompletedCleaningJob(cleanB.id);
  const handyJob = await createCompletedCleaningJob(handyC.id, { tradeCode: "HANDYMAN" });

  const invoicesBefore = await countBusinessInvoices(prisma, cleanA.id);
  const jobsBefore = await countBusinessJobs(prisma, cleanA.id);

  console.log("\nLIVE — authorization, isolation, date, duplicate-submit");

  await expectThrow(
    "ADMIN cannot create the next booking",
    () =>
      createNextBookingFromCompletedCleaningJob(prisma, adminA, {
        jobId: jobA.id,
        date: "2026-10-05",
        time: "09:00",
        confirmCreate: "1",
      }),
    (error) =>
      error instanceof ForbiddenError &&
      cleaningNextBookingErrorMessage(error, "") === OWNER_CREATES_NEXT_BOOKING_MESSAGE,
  );
  await expectThrow(
    "MEMBER cannot create the next booking",
    () =>
      createNextBookingFromCompletedCleaningJob(prisma, memberA, {
        jobId: jobA.id,
        date: "2026-10-05",
        time: "09:00",
        confirmCreate: "1",
      }),
    (error) =>
      error instanceof ForbiddenError &&
      cleaningNextBookingErrorMessage(error, "") === OWNER_CREATES_NEXT_BOOKING_MESSAGE,
  );
  await expectThrow(
    "OWNER cannot create a next booking from a Handyman job",
    () =>
      createNextBookingFromCompletedCleaningJob(prisma, handyOwner, {
        jobId: handyJob.id,
        date: "2026-10-05",
        confirmCreate: "1",
      }),
    (error) =>
      error instanceof Error && error.message === CLEANING_NEXT_BOOKING_ONLY_MESSAGE,
  );
  await expectThrow(
    "OWNER A cannot create a next booking from business B's job",
    () =>
      createNextBookingFromCompletedCleaningJob(prisma, ownerA, {
        jobId: jobB.id,
        date: "2026-10-05",
        confirmCreate: "1",
      }),
    (error) =>
      error instanceof Error &&
      error.message === "Record is not in the authorized business workspace.",
  );
  await expectThrow(
    "In-progress Cleaning job cannot become a next booking",
    () =>
      createNextBookingFromCompletedCleaningJob(prisma, ownerA, {
        jobId: jobAOpen.id,
        date: "2026-10-05",
        confirmCreate: "1",
      }),
    (error) => error instanceof Error && error.message === CLEANING_NEXT_BOOKING_NOT_COMPLETED_MESSAGE,
  );
  await expectThrow(
    "Date is required",
    () =>
      createNextBookingFromCompletedCleaningJob(prisma, ownerA, {
        jobId: jobA.id,
        date: "",
        confirmCreate: "1",
      }),
    (error) =>
      error instanceof Error && error.message === CLEANING_NEXT_BOOKING_DATE_REQUIRED_MESSAGE,
  );
  await expectThrow(
    "Confirmation is required",
    () =>
      createNextBookingFromCompletedCleaningJob(prisma, ownerA, {
        jobId: jobA.id,
        date: "2026-10-05",
        confirmCreate: "",
      }),
    (error) =>
      error instanceof Error && error.message === CLEANING_NEXT_BOOKING_CONFIRM_REQUIRED_MESSAGE,
  );
  await expectThrow(
    "Invalid civil date is rejected",
    () =>
      createNextBookingFromCompletedCleaningJob(prisma, ownerA, {
        jobId: jobA.id,
        date: "2026-13-40",
        confirmCreate: "1",
      }),
    (error) =>
      error instanceof Error && error.message === CLEANING_NEXT_BOOKING_INVALID_DATE_MESSAGE,
  );
  await expectThrow(
    "Same-business customer is required",
    () =>
      createNextBookingFromCompletedCleaningJob(prisma, ownerA, {
        jobId: jobANoCustomer.id,
        date: "2026-10-05",
        confirmCreate: "1",
      }),
    (error) =>
      error instanceof Error && error.message === CLEANING_NEXT_BOOKING_CUSTOMER_REQUIRED_MESSAGE,
  );
  await expectThrow(
    "Same-business property is required",
    () =>
      createNextBookingFromCompletedCleaningJob(prisma, ownerA, {
        jobId: jobANoProperty.id,
        date: "2026-10-05",
        confirmCreate: "1",
      }),
    (error) =>
      error instanceof Error && error.message === CLEANING_NEXT_BOOKING_PROPERTY_REQUIRED_MESSAGE,
  );
  await expectThrow(
    "Selected service scope is required",
    () =>
      createNextBookingFromCompletedCleaningJob(prisma, ownerA, {
        jobId: jobANoScope.id,
        date: "2026-10-05",
        confirmCreate: "1",
      }),
    (error) =>
      error instanceof Error && error.message === CLEANING_NEXT_BOOKING_SCOPE_REQUIRED_MESSAGE,
  );

  const leakedReview = await loadCleaningNextBookingReview(prisma, ownerA, jobB.id);
  const handyReview = await loadCleaningNextBookingReview(prisma, handyOwner, handyJob.id);
  const ownerReview = await loadCleaningNextBookingReview(prisma, ownerA, jobA.id);
  check(
    "Review loader is tenant-isolated and Cleaning-only",
    leakedReview === null &&
      handyReview === null &&
      ownerReview?.eligible === true &&
      ownerReview.customer?.id === jobA.customerId &&
      ownerReview.property?.id === jobA.propertyId &&
      ownerReview.scopeLines.some((line) => line.title === "Standard clean") &&
      ownerReview.canCreate === true,
  );

  const created = await createNextBookingFromCompletedCleaningJob(prisma, ownerA, {
    jobId: jobA.id,
    date: "2026-09-28",
    time: "18:00",
    confirmCreate: "1",
  });
  const jobsAfterCreate = await countBusinessJobs(prisma, cleanA.id);
  const invoicesAfterCreate = await countBusinessInvoices(prisma, cleanA.id);
  const createdRow = await prisma.job.findFirst({
    where: { id: created.id, businessId: cleanA.id },
    include: {
      invoices: true,
      appointmentEvents: true,
      crewVisit: true,
    },
  });
  const sourceAfter = await prisma.job.findFirst({
    where: { id: jobA.id, businessId: cleanA.id },
  });
  const seriesCount = await prisma.job.count({
    where: { businessId: cleanA.id, recurrenceSourceJobId: jobA.id },
  });

  check(
    "OWNER creates one SCHEDULED booking that carries customer, property, and scope",
    created.alreadyExists === false &&
      created.businessId === cleanA.id &&
      created.customerId === jobA.customerId &&
      created.propertyId === jobA.propertyId &&
      created.estimateId === jobA.estimateId &&
      created.approvedEstimateVersionId === jobA.approvedEstimateVersionId &&
      created.recurrenceSourceJobId === jobA.id &&
      created.status === "SCHEDULED" &&
      created.serviceIntent === "ONE_TIME" &&
      created.recurrenceCadence === "" &&
      created.recurrenceStatus === "" &&
      created.nextOccurrenceAt === null &&
      jobsAfterCreate === jobsBefore + 1 &&
      seriesCount === 1,
  );
  check(
    "Business-timezone date is stored as Los Angeles civil 2026-09-28, not the UTC day",
    created.scheduledAt?.toISOString() === "2026-09-29T01:00:00.000Z" &&
      nextBookingCivilDate(created.scheduledAt, "America/Los_Angeles") === "2026-09-28" &&
      formatISODateInTimeZone(created.scheduledAt, "America/Los_Angeles") === "2026-09-28" &&
      formatISODateInTimeZone(created.scheduledAt, "UTC") === "2026-09-29" &&
      DEFAULT_NEXT_BOOKING_TIME === "09:00",
  );
  check(
    "Create path writes no invoice, appointment message, crew visit, or extra series rows",
    invoicesAfterCreate === invoicesBefore &&
      createdRow?.invoices.length === 0 &&
      createdRow?.appointmentEvents.length === 0 &&
      createdRow?.crewVisit === null &&
      createdRow?.appointmentConfirmationStatus === "NONE" &&
      !createdRow?.appointmentNotificationStatus &&
      sourceAfter?.serviceIntent === "RECURRING" &&
      sourceAfter?.recurrenceCadence === "WEEKLY",
  );

  const duplicate = await createNextBookingFromCompletedCleaningJob(prisma, ownerA, {
    jobId: jobA.id,
    date: "2026-11-01",
    time: "10:00",
    confirmCreate: "1",
  });
  const jobsAfterDuplicate = await countBusinessJobs(prisma, cleanA.id);
  const seriesAfterDuplicate = await prisma.job.count({
    where: { businessId: cleanA.id, recurrenceSourceJobId: jobA.id },
  });
  check(
    "Duplicate submit returns the existing booking and does not change the date",
    duplicate.alreadyExists === true &&
      duplicate.id === created.id &&
      duplicate.scheduledAt?.toISOString() === created.scheduledAt?.toISOString() &&
      jobsAfterDuplicate === jobsAfterCreate &&
      seriesAfterDuplicate === 1,
  );

  const reviewAfter = await loadCleaningNextBookingReview(prisma, ownerA, jobA.id);
  check(
    "Review after create points at the existing next booking and hides the form",
    reviewAfter?.existingNextBooking?.id === created.id &&
      reviewAfter.canCreate === false,
  );

  const isolated = await prisma.job.findFirst({
    where: { id: created.id, ...businessScope(cleanB.id) },
  });
  const ownerBSeesA = await loadCleaningNextBookingReview(prisma, ownerB, jobA.id);
  const ownerBSeesCreated = await prisma.job.findFirst({
    where: { id: created.id, businessId: cleanB.id },
  });
  check(
    "Next booking is invisible to the other tenant",
    isolated === null && ownerBSeesA === null && ownerBSeesCreated === null,
  );

  const createdB = await createNextBookingFromCompletedCleaningJob(prisma, ownerB, {
    jobId: jobB.id,
    date: "2026-09-28",
    time: "18:00",
    confirmCreate: "1",
  });
  check(
    "Business B stores the same civil date in America/New_York, not Los Angeles",
    createdB.businessId === cleanB.id &&
      createdB.scheduledAt?.toISOString() === "2026-09-28T22:00:00.000Z" &&
      nextBookingCivilDate(createdB.scheduledAt, "America/New_York") === "2026-09-28" &&
      createdB.scheduledAt?.toISOString() !== created.scheduledAt?.toISOString(),
  );

  const aCannotReadB = await prisma.job.findFirst({
    where: { id: createdB.id, ...businessScope(cleanA.id) },
  });
  check("Owner A cannot read business B's next booking", aCannotReadB === null);

  const jobsB = await countBusinessJobs(prisma, cleanB.id);
  const jobsAFinal = await countBusinessJobs(prisma, cleanA.id);
  check(
    "Each tenant only gained its own one next booking",
    jobsAFinal === jobsAfterCreate && jobsB >= 2,
  );
} catch (error) {
  failed += 1;
  console.error("FAIL - live Cleaning next-booking proofs crashed");
  console.error(error);
} finally {
  await prisma.$disconnect();
}

console.log(
  failed === 0
    ? `\nAll Cleaning next-booking checks passed (${passed}).`
    : `\n${failed} Cleaning next-booking check(s) failed; ${passed} passed.`,
);
process.exit(failed === 0 ? 0 : 1);
