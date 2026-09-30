/**
 * OWNER future recurring Cleaning bookings.
 *
 * Dedicated unique local disposable database. Remote DATABASE_URL
 * hosts are refused before Prisma generate, schema push, or forced
 * database drop.
 *
 * Proves authorization, tenant isolation, timezone date boundaries,
 * stop/cancel canonical Job.status, resume eligibility, schedule
 * gates, unique-error recovery, concurrent slot reservation, and
 * idempotency under retries.
 * Recurring occurrences stay distinct from one-time next bookings and
 * corrective cleans.
 *
 * Run with:
 *   npm run test:cleaning-recurring-booking
 */
import { register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertLocalDatabaseUrl,
  openDisposableTestDatabase,
} from "./disposable-test-database.mjs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run the Cleaning recurring-booking check.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "Cleaning recurring-booking disposable database");

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for Cleaning recurring-booking checks.");
  process.exit(generateEarly.status ?? 1);
}

const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const { ForbiddenError } = await import("@/lib/authorization");
const { formatISODateInTimeZone } = await import("@/lib/business-timezone");
const { parseScheduleStart } = await import("@/lib/job-schedule");
const {
  CLEANING_RECURRING_ALREADY_EXISTS_MESSAGE,
  CLEANING_RECURRING_BOOKING_ONLY_MESSAGE,
  CLEANING_RECURRING_BOOKING_SOURCE_MESSAGE,
  CLEANING_RECURRING_CADENCE_REQUIRED_MESSAGE,
  CLEANING_RECURRING_CONFIRM_REQUIRED_MESSAGE,
  CLEANING_RECURRING_CREATED_MESSAGE,
  CLEANING_RECURRING_CUSTOMER_REQUIRED_MESSAGE,
  CLEANING_RECURRING_DATE_IN_PAST_MESSAGE,
  CLEANING_RECURRING_DATE_REQUIRED_MESSAGE,
  CLEANING_RECURRING_INVALID_DATE_MESSAGE,
  CLEANING_RECURRING_NOT_ACTIVE_MESSAGE,
  CLEANING_RECURRING_PROPERTY_REQUIRED_MESSAGE,
  CLEANING_RECURRING_SCOPE_REQUIRED_MESSAGE,
  CLEANING_RECURRING_SLOT_BLOCKED_MESSAGE,
  CLEANING_RECURRING_STOP_CONFIRM_REQUIRED_MESSAGE,
  canCancelUnstartedRecurringOccurrence,
  canReopenCancelledRecurringOccurrence,
  DEFAULT_RECURRING_BOOKING_TIME,
  MAX_UPCOMING_RECURRING_BOOKINGS,
  OWNER_MANAGES_RECURRING_BOOKINGS_MESSAGE,
  cleaningRecurringBookingEligible,
  firstCivilDateIsInPast,
  isRecurringSeriesSource,
  listUpcomingRecurringStarts,
  parseOwnerRecurringCadence,
  parseOwnerRecurringConfirmation,
  parseOwnerRecurringStart,
  recurrenceOccurrenceKey,
  recurringBookingCivilDate,
  recurringOccurrencePlan,
} = await import("@/lib/cleaning-recurring-booking");
const {
  cleaningRecurringBookingErrorMessage,
  countBusinessInvoices,
  countBusinessJobs,
  fillCleaningRecurringBookings,
  isRecurrenceOccurrenceKeyConflict,
  resumeCleaningRecurringBookings,
  setupCleaningRecurringBookings,
  stopCleaningRecurringBookings,
} = await import("@/lib/cleaning-recurring-booking-ops");
const { loadCleaningRecurringBookingReview } = await import(
  "@/lib/cleaning-recurring-booking-data"
);
const { createNextBookingFromCompletedCleaningJob } = await import(
  "@/lib/cleaning-next-booking-ops"
);
const { scheduleCorrectiveCleanFromReCleanRequestedJob } = await import(
  "@/lib/cleaning-corrective-clean-ops"
);
const { scheduleSnapshotFromJob } = await import("@/lib/owner-day-route/snapshot");
const { DAY_ROUTE_APPOINTMENT_CONFLICT_MESSAGE } = await import(
  "@/lib/owner-day-route-appointment"
);
const { changeOwnerDayRouteAppointment } = await import(
  "@/lib/owner-day-route-appointment-ops"
);
const { businessScheduleReservationLockKey } = await import("@/lib/schedule-reservation");

let session;
let prisma;

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
      business: { id: businessId, name: "Recurring Booking Co", timezone },
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
  "src/lib/cleaning-recurring-booking.ts",
  "src/lib/cleaning-recurring-booking-ops.ts",
  "src/lib/cleaning-recurring-booking-data.ts",
  "src/app/actions/cleaning-recurring-booking.ts",
  "src/components/jobs/cleaning-recurring-booking-form.tsx",
  "src/app/(app)/jobs/[jobId]/page.tsx",
];
const featureSrc = featureFiles.map(read).join("\n");
const opsSrc = read("src/lib/cleaning-recurring-booking-ops.ts");
const actionSrc = read("src/app/actions/cleaning-recurring-booking.ts");
const dataSrc = read("src/lib/cleaning-recurring-booking-data.ts");
const formSrc = read("src/components/jobs/cleaning-recurring-booking-form.tsx");
const pageSrc = read("src/app/(app)/jobs/[jobId]/page.tsx");
const reservationSrc = read("src/lib/schedule-reservation.ts");
const dayRouteOpsSrc = read("src/lib/owner-day-route-appointment-ops.ts");
const schemaSrc = read("prisma/schema.prisma");
const migrationSrc = read(
  "prisma/migrations/20260928180000_job_recurrence_occurrence_key/migration.sql",
);

const frozenNow = new Date("2026-09-28T17:00:00.000Z");

console.log("\nSTATIC — explicit recurring series, distinct from next booking / corrective");
check(
  "OWNER-only gate and Cleaning eligibility",
  OWNER_MANAGES_RECURRING_BOOKINGS_MESSAGE.includes("business owner") &&
    cleaningRecurringBookingEligible("CLEANING") === true &&
    cleaningRecurringBookingEligible("HANDYMAN") === false &&
    recurringOccurrencePlan("WEEKLY").serviceIntent === "RECURRING" &&
    recurringOccurrencePlan("WEEKLY").nextBookingSourceJobId === null &&
    recurringOccurrencePlan("WEEKLY").correctiveCleanSourceJobId === null &&
    isRecurringSeriesSource({
      recurrenceSourceJobId: null,
      nextBookingSourceJobId: null,
      correctiveCleanSourceJobId: null,
    }) === true &&
    isRecurringSeriesSource({ nextBookingSourceJobId: "nb" }) === false,
);
check(
  "Date and confirmation parsers require explicit values",
  parseOwnerRecurringConfirmation("1") === true &&
    parseOwnerRecurringConfirmation("") === false &&
    parseOwnerRecurringCadence("WEEKLY") === "WEEKLY" &&
    parseOwnerRecurringCadence("DAILY") === "" &&
    parseOwnerRecurringStart({ date: "", timeZone: "America/Los_Angeles" }) === null &&
    parseOwnerRecurringStart({
      date: "2026-10-05",
      time: "18:00",
      timeZone: "America/Los_Angeles",
    })?.toISOString() === "2026-10-06T01:00:00.000Z" &&
    firstCivilDateIsInPast({
      firstAt: parseOwnerRecurringStart({
        date: "2026-09-27",
        time: "09:00",
        timeZone: "America/Los_Angeles",
      }),
      timeZone: "America/Los_Angeles",
      now: frozenNow,
    }) === true,
);
const weeklyStarts = listUpcomingRecurringStarts({
  firstAt: parseScheduleStart("2026-10-05", "09:00", "America/Los_Angeles"),
  cadence: "WEEKLY",
  timeZone: "America/Los_Angeles",
  now: frozenNow,
  maxOccurrences: 3,
});
check(
  "Upcoming list stays on the Los Angeles civil week and wall clock",
  weeklyStarts.length === 3 &&
    weeklyStarts.map((at) => formatISODateInTimeZone(at, "America/Los_Angeles")).join(",") ===
      "2026-10-05,2026-10-12,2026-10-19" &&
    weeklyStarts[0].toISOString() === "2026-10-05T16:00:00.000Z",
);
const dstStarts = listUpcomingRecurringStarts({
  firstAt: parseScheduleStart("2026-03-01", "09:00", "America/New_York"),
  cadence: "WEEKLY",
  timeZone: "America/New_York",
  now: new Date("2026-02-20T17:00:00.000Z"),
  maxOccurrences: 2,
});
check(
  "Weekly step keeps 09:00 America/New_York through the 2026 DST spring-forward",
  dstStarts.length === 2 &&
    dstStarts[0].toISOString() === "2026-03-01T14:00:00.000Z" &&
    dstStarts[1].toISOString() === "2026-03-08T13:00:00.000Z" &&
    formatISODateInTimeZone(dstStarts[1], "America/New_York") === "2026-03-08",
);
check(
  "Write path creates Jobs with occurrence keys and does not invoice or message",
  opsSrc.includes("tx.job.create") &&
    opsSrc.includes("recurrenceOccurrenceKey") &&
    opsSrc.includes("pg_advisory_xact_lock") &&
    opsSrc.includes("lockTenantOwnedJob") &&
    !opsSrc.includes("invoice.create") &&
    !opsSrc.includes("persistDraftInvoice") &&
    !opsSrc.includes("completeJobAndSendInvoice") &&
    !opsSrc.includes("notifyCustomer") &&
    !opsSrc.includes("emitAndProcessBusinessEvent") &&
    !actionSrc.includes("invoice.create") &&
    !actionSrc.includes("notifyCustomer"),
);
check(
  "Occurrences use recurrenceSourceJobId plus unique recurrenceOccurrenceKey",
  opsSrc.includes("recurrenceSourceJobId: input.source.id") &&
    opsSrc.includes("nextBookingSourceJobId: null") &&
    opsSrc.includes("correctiveCleanSourceJobId: null") &&
    schemaSrc.includes("recurrenceSourceJobId String?") &&
    !schemaSrc.includes("recurrenceSourceJobId String? @unique") &&
    schemaSrc.includes("recurrenceOccurrenceKey String? @unique") &&
    schemaSrc.includes("nextBookingSourceJobId String? @unique") &&
    schemaSrc.includes("correctiveCleanSourceJobId String? @unique") &&
    schemaSrc.includes("@@index([recurrenceSourceJobId])") &&
    migrationSrc.includes('ADD COLUMN IF NOT EXISTS "recurrenceOccurrenceKey"') &&
    migrationSrc.includes("CREATE UNIQUE INDEX IF NOT EXISTS") &&
    migrationSrc.includes("Job_recurrenceOccurrenceKey_key") &&
    !migrationSrc.includes("Job_recurrenceSourceJobId_key") &&
    !migrationSrc.includes("Job_nextBookingSourceJobId_key") &&
    !migrationSrc.includes("Job_correctiveCleanSourceJobId_key") &&
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migrationSrc),
);
check(
  "Duplicate and concurrent writes reuse the unique occurrence key (P2002 + lock)",
  opsSrc.includes("alreadyExists") &&
    opsSrc.includes("isRecurrenceOccurrenceKeyConflict") &&
    opsSrc.includes("recurrenceOccurrenceKey: key") &&
    opsSrc.includes("withSeriesLock") &&
    !opsSrc.includes("tx.job.findFirst") &&
    !/error\.code === ["']P2002["']/.test(opsSrc),
);
check(
  "Scheduled occurrences are gated and future unstarted stop uses Job.status CANCELLED",
  opsSrc.includes("evaluateProposedSchedule") &&
    opsSrc.includes("hasScheduleWarning") &&
    opsSrc.includes("detectScheduleConflicts") &&
    opsSrc.includes('status: "CANCELLED"') &&
    opsSrc.includes("reopenCancelled") &&
    !opsSrc.includes('status: { in: ["SCHEDULED", "UNSCHEDULED"] }') &&
    CLEANING_RECURRING_SLOT_BLOCKED_MESSAGE.includes("No bookings were created") &&
    canCancelUnstartedRecurringOccurrence({
      status: "SCHEDULED",
      scheduledAt: parseScheduleStart("2026-10-05", "09:00", "America/Los_Angeles"),
      timeZone: "America/Los_Angeles",
      now: frozenNow,
    }) === true &&
    canCancelUnstartedRecurringOccurrence({
      status: "IN_PROGRESS",
      scheduledAt: parseScheduleStart("2026-10-05", "09:00", "America/Los_Angeles"),
      timeZone: "America/Los_Angeles",
      now: frozenNow,
    }) === false &&
    canReopenCancelledRecurringOccurrence({
      status: "CANCELLED",
      scheduledAt: parseScheduleStart("2026-09-21", "09:00", "America/Los_Angeles"),
      timeZone: "America/Los_Angeles",
      now: frozenNow,
    }) === false &&
    canReopenCancelledRecurringOccurrence({
      status: "CANCELLED",
      scheduledAt: parseScheduleStart("2026-10-05", "09:00", "America/Los_Angeles"),
      timeZone: "America/Los_Angeles",
      now: frozenNow,
    }) === true,
);
check(
  "Recurring series and day-route appointment changes share one tenant schedule lock",
  reservationSrc.includes("schedule-reservation:") &&
    reservationSrc.includes("pg_advisory_xact_lock") &&
    businessScheduleReservationLockKey("biz") === "schedule-reservation:biz" &&
    opsSrc.includes("lockBusinessScheduleReservation") &&
    opsSrc.indexOf("await lockBusinessScheduleReservation") <
      opsSrc.indexOf("await lockTenantOwnedJob") &&
    dayRouteOpsSrc.includes("lockBusinessScheduleReservation") &&
    dayRouteOpsSrc.indexOf("await lockBusinessScheduleReservation") <
      dayRouteOpsSrc.indexOf("dayRouteAppointmentLockKey(access.businessId)"),
);
check(
  "Review loader is mutation-free and tenant-scoped",
  dataSrc.includes("...access.scope") &&
    !/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/.test(dataSrc),
);
check(
  "Job page and form require cadence, date, confirmation, and stop control",
  pageSrc.includes("CleaningRecurringBookingForm") &&
    pageSrc.includes("Recurring bookings") &&
    formSrc.includes('name="cadence"') &&
    formSrc.includes('name="date"') &&
    formSrc.includes('name="confirmCreate"') &&
    formSrc.includes('name="confirmStop"') &&
    formSrc.includes("Stop recurring bookings") &&
    formSrc.includes("one-time next") &&
    formSrc.includes("corrective clean") &&
    formSrc.includes("setupCleaningRecurringBookingsAction") &&
    formSrc.includes("stopCleaningRecurringBookingsAction") &&
    CLEANING_RECURRING_CREATED_MESSAGE.includes("No next booking, corrective clean") &&
    CLEANING_RECURRING_ALREADY_EXISTS_MESSAGE.includes("already has"),
);
check(
  "Feature stays off the visit-cadence and one-time copy write paths",
  !featureSrc.includes("createNextBookingFromCompletedCleaningJob") &&
    !featureSrc.includes("scheduleCorrectiveCleanFromReCleanRequestedJob") &&
    !opsSrc.includes("projectRecurrenceOccurrences"),
);
check(
  "Business-timezone helpers are the schedule start path",
  opsSrc.includes("parseOwnerRecurringStart") &&
    opsSrc.includes("businessTimeZoneForRecurringBooking") &&
    parseScheduleStart("2026-10-05", "18:00", "America/Los_Angeles")?.toISOString() ===
      "2026-10-06T01:00:00.000Z",
);

session = await openDisposableTestDatabase({
  databaseUrl: baseUrl,
  namePrefix: "tbbt_cleaning_recurring_booking",
  setProcessEnv: true,
});
prisma = session.prisma;

try {
  const suffix = randomUUID().slice(0, 8);
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia", email: `owner-rb-${suffix}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Ava", email: `admin-rb-${suffix}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia", email: `member-rb-${suffix}@example.com`, passwordHash: "x" },
  });
  const ownerBUser = await prisma.user.create({
    data: { name: "Bea", email: `beta-rb-${suffix}@example.com`, passwordHash: "x" },
  });
  const handyOwnerUser = await prisma.user.create({
    data: { name: "Hank", email: `handy-rb-${suffix}@example.com`, passwordHash: "x" },
  });

  const cleanA = await prisma.business.create({
    data: {
      name: "Alpha Recurring",
      slug: `alpha-rb-${suffix}`,
      tradeCode: "CLEANING",
      timezone: "America/Los_Angeles",
    },
  });
  const cleanB = await prisma.business.create({
    data: {
      name: "Beta Recurring",
      slug: `beta-rb-${suffix}`,
      tradeCode: "CLEANING",
      timezone: "America/New_York",
    },
  });
  const handyC = await prisma.business.create({
    data: {
      name: "Gamma Handy",
      slug: `gamma-rb-${suffix}`,
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
      status = "COMPLETED",
      includeCustomer = true,
      includeProperty = true,
      includeScope = true,
      tradeCode = "CLEANING",
      scheduledAt = new Date("2026-09-20T16:00:00.000Z"),
      reCleanRequested = false,
      pickupDurationMinutes = null,
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
    const job = await prisma.job.create({
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
        pickupDurationMinutes,
        serviceIntent: "ONE_TIME",
      },
    });
    if (reCleanRequested) {
      await prisma.jobCrewVisit.create({
        data: {
          businessId,
          jobId: job.id,
          checklistJson: "[]",
          outcomeStatus: "RE_CLEAN_REQUESTED",
        },
      });
    }
    return job;
  }

  const jobA = await createCleaningJob(cleanA.id);
  const jobAHours = await createCleaningJob(cleanA.id);
  const jobASunday = await createCleaningJob(cleanA.id);
  const jobAAtomic = await createCleaningJob(cleanA.id);
  const jobABuffer = await createCleaningJob(cleanA.id);
  const jobAPickup = await createCleaningJob(cleanA.id, { pickupDurationMinutes: 45 });
  const jobANoCustomer = await createCleaningJob(cleanA.id, {
    includeCustomer: false,
    includeProperty: false,
  });
  const jobANoProperty = await createCleaningJob(cleanA.id, { includeProperty: false });
  const jobANoScope = await createCleaningJob(cleanA.id, { includeScope: false });
  const jobADistinct = await createCleaningJob(cleanA.id, { reCleanRequested: true });
  const jobAConcurrent = await createCleaningJob(cleanA.id);
  const jobRaceA = await createCleaningJob(cleanA.id);
  const jobRaceB = await createCleaningJob(cleanA.id);
  const jobRaceC = await createCleaningJob(cleanA.id);
  const jobB = await createCleaningJob(cleanB.id);
  const handyJob = await createCleaningJob(handyC.id, { tradeCode: "HANDYMAN" });

  const invoicesBefore = await countBusinessInvoices(prisma, cleanA.id);

  console.log("\nLIVE — authorization, isolation, date boundaries, idempotency");

  await expectThrow(
    "ADMIN cannot set up recurring bookings",
    () =>
      setupCleaningRecurringBookings(prisma, adminA, {
        jobId: jobA.id,
        cadence: "WEEKLY",
        date: "2026-10-05",
        time: "09:00",
        confirmCreate: "1",
        now: frozenNow,
      }),
    (error) =>
      error instanceof ForbiddenError &&
      cleaningRecurringBookingErrorMessage(error, "") === OWNER_MANAGES_RECURRING_BOOKINGS_MESSAGE,
  );
  await expectThrow(
    "MEMBER cannot set up recurring bookings",
    () =>
      setupCleaningRecurringBookings(prisma, memberA, {
        jobId: jobA.id,
        cadence: "WEEKLY",
        date: "2026-10-05",
        time: "09:00",
        confirmCreate: "1",
        now: frozenNow,
      }),
    (error) =>
      error instanceof ForbiddenError &&
      cleaningRecurringBookingErrorMessage(error, "") === OWNER_MANAGES_RECURRING_BOOKINGS_MESSAGE,
  );
  await expectThrow(
    "OWNER cannot set up recurring bookings from a Handyman job",
    () =>
      setupCleaningRecurringBookings(prisma, handyOwner, {
        jobId: handyJob.id,
        cadence: "WEEKLY",
        date: "2026-10-05",
        confirmCreate: "1",
        now: frozenNow,
      }),
    (error) =>
      error instanceof Error && error.message === CLEANING_RECURRING_BOOKING_ONLY_MESSAGE,
  );
  await expectThrow(
    "OWNER A cannot set up recurring bookings from business B's job",
    () =>
      setupCleaningRecurringBookings(prisma, ownerA, {
        jobId: jobB.id,
        cadence: "WEEKLY",
        date: "2026-10-05",
        confirmCreate: "1",
        now: frozenNow,
      }),
    (error) =>
      error instanceof Error &&
      error.message === "Record is not in the authorized business workspace.",
  );
  await expectThrow(
    "Cadence is required",
    () =>
      setupCleaningRecurringBookings(prisma, ownerA, {
        jobId: jobA.id,
        cadence: "DAILY",
        date: "2026-10-05",
        confirmCreate: "1",
        now: frozenNow,
      }),
    (error) =>
      error instanceof Error && error.message === CLEANING_RECURRING_CADENCE_REQUIRED_MESSAGE,
  );
  await expectThrow(
    "Date is required",
    () =>
      setupCleaningRecurringBookings(prisma, ownerA, {
        jobId: jobA.id,
        cadence: "WEEKLY",
        date: "",
        confirmCreate: "1",
        now: frozenNow,
      }),
    (error) =>
      error instanceof Error && error.message === CLEANING_RECURRING_DATE_REQUIRED_MESSAGE,
  );
  await expectThrow(
    "Confirmation is required",
    () =>
      setupCleaningRecurringBookings(prisma, ownerA, {
        jobId: jobA.id,
        cadence: "WEEKLY",
        date: "2026-10-05",
        confirmCreate: "",
        now: frozenNow,
      }),
    (error) =>
      error instanceof Error && error.message === CLEANING_RECURRING_CONFIRM_REQUIRED_MESSAGE,
  );
  await expectThrow(
    "Invalid civil date is rejected",
    () =>
      setupCleaningRecurringBookings(prisma, ownerA, {
        jobId: jobA.id,
        cadence: "WEEKLY",
        date: "2026-13-40",
        confirmCreate: "1",
        now: frozenNow,
      }),
    (error) =>
      error instanceof Error && error.message === CLEANING_RECURRING_INVALID_DATE_MESSAGE,
  );
  await expectThrow(
    "First date before today in the business timezone is rejected",
    () =>
      setupCleaningRecurringBookings(prisma, ownerA, {
        jobId: jobA.id,
        cadence: "WEEKLY",
        date: "2026-09-27",
        time: "09:00",
        confirmCreate: "1",
        now: frozenNow,
      }),
    (error) =>
      error instanceof Error && error.message === CLEANING_RECURRING_DATE_IN_PAST_MESSAGE,
  );
  await expectThrow(
    "Same-business customer is required",
    () =>
      setupCleaningRecurringBookings(prisma, ownerA, {
        jobId: jobANoCustomer.id,
        cadence: "WEEKLY",
        date: "2026-10-05",
        confirmCreate: "1",
        now: frozenNow,
      }),
    (error) =>
      error instanceof Error && error.message === CLEANING_RECURRING_CUSTOMER_REQUIRED_MESSAGE,
  );
  await expectThrow(
    "Same-business property is required",
    () =>
      setupCleaningRecurringBookings(prisma, ownerA, {
        jobId: jobANoProperty.id,
        cadence: "WEEKLY",
        date: "2026-10-05",
        confirmCreate: "1",
        now: frozenNow,
      }),
    (error) =>
      error instanceof Error && error.message === CLEANING_RECURRING_PROPERTY_REQUIRED_MESSAGE,
  );
  await expectThrow(
    "Selected service scope is required",
    () =>
      setupCleaningRecurringBookings(prisma, ownerA, {
        jobId: jobANoScope.id,
        cadence: "WEEKLY",
        date: "2026-10-05",
        confirmCreate: "1",
        now: frozenNow,
      }),
    (error) =>
      error instanceof Error && error.message === CLEANING_RECURRING_SCOPE_REQUIRED_MESSAGE,
  );

  const leakedReview = await loadCleaningRecurringBookingReview(prisma, ownerA, jobB.id);
  const handyReview = await loadCleaningRecurringBookingReview(prisma, handyOwner, handyJob.id);
  const ownerReview = await loadCleaningRecurringBookingReview(prisma, ownerA, jobA.id);
  check(
    "Review loader is tenant-isolated and Cleaning-only",
    leakedReview === null &&
      handyReview === null &&
      ownerReview?.eligible === true &&
      ownerReview.customer?.id === jobA.customerId &&
      ownerReview.property?.id === jobA.propertyId &&
      ownerReview.scopeLines.some((line) => line.title === "Standard clean") &&
      ownerReview.canSetup === true,
  );

  const jobsBeforeBlocked = await countBusinessJobs(prisma, cleanA.id);
  await expectThrow(
    "Outside working hours rejects setup atomically",
    () =>
      setupCleaningRecurringBookings(prisma, ownerA, {
        jobId: jobAHours.id,
        cadence: "WEEKLY",
        date: "2026-10-06",
        time: "18:00",
        confirmCreate: "1",
        now: frozenNow,
      }),
    (error) =>
      error instanceof Error && error.message === CLEANING_RECURRING_SLOT_BLOCKED_MESSAGE,
  );
  await expectThrow(
    "Sunday non-working day rejects setup atomically",
    () =>
      setupCleaningRecurringBookings(prisma, ownerA, {
        jobId: jobASunday.id,
        cadence: "WEEKLY",
        date: "2026-10-04",
        time: "09:00",
        confirmCreate: "1",
        now: frozenNow,
      }),
    (error) =>
      error instanceof Error && error.message === CLEANING_RECURRING_SLOT_BLOCKED_MESSAGE,
  );
  const overlapBlocker = await prisma.job.create({
    data: {
      businessId: cleanA.id,
      customerId: jobAAtomic.customerId,
      propertyId: jobAAtomic.propertyId,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: parseScheduleStart("2026-11-18", "09:00", "America/Los_Angeles"),
      scheduledDurationMinutes: 120,
      serviceIntent: "ONE_TIME",
    },
  });
  await expectThrow(
    "A later occupied slot rejects the whole series and creates no occurrences",
    () =>
      setupCleaningRecurringBookings(prisma, ownerA, {
        jobId: jobAAtomic.id,
        cadence: "WEEKLY",
        date: "2026-10-07",
        time: "09:00",
        confirmCreate: "1",
        now: frozenNow,
      }),
    (error) =>
      error instanceof Error && error.message === CLEANING_RECURRING_SLOT_BLOCKED_MESSAGE,
  );
  const bufferBlocker = await prisma.job.create({
    data: {
      businessId: cleanA.id,
      customerId: jobABuffer.customerId,
      propertyId: jobABuffer.propertyId,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: parseScheduleStart("2026-10-08", "09:00", "America/Los_Angeles"),
      scheduledDurationMinutes: 120,
      serviceIntent: "ONE_TIME",
    },
  });
  await expectThrow(
    "Travel/pickup buffer overlap rejects setup atomically",
    () =>
      setupCleaningRecurringBookings(prisma, ownerA, {
        jobId: jobABuffer.id,
        cadence: "WEEKLY",
        date: "2026-10-08",
        time: "11:15",
        confirmCreate: "1",
        now: frozenNow,
      }),
    (error) =>
      error instanceof Error && error.message === CLEANING_RECURRING_SLOT_BLOCKED_MESSAGE,
  );
  const pickupBlocker = await prisma.job.create({
    data: {
      businessId: cleanA.id,
      customerId: jobAPickup.customerId,
      propertyId: jobAPickup.propertyId,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: parseScheduleStart("2026-10-09", "09:00", "America/Los_Angeles"),
      scheduledDurationMinutes: 120,
      serviceIntent: "ONE_TIME",
    },
  });
  await expectThrow(
    "Pickup window overlap rejects setup atomically",
    () =>
      setupCleaningRecurringBookings(prisma, ownerA, {
        jobId: jobAPickup.id,
        cadence: "WEEKLY",
        date: "2026-10-09",
        time: "11:40",
        confirmCreate: "1",
        now: frozenNow,
      }),
    (error) =>
      error instanceof Error && error.message === CLEANING_RECURRING_SLOT_BLOCKED_MESSAGE,
  );
  const blockedSeriesCount = await prisma.job.count({
    where: {
      businessId: cleanA.id,
      recurrenceSourceJobId: { in: [jobAHours.id, jobASunday.id, jobAAtomic.id, jobABuffer.id, jobAPickup.id] },
    },
  });
  const jobsAfterBlocked = await countBusinessJobs(prisma, cleanA.id);
  check(
    "Blocked-slot setups leave no recurring occurrences and add only the blocker jobs",
    blockedSeriesCount === 0 &&
      jobsAfterBlocked === jobsBeforeBlocked + 3 &&
      overlapBlocker.status === "SCHEDULED" &&
      bufferBlocker.status === "SCHEDULED" &&
      pickupBlocker.status === "SCHEDULED",
  );

  const raceStart = parseScheduleStart("2026-10-06", "09:00", "America/Los_Angeles");
  const [seriesLeft, seriesRight] = await Promise.allSettled([
    setupCleaningRecurringBookings(prisma, ownerA, {
      jobId: jobRaceA.id,
      cadence: "WEEKLY",
      date: "2026-10-06",
      time: "09:00",
      confirmCreate: "1",
      now: frozenNow,
    }),
    setupCleaningRecurringBookings(prisma, ownerA, {
      jobId: jobRaceB.id,
      cadence: "WEEKLY",
      date: "2026-10-06",
      time: "09:00",
      confirmCreate: "1",
      now: frozenNow,
    }),
  ]);
  const seriesWins = [seriesLeft, seriesRight].filter((row) => row.status === "fulfilled");
  const seriesLosses = [seriesLeft, seriesRight].filter((row) => row.status === "rejected");
  const raceACount = await prisma.job.count({
    where: { businessId: cleanA.id, recurrenceSourceJobId: jobRaceA.id },
  });
  const raceBCount = await prisma.job.count({
    where: { businessId: cleanA.id, recurrenceSourceJobId: jobRaceB.id },
  });
  const seriesSlotHolders = await prisma.job.findMany({
    where: {
      businessId: cleanA.id,
      scheduledAt: raceStart,
      status: { notIn: ["COMPLETED", "CANCELLED"] },
    },
    select: { id: true, recurrenceSourceJobId: true, status: true },
  });
  check(
    "Concurrent series vs series: exactly one claims the slot and the loser is a handled conflict",
    seriesWins.length === 1 &&
      seriesLosses.length === 1 &&
      seriesLosses[0].reason?.message === CLEANING_RECURRING_SLOT_BLOCKED_MESSAGE &&
      ((raceACount === MAX_UPCOMING_RECURRING_BOOKINGS && raceBCount === 0) ||
        (raceBCount === MAX_UPCOMING_RECURRING_BOOKINGS && raceACount === 0)) &&
      seriesSlotHolders.length === 1 &&
      (seriesSlotHolders[0].recurrenceSourceJobId === jobRaceA.id ||
        seriesSlotHolders[0].recurrenceSourceJobId === jobRaceB.id),
  );

  const movable = await prisma.job.create({
    data: {
      businessId: cleanA.id,
      customerId: jobRaceC.customerId,
      propertyId: jobRaceC.propertyId,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: parseScheduleStart("2026-10-08", "15:00", "America/Los_Angeles"),
      scheduledDurationMinutes: 120,
      pickupDurationMinutes: null,
      arrivalWindowMinutes: null,
      assignedMembershipId: null,
      serviceIntent: "ONE_TIME",
    },
  });
  const movableSnapshot = scheduleSnapshotFromJob(movable);
  const [seriesVsRoute, routeVsSeries] = await Promise.allSettled([
    setupCleaningRecurringBookings(prisma, ownerA, {
      jobId: jobRaceC.id,
      cadence: "WEEKLY",
      date: "2026-10-09",
      time: "15:00",
      confirmCreate: "1",
      now: frozenNow,
    }),
    changeOwnerDayRouteAppointment(prisma, ownerA, {
      jobId: movable.id,
      date: "2026-10-09",
      time: "15:00",
      snapshot: movableSnapshot,
    }),
  ]);
  const routeRaceOutcomes = [seriesVsRoute, routeVsSeries];
  const routeWins = routeRaceOutcomes.filter((row) => row.status === "fulfilled");
  const routeLosses = routeRaceOutcomes.filter((row) => row.status === "rejected");
  const raceCCount = await prisma.job.count({
    where: { businessId: cleanA.id, recurrenceSourceJobId: jobRaceC.id },
  });
  const moved = await prisma.job.findFirst({
    where: { id: movable.id, businessId: cleanA.id },
    select: { id: true, scheduledAt: true, status: true },
  });
  const routeSlot = parseScheduleStart("2026-10-09", "15:00", "America/Los_Angeles");
  const routeSlotHolders = await prisma.job.findMany({
    where: {
      businessId: cleanA.id,
      scheduledAt: routeSlot,
      status: { notIn: ["COMPLETED", "CANCELLED"] },
    },
    select: { id: true, recurrenceSourceJobId: true },
  });
  const routeLoserMessage = routeLosses[0]?.reason?.message ?? "";
  check(
    "Concurrent series vs day-route: exactly one claims the slot and the loser is a handled conflict",
    routeWins.length === 1 &&
      routeLosses.length === 1 &&
      routeSlotHolders.length === 1 &&
      (routeLoserMessage === CLEANING_RECURRING_SLOT_BLOCKED_MESSAGE ||
        routeLoserMessage === DAY_ROUTE_APPOINTMENT_CONFLICT_MESSAGE ||
        /overlap/i.test(routeLoserMessage)) &&
      ((seriesVsRoute.status === "fulfilled" &&
        raceCCount === MAX_UPCOMING_RECURRING_BOOKINGS &&
        moved?.scheduledAt?.toISOString() === movable.scheduledAt.toISOString()) ||
        (routeVsSeries.status === "fulfilled" &&
          raceCCount === 0 &&
          moved?.scheduledAt?.toISOString() === routeSlot.toISOString() &&
          routeSlotHolders[0].id === movable.id)),
  );

  const jobsBeforeCreate = await countBusinessJobs(prisma, cleanA.id);
  const created = await setupCleaningRecurringBookings(prisma, ownerA, {
    jobId: jobA.id,
    cadence: "WEEKLY",
    date: "2026-10-05",
    time: "09:00",
    confirmCreate: "1",
    now: frozenNow,
  });
  const jobsAfterCreate = await countBusinessJobs(prisma, cleanA.id);
  const invoicesAfterCreate = await countBusinessInvoices(prisma, cleanA.id);
  const first = created.occurrences[0];
  const civilDates = created.occurrences
    .map((row) => (row.scheduledAt ? recurringBookingCivilDate(row.scheduledAt, "America/Los_Angeles") : ""))
    .join(",");
  const sourceAfter = await prisma.job.findFirst({
    where: { id: jobA.id, businessId: cleanA.id },
  });
  const firstRow = await prisma.job.findFirst({
    where: { id: first?.id, businessId: cleanA.id },
    include: { invoices: true, appointmentEvents: true, crewVisit: true },
  });

  check(
    "OWNER creates a bounded weekly series that carries customer, property, and scope",
    created.alreadyExists === false &&
      created.sourceJobId === jobA.id &&
      created.recurrenceStatus === "ACTIVE" &&
      created.recurrenceCadence === "WEEKLY" &&
      created.createdCount === MAX_UPCOMING_RECURRING_BOOKINGS &&
      created.occurrences.length === MAX_UPCOMING_RECURRING_BOOKINGS &&
      created.occurrences.every(
        (row) =>
          row.businessId === cleanA.id &&
          row.customerId === jobA.customerId &&
          row.propertyId === jobA.propertyId &&
          row.estimateId === jobA.estimateId &&
          row.approvedEstimateVersionId === jobA.approvedEstimateVersionId &&
          row.recurrenceSourceJobId === jobA.id &&
          row.nextBookingSourceJobId === null &&
          row.correctiveCleanSourceJobId === null &&
          row.serviceIntent === "RECURRING" &&
          row.recurrenceCadence === "WEEKLY" &&
          row.status === "SCHEDULED",
      ) &&
      jobsAfterCreate === jobsBeforeCreate + MAX_UPCOMING_RECURRING_BOOKINGS,
  );
  check(
    "Business-timezone first date is Los Angeles civil 2026-10-05, not the UTC day",
    first?.scheduledAt?.toISOString() === "2026-10-05T16:00:00.000Z" &&
      recurringBookingCivilDate(first.scheduledAt, "America/Los_Angeles") === "2026-10-05" &&
      formatISODateInTimeZone(first.scheduledAt, "UTC") === "2026-10-05" &&
      civilDates.startsWith("2026-10-05,2026-10-12") &&
      DEFAULT_RECURRING_BOOKING_TIME === "09:00",
  );
  check(
    "Occurrence keys are unique per source civil date",
    created.occurrences.every(
      (row, index, rows) =>
        row.recurrenceOccurrenceKey ===
          recurrenceOccurrenceKey(
            jobA.id,
            recurringBookingCivilDate(row.scheduledAt, "America/Los_Angeles"),
          ) &&
        rows.filter((other) => other.recurrenceOccurrenceKey === row.recurrenceOccurrenceKey)
          .length === 1,
    ),
  );
  check(
    "Setup writes no invoice, appointment message, or crew visit on occurrences",
    invoicesAfterCreate === invoicesBefore &&
      firstRow?.invoices.length === 0 &&
      firstRow?.appointmentEvents.length === 0 &&
      firstRow?.crewVisit === null &&
      firstRow?.appointmentConfirmationStatus === "NONE" &&
      sourceAfter?.serviceIntent === "RECURRING" &&
      sourceAfter?.recurrenceCadence === "WEEKLY" &&
      sourceAfter?.recurrenceStatus === "ACTIVE",
  );

  const duplicate = await setupCleaningRecurringBookings(prisma, ownerA, {
    jobId: jobA.id,
    cadence: "MONTHLY",
    date: "2026-11-01",
    time: "10:00",
    confirmCreate: "1",
    now: frozenNow,
  });
  const jobsAfterDuplicate = await countBusinessJobs(prisma, cleanA.id);
  check(
    "Retry of setup returns the existing series and does not change cadence or dates",
    duplicate.alreadyExists === true &&
      duplicate.occurrences.length === created.occurrences.length &&
      duplicate.occurrences[0].id === created.occurrences[0].id &&
      duplicate.occurrences[0].scheduledAt?.toISOString() ===
        created.occurrences[0].scheduledAt?.toISOString() &&
      duplicate.recurrenceCadence === "WEEKLY" &&
      jobsAfterDuplicate === jobsAfterCreate,
  );

  const fillRetry = await fillCleaningRecurringBookings(prisma, ownerA, {
    jobId: jobA.id,
    now: frozenNow,
  });
  const jobsAfterFill = await countBusinessJobs(prisma, cleanA.id);
  check(
    "Fill upcoming is idempotent when the window is already full",
    fillRetry.createdCount === 0 &&
      fillRetry.occurrences.length === created.occurrences.length &&
      jobsAfterFill === jobsAfterCreate,
  );

  const [concurrentOne, concurrentTwo] = await Promise.all([
    setupCleaningRecurringBookings(prisma, ownerA, {
      jobId: jobAConcurrent.id,
      cadence: "WEEKLY",
      date: "2026-10-05",
      time: "12:00",
      confirmCreate: "1",
      now: frozenNow,
    }),
    setupCleaningRecurringBookings(prisma, ownerA, {
      jobId: jobAConcurrent.id,
      cadence: "WEEKLY",
      date: "2026-10-05",
      time: "12:00",
      confirmCreate: "1",
      now: frozenNow,
    }),
  ]);
  const concurrentCount = await prisma.job.count({
    where: { businessId: cleanA.id, recurrenceSourceJobId: jobAConcurrent.id },
  });
  const concurrentKeys = await prisma.job.findMany({
    where: { businessId: cleanA.id, recurrenceSourceJobId: jobAConcurrent.id },
    select: { recurrenceOccurrenceKey: true },
  });
  check(
    "Concurrent setup creates one series and no duplicate occurrence keys",
    concurrentCount === MAX_UPCOMING_RECURRING_BOOKINGS &&
      new Set(concurrentKeys.map((row) => row.recurrenceOccurrenceKey)).size ===
        MAX_UPCOMING_RECURRING_BOOKINGS &&
      [concurrentOne, concurrentTwo].some((row) => row.alreadyExists === true) &&
      [concurrentOne, concurrentTwo].some((row) => row.alreadyExists === false),
  );

  const [fillOne, fillTwo] = await Promise.all([
    fillCleaningRecurringBookings(prisma, ownerA, {
      jobId: jobAConcurrent.id,
      now: frozenNow,
    }),
    fillCleaningRecurringBookings(prisma, ownerA, {
      jobId: jobAConcurrent.id,
      now: frozenNow,
    }),
  ]);
  const concurrentCountAfterFill = await prisma.job.count({
    where: { businessId: cleanA.id, recurrenceSourceJobId: jobAConcurrent.id },
  });
  check(
    "Concurrent fill does not create extra jobs",
    concurrentCountAfterFill === MAX_UPCOMING_RECURRING_BOOKINGS &&
      fillOne.createdCount === 0 &&
      fillTwo.createdCount === 0,
  );

  let occurrenceKeyError = null;
  try {
    await prisma.job.create({
      data: {
        businessId: cleanA.id,
        customerId: jobA.customerId,
        propertyId: jobA.propertyId,
        estimateId: jobA.estimateId,
        projectToken: randomUUID(),
        status: "SCHEDULED",
        scheduledAt: new Date("2026-12-01T16:00:00.000Z"),
        recurrenceSourceJobId: jobA.id,
        recurrenceOccurrenceKey: created.occurrences[0].recurrenceOccurrenceKey,
      },
    });
  } catch (error) {
    occurrenceKeyError = error;
  }
  let unrelatedUniqueError = null;
  try {
    await prisma.job.create({
      data: {
        businessId: cleanA.id,
        customerId: jobA.customerId,
        propertyId: jobA.propertyId,
        estimateId: jobA.estimateId,
        projectToken: jobA.projectToken,
        status: "SCHEDULED",
        scheduledAt: new Date("2026-12-02T16:00:00.000Z"),
      },
    });
  } catch (error) {
    unrelatedUniqueError = error;
  }
  check(
    "P2002 on recurrenceOccurrenceKey is recoverable; an unrelated unique is not treated as an existing occurrence",
    occurrenceKeyError?.code === "P2002" &&
      unrelatedUniqueError?.code === "P2002" &&
      isRecurrenceOccurrenceKeyConflict(occurrenceKeyError) === true &&
      isRecurrenceOccurrenceKeyConflict(unrelatedUniqueError) === false,
  );

  const reviewAfter = await loadCleaningRecurringBookingReview(prisma, ownerA, jobA.id);
  check(
    "Review after setup lists occurrences and exposes stop, not setup",
    reviewAfter?.canSetup === false &&
      reviewAfter.canStop === true &&
      reviewAfter.canFillUpcoming === true &&
      reviewAfter.occurrences.length === MAX_UPCOMING_RECURRING_BOOKINGS &&
      reviewAfter.occurrences[0].id === created.occurrences[0].id,
  );

  const isolated = await prisma.job.findFirst({
    where: { id: created.occurrences[0].id, ...businessScope(cleanB.id) },
  });
  const ownerBSeesA = await loadCleaningRecurringBookingReview(prisma, ownerB, jobA.id);
  const ownerBSeesCreated = await prisma.job.findFirst({
    where: { id: created.occurrences[0].id, businessId: cleanB.id },
  });
  check(
    "Recurring occurrences are invisible to the other tenant",
    isolated === null && ownerBSeesA === null && ownerBSeesCreated === null,
  );

  const createdB = await setupCleaningRecurringBookings(prisma, ownerB, {
    jobId: jobB.id,
    cadence: "WEEKLY",
    date: "2026-10-05",
    time: "09:00",
    confirmCreate: "1",
    now: frozenNow,
  });
  check(
    "Business B stores the same civil date in America/New_York, not Los Angeles",
    createdB.occurrences[0].businessId === cleanB.id &&
      createdB.occurrences[0].scheduledAt?.toISOString() === "2026-10-05T13:00:00.000Z" &&
      recurringBookingCivilDate(createdB.occurrences[0].scheduledAt, "America/New_York") ===
        "2026-10-05" &&
      createdB.occurrences[0].scheduledAt?.toISOString() !== first.scheduledAt?.toISOString(),
  );

  const aCannotReadB = await prisma.job.findFirst({
    where: { id: createdB.occurrences[0].id, ...businessScope(cleanA.id) },
  });
  check("Owner A cannot read business B's recurring occurrence", aCannotReadB === null);

  await expectThrow(
    "ADMIN cannot stop recurring bookings",
    () =>
      stopCleaningRecurringBookings(prisma, adminA, {
        jobId: jobA.id,
        confirmStop: "1",
      }),
    (error) =>
      error instanceof ForbiddenError &&
      cleaningRecurringBookingErrorMessage(error, "") === OWNER_MANAGES_RECURRING_BOOKINGS_MESSAGE,
  );
  await expectThrow(
    "Stop confirmation is required",
    () =>
      stopCleaningRecurringBookings(prisma, ownerA, {
        jobId: jobA.id,
        confirmStop: "",
      }),
    (error) =>
      error instanceof Error && error.message === CLEANING_RECURRING_STOP_CONFIRM_REQUIRED_MESSAGE,
  );

  const inProgressOccurrence = created.occurrences[0];
  const completedOccurrence = created.occurrences[1];
  const futureUnstartedOccurrence = created.occurrences[2];
  await prisma.job.update({
    where: { id: inProgressOccurrence.id },
    data: { status: "IN_PROGRESS" },
  });
  await prisma.job.update({
    where: { id: completedOccurrence.id },
    data: { status: "COMPLETED" },
  });
  const pastOccurrence = await prisma.job.create({
    data: {
      businessId: cleanA.id,
      customerId: jobA.customerId,
      propertyId: jobA.propertyId,
      estimateId: jobA.estimateId,
      approvedEstimateVersionId: jobA.approvedEstimateVersionId,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt: parseScheduleStart("2026-09-21", "09:00", "America/Los_Angeles"),
      scheduledDurationMinutes: 120,
      serviceIntent: "RECURRING",
      recurrenceCadence: "WEEKLY",
      recurrenceStatus: "ACTIVE",
      recurrenceSourceJobId: jobA.id,
      recurrenceOccurrenceKey: recurrenceOccurrenceKey(jobA.id, "2026-09-21"),
    },
  });

  const jobsBeforeStop = await countBusinessJobs(prisma, cleanA.id);
  const stopped = await stopCleaningRecurringBookings(prisma, ownerA, {
    jobId: jobA.id,
    confirmStop: "1",
    now: frozenNow,
  });
  const sourceStopped = await prisma.job.findFirst({
    where: { id: jobA.id, businessId: cleanA.id },
  });
  const stoppedOccurrences = await prisma.job.findMany({
    where: { businessId: cleanA.id, recurrenceSourceJobId: jobA.id },
    orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
  });
  const jobsAfterStop = await countBusinessJobs(prisma, cleanA.id);
  const stoppedById = new Map(stoppedOccurrences.map((row) => [row.id, row]));
  check(
    "Stop sets future unstarted Job.status to CANCELLED and leaves started, completed, and past work alone",
    stopped.recurrenceStatus === "CANCELLED" &&
      sourceStopped?.recurrenceStatus === "CANCELLED" &&
      sourceStopped?.status === "COMPLETED" &&
      sourceStopped?.nextOccurrenceAt === null &&
      stoppedById.get(inProgressOccurrence.id)?.status === "IN_PROGRESS" &&
      stoppedById.get(inProgressOccurrence.id)?.recurrenceStatus === "ACTIVE" &&
      stoppedById.get(completedOccurrence.id)?.status === "COMPLETED" &&
      stoppedById.get(completedOccurrence.id)?.recurrenceStatus === "ACTIVE" &&
      stoppedById.get(pastOccurrence.id)?.status === "SCHEDULED" &&
      stoppedById.get(pastOccurrence.id)?.recurrenceStatus === "CANCELLED" &&
      stoppedById.get(pastOccurrence.id)?.scheduledAt?.toISOString() ===
        pastOccurrence.scheduledAt.toISOString() &&
      stoppedById.get(futureUnstartedOccurrence.id)?.status === "CANCELLED" &&
      stoppedById.get(futureUnstartedOccurrence.id)?.recurrenceStatus === "CANCELLED" &&
      stoppedById.get(futureUnstartedOccurrence.id)?.scheduledAt?.toISOString() ===
        futureUnstartedOccurrence.scheduledAt.toISOString() &&
      stoppedOccurrences.filter((row) =>
        created.occurrences.slice(2).some((item) => item.id === row.id),
      ).every((row) => row.status === "CANCELLED" && row.recurrenceStatus === "CANCELLED") &&
      jobsAfterStop === jobsBeforeStop,
  );

  await expectThrow(
    "Fill after stop does not create more jobs",
    () =>
      fillCleaningRecurringBookings(prisma, ownerA, {
        jobId: jobA.id,
        now: frozenNow,
      }),
    (error) => error instanceof Error && error.message === CLEANING_RECURRING_NOT_ACTIVE_MESSAGE,
  );
  const jobsAfterStoppedFill = await countBusinessJobs(prisma, cleanA.id);
  check("Stopped series job count is unchanged after refused fill", jobsAfterStoppedFill === jobsAfterStop);

  const resumed = await resumeCleaningRecurringBookings(prisma, ownerA, {
    jobId: jobA.id,
    confirmResume: "1",
    now: frozenNow,
  });
  const resumedById = new Map(resumed.occurrences.map((row) => [row.id, row]));
  check(
    "Resume reopens only future canceled unstarted jobs and does not duplicate keys",
    resumed.recurrenceStatus === "ACTIVE" &&
      resumed.occurrences.length === MAX_UPCOMING_RECURRING_BOOKINGS + 1 &&
      resumedById.get(inProgressOccurrence.id)?.status === "IN_PROGRESS" &&
      resumedById.get(completedOccurrence.id)?.status === "COMPLETED" &&
      resumedById.get(pastOccurrence.id)?.status === "SCHEDULED" &&
      resumedById.get(pastOccurrence.id)?.recurrenceStatus === "CANCELLED" &&
      resumedById.get(futureUnstartedOccurrence.id)?.status === "SCHEDULED" &&
      resumedById.get(futureUnstartedOccurrence.id)?.recurrenceStatus === "ACTIVE" &&
      created.occurrences.slice(2).every(
        (row) =>
          resumedById.get(row.id)?.status === "SCHEDULED" &&
          resumedById.get(row.id)?.recurrenceStatus === "ACTIVE",
      ),
  );

  const nextBooking = await createNextBookingFromCompletedCleaningJob(prisma, ownerA, {
    jobId: jobADistinct.id,
    date: "2026-10-20",
    time: "14:00",
    confirmCreate: "1",
  });
  const corrective = await scheduleCorrectiveCleanFromReCleanRequestedJob(prisma, ownerA, {
    jobId: jobADistinct.id,
    date: "2026-10-21",
    time: "14:00",
    confirmCreate: "1",
  });
  const recurringDistinct = await setupCleaningRecurringBookings(prisma, ownerA, {
    jobId: jobADistinct.id,
    cadence: "BIWEEKLY",
    date: "2026-10-15",
    time: "14:00",
    confirmCreate: "1",
    now: frozenNow,
  });
  const nextRow = await prisma.job.findFirst({
    where: { id: nextBooking.id, businessId: cleanA.id },
    select: {
      nextBookingSourceJobId: true,
      correctiveCleanSourceJobId: true,
      recurrenceSourceJobId: true,
      recurrenceOccurrenceKey: true,
      serviceIntent: true,
    },
  });
  const correctiveRow = await prisma.job.findFirst({
    where: { id: corrective.id, businessId: cleanA.id },
    select: {
      nextBookingSourceJobId: true,
      correctiveCleanSourceJobId: true,
      recurrenceSourceJobId: true,
      recurrenceOccurrenceKey: true,
      serviceIntent: true,
    },
  });
  const recurringIds = new Set(recurringDistinct.occurrences.map((row) => row.id));
  check(
    "Recurring occurrences stay distinct from the one-time next booking and corrective clean",
    nextBooking.id !== corrective.id &&
      !recurringIds.has(nextBooking.id) &&
      !recurringIds.has(corrective.id) &&
      nextRow?.nextBookingSourceJobId === jobADistinct.id &&
      nextRow?.correctiveCleanSourceJobId === null &&
      nextRow?.recurrenceSourceJobId === null &&
      nextRow?.recurrenceOccurrenceKey === null &&
      nextRow?.serviceIntent === "ONE_TIME" &&
      correctiveRow?.correctiveCleanSourceJobId === jobADistinct.id &&
      correctiveRow?.nextBookingSourceJobId === null &&
      correctiveRow?.recurrenceSourceJobId === null &&
      correctiveRow?.recurrenceOccurrenceKey === null &&
      correctiveRow?.serviceIntent === "ONE_TIME" &&
      recurringDistinct.occurrences.every(
        (row) =>
          row.recurrenceSourceJobId === jobADistinct.id &&
          row.nextBookingSourceJobId === null &&
          row.correctiveCleanSourceJobId === null &&
          row.recurrenceOccurrenceKey &&
          row.serviceIntent === "RECURRING" &&
          row.recurrenceCadence === "BIWEEKLY",
      ),
  );

  await expectThrow(
    "A next-booking job cannot become a recurring series source",
    () =>
      setupCleaningRecurringBookings(prisma, ownerA, {
        jobId: nextBooking.id,
        cadence: "WEEKLY",
        date: "2026-11-02",
        confirmCreate: "1",
        now: frozenNow,
      }),
    (error) =>
      error instanceof Error && error.message === CLEANING_RECURRING_BOOKING_SOURCE_MESSAGE,
  );
  await expectThrow(
    "A corrective-clean job cannot become a recurring series source",
    () =>
      setupCleaningRecurringBookings(prisma, ownerA, {
        jobId: corrective.id,
        cadence: "WEEKLY",
        date: "2026-11-02",
        confirmCreate: "1",
        now: frozenNow,
      }),
    (error) =>
      error instanceof Error && error.message === CLEANING_RECURRING_BOOKING_SOURCE_MESSAGE,
  );
  await expectThrow(
    "A recurring occurrence cannot become a new series source",
    () =>
      setupCleaningRecurringBookings(prisma, ownerA, {
        jobId: recurringDistinct.occurrences[0].id,
        cadence: "WEEKLY",
        date: "2026-11-02",
        confirmCreate: "1",
        now: frozenNow,
      }),
    (error) =>
      error instanceof Error && error.message === CLEANING_RECURRING_BOOKING_SOURCE_MESSAGE,
  );

  const occurrenceReview = await loadCleaningRecurringBookingReview(
    prisma,
    ownerA,
    recurringDistinct.occurrences[0].id,
  );
  const nextBookingReview = await loadCleaningRecurringBookingReview(
    prisma,
    ownerA,
    nextBooking.id,
  );
  const correctiveReview = await loadCleaningRecurringBookingReview(
    prisma,
    ownerA,
    corrective.id,
  );
  check(
    "Review hides one-time copies and links occurrences back to the series source",
    nextBookingReview === null &&
      correctiveReview === null &&
      occurrenceReview?.isOccurrence === true &&
      occurrenceReview.sourceJobId === jobADistinct.id &&
      occurrenceReview.canSetup === false,
  );
} catch (error) {
  failed += 1;
  console.error("FAIL - live Cleaning recurring-booking proofs crashed");
  console.error(error);
} finally {
  if (session) await session.cleanup();
}

console.log(
  failed === 0
    ? `\nAll Cleaning recurring-booking checks passed (${passed}).`
    : `\n${failed} Cleaning recurring-booking check(s) failed; ${passed} passed.`,
);
process.exit(failed === 0 ? 0 : 1);
