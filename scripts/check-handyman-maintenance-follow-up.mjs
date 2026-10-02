/**
 * OWNER-set Handyman maintenance follow-up on a completed job.
 *
 * Dedicated local disposable database (name prefix tbbt_handy_maint_fu).
 * Fake SMS/email providers only. No real messages, migrate, or deploy.
 *
 * Proves timezone/DST due dates, STOP opt-out, changed number, duplicate
 * sends, tenant isolation, and cancellation. Creating the row never
 * books a job or a Cleaning recurring visit. Customer reminders go
 * through composeCustomerCommunication after explicit OWNER review.
 *
 * Run with:
 *   npm run test:handyman-maintenance-follow-up
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

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for handyman maintenance follow-up checks.");
  process.exit(generateEarly.status ?? 1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const { ForbiddenError } = await import("@/lib/authorization");
const { formatISODateInTimeZone, startOfZonedDay, parseCivilDateInTimeZone } = await import(
  "@/lib/business-timezone"
);
const { CUSTOMER_FOLLOW_UP_ORIGINS, customerFollowUpDueScanWhere } = await import(
  "@/lib/customer-follow-up-origin"
);
const {
  HANDYMAN_MAINTENANCE_ALREADY_SENT_MESSAGE,
  HANDYMAN_MAINTENANCE_CANCELLED_MESSAGE,
  HANDYMAN_MAINTENANCE_COMPLETED_JOB_MESSAGE,
  HANDYMAN_MAINTENANCE_CREATED_MESSAGE,
  HANDYMAN_MAINTENANCE_HANDYMAN_ONLY_MESSAGE,
  HANDYMAN_MAINTENANCE_JOB_REQUIRED_MESSAGE,
  HANDYMAN_MAINTENANCE_OWNER_ONLY_MESSAGE,
  HANDYMAN_MAINTENANCE_OWNER_SEND_MESSAGE,
  HANDYMAN_MAINTENANCE_PAST_DUE_DATE_MESSAGE,
  HANDYMAN_MAINTENANCE_QUEUE_TITLE,
  HANDYMAN_MAINTENANCE_HAS_MESSAGE_MESSAGE,
  HANDYMAN_MAINTENANCE_IN_PROGRESS_MESSAGE,
  HANDYMAN_MAINTENANCE_REVIEWS_REFUSED_MESSAGE,
  handymanMaintenanceDueState,
  handymanMaintenanceWriteAllowed,
  parseHandymanMaintenanceDueOn,
} = await import("@/lib/handyman-maintenance-follow-up");
const {
  loadHandymanMaintenanceFollowUpReview,
  loadMaintenanceFollowUpComposeContext,
  maintenanceFollowUpDueWhere,
} = await import("@/lib/handyman-maintenance-follow-up-data");
const {
  cancelHandymanMaintenanceFollowUp,
  countBusinessCommunications,
  countBusinessJobs,
  createHandymanMaintenanceFollowUp,
} = await import("@/lib/handyman-maintenance-follow-up-ops");
const {
  buildOwnerDailyMaintenanceFollowUpAttention,
  OWNER_DAILY_GROUP_TITLES,
} = await import("@/lib/owner-daily-attention");
const { loadOwnerDailyMaintenanceFollowUpAttention } = await import(
  "@/lib/owner-daily-attention-data"
);
const {
  composeCustomerCommunication,
  maintenanceComposeTestHooks,
  resetCommunicationEmailSender,
  setCommunicationEmailSender,
} = await import("@/lib/communications");
const {
  applyInboundConsentEvent,
  createFakeCustomerMessagingProvider,
  setCustomerMessagingProvider,
} = await import("@/lib/customer-messaging");
const { PRODUCT_CAPABILITIES } = await import("@/lib/product-catalog/codes");
const { scanScheduledBusinessEvents } = await import("@/lib/automation/scan");
const {
  emitBusinessEvent,
  ensureDefaultAutomationRules,
  processPendingAutomationRuns,
  queueAutomationRunsForEvent,
  recordWorkflowChannelResult,
} = await import("@/lib/automation");
const { attemptAutomationEmail } = await import("@/lib/automation/email");
const {
  cancelCustomerFollowUp,
  markCustomerFollowUpSentManually,
  ReferralError,
  sendCustomerFollowUp,
} = await import("@/lib/referral-ops");
const { loadReviewsSource } = await import("@/lib/reviews-data");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run the handyman maintenance follow-up check.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "handyman maintenance follow-up dedicated local database");

process.env.NEXT_PUBLIC_APP_URL = "http://handyman-maintenance.test";
process.env.RESEND_API_KEY = "re_test_handyman_maintenance";
process.env.EMAIL_FROM = "TBBT <maint@example.com>";
process.env.TBBT_EMAIL_ADAPTER = "fake";
delete process.env.VERCEL_ENV;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

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

function pad2(value) {
  return String(value).padStart(2, "0");
}

function addCivilDays(isoDate, days) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  return `${utc.getUTCFullYear()}-${pad2(utc.getUTCMonth() + 1)}-${pad2(utc.getUTCDate())}`;
}

function civilDateOffset(timeZone, dayOffset, now = new Date()) {
  return addCivilDays(formatISODateInTimeZone(now, timeZone), dayOffset);
}

function parseIsoCivil(isoDate, timeZone) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return parseCivilDateInTimeZone(year, month, day, timeZone);
}

function createWriteBarrier(expected, timeoutMs) {
  let arrived = 0;
  let released = false;
  let release;
  let fail;
  const held = new Promise((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  const timer = setTimeout(() => {
    if (!released) {
      fail(new Error(`Race barrier timed out after ${timeoutMs}ms`));
    }
  }, timeoutMs);
  return {
    async arriveAndWait() {
      arrived += 1;
      if (arrived >= expected) {
        released = true;
        clearTimeout(timer);
        release();
      }
      await held;
    },
  };
}

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      business: { id: businessId, name: "Handy Maint Co" },
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

const originSrc = read("src/lib/customer-follow-up-origin.ts");
const opsSrc = read("src/lib/handyman-maintenance-follow-up-ops.ts");
const dataSrc = read("src/lib/handyman-maintenance-follow-up-data.ts");
const actionSrc = read("src/app/actions/handyman-maintenance-follow-up.ts");
const panelSrc = read("src/components/jobs/handyman-maintenance-follow-up-panel.tsx");
const pageSrc = read("src/app/(app)/jobs/[jobId]/page.tsx");
const engineSrc = read("src/lib/communications/engine.ts");
const processorSrc = read("src/lib/automation/processor.ts");
const emailSrc = read("src/lib/automation/email.ts");
const dashboardSrc = read("src/app/(app)/dashboard/page.tsx");
const todaySrc = read("src/app/(app)/today/page.tsx");
const attentionSrc = read("src/lib/owner-daily-attention.ts");
const schemaSrc = read("prisma/schema.prisma");
const referralOpsSrc = read("src/lib/referral-ops.ts");
const reviewsDataSrc = read("src/lib/reviews-data.ts");
const reviewsWorkspaceSrc = read("src/components/reviews/reviews-workspace.tsx");

console.log("\nSTATIC — OWNER-set MAINTENANCE follow-up, no auto-send or booking");
check(
  "Reuses CustomerFollowUp.origin MAINTENANCE without a new table",
  originSrc.includes("MAINTENANCE: \"MAINTENANCE\"") &&
    schemaSrc.includes("RETENTION_TASK | MAINTENANCE") &&
    !schemaSrc.includes("model HandymanMaintenance") &&
    !schemaSrc.includes("model JobCustomerIssue"),
);
check(
  "Due scans and automation skip MAINTENANCE",
  customerFollowUpDueScanWhere("biz").origin.notIn.includes(
    CUSTOMER_FOLLOW_UP_ORIGINS.MAINTENANCE,
  ) &&
    processorSrc.includes("isMaintenanceFollowUp") &&
    emailSrc.includes("isMaintenanceFollowUp") &&
    processorSrc.includes("explicit owner review"),
);
check(
  "Create/cancel never send, book, or write Cleaning recurrence",
  !/createCustomerFollowUp|sendCustomerFollowUp|attemptJobFollowUpSms|emitAndProcessBusinessEvent|emitBusinessEvent/.test(
    opsSrc,
  ) &&
    !/cleaningRecurring|createRecurring|job.create|invoice.create/.test(opsSrc) &&
    !/createCustomerFollowUp|sendCustomerFollowUp|composeCustomerCommunication/.test(actionSrc) &&
    HANDYMAN_MAINTENANCE_CREATED_MESSAGE.includes("No customer message") &&
    HANDYMAN_MAINTENANCE_CREATED_MESSAGE.includes("no job was booked"),
);
check(
  "OWNER-only write gate",
  handymanMaintenanceWriteAllowed("OWNER") === true &&
    handymanMaintenanceWriteAllowed("ADMIN") === false &&
    handymanMaintenanceWriteAllowed("MEMBER") === false &&
    HANDYMAN_MAINTENANCE_OWNER_ONLY_MESSAGE.includes("owner"),
);
check(
  "Due dates use the business timezone, not UTC midnight",
  read("src/lib/handyman-maintenance-follow-up.ts").includes("parseCivilDateInTimeZone") &&
    read("src/lib/handyman-maintenance-follow-up.ts").includes("startOfZonedDay") &&
    !read("src/lib/handyman-maintenance-follow-up.ts").includes("toISOString().slice(0, 10)"),
);
check(
  "Existing owner queue shows due items; not a second callback/aftercare queue",
  OWNER_DAILY_GROUP_TITLES.maintenanceFollowUps === HANDYMAN_MAINTENANCE_QUEUE_TITLE &&
    dashboardSrc.includes("OWNER_DAILY_GROUP_TITLES.maintenanceFollowUps") &&
    todaySrc.includes("OWNER_DAILY_GROUP_TITLES.maintenanceFollowUps") &&
    attentionSrc.includes("origin !== \"MAINTENANCE\"") &&
    dataSrc.includes("aftercare, callbacks, and warranty") &&
    !pageSrc.includes("job_customer_issue") &&
    pageSrc.includes("HandymanMaintenanceFollowUpPanel") &&
    pageSrc.includes("JobAftercarePanel") &&
    pageSrc.includes("JobCallbackPanel"),
);
check(
  "Compose is the only customer reminder path",
  engineSrc.includes("assertMaintenanceFollowUpComposeAllowed") &&
    engineSrc.includes("claimMaintenanceFollowUpCompose") &&
    engineSrc.includes("finishMaintenanceMarkSent") &&
    engineSrc.includes("Failed to mark MAINTENANCE follow-up SENT") &&
    !engineSrc.includes("composeCustomerCommunicationLocked") &&
    opsSrc.includes("pg_advisory_xact_lock") &&
    opsSrc.includes("claimMaintenanceFollowUpCompose") &&
    opsSrc.includes("outcome: \"in_progress\"") &&
    opsSrc.includes("healMaintenanceFollowUpIfAccepted") &&
    engineSrc.includes('claimed.outcome === "in_progress"') &&
    opsSrc.includes("timeout: 8_000") &&
    panelSrc.includes("maintenanceFollowUpComposeHref") &&
    panelSrc.includes("Review reminder") &&
    !panelSrc.includes("sendCustomerFollowUp"),
);
check(
  "Reviews send/mark-sent/cancel refuse MAINTENANCE and hide those buttons",
  referralOpsSrc.includes("followUpSkipsAutomaticSend") &&
    referralOpsSrc.includes("refuseSkippedFollowUpOrigin") &&
    HANDYMAN_MAINTENANCE_REVIEWS_REFUSED_MESSAGE.includes("Communications compose") &&
    reviewsDataSrc.includes("origin: { not: CUSTOMER_FOLLOW_UP_ORIGINS.MAINTENANCE }") &&
    reviewsWorkspaceSrc.includes("isMaintenanceFollowUp") &&
    reviewsWorkspaceSrc.includes("!isMaintenanceFollowUp(row.origin)"),
);

const ny = "America/New_York";
const springDay = parseCivilDateInTimeZone(2026, 3, 8, ny);
const springNext = parseCivilDateInTimeZone(2026, 3, 9, ny);
const fallDay = parseCivilDateInTimeZone(2026, 11, 1, ny);
check(
  "DST spring-forward civil date is 05:00 UTC, not UTC midnight",
  springDay?.toISOString() === "2026-03-08T05:00:00.000Z" &&
    springNext?.toISOString() === "2026-03-09T04:00:00.000Z",
);
check(
  "DST fall-back civil date is 04:00 UTC",
  fallDay?.toISOString() === "2026-11-01T04:00:00.000Z",
);
const beforeSpring = new Date("2026-03-08T03:00:00.000Z");
const duringSpring = new Date("2026-03-08T06:00:00.000Z");
check(
  "March 8 due is upcoming at 10pm EST March 7 and due_today after local midnight",
  handymanMaintenanceDueState(springDay, beforeSpring, ny) === "upcoming" &&
    handymanMaintenanceDueState(springDay, duringSpring, ny) === "due_today" &&
    parseHandymanMaintenanceDueOn("2026-03-08", ny, beforeSpring).ok === true &&
    parseHandymanMaintenanceDueOn("2026-03-07", ny, duringSpring).ok === false,
);

let session;
try {
  session = await openDisposableTestDatabase({
    databaseUrl: baseUrl,
    namePrefix: "tbbt_handy_maint_fu",
    setProcessEnv: true,
  });
  const prisma = session.prisma;
  check(
    "Dedicated local disposable database opened",
    Boolean(session.testDbName?.startsWith("tbbt_handy_maint_fu_")),
  );

  const suffix = randomUUID().slice(0, 8);
  const ownerUser = await prisma.user.create({
    data: { name: "Owen", email: `owner-hmf-${suffix}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Ada", email: `admin-hmf-${suffix}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mel", email: `member-hmf-${suffix}@example.com`, passwordHash: "x" },
  });
  const ownerBUser = await prisma.user.create({
    data: { name: "Bea", email: `beta-hmf-${suffix}@example.com`, passwordHash: "x" },
  });

  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Handy",
      slug: `alpha-hmf-${suffix}`,
      tradeCode: "HANDYMAN",
      timezone: "America/New_York",
      operationalSmsNumber: "2395550100",
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Clean",
      slug: `beta-hmf-${suffix}`,
      tradeCode: "CLEANING",
      timezone: "America/Chicago",
      operationalSmsNumber: "2395550199",
    },
  });

  const memOwnerA = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const memAdminA = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: businessA.id, role: "ADMIN" },
  });
  const memMemberA = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const memOwnerB = await prisma.membership.create({
    data: { userId: ownerBUser.id, businessId: businessB.id, role: "OWNER" },
  });

  const ownerA = makeAccess(businessA.id, "OWNER", memOwnerA.id);
  const adminA = makeAccess(businessA.id, "ADMIN", memAdminA.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memMemberA.id);
  const ownerB = makeAccess(businessB.id, "OWNER", memOwnerB.id);

  async function grantSms(businessId) {
    await prisma.businessProductGrant.create({
      data: {
        businessId,
        grantType: "CAPABILITY",
        code: PRODUCT_CAPABILITIES.SMS_MESSAGING,
        status: "ACTIVE",
        source: "MANUAL",
        sourceRef: `sms-${randomUUID()}`,
      },
    });
  }
  await grantSms(businessA.id);

  async function createCompletedJob(businessId, options = {}) {
    const {
      status = "COMPLETED",
      tradeCode = "HANDYMAN",
      phone = "2395550101",
      email = `cust-${randomUUID().slice(0, 6)}@example.com`,
      smsConsentStatus = "GRANTED",
    } = options;
    const customer = await prisma.customer.create({
      data: {
        businessId,
        name: `${tradeCode} Customer`,
        phone,
        email,
        smsConsentStatus,
      },
    });
    let estimateId = null;
    if (tradeCode !== "HANDYMAN") {
      const request = await prisma.serviceRequest.create({
        data: {
          businessId,
          customerId: customer.id,
          description: `${tradeCode} work`,
          tradeCode,
        },
      });
      const estimate = await prisma.estimate.create({
        data: {
          businessId,
          customerId: customer.id,
          serviceRequestId: request.id,
          status: "APPROVED",
          publicToken: randomUUID(),
          total: 120,
        },
      });
      estimateId = estimate.id;
    }
    const job = await prisma.job.create({
      data: {
        businessId,
        customerId: customer.id,
        estimateId,
        status,
        projectToken: randomUUID(),
      },
    });
    return { customer, job };
  }

  const handy = await createCompletedJob(businessA.id);
  const scheduled = await createCompletedJob(businessA.id, { status: "SCHEDULED" });
  const cleaning = await createCompletedJob(businessB.id, { tradeCode: "CLEANING" });
  const futureDue = civilDateOffset(ny, 21);
  const pastDue = civilDateOffset(ny, -2);
  const dayBeforeDue = addCivilDays(futureDue, -1);
  const futureDueAt = parseIsoCivil(futureDue, ny);
  const beforeDueStart = startOfZonedDay(parseIsoCivil(dayBeforeDue, ny), ny);
  const onDueStart = startOfZonedDay(futureDueAt, ny);

  console.log("\nDB — OWNER create, eligibility, and no side effects");
  await expectThrow(
    "MEMBER cannot set a maintenance follow-up",
    () =>
      createHandymanMaintenanceFollowUp(prisma, memberA, {
        jobId: handy.job.id,
        task: "Recaulk the tub",
        dueOn: futureDue,
      }),
    (error) =>
      error instanceof ForbiddenError ||
      error?.message === HANDYMAN_MAINTENANCE_OWNER_ONLY_MESSAGE,
  );
  await expectThrow(
    "ADMIN cannot set a maintenance follow-up",
    () =>
      createHandymanMaintenanceFollowUp(prisma, adminA, {
        jobId: handy.job.id,
        task: "Recaulk the tub",
        dueOn: futureDue,
      }),
    (error) =>
      error instanceof ForbiddenError ||
      error?.message === HANDYMAN_MAINTENANCE_OWNER_ONLY_MESSAGE,
  );
  await expectThrow(
    "Incomplete job is refused",
    () =>
      createHandymanMaintenanceFollowUp(prisma, ownerA, {
        jobId: scheduled.job.id,
        task: "Recaulk the tub",
        dueOn: futureDue,
      }),
    (error) => error?.message === HANDYMAN_MAINTENANCE_COMPLETED_JOB_MESSAGE,
  );
  await expectThrow(
    "Cleaning job is refused and is not treated as a recurring visit",
    () =>
      createHandymanMaintenanceFollowUp(prisma, ownerB, {
        jobId: cleaning.job.id,
        task: "Weekly clean",
        dueOn: futureDue,
      }),
    (error) => error?.message === HANDYMAN_MAINTENANCE_HANDYMAN_ONLY_MESSAGE,
  );
  await expectThrow(
    "Past due date is refused in the business timezone",
    () =>
      createHandymanMaintenanceFollowUp(prisma, ownerA, {
        jobId: handy.job.id,
        task: "Recaulk the tub",
        dueOn: pastDue,
      }),
    (error) => error?.message === HANDYMAN_MAINTENANCE_PAST_DUE_DATE_MESSAGE,
  );

  const created = await createHandymanMaintenanceFollowUp(prisma, ownerA, {
    jobId: handy.job.id,
    task: "Recaulk the shower in six months",
    dueOn: futureDue,
  });
  check(
    "OWNER create writes one OPEN MAINTENANCE CustomerFollowUp",
    created.origin === CUSTOMER_FOLLOW_UP_ORIGINS.MAINTENANCE &&
      created.status === "OPEN" &&
      created.kind === "JOB_COMPLETE" &&
      created.notes === "Recaulk the shower in six months" &&
      created.dueOn?.toISOString() === futureDueAt.toISOString() &&
      created.jobId === handy.job.id &&
      created.customerId === handy.customer.id,
  );
  await expectThrow(
    "Second open follow-up on the same job is refused",
    () =>
      createHandymanMaintenanceFollowUp(prisma, ownerA, {
        jobId: handy.job.id,
        task: "Another task",
        dueOn: addCivilDays(futureDue, 1),
      }),
    (error) => /already has an open maintenance follow-up/.test(error?.message ?? ""),
  );

  const foreignHandy = await createCompletedJob(businessB.id);
  const followUpsBeforeForeign = await prisma.customerFollowUp.count({
    where: { origin: CUSTOMER_FOLLOW_UP_ORIGINS.MAINTENANCE },
  });
  await expectThrow(
    "OWNER cannot set a maintenance follow-up on another business job",
    () =>
      createHandymanMaintenanceFollowUp(prisma, ownerA, {
        jobId: foreignHandy.job.id,
        task: "Cross-business should fail",
        dueOn: futureDue,
      }),
    (error) => error?.message === HANDYMAN_MAINTENANCE_JOB_REQUIRED_MESSAGE,
  );
  const followUpsAfterForeign = await prisma.customerFollowUp.count({
    where: { origin: CUSTOMER_FOLLOW_UP_ORIGINS.MAINTENANCE },
  });
  check(
    "Cross-business job create writes no MAINTENANCE row",
    followUpsAfterForeign === followUpsBeforeForeign,
  );

  const createClientA = session.createClient();
  const createClientB = session.createClient();
  let createRaceFailures = 0;
  for (let i = 0; i < 25; i += 1) {
    const raceCreateJob = await createCompletedJob(businessA.id);
    const createBarrier = createWriteBarrier(2, 5000);
    const createRace = await Promise.allSettled([
      (async () => {
        await createBarrier.arriveAndWait();
        return createHandymanMaintenanceFollowUp(createClientA, ownerA, {
          jobId: raceCreateJob.job.id,
          task: `Concurrent create A ${i}`,
          dueOn: futureDue,
        });
      })(),
      (async () => {
        await createBarrier.arriveAndWait();
        return createHandymanMaintenanceFollowUp(createClientB, ownerA, {
          jobId: raceCreateJob.job.id,
          task: `Concurrent create B ${i}`,
          dueOn: futureDue,
        });
      })(),
    ]);
    const createOk = createRace.filter((row) => row.status === "fulfilled");
    const createDenied = createRace.filter(
      (row) =>
        row.status === "rejected" &&
        /already has an open maintenance follow-up/.test(row.reason?.message ?? ""),
    );
    const raceCreateCount = await prisma.customerFollowUp.count({
      where: {
        businessId: businessA.id,
        jobId: raceCreateJob.job.id,
        origin: CUSTOMER_FOLLOW_UP_ORIGINS.MAINTENANCE,
        status: "OPEN",
      },
    });
    if (!(raceCreateCount === 1 && createOk.length === 1 && createDenied.length === 1)) {
      createRaceFailures += 1;
    }
  }
  check(
    "25 concurrent-create races each produce one OPEN MAINTENANCE row",
    createRaceFailures === 0,
  );

  const jobsBeforeScan = await countBusinessJobs(prisma, businessA.id);
  const commsBeforeScan = await countBusinessCommunications(prisma, businessA.id);
  const eventsAfterCreate = await prisma.businessEvent.findMany({
    where: { businessId: businessA.id, type: "CUSTOMER_FOLLOW_UP_DUE" },
  });
  await scanScheduledBusinessEvents(prisma, businessA.id);
  const eventsAfterScan = await prisma.businessEvent.findMany({
    where: { businessId: businessA.id, type: "CUSTOMER_FOLLOW_UP_DUE" },
  });
  const jobsAfter = await countBusinessJobs(prisma, businessA.id);
  const commsAfterCreate = await countBusinessCommunications(prisma, businessA.id);
  const recurringAfter = await prisma.job.count({
    where: { businessId: businessA.id, serviceIntent: "RECURRING" },
  });
  check(
    "Create and due scan do not emit CUSTOMER_FOLLOW_UP_DUE, book a job, or start recurrence",
    eventsAfterCreate.length === 0 &&
      eventsAfterScan.length === 0 &&
      jobsAfter === jobsBeforeScan &&
      commsAfterCreate === commsBeforeScan &&
      recurringAfter === 0,
  );

  console.log("\nDB — Owner queue is due/overdue only and tenant-scoped");
  const beforeDue = await loadOwnerDailyMaintenanceFollowUpAttention(prisma, businessA.id, {
    todayStart: beforeDueStart,
  });
  const onDue = await loadOwnerDailyMaintenanceFollowUpAttention(prisma, businessA.id, {
    todayStart: onDueStart,
  });
  const foreignQueue = await loadOwnerDailyMaintenanceFollowUpAttention(prisma, businessB.id, {
    todayStart: onDueStart,
  });
  check(
    "Upcoming DST due date stays out of the owner queue",
    beforeDue.items.length === 0 && beforeDue.count === 0,
  );
  const createdQueueItem = onDue.items.find((item) => item.key === created.id);
  check(
    "Due DST date appears in the same owner queue with Review → compose",
    createdQueueItem != null &&
      createdQueueItem.action === "Review" &&
      createdQueueItem.href.includes("area=compose") &&
      createdQueueItem.href.includes(created.id) &&
      createdQueueItem.meta.includes("Recaulk the shower"),
  );
  check("Foreign tenant queue does not include the follow-up", foreignQueue.items.length === 0);
  const builtForeign = buildOwnerDailyMaintenanceFollowUpAttention(
    [
      {
        ...created,
        customer: { name: "Leak" },
      },
    ],
    { businessId: businessB.id, todayStart: onDueStart },
  );
  check("Builder fails closed on a foreign businessId", builtForeign.length === 0);

  const review = await loadHandymanMaintenanceFollowUpReview(prisma, ownerA, handy.job.id);
  check(
    "Job review shows the open task and due date",
    review?.openFollowUp?.id === created.id &&
      review?.eligible === true &&
      review?.canWrite === true &&
      review?.openFollowUp?.dueOnLabel === futureDue,
  );
  const foreignReview = await loadHandymanMaintenanceFollowUpReview(
    prisma,
    ownerB,
    handy.job.id,
  );
  check("Foreign owner cannot load the job review", foreignReview == null);

  console.log("\nDB — Reviews page cannot send, mark sent, or cancel MAINTENANCE");
  const reviewsSource = await loadReviewsSource(prisma, businessA.id);
  check(
    "Reviews source excludes MAINTENANCE follow-ups",
    reviewsSource.followUps.every((row) => row.id !== created.id) &&
      reviewsSource.followUps.every((row) => row.origin !== CUSTOMER_FOLLOW_UP_ORIGINS.MAINTENANCE),
  );
  const commsBeforeReviews = await countBusinessCommunications(prisma, businessA.id);
  await expectThrow(
    "ADMIN sendCustomerFollowUp refuses MAINTENANCE and does not use notes as the body",
    () => sendCustomerFollowUp(prisma, adminA, { followUpId: created.id }),
    (error) =>
      error instanceof ReferralError &&
      error.message === HANDYMAN_MAINTENANCE_REVIEWS_REFUSED_MESSAGE,
  );
  await expectThrow(
    "ADMIN markCustomerFollowUpSentManually refuses MAINTENANCE",
    () => markCustomerFollowUpSentManually(prisma, adminA, { followUpId: created.id }),
    (error) =>
      error instanceof ReferralError &&
      error.message === HANDYMAN_MAINTENANCE_REVIEWS_REFUSED_MESSAGE,
  );
  await expectThrow(
    "ADMIN cancelCustomerFollowUp refuses MAINTENANCE",
    () => cancelCustomerFollowUp(prisma, adminA, { followUpId: created.id }),
    (error) =>
      error instanceof ReferralError &&
      error.message === HANDYMAN_MAINTENANCE_REVIEWS_REFUSED_MESSAGE,
  );
  const afterReviews = await prisma.customerFollowUp.findFirst({ where: { id: created.id } });
  const commsAfterReviews = await countBusinessCommunications(prisma, businessA.id);
  check(
    "Reviews bypass leaves the MAINTENANCE row OPEN and sends nothing",
    afterReviews?.status === "OPEN" && commsAfterReviews === commsBeforeReviews,
  );

  console.log("\nDB — Automation processor skips MAINTENANCE even when a due event is forced");
  const autoJob = await createCompletedJob(businessA.id, {
    phone: "2395550166",
    email: `auto-${suffix}@example.com`,
  });
  const autoFollowUp = await createHandymanMaintenanceFollowUp(prisma, ownerA, {
    jobId: autoJob.job.id,
    task: "SECRET internal caulk task",
    dueOn: futureDue,
  });
  await ensureDefaultAutomationRules(prisma, businessA.id);
  const jobFollowRule = await prisma.automationRule.findFirst({
    where: {
      businessId: businessA.id,
      eventType: "CUSTOMER_FOLLOW_UP_DUE",
      purpose: "JOB_FOLLOW_UP",
    },
  });
  await prisma.automationRule.update({
    where: { id: jobFollowRule.id },
    data: { enabled: true, channel: "SMS", delayMinutes: 0 },
  });
  const forcedDue = await emitBusinessEvent(prisma, {
    businessId: businessA.id,
    type: "CUSTOMER_FOLLOW_UP_DUE",
    subjectType: "CUSTOMER_FOLLOW_UP",
    subjectId: autoFollowUp.id,
    payload: {
      customerId: autoJob.customer.id,
      jobId: autoJob.job.id,
      followUpId: autoFollowUp.id,
      businessName: "Alpha Handy",
    },
    idempotencyKey: `CUSTOMER_FOLLOW_UP_DUE:${autoFollowUp.id}`,
  });
  await queueAutomationRunsForEvent(prisma, businessA.id, forcedDue.event);
  const autoCommsBefore = await prisma.customerCommunication.count({
    where: {
      businessId: businessA.id,
      relatedType: "CUSTOMER_FOLLOW_UP",
      relatedId: autoFollowUp.id,
    },
  });
  await processPendingAutomationRuns(prisma, businessA.id);
  const autoAfter = await prisma.customerFollowUp.findFirst({ where: { id: autoFollowUp.id } });
  const autoCommsAfter = await prisma.customerCommunication.count({
    where: {
      businessId: businessA.id,
      relatedType: "CUSTOMER_FOLLOW_UP",
      relatedId: autoFollowUp.id,
    },
  });
  check(
    "Forced CUSTOMER_FOLLOW_UP_DUE does not send or close a MAINTENANCE follow-up",
    autoAfter?.status === "OPEN" &&
      autoAfter?.sentAt == null &&
      autoCommsBefore === 0 &&
      autoCommsAfter === 0,
  );
  const autoEmail = await attemptAutomationEmail(prisma, {
    businessId: businessA.id,
    runId: `auto-email-${randomUUID()}`,
    purpose: "JOB_FOLLOW_UP",
    subjectType: "CUSTOMER_FOLLOW_UP",
    subjectId: autoFollowUp.id,
    customerId: autoJob.customer.id,
    businessName: "Alpha Handy",
    payload: { customerId: autoJob.customer.id, followUpId: autoFollowUp.id },
  });
  const autoAfterEmail = await prisma.customerFollowUp.findFirst({ where: { id: autoFollowUp.id } });
  check(
    "Automation email skip leaves MAINTENANCE OPEN and does not send",
    autoEmail.status === "SKIPPED" &&
      /explicit owner review/.test(autoEmail.failureReason ?? "") &&
      autoAfterEmail?.status === "OPEN" &&
      autoAfterEmail?.sentAt == null &&
      (await prisma.customerCommunication.count({
        where: {
          businessId: businessA.id,
          relatedType: "CUSTOMER_FOLLOW_UP",
          relatedId: autoFollowUp.id,
        },
      })) === 0,
  );
  await recordWorkflowChannelResult(
    prisma,
    businessA.id,
    { subjectType: "CUSTOMER_FOLLOW_UP", subjectId: autoFollowUp.id },
    "JOB_FOLLOW_UP",
    [{ channel: "SMS", status: "SENT" }],
  );
  const autoAfterRecord = await prisma.customerFollowUp.findFirst({ where: { id: autoFollowUp.id } });
  check(
    "Automation result writer does not mark a MAINTENANCE follow-up SENT",
    autoAfterRecord?.status === "OPEN" && autoAfterRecord?.sentAt == null,
  );

  console.log("\nDB — Compose path: STOP, changed number, duplicates, cancel");
  const fakeSms = createFakeCustomerMessagingProvider();
  setCustomerMessagingProvider(fakeSms);
  const fakeEmails = [];
  setCommunicationEmailSender(async (input) => {
    fakeEmails.push(input);
    return { id: `fake-email:${input.idempotencyKey}` };
  });

  const stopCustomerJob = await createCompletedJob(businessA.id, {
    phone: "2395550111",
    email: `stop-${suffix}@example.com`,
  });
  const stopFollowUp = await createHandymanMaintenanceFollowUp(prisma, ownerA, {
    jobId: stopCustomerJob.job.id,
    task: "Check exterior caulk",
        dueOn: futureDue,
  });
  const inboundStop = await applyInboundConsentEvent(prisma, {
    provider: "twilio",
    providerEventId: `SM_stop_${randomUUID()}`,
    from: "+12395550111",
    to: "+12395550100",
    body: "STOP",
    optOutType: "STOP",
  });
  const afterStop = await prisma.customer.findFirst({
    where: { id: stopCustomerJob.customer.id },
  });
  const stoppedSms = await composeCustomerCommunication(prisma, ownerA, {
    customerId: stopCustomerJob.customer.id,
    channel: "SMS",
    purpose: "GENERAL",
    body: "Checking on the caulk we discussed.",
    relatedType: "CUSTOMER_FOLLOW_UP",
    relatedId: stopFollowUp.id,
    idempotencyKey: `sms-stop-${randomUUID()}`,
  });
  const stopRow = await prisma.customerFollowUp.findFirst({
    where: { id: stopFollowUp.id },
  });
  check(
    "STOP revokes consent and blocks SMS without marking the follow-up sent",
    inboundStop.applied === true &&
      afterStop?.smsConsentStatus === "REVOKED" &&
      stoppedSms.ok === false &&
      stoppedSms.status === "BLOCKED" &&
      /revoked/i.test(stoppedSms.failureReason ?? "") &&
      stopRow?.status === "OPEN" &&
      fakeSms.sent.length === 0,
  );

  const changed = await createCompletedJob(businessA.id, {
    phone: "2395550122",
    email: `changed-${suffix}@example.com`,
  });
  const changedFollowUp = await createHandymanMaintenanceFollowUp(prisma, ownerA, {
    jobId: changed.job.id,
    task: "Inspect the new faucet",
        dueOn: futureDue,
  });
  await prisma.customer.update({
    where: { id: changed.customer.id },
    data: { phone: "2395550133" },
  });
  const changedSend = await composeCustomerCommunication(prisma, ownerA, {
    customerId: changed.customer.id,
    channel: "SMS",
    purpose: "GENERAL",
    body: "Following up on the faucet.",
    relatedType: "CUSTOMER_FOLLOW_UP",
    relatedId: changedFollowUp.id,
    idempotencyKey: `sms-changed-${randomUUID()}`,
  });
  const changedRow = await prisma.customerFollowUp.findFirst({
    where: { id: changedFollowUp.id },
  });
  check(
    "Send uses the live phone number, not the number at create time",
    changedSend.ok === true &&
      fakeSms.sent.length === 1 &&
      /2395550133/.test(fakeSms.sent[0].to.replace(/\D/g, "")) &&
      !/2395550122/.test(fakeSms.sent[0].to.replace(/\D/g, "")) &&
      changedRow?.status === "SENT",
  );

  const dupeKey = `sms-dupe-${randomUUID()}`;
  const dupeJob = await createCompletedJob(businessA.id, {
    phone: "2395550144",
    email: `dupe-${suffix}@example.com`,
  });
  const dupeFollowUp = await createHandymanMaintenanceFollowUp(prisma, ownerA, {
    jobId: dupeJob.job.id,
    task: "Touch up paint",
        dueOn: futureDue,
  });
  const firstSend = await composeCustomerCommunication(prisma, ownerA, {
    customerId: dupeJob.customer.id,
    channel: "SMS",
    purpose: "GENERAL",
    body: "Paint touch-up reminder.",
    relatedType: "CUSTOMER_FOLLOW_UP",
    relatedId: dupeFollowUp.id,
    idempotencyKey: dupeKey,
  });
  const reuseSend = await composeCustomerCommunication(prisma, ownerA, {
    customerId: dupeJob.customer.id,
    channel: "SMS",
    purpose: "GENERAL",
    body: "Paint touch-up reminder.",
    relatedType: "CUSTOMER_FOLLOW_UP",
    relatedId: dupeFollowUp.id,
    idempotencyKey: dupeKey,
  });
  const secondIntent = await composeCustomerCommunication(prisma, ownerA, {
    customerId: dupeJob.customer.id,
    channel: "SMS",
    purpose: "GENERAL",
    body: "Second paint reminder.",
    relatedType: "CUSTOMER_FOLLOW_UP",
    relatedId: dupeFollowUp.id,
    idempotencyKey: `sms-dupe-2-${randomUUID()}`,
  });
  const dupeComms = await prisma.customerCommunication.count({
    where: {
      businessId: businessA.id,
      relatedType: "CUSTOMER_FOLLOW_UP",
      relatedId: dupeFollowUp.id,
    },
  });
  check(
    "Same idempotency key is reused; a second send is blocked after SENT",
    firstSend.ok === true &&
      reuseSend.ok === true &&
      reuseSend.reused === true &&
      secondIntent.ok === false &&
      secondIntent.failureReason === HANDYMAN_MAINTENANCE_ALREADY_SENT_MESSAGE &&
      fakeSms.sent.filter((row) => /Paint touch-up/.test(row.body)).length === 1 &&
      dupeComms === 1,
  );

  const failMarkJob = await createCompletedJob(businessA.id, {
    phone: "2395550188",
    email: `fail-mark-${suffix}@example.com`,
  });
  const failMarkFollowUp = await createHandymanMaintenanceFollowUp(prisma, ownerA, {
    jobId: failMarkJob.job.id,
    task: "Fail mark sent",
    dueOn: futureDue,
  });
  const failMarkKey = `sms-fail-mark-${randomUUID()}`;
  maintenanceComposeTestHooks.beforeMarkSent = async () => {
    throw new Error("forced mark-SENT failure");
  };
  const sentBeforeFailMark = fakeSms.sent.length;
  let failMarkSend;
  try {
    failMarkSend = await composeCustomerCommunication(prisma, ownerA, {
      customerId: failMarkJob.customer.id,
      channel: "SMS",
      purpose: "GENERAL",
      body: "Mark-sent should not roll back this SMS.",
      relatedType: "CUSTOMER_FOLLOW_UP",
      relatedId: failMarkFollowUp.id,
      idempotencyKey: failMarkKey,
    });
  } finally {
    maintenanceComposeTestHooks.beforeMarkSent = undefined;
  }
  const failMarkRow = await prisma.customerFollowUp.findFirst({
    where: { id: failMarkFollowUp.id },
  });
  const failMarkComms = await prisma.customerCommunication.findMany({
    where: {
      businessId: businessA.id,
      relatedType: "CUSTOMER_FOLLOW_UP",
      relatedId: failMarkFollowUp.id,
    },
  });
  check(
    "Failed mark-SENT keeps one provider send and one communication row",
    failMarkSend?.ok === true &&
      failMarkRow?.status === "OPEN" &&
      failMarkComms.length === 1 &&
      ["QUEUED", "ACCEPTED", "SENT", "DELIVERED"].includes(failMarkComms[0].status) &&
      fakeSms.sent.length === sentBeforeFailMark + 1,
  );
  const queueBeforeHeal = await loadOwnerDailyMaintenanceFollowUpAttention(prisma, businessA.id, {
    todayStart: onDueStart,
  });
  const healedRow = await prisma.customerFollowUp.findFirst({
    where: { id: failMarkFollowUp.id },
  });
  const queueAfterHeal = await loadOwnerDailyMaintenanceFollowUpAttention(prisma, businessA.id, {
    todayStart: onDueStart,
  });
  await expectThrow(
    "Cancel after a healed accepted send is refused",
    () => cancelHandymanMaintenanceFollowUp(prisma, ownerA, { followUpId: failMarkFollowUp.id }),
    (error) =>
      error?.message === HANDYMAN_MAINTENANCE_HAS_MESSAGE_MESSAGE ||
      error?.message === HANDYMAN_MAINTENANCE_NOT_OPEN_MESSAGE,
  );
  const failMarkRetry = await composeCustomerCommunication(prisma, ownerA, {
    customerId: failMarkJob.customer.id,
    channel: "SMS",
    purpose: "GENERAL",
    body: "Mark-sent should not roll back this SMS.",
    relatedType: "CUSTOMER_FOLLOW_UP",
    relatedId: failMarkFollowUp.id,
    idempotencyKey: failMarkKey,
  });
  const failMarkDistinct = await composeCustomerCommunication(prisma, ownerA, {
    customerId: failMarkJob.customer.id,
    channel: "SMS",
    purpose: "GENERAL",
    body: "Distinct key after mark-SENT failure.",
    relatedType: "CUSTOMER_FOLLOW_UP",
    relatedId: failMarkFollowUp.id,
    idempotencyKey: `sms-fail-mark-2-${randomUUID()}`,
  });
  check(
    "Failed mark-SENT heals to SENT and leaves the owner queue",
    queueBeforeHeal.items.some((item) => item.key === failMarkFollowUp.id) === false &&
      healedRow?.status === "SENT" &&
      queueAfterHeal.items.every((item) => item.key !== failMarkFollowUp.id) &&
      failMarkRetry.ok === true &&
      failMarkRetry.reused === true &&
      failMarkDistinct.ok === false &&
      failMarkDistinct.failureReason === HANDYMAN_MAINTENANCE_ALREADY_SENT_MESSAGE &&
      fakeSms.sent.length === sentBeforeFailMark + 1 &&
      (await prisma.customerCommunication.count({
        where: {
          businessId: businessA.id,
          relatedType: "CUSTOMER_FOLLOW_UP",
          relatedId: failMarkFollowUp.id,
        },
      })) === 1,
  );

  const raceSendJob = await createCompletedJob(businessA.id, {
    phone: "2395550177",
    email: `race-send-${suffix}@example.com`,
  });
  const raceSendFollowUp = await createHandymanMaintenanceFollowUp(prisma, ownerA, {
    jobId: raceSendJob.job.id,
    task: "Race the reminder",
    dueOn: futureDue,
  });
  const raceSendA = session.createClient();
  const raceSendB = session.createClient();
  const sentBeforeRace = fakeSms.sent.length;
  const raceResults = await Promise.all([
    composeCustomerCommunication(raceSendA, ownerA, {
      customerId: raceSendJob.customer.id,
      channel: "SMS",
      purpose: "GENERAL",
      body: "Race key one.",
      relatedType: "CUSTOMER_FOLLOW_UP",
      relatedId: raceSendFollowUp.id,
      idempotencyKey: `sms-race-a-${randomUUID()}`,
    }),
    composeCustomerCommunication(raceSendB, ownerA, {
      customerId: raceSendJob.customer.id,
      channel: "SMS",
      purpose: "GENERAL",
      body: "Race key two.",
      relatedType: "CUSTOMER_FOLLOW_UP",
      relatedId: raceSendFollowUp.id,
      idempotencyKey: `sms-race-b-${randomUUID()}`,
    }),
  ]);
  const raceAccepted = raceResults.filter((row) => row.ok === true);
  const raceBlocked = raceResults.filter(
    (row) =>
      row.ok === false && row.failureReason === HANDYMAN_MAINTENANCE_ALREADY_SENT_MESSAGE,
  );
  const raceSendRow = await prisma.customerFollowUp.findFirst({
    where: { id: raceSendFollowUp.id },
  });
  const raceComms = await prisma.customerCommunication.count({
    where: {
      businessId: businessA.id,
      relatedType: "CUSTOMER_FOLLOW_UP",
      relatedId: raceSendFollowUp.id,
    },
  });
  check(
    "Two-connection compose with distinct keys sends once",
    raceAccepted.length === 1 &&
      raceBlocked.length === 1 &&
      raceSendRow?.status === "SENT" &&
      raceComms === 1 &&
      fakeSms.sent.length === sentBeforeRace + 1 &&
      raceResults.every((row) => !/Transaction already closed/i.test(row.failureReason ?? "")),
  );

  async function countFollowUpComms(followUpId) {
    return prisma.customerCommunication.count({
      where: {
        businessId: businessA.id,
        relatedType: "CUSTOMER_FOLLOW_UP",
        relatedId: followUpId,
      },
    });
  }

  async function runSameKeyRounds(channel, rounds) {
    let failures = 0;
    for (let i = 0; i < rounds; i += 1) {
      const job = await createCompletedJob(businessA.id, {
        phone: channel === "SMS" ? "2395550211" : "2395550212",
        email: `same-key-${channel}-${i}-${suffix}@example.com`,
      });
      const followUp = await createHandymanMaintenanceFollowUp(prisma, ownerA, {
        jobId: job.job.id,
        task: `Same key ${channel} ${i}`,
        dueOn: futureDue,
      });
      const key = `${channel.toLowerCase()}-same-${i}-${randomUUID()}`;
      const clientA = session.createClient();
      const clientB = session.createClient();
      const sentBefore =
        channel === "SMS" ? fakeSms.sent.length : fakeEmails.length;
      const results = await Promise.all([
        composeCustomerCommunication(clientA, ownerA, {
          customerId: job.customer.id,
          channel,
          purpose: "GENERAL",
          subject: channel === "EMAIL" ? "Same key A" : undefined,
          body: `Same-key ${channel} body ${i}.`,
          relatedType: "CUSTOMER_FOLLOW_UP",
          relatedId: followUp.id,
          idempotencyKey: key,
        }),
        composeCustomerCommunication(clientB, ownerA, {
          customerId: job.customer.id,
          channel,
          purpose: "GENERAL",
          subject: channel === "EMAIL" ? "Same key B" : undefined,
          body: `Same-key ${channel} body ${i}.`,
          relatedType: "CUSTOMER_FOLLOW_UP",
          relatedId: followUp.id,
          idempotencyKey: key,
        }),
      ]);
      const sentAfter = channel === "SMS" ? fakeSms.sent.length : fakeEmails.length;
      const comms = await countFollowUpComms(followUp.id);
      const closed = results.some((row) =>
        /Transaction already closed/i.test(row.failureReason ?? ""),
      );
      if (sentAfter !== sentBefore + 1 || comms !== 1 || closed) {
        failures += 1;
      }
    }
    return failures;
  }

  check(
    "20 same-key two-connection SMS composes send once each",
    (await runSameKeyRounds("SMS", 20)) === 0,
  );
  check(
    "20 same-key two-connection EMAIL composes send once each",
    (await runSameKeyRounds("EMAIL", 20)) === 0,
  );

  const crashedJob = await createCompletedJob(businessA.id, {
    phone: "2395550213",
    email: `crashed-${suffix}@example.com`,
  });
  const crashedFollowUp = await createHandymanMaintenanceFollowUp(prisma, ownerA, {
    jobId: crashedJob.job.id,
    task: "Crashed in-lease claim",
    dueOn: futureDue,
  });
  const crashedKey = `sms-crashed-${randomUUID()}`;
  await prisma.customerCommunication.create({
    data: {
      businessId: businessA.id,
      customerId: crashedJob.customer.id,
      direction: "OUTBOUND",
      channel: "SMS",
      purpose: "GENERAL",
      relatedType: "CUSTOMER_FOLLOW_UP",
      relatedId: crashedFollowUp.id,
      idempotencyKey: crashedKey,
      bodySnapshot: "Crashed before provider send.",
      status: "READY",
      provider: "pending",
      attemptedAt: new Date(),
    },
  });
  const sentBeforeCrash = fakeSms.sent.length;
  const crashedSend = await composeCustomerCommunication(prisma, ownerA, {
    customerId: crashedJob.customer.id,
    channel: "SMS",
    purpose: "GENERAL",
    body: "Retry inside a crashed in-lease claim.",
    relatedType: "CUSTOMER_FOLLOW_UP",
    relatedId: crashedFollowUp.id,
    idempotencyKey: crashedKey,
  });
  check(
    "Same-key retry inside a crashed in-lease claim does not send",
    crashedSend.ok === false &&
      crashedSend.reused === true &&
      crashedSend.failureReason === HANDYMAN_MAINTENANCE_IN_PROGRESS_MESSAGE &&
      fakeSms.sent.length === sentBeforeCrash &&
      (await countFollowUpComms(crashedFollowUp.id)) === 1,
  );

  const cancelInFlightJob = await createCompletedJob(businessA.id, {
    phone: "2395550200",
    email: `cancel-inflight-${suffix}@example.com`,
  });
  const cancelInFlightFollowUp = await createHandymanMaintenanceFollowUp(prisma, ownerA, {
    jobId: cancelInFlightJob.job.id,
    task: "Cancel during send",
    dueOn: futureDue,
  });
  let cancelDuringSend = null;
  maintenanceComposeTestHooks.afterClaim = async () => {
    try {
      await cancelHandymanMaintenanceFollowUp(prisma, ownerA, {
        followUpId: cancelInFlightFollowUp.id,
      });
      cancelDuringSend = "cancelled";
    } catch (error) {
      cancelDuringSend = error?.message ?? "error";
    }
  };
  const sentBeforeCancelInFlight = fakeSms.sent.length;
  let cancelInFlightSend;
  try {
    cancelInFlightSend = await composeCustomerCommunication(prisma, ownerA, {
      customerId: cancelInFlightJob.customer.id,
      channel: "SMS",
      purpose: "GENERAL",
      body: "In-flight cancel must not leave a sent CANCELLED row.",
      relatedType: "CUSTOMER_FOLLOW_UP",
      relatedId: cancelInFlightFollowUp.id,
      idempotencyKey: `sms-cancel-inflight-${randomUUID()}`,
    });
  } finally {
    maintenanceComposeTestHooks.afterClaim = undefined;
  }
  const cancelInFlightRow = await prisma.customerFollowUp.findFirst({
    where: { id: cancelInFlightFollowUp.id },
  });
  const cancelInFlightComms = await prisma.customerCommunication.count({
    where: {
      businessId: businessA.id,
      relatedType: "CUSTOMER_FOLLOW_UP",
      relatedId: cancelInFlightFollowUp.id,
    },
  });
  check(
    "Cancel during an in-lease claim is refused; send completes once",
    cancelDuringSend === HANDYMAN_MAINTENANCE_HAS_MESSAGE_MESSAGE &&
      cancelInFlightSend?.ok === true &&
      cancelInFlightRow?.status === "SENT" &&
      cancelInFlightRow?.cancelledAt == null &&
      cancelInFlightComms === 1 &&
      fakeSms.sent.length === sentBeforeCancelInFlight + 1,
  );

  const slowJob = await createCompletedJob(businessA.id, {
    phone: "2395550199",
    email: `slow-${suffix}@example.com`,
  });
  const slowFollowUp = await createHandymanMaintenanceFollowUp(prisma, ownerA, {
    jobId: slowJob.job.id,
    task: "Slow provider",
    dueOn: futureDue,
  });
  const emailsBeforeSlow = fakeEmails.length;
  setCommunicationEmailSender(async (input) => {
    await new Promise((resolve) => setTimeout(resolve, 32_000));
    fakeEmails.push(input);
    return { id: `fake-email:${input.idempotencyKey}` };
  });
  const slowA = session.createClient();
  const slowB = session.createClient();
  let slowResults;
  try {
    slowResults = await Promise.all([
      composeCustomerCommunication(slowA, ownerA, {
        customerId: slowJob.customer.id,
        channel: "EMAIL",
        purpose: "GENERAL",
        subject: "Slow A",
        body: "Slow provider key one.",
        relatedType: "CUSTOMER_FOLLOW_UP",
        relatedId: slowFollowUp.id,
        idempotencyKey: `email-slow-a-${randomUUID()}`,
      }),
      composeCustomerCommunication(slowB, ownerA, {
        customerId: slowJob.customer.id,
        channel: "EMAIL",
        purpose: "GENERAL",
        subject: "Slow B",
        body: "Slow provider key two.",
        relatedType: "CUSTOMER_FOLLOW_UP",
        relatedId: slowFollowUp.id,
        idempotencyKey: `email-slow-b-${randomUUID()}`,
      }),
    ]);
  } finally {
    setCommunicationEmailSender(async (input) => {
      fakeEmails.push(input);
      return { id: `fake-email:${input.idempotencyKey}` };
    });
  }
  const slowAccepted = slowResults.filter((row) => row.ok === true);
  const slowBlocked = slowResults.filter(
    (row) =>
      row.ok === false && row.failureReason === HANDYMAN_MAINTENANCE_ALREADY_SENT_MESSAGE,
  );
  const slowRow = await prisma.customerFollowUp.findFirst({ where: { id: slowFollowUp.id } });
  const slowComms = await prisma.customerCommunication.count({
    where: {
      businessId: businessA.id,
      relatedType: "CUSTOMER_FOLLOW_UP",
      relatedId: slowFollowUp.id,
    },
  });
  check(
    "Provider slower than the claim transaction still sends once",
    slowAccepted.length === 1 &&
      slowBlocked.length === 1 &&
      slowRow?.status === "SENT" &&
      slowComms === 1 &&
      fakeEmails.length === emailsBeforeSlow + 1 &&
      slowResults.every((row) => !/Transaction already closed/i.test(String(row.failureReason ?? ""))),
  );

  const sameSlowJob = await createCompletedJob(businessA.id, {
    phone: "2395550220",
    email: `same-slow-${suffix}@example.com`,
  });
  const sameSlowFollowUp = await createHandymanMaintenanceFollowUp(prisma, ownerA, {
    jobId: sameSlowJob.job.id,
    task: "Same-key slow provider",
    dueOn: futureDue,
  });
  const emailsBeforeSameSlow = fakeEmails.length;
  const sameSlowKey = `email-same-slow-${randomUUID()}`;
  setCommunicationEmailSender(async (input) => {
    await new Promise((resolve) => setTimeout(resolve, 32_000));
    fakeEmails.push(input);
    return { id: `fake-email:${input.idempotencyKey}` };
  });
  const sameSlowA = session.createClient();
  const sameSlowB = session.createClient();
  let sameSlowResults;
  try {
    sameSlowResults = await Promise.all([
      composeCustomerCommunication(sameSlowA, ownerA, {
        customerId: sameSlowJob.customer.id,
        channel: "EMAIL",
        purpose: "GENERAL",
        subject: "Same slow A",
        body: "Same-key slow provider body.",
        relatedType: "CUSTOMER_FOLLOW_UP",
        relatedId: sameSlowFollowUp.id,
        idempotencyKey: sameSlowKey,
      }),
      composeCustomerCommunication(sameSlowB, ownerA, {
        customerId: sameSlowJob.customer.id,
        channel: "EMAIL",
        purpose: "GENERAL",
        subject: "Same slow B",
        body: "Same-key slow provider body.",
        relatedType: "CUSTOMER_FOLLOW_UP",
        relatedId: sameSlowFollowUp.id,
        idempotencyKey: sameSlowKey,
      }),
    ]);
  } finally {
    setCommunicationEmailSender(async (input) => {
      fakeEmails.push(input);
      return { id: `fake-email:${input.idempotencyKey}` };
    });
  }
  const sameSlowAccepted = sameSlowResults.filter((row) => row.ok === true);
  const sameSlowBlocked = sameSlowResults.filter(
    (row) =>
      row.ok === false &&
      row.failureReason === HANDYMAN_MAINTENANCE_IN_PROGRESS_MESSAGE,
  );
  const sameSlowRow = await prisma.customerFollowUp.findFirst({
    where: { id: sameSlowFollowUp.id },
  });
  const sameSlowComms = await countFollowUpComms(sameSlowFollowUp.id);
  check(
    "32s same-key two-connection EMAIL compose sends once",
    sameSlowAccepted.length === 1 &&
      sameSlowBlocked.length === 1 &&
      sameSlowRow?.status === "SENT" &&
      sameSlowComms === 1 &&
      fakeEmails.length === emailsBeforeSameSlow + 1 &&
      sameSlowResults.every((row) => !/Transaction already closed/i.test(String(row.failureReason ?? ""))),
  );

  const cancelJob = await createCompletedJob(businessA.id, {
    phone: "2395550155",
    email: `cancel-${suffix}@example.com`,
  });
  const cancelFollowUp = await createHandymanMaintenanceFollowUp(prisma, ownerA, {
    jobId: cancelJob.job.id,
    task: "Check weatherstripping",
        dueOn: futureDue,
  });
  const cancelled = await cancelHandymanMaintenanceFollowUp(prisma, ownerA, {
    followUpId: cancelFollowUp.id,
  });
  const queueAfterCancel = await loadOwnerDailyMaintenanceFollowUpAttention(
    prisma,
    businessA.id,
    { todayStart: onDueStart },
  );
  const cancelSend = await composeCustomerCommunication(prisma, ownerA, {
    customerId: cancelJob.customer.id,
    channel: "SMS",
    purpose: "GENERAL",
    body: "Should not send.",
    relatedType: "CUSTOMER_FOLLOW_UP",
    relatedId: cancelFollowUp.id,
    idempotencyKey: `sms-cancel-${randomUUID()}`,
  });
  check(
    "Cancellation leaves the owner queue and blocks compose",
    cancelled.status === "CANCELLED" &&
      cancelled.cancelledAt != null &&
      queueAfterCancel.items.every((item) => item.key !== cancelFollowUp.id) &&
      cancelSend.ok === false &&
      cancelSend.failureReason === HANDYMAN_MAINTENANCE_CANCELLED_MESSAGE,
  );

  console.log("\nDB — Tenant isolation and ADMIN cannot send the maintenance reminder");
  await expectThrow(
    "Foreign compose cannot use another tenant's customer or follow-up",
    () =>
      composeCustomerCommunication(prisma, ownerB, {
        customerId: handy.customer.id,
        channel: "SMS",
        purpose: "GENERAL",
        body: "Cross-tenant should fail.",
        relatedType: "CUSTOMER_FOLLOW_UP",
        relatedId: created.id,
        idempotencyKey: `sms-iso-${randomUUID()}`,
      }),
    (error) => error instanceof ForbiddenError || error?.ok === false,
  );
  await expectThrow(
    "Foreign OWNER cannot cancel another tenant's follow-up",
    () =>
      cancelHandymanMaintenanceFollowUp(prisma, ownerB, { followUpId: created.id }),
    (error) =>
      error instanceof ForbiddenError || /could not be found/i.test(error?.message ?? ""),
  );
  const adminSend = await composeCustomerCommunication(prisma, adminA, {
    customerId: handy.customer.id,
    channel: "EMAIL",
    purpose: "GENERAL",
    subject: "Maintenance",
    body: "Admin should not send this related reminder.",
    relatedType: "CUSTOMER_FOLLOW_UP",
    relatedId: created.id,
    idempotencyKey: `email-admin-${randomUUID()}`,
  });
  const stillOpen = await prisma.customerFollowUp.findFirst({
    where: { id: created.id },
  });
  check(
    "ADMIN compose of a MAINTENANCE follow-up is refused; row stays OPEN",
    adminSend.ok === false &&
      adminSend.failureReason === HANDYMAN_MAINTENANCE_OWNER_SEND_MESSAGE &&
      stillOpen?.status === "OPEN",
  );

  const emailSend = await composeCustomerCommunication(prisma, ownerA, {
    customerId: handy.customer.id,
    channel: "EMAIL",
    purpose: "GENERAL",
    subject: "Maintenance check-in",
    body: "Reviewing the shower caulk we installed.",
    relatedType: "CUSTOMER_FOLLOW_UP",
    relatedId: created.id,
    idempotencyKey: `email-ok-${randomUUID()}`,
  });
  const emailed = await prisma.customerFollowUp.findFirst({
    where: { id: created.id },
  });
  const queueAfterEmail = await loadOwnerDailyMaintenanceFollowUpAttention(
    prisma,
    businessA.id,
    { todayStart: onDueStart },
  );
  check(
    "OWNER-reviewed email send marks SENT and removes the item from the queue",
    emailSend.ok === true &&
      emailed?.status === "SENT" &&
      fakeEmails.length >= 1 &&
      queueAfterEmail.items.every((item) => item.key !== created.id),
  );

  const composeContext = await loadMaintenanceFollowUpComposeContext(prisma, ownerA, {
    followUpId: emailed.id,
    customerId: handy.customer.id,
  });
  check(
    "Compose context stays same-tenant and does not invent a callback",
    composeContext?.id === emailed.id && composeContext?.task.includes("Recaulk"),
  );

  resetCommunicationEmailSender();
} catch (error) {
  failed += 1;
  console.error("FAIL - dedicated database run", error);
} finally {
  resetCommunicationEmailSender();
  if (session) await session.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
