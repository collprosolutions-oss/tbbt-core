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
const { startOfZonedDay, parseCivilDateInTimeZone } = await import("@/lib/business-timezone");
const { CUSTOMER_FOLLOW_UP_ORIGINS, customerFollowUpDueScanWhere } = await import(
  "@/lib/customer-follow-up-origin"
);
const {
  HANDYMAN_MAINTENANCE_ALREADY_SENT_MESSAGE,
  HANDYMAN_MAINTENANCE_CANCELLED_MESSAGE,
  HANDYMAN_MAINTENANCE_COMPLETED_JOB_MESSAGE,
  HANDYMAN_MAINTENANCE_CREATED_MESSAGE,
  HANDYMAN_MAINTENANCE_HANDYMAN_ONLY_MESSAGE,
  HANDYMAN_MAINTENANCE_OWNER_ONLY_MESSAGE,
  HANDYMAN_MAINTENANCE_OWNER_SEND_MESSAGE,
  HANDYMAN_MAINTENANCE_PAST_DUE_DATE_MESSAGE,
  HANDYMAN_MAINTENANCE_QUEUE_TITLE,
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
    engineSrc.includes("markMaintenanceFollowUpSentAfterCompose") &&
    panelSrc.includes("maintenanceFollowUpComposeHref") &&
    panelSrc.includes("Review reminder") &&
    !panelSrc.includes("sendCustomerFollowUp"),
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

  const jobsBefore = await countBusinessJobs(prisma, businessA.id);
  const commsBefore = await countBusinessCommunications(prisma, businessA.id);

  console.log("\nDB — OWNER create, eligibility, and no side effects");
  await expectThrow(
    "MEMBER cannot set a maintenance follow-up",
    () =>
      createHandymanMaintenanceFollowUp(prisma, memberA, {
        jobId: handy.job.id,
        task: "Recaulk the tub",
        dueOn: "2026-11-01",
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
        dueOn: "2026-11-01",
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
        dueOn: "2026-11-01",
      }),
    (error) => error?.message === HANDYMAN_MAINTENANCE_COMPLETED_JOB_MESSAGE,
  );
  await expectThrow(
    "Cleaning job is refused and is not treated as a recurring visit",
    () =>
      createHandymanMaintenanceFollowUp(prisma, ownerB, {
        jobId: cleaning.job.id,
        task: "Weekly clean",
        dueOn: "2026-11-01",
      }),
    (error) => error?.message === HANDYMAN_MAINTENANCE_HANDYMAN_ONLY_MESSAGE,
  );
  await expectThrow(
    "Past due date is refused in the business timezone",
    () =>
      createHandymanMaintenanceFollowUp(prisma, ownerA, {
        jobId: handy.job.id,
        task: "Recaulk the tub",
        dueOn: "2026-03-07",
      }),
    (error) => error?.message === HANDYMAN_MAINTENANCE_PAST_DUE_DATE_MESSAGE,
  );

  const created = await createHandymanMaintenanceFollowUp(prisma, ownerA, {
    jobId: handy.job.id,
    task: "Recaulk the shower in six months",
    dueOn: "2026-11-01",
  });
  check(
    "OWNER create writes one OPEN MAINTENANCE CustomerFollowUp",
    created.origin === CUSTOMER_FOLLOW_UP_ORIGINS.MAINTENANCE &&
      created.status === "OPEN" &&
      created.kind === "JOB_COMPLETE" &&
      created.notes === "Recaulk the shower in six months" &&
      created.dueOn?.toISOString() === "2026-11-01T04:00:00.000Z" &&
      created.jobId === handy.job.id &&
      created.customerId === handy.customer.id,
  );
  await expectThrow(
    "Second open follow-up on the same job is refused",
    () =>
      createHandymanMaintenanceFollowUp(prisma, ownerA, {
        jobId: handy.job.id,
        task: "Another task",
        dueOn: "2026-11-02",
      }),
    (error) => /already has an open maintenance follow-up/.test(error?.message ?? ""),
  );

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
      jobsAfter === jobsBefore &&
      commsAfterCreate === commsBefore &&
      recurringAfter === 0,
  );

  console.log("\nDB — Owner queue is due/overdue only and tenant-scoped");
  const beforeFall = new Date("2026-11-01T03:00:00.000Z");
  const duringFall = new Date("2026-11-01T08:00:00.000Z");
  const beforeDue = await loadOwnerDailyMaintenanceFollowUpAttention(prisma, businessA.id, {
    todayStart: startOfZonedDay(beforeFall, ny),
  });
  const onDue = await loadOwnerDailyMaintenanceFollowUpAttention(prisma, businessA.id, {
    todayStart: startOfZonedDay(duringFall, ny),
  });
  const foreignQueue = await loadOwnerDailyMaintenanceFollowUpAttention(prisma, businessB.id, {
    todayStart: startOfZonedDay(duringFall, ny),
  });
  check(
    "Upcoming DST due date stays out of the owner queue",
    beforeDue.items.length === 0 && beforeDue.count === 0,
  );
  check(
    "Due DST date appears in the same owner queue with Review → compose",
    onDue.items.length === 1 &&
      onDue.items[0].key === created.id &&
      onDue.items[0].action === "Review" &&
      onDue.items[0].href.includes("area=compose") &&
      onDue.items[0].href.includes(created.id) &&
      onDue.items[0].meta.includes("Recaulk the shower"),
  );
  check("Foreign tenant queue does not include the follow-up", foreignQueue.items.length === 0);
  const builtForeign = buildOwnerDailyMaintenanceFollowUpAttention(
    [
      {
        ...created,
        customer: { name: "Leak" },
      },
    ],
    { businessId: businessB.id, todayStart: startOfZonedDay(duringFall, ny) },
  );
  check("Builder fails closed on a foreign businessId", builtForeign.length === 0);

  const review = await loadHandymanMaintenanceFollowUpReview(prisma, ownerA, handy.job.id);
  check(
    "Job review shows the open task and due date",
    review?.openFollowUp?.id === created.id &&
      review?.eligible === true &&
      review?.canWrite === true &&
      review?.openFollowUp?.dueOnLabel === "2026-11-01",
  );
  const foreignReview = await loadHandymanMaintenanceFollowUpReview(
    prisma,
    ownerB,
    handy.job.id,
  );
  check("Foreign owner cannot load the job review", foreignReview == null);

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
        dueOn: "2026-11-01",
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
        dueOn: "2026-11-01",
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
        dueOn: "2026-11-01",
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
  check(
    "Same idempotency key is reused; a second send is blocked after SENT",
    firstSend.ok === true &&
      reuseSend.ok === true &&
      reuseSend.reused === true &&
      secondIntent.ok === false &&
      secondIntent.failureReason === HANDYMAN_MAINTENANCE_ALREADY_SENT_MESSAGE &&
      fakeSms.sent.filter((row) => /Paint touch-up/.test(row.body)).length === 1,
  );

  const cancelJob = await createCompletedJob(businessA.id, {
    phone: "2395550155",
    email: `cancel-${suffix}@example.com`,
  });
  const cancelFollowUp = await createHandymanMaintenanceFollowUp(prisma, ownerA, {
    jobId: cancelJob.job.id,
    task: "Check weatherstripping",
        dueOn: "2026-11-01",
  });
  const cancelled = await cancelHandymanMaintenanceFollowUp(prisma, ownerA, {
    followUpId: cancelFollowUp.id,
  });
  const queueAfterCancel = await loadOwnerDailyMaintenanceFollowUpAttention(
    prisma,
    businessA.id,
    { todayStart: startOfZonedDay(duringFall, ny) },
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
    { todayStart: startOfZonedDay(duringFall, ny) },
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
