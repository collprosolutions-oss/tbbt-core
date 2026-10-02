/**
 * Handyman public-request preferred days / time windows.
 *
 * Proves storage on the request, OWNER scheduling display, and that
 * preferences are not bookings. Owner approval, first exact slot, later
 * arrival windows, and the 30-minute buffer stay on scheduleJob.
 *
 * Dedicated disposable localhost Postgres. No migrate. No deploy.
 * No real customer messages.
 *
 * Run with:
 *   npm run test:request-preferred-windows
 */
import { register } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
}

function form(fields) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value != null) data.set(key, String(value));
  }
  return data;
}

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

console.log("\nSTATIC — preferences stay requests, not bookings");
const preferredFieldsSrc = readRepo(
  "src/components/public/request-preferred-windows-fields.tsx",
);
const preferredSrc = readRepo("src/lib/request-preferred-windows.ts");
const preferredDataSrc = readRepo("src/lib/request-preferred-windows-data.ts");
const intakeSrc = readRepo("src/lib/public-intake.ts");
const intakeActionSrc = readRepo("src/app/actions/intake.ts");
const requestFlowSrc = readRepo("src/components/public/request-flow.tsx");
const scheduleFormSrc = readRepo("src/components/jobs/schedule-job-form.tsx");
const jobActionSrc = readRepo("src/app/actions/job.ts");
const notesSrc = readRepo("src/lib/work-area-intake.ts");
const schemaSrc = readRepo("prisma/schema.prisma");

check(
  "Preferred windows encode on ServiceRequest.description, not a new Prisma column",
  preferredSrc.includes('PREFERRED_WINDOWS_MARKER = "\\n\\nTBBT Preferred Windows:\\n"') &&
    preferredSrc.includes("appendPreferredWindowsToDescription") &&
    !schemaSrc.includes("preferredWindowsJson") &&
    !schemaSrc.includes("ServiceRequestPreferredWindow") &&
    notesSrc.includes("PREFERRED_WINDOWS_MARKER"),
);
check(
  "Public Handyman submit stores preferences and never calls scheduleJob",
  intakeSrc.includes("normalizePreferredWindowsInput") &&
    intakeSrc.includes("appendPreferredWindowsToDescription") &&
    intakeActionSrc.includes("preferredWindows: parsePreferredWindowsField") &&
    requestFlowSrc.includes('resolvedTrade === "HANDYMAN"') &&
    requestFlowSrc.includes('"preferredWindows"') &&
    requestFlowSrc.includes("RequestPreferredWindowsFields") &&
    !intakeSrc.includes("scheduleJob(") &&
    !preferredSrc.includes("scheduleJob("),
);
check(
  "Preferred-window remove controls name the row; schedule explains unpaid-deposit disablement",
  preferredFieldsSrc.includes("preference {index + 1}") &&
    requestFlowSrc.includes("errorRef.current?.focus()") &&
    requestFlowSrc.includes("stepHeadingRef.current?.focus()") &&
    scheduleFormSrc.includes('id={`deposit-warning-${jobId}`}') &&
    scheduleFormSrc.includes("aria-describedby={unpaidDepositWarning ? `deposit-warning-${jobId}` : undefined}"),
);
check(
  "OWNER scheduling shows preferences and still uses scheduleJob",
  scheduleFormSrc.includes("RequestPreferredWindowsList") &&
    scheduleFormSrc.includes("preferredWindows") &&
    jobActionSrc.includes("evaluateOwnedScheduleProposal") &&
    jobActionSrc.includes("lockBusinessScheduleReservation") &&
    jobActionSrc.includes("arrivalWindowMinutesForMode") &&
    preferredDataSrc.includes("businessId !== access.businessId"),
);
check(
  "Preferences stay requests: stale/expired apply cannot book",
  preferredSrc.includes("PREFERRED_WINDOWS_NOT_A_BOOKING") &&
    preferredSrc.includes("applyPreferredWindowForScheduling") &&
    preferredSrc.includes("PREFERRED_WINDOWS_STALE_MESSAGE") &&
    preferredSrc.includes("void input.timeZone") &&
    preferredSrc.includes("resolveBusinessTimeZone(input.business)"),
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "request-preferred-windows disposable database");

const session = await openDisposableTestDatabase({
  databaseUrl: baseUrl,
  namePrefix: "tbbt_pref_windows",
  setProcessEnv: true,
});

try {
  const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
  const { createPublicServiceRequest } = await import("@/lib/public-intake");
  const { createJobFromApprovedEstimate } = await import("@/lib/job-from-estimate");
  const { scheduleJob, assignJobMember } = await import("@/app/actions/job");
  const { jobWriteTestHooks } = await import("@/lib/job-write-test-hooks");
  const { JOB_CANCELLED_CANNOT_RESCHEDULE_MESSAGE } = await import("@/lib/job-lifecycle");
  const {
    applyPreferredWindowForScheduling,
    appendPreferredWindowsToDescription,
    normalizePreferredWindowsInput,
    ownerPreferredWindowsFromDescription,
    parsePreferredWindowsFromDescription,
    preferredWindowsFingerprint,
    preferredWindowsTestHooks,
    PREFERRED_WINDOWS_EXPIRED_MESSAGE,
    PREFERRED_WINDOWS_HANDYMAN_ONLY_MESSAGE,
    PREFERRED_WINDOWS_INVALID_MESSAGE,
    PREFERRED_WINDOWS_STALE_MESSAGE,
    PREFERRED_WINDOWS_TOO_MANY_MESSAGE,
  } = await import("@/lib/request-preferred-windows");
  const {
    loadOwnedJobPreferredWindows,
    loadOwnedRequestPreferredWindows,
    preferredWindowsFromOwnedRequest,
  } = await import("@/lib/request-preferred-windows-data");
  const { requestNotesText } = await import("@/lib/work-area-intake");
  const { zonedCivilToUtc } = await import("@/lib/business-timezone");
  const { setTestAccess } = await import("./estimate-options-test-access.mjs");
  const { prisma } = await import("@/lib/prisma");

  function makeAccess(business, role, membership) {
    return {
      businessId: business.id,
      workspace: {
        role,
        membership: { id: membership.id },
        user: { id: membership.userId },
        business: {
          id: business.id,
          name: business.name,
          slug: business.slug,
          tradeCode: business.tradeCode,
          timezone: business.timezone,
        },
      },
      scope: businessScope(business.id),
      assertOwned(record) {
        return assertBusinessRecord(record, business.id);
      },
      assertAttachable(record) {
        return assertBusinessRecord(record, business.id);
      },
    };
  }

  async function submitHandymanRequest(slug, extras = {}) {
    return createPublicServiceRequest(prisma, {
      slug,
      name: extras.name ?? "Pat Homeowner",
      email: extras.email ?? `pat-${randomUUID().slice(0, 8)}@example.com`,
      phone: extras.phone ?? "555-0100",
      address: "",
      streetAddress: extras.streetAddress ?? "10 Maple St",
      city: extras.city ?? "Austin",
      region: extras.region ?? "TX",
      postalCode: extras.postalCode ?? "78701",
      notes: extras.notes ?? "Repair a sticking door.",
      catalogItemIds: extras.catalogItemIds ?? [],
      includeOther: extras.includeOther ?? true,
      otherDescription: extras.otherDescription ?? "Door repair",
      preferredWindows: extras.preferredWindows,
      requestedTradeCode: extras.requestedTradeCode ?? "HANDYMAN",
    });
  }

  async function jobFromRequest(access, requestId) {
    const request = await prisma.serviceRequest.findFirstOrThrow({
      where: { id: requestId, businessId: access.businessId },
    });
    const estimate = await prisma.estimate.create({
      data: {
        businessId: access.businessId,
        customerId: request.customerId,
        propertyId: request.propertyId,
        serviceRequestId: request.id,
        status: "APPROVED",
        publicToken: randomUUID(),
      },
    });
    const converted = await createJobFromApprovedEstimate(prisma, access, estimate.id);
    if (!converted.ok) throw new Error(converted.error);
    return prisma.job.findFirstOrThrow({
      where: { id: converted.jobId, businessId: access.businessId },
    });
  }

  const suffix = randomUUID().slice(0, 8);
  const NY = "America/New_York";
  const LA = "America/Los_Angeles";
  const businessNy = await prisma.business.create({
    data: {
      name: "NY Preferred Windows",
      slug: `ny-pref-win-${suffix}`,
      tradeCode: "HANDYMAN",
      timezone: NY,
    },
  });
  const businessLa = await prisma.business.create({
    data: {
      name: "LA Preferred Windows",
      slug: `la-pref-win-${suffix}`,
      tradeCode: "HANDYMAN",
      timezone: LA,
    },
  });
  const businessClean = await prisma.business.create({
    data: {
      name: "Cleaning Preferred Block",
      slug: `clean-pref-win-${suffix}`,
      tradeCode: "CLEANING",
      timezone: NY,
    },
  });
  await prisma.businessSettings.create({
    data: {
      businessId: businessNy.id,
      workingWeekdays: "1,2,3,4,5",
      workStartMinutes: 8 * 60,
      workEndMinutes: 17 * 60,
      schedulingBufferMinutes: 30,
    },
  });
  await prisma.businessSettings.create({
    data: {
      businessId: businessLa.id,
      workingWeekdays: "1,2,3,4,5",
      workStartMinutes: 8 * 60,
      workEndMinutes: 17 * 60,
      schedulingBufferMinutes: 30,
    },
  });

  const ownerUser = await prisma.user.create({
    data: { name: "Owner NY", email: `owner-ny-${suffix}@example.com`, passwordHash: "x" },
  });
  const laOwnerUser = await prisma.user.create({
    data: { name: "Owner LA", email: `owner-la-${suffix}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Member NY", email: `member-ny-${suffix}@example.com`, passwordHash: "x" },
  });
  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessNy.id, role: "OWNER" },
  });
  const laOwnerMem = await prisma.membership.create({
    data: { userId: laOwnerUser.id, businessId: businessLa.id, role: "OWNER" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessNy.id, role: "MEMBER" },
  });
  const ownerNy = makeAccess(businessNy, "OWNER", ownerMem);
  const ownerLa = makeAccess(businessLa, "OWNER", laOwnerMem);
  setTestAccess(ownerNy);

  const futureDay = "2027-07-15";
  const laterDay = "2027-07-16";
  const thirdDay = "2027-07-19";
  const nyDayStart = zonedCivilToUtc(2027, 7, 15, 0, 0, 0, NY);
  const nyDayEnd = zonedCivilToUtc(2027, 7, 16, 0, 0, 0, NY);
  const laDayStart = zonedCivilToUtc(2027, 7, 15, 0, 0, 0, LA);
  const nyWindowStart = zonedCivilToUtc(2027, 7, 15, 9, 0, 0, NY);
  const nyWindowEnd = zonedCivilToUtc(2027, 7, 15, 11, 0, 0, NY);

  console.log("\nBEHAVIOR — Handyman public submit stores up to three preferences");
  const created = await submitHandymanRequest(businessNy.slug, {
    preferredWindows: [
      { kind: "DAY", localDate: futureDay },
      { kind: "WINDOW", localDate: laterDay, startLocal: "09:00", endLocal: "11:00" },
      { kind: "DAY", localDate: thirdDay },
    ],
  });
  check("Handyman public request with three preferences succeeds", created.ok === true);
  const stored = created.ok
    ? await prisma.serviceRequest.findFirst({
        where: { id: created.requestId, businessId: businessNy.id },
      })
    : null;
  const record = parsePreferredWindowsFromDescription(stored?.description);
  check(
    "Preferences persist on the request in the business timezone",
    record?.timeZone === NY &&
      record?.windows.length === 3 &&
      record.windows[0].kind === "DAY" &&
      record.windows[0].startAt === nyDayStart.toISOString() &&
      record.windows[0].endAt === nyDayEnd.toISOString() &&
      record.windows[1].kind === "WINDOW" &&
      record.windows[1].startAt === zonedCivilToUtc(2027, 7, 16, 9, 0, 0, NY).toISOString() &&
      requestNotesText(stored?.description) === "Repair a sticking door.",
  );
  const jobsAfterSubmit = created.ok
    ? await prisma.job.count({
        where: { businessId: businessNy.id, customerId: stored?.customerId ?? "__none__" },
      })
    : -1;
  check("Public submit does not create a scheduled job", jobsAfterSubmit === 0);

  const ownerView = ownerPreferredWindowsFromDescription(stored?.description);
  check(
    "OWNER view lists current preferences and says they are not bookings",
    ownerView?.windows.length === 3 &&
      ownerView.windows.every((row) => row.status === "current") &&
      ownerView.notABooking.includes("not confirmed bookings") &&
      ownerView.timeZone === NY,
  );

  console.log("\nBEHAVIOR — timezone is the business timezone, never the client");
  const clientTz = normalizePreferredWindowsInput({
    drafts: [{ kind: "DAY", localDate: futureDay }],
    timeZone: LA,
    business: businessNy,
    tradeCode: "HANDYMAN",
    now: new Date("2027-01-01T12:00:00.000Z"),
  });
  check(
    "Client-supplied America/Los_Angeles is ignored for a New York business",
    clientTz.ok === true &&
      clientTz.record?.timeZone === NY &&
      clientTz.record.windows[0].startAt === nyDayStart.toISOString() &&
      clientTz.record.windows[0].startAt !== laDayStart.toISOString(),
  );

  const laCreated = await submitHandymanRequest(businessLa.slug, {
    name: "LA Customer",
    email: `la-${suffix}@example.com`,
    streetAddress: "200 Sunset",
    city: "Los Angeles",
    region: "CA",
    postalCode: "90012",
    preferredWindows: [{ kind: "DAY", localDate: futureDay }],
  });
  const laStored = laCreated.ok
    ? await prisma.serviceRequest.findFirst({
        where: { id: laCreated.requestId, businessId: businessLa.id },
      })
    : null;
  const laRecord = parsePreferredWindowsFromDescription(laStored?.description);
  check(
    "Same civil day is a different UTC instant in America/Los_Angeles",
    laCreated.ok === true &&
      laRecord?.timeZone === LA &&
      laRecord.windows[0].startAt === laDayStart.toISOString() &&
      laRecord.windows[0].startAt !== nyDayStart.toISOString(),
  );

  console.log("\nBEHAVIOR — invalid and expired windows are refused");
  const tooMany = await submitHandymanRequest(businessNy.slug, {
    email: `too-many-${suffix}@example.com`,
    preferredWindows: [
      { kind: "DAY", localDate: futureDay },
      { kind: "DAY", localDate: laterDay },
      { kind: "DAY", localDate: thirdDay },
      { kind: "DAY", localDate: "2027-07-20" },
    ],
  });
  check(
    "More than three preferred windows is refused",
    tooMany.ok === false && tooMany.error === PREFERRED_WINDOWS_TOO_MANY_MESSAGE,
  );

  const invalid = await submitHandymanRequest(businessNy.slug, {
    email: `invalid-${suffix}@example.com`,
    preferredWindows: [{ kind: "WINDOW", localDate: futureDay, startLocal: "11:00", endLocal: "09:00" }],
  });
  check(
    "A window that ends before it starts is refused",
    invalid.ok === false && invalid.error === PREFERRED_WINDOWS_INVALID_MESSAGE,
  );

  const badDate = await submitHandymanRequest(businessNy.slug, {
    email: `baddate-${suffix}@example.com`,
    preferredWindows: [{ kind: "DAY", localDate: "2027-13-40" }],
  });
  check(
    "An impossible date is refused",
    badDate.ok === false && badDate.error === PREFERRED_WINDOWS_INVALID_MESSAGE,
  );

  preferredWindowsTestHooks.now = () => new Date("2027-07-16T16:00:00.000Z");
  const expired = await submitHandymanRequest(businessNy.slug, {
    email: `expired-${suffix}@example.com`,
    preferredWindows: [{ kind: "DAY", localDate: futureDay }],
  });
  preferredWindowsTestHooks.now = undefined;
  check(
    "An already-ended preferred day is refused at submit",
    expired.ok === false && expired.error === PREFERRED_WINDOWS_EXPIRED_MESSAGE,
  );

  const cleaning = await createPublicServiceRequest(prisma, {
    slug: businessClean.slug,
    name: "Clean Customer",
    email: `clean-${suffix}@example.com`,
    phone: "555-0200",
    address: "",
    streetAddress: "1 Soap St",
    city: "Austin",
    region: "TX",
    postalCode: "78701",
    notes: "Weekly clean",
    catalogItemIds: [],
    includeOther: true,
    otherDescription: "House clean",
    requestedTradeCode: "CLEANING",
    preferredWindows: [{ kind: "DAY", localDate: futureDay }],
  });
  check(
    "Cleaning public requests cannot store preferred windows",
    cleaning.ok === false && cleaning.error === PREFERRED_WINDOWS_HANDYMAN_ONLY_MESSAGE,
  );

  console.log("\nBEHAVIOR — tenant isolation");
  const nyLoaded = await loadOwnedRequestPreferredWindows(prisma, ownerNy, stored.id);
  const crossRequest = await loadOwnedRequestPreferredWindows(prisma, ownerNy, laStored.id);
  const nyJob = await jobFromRequest(ownerNy, stored.id);
  const laJob = await jobFromRequest(ownerLa, laStored.id);
  const nyJobView = await loadOwnedJobPreferredWindows(prisma, ownerNy, nyJob.id);
  const crossJob = await loadOwnedJobPreferredWindows(prisma, ownerNy, laJob.id);
  const leaked = preferredWindowsFromOwnedRequest({
    businessId: businessNy.id,
    requestBusinessId: businessLa.id,
    description: laStored.description,
  });
  check(
    "OWNER sees own request preferences during scheduling load",
    nyLoaded?.fingerprint === ownerView.fingerprint &&
      nyJobView?.windows.length === 3 &&
      nyJobView.windows[0].localDate === futureDay,
  );
  check(
    "NY OWNER cannot load LA request or job preferences",
    crossRequest == null && crossJob == null && leaked == null,
  );

  console.log("\nBEHAVIOR — stale apply and scheduleJob still own the booking");
  const applyCurrent = applyPreferredWindowForScheduling({
    record,
    windowId: record.windows[1].id,
    fingerprint: preferredWindowsFingerprint(record),
    now: new Date("2027-01-01T12:00:00.000Z"),
  });
  check(
    "A current window can prefill the schedule form without booking",
    applyCurrent.ok === true &&
      applyCurrent.date === laterDay &&
      applyCurrent.time === "09:00" &&
      nyJob.status === "UNSCHEDULED" &&
      nyJob.scheduledAt == null,
  );

  const rewritten = appendPreferredWindowsToDescription(
    stored.description,
    normalizePreferredWindowsInput({
      drafts: [{ kind: "DAY", localDate: "2027-08-01" }],
      business: businessNy,
      tradeCode: "HANDYMAN",
      now: new Date("2027-01-01T12:00:00.000Z"),
    }).record,
  );
  const staleApply = applyPreferredWindowForScheduling({
    record: parsePreferredWindowsFromDescription(rewritten),
    windowId: record.windows[1].id,
    fingerprint: preferredWindowsFingerprint(record),
    now: new Date("2027-01-01T12:00:00.000Z"),
  });
  check(
    "A stale fingerprint cannot apply a rewritten preference",
    staleApply.ok === false && staleApply.error === PREFERRED_WINDOWS_STALE_MESSAGE,
  );

  const expiredApply = applyPreferredWindowForScheduling({
    record,
    windowId: record.windows[0].id,
    fingerprint: preferredWindowsFingerprint(record),
    now: nyDayEnd,
  });
  check(
    "An expired preferred day cannot be applied after the clock advances",
    expiredApply.ok === false && expiredApply.error === PREFERRED_WINDOWS_EXPIRED_MESSAGE,
  );

  const scheduledFirst = await scheduleJob(
    {},
    form({
      jobId: nyJob.id,
      date: "2027-07-15",
      time: "08:00",
      durationPreset: "60",
    }),
  );
  const firstRow = await prisma.job.findFirstOrThrow({
    where: { id: nyJob.id, businessId: businessNy.id },
  });
  check(
    "OWNER scheduleJob still books the first exact slot",
    !scheduledFirst?.error &&
      firstRow.status === "SCHEDULED" &&
      firstRow.scheduledAt?.toISOString() === zonedCivilToUtc(2027, 7, 15, 8, 0, 0, NY).toISOString() &&
      firstRow.arrivalWindowMinutes == null,
  );

  const secondCreated = await submitHandymanRequest(businessNy.slug, {
    name: "Later Stop",
    email: `later-${suffix}@example.com`,
    streetAddress: "500 Oak Blvd",
    preferredWindows: [{ kind: "WINDOW", localDate: futureDay, startLocal: "10:00", endLocal: "12:00" }],
  });
  const secondJob = await jobFromRequest(ownerNy, secondCreated.requestId);
  const bufferConflict = await scheduleJob(
    {},
    form({
      jobId: secondJob.id,
      date: "2027-07-15",
      time: "09:00",
      durationPreset: "60",
    }),
  );
  const afterBuffer = await prisma.job.findFirstOrThrow({
    where: { id: secondJob.id, businessId: businessNy.id },
    select: { scheduledAt: true, status: true },
  });
  check(
    "30-minute buffer still conflicts 9:00 after an 8:00–9:00 first job",
    Boolean(bufferConflict?.warning) &&
      afterBuffer.scheduledAt == null &&
      afterBuffer.status === "UNSCHEDULED",
  );

  const laterOk = await scheduleJob(
    {},
    form({
      jobId: secondJob.id,
      date: "2027-07-15",
      time: "09:30",
      durationPreset: "60",
    }),
  );
  const laterRow = await prisma.job.findFirstOrThrow({
    where: { id: secondJob.id, businessId: businessNy.id },
  });
  check(
    "Later same-day job keeps an arrival window after the 30-minute buffer",
    !laterOk?.error &&
      laterRow.status === "SCHEDULED" &&
      laterRow.scheduledAt?.toISOString() ===
        zonedCivilToUtc(2027, 7, 15, 9, 30, 0, NY).toISOString() &&
      laterRow.arrivalWindowMinutes === 120,
  );

  const cancelJob = await jobFromRequest(ownerNy, (
    await submitHandymanRequest(businessNy.slug, {
      name: "Cancel Race",
      email: `cancel-${suffix}@example.com`,
      preferredWindows: [{ kind: "DAY", localDate: laterDay }],
    })
  ).requestId);
  jobWriteTestHooks.afterScheduleJobRead = async (jobId) => {
    if (jobId === cancelJob.id) {
      await prisma.job.update({
        where: { id: jobId },
        data: { status: "CANCELLED" },
      });
    }
  };
  const staleSchedule = await scheduleJob(
    {},
    form({
      jobId: cancelJob.id,
      date: laterDay,
      time: "10:00",
      durationPreset: "60",
    }),
  );
  jobWriteTestHooks.afterScheduleJobRead = undefined;
  const cancelRow = await prisma.job.findFirstOrThrow({
    where: { id: cancelJob.id, businessId: businessNy.id },
    select: { status: true, scheduledAt: true },
  });
  check(
    "Stale scheduleJob still refuses a job cancelled after the initial read",
    staleSchedule?.error === JOB_CANCELLED_CANNOT_RESCHEDULE_MESSAGE &&
      cancelRow.status === "CANCELLED" &&
      cancelRow.scheduledAt == null,
  );

  void assignJobMember;
  void memberMem;
  void nyWindowStart;
  void nyWindowEnd;

  if (failed > 0) {
    throw new Error(`${failed} check(s) failed`);
  }
  console.log(`\n${passed} checks passed`);
} finally {
  await session.cleanup();
}
