/**
 * OWNER weekly Marketing Studio review reminder.
 *
 * Proves consent (default off / explicit opt-in), opt-out, timezone
 * week boundaries, idempotency for the same business/week,
 * authorization, and tenant isolation on a dedicated test database.
 * Delivery stays on the existing OWNER in-app path. Optional OWNER SMS
 * uses a fake provider adapter only. Never messages customers,
 * auto-approves, publishes, posts, or sends a real SMS.
 *
 * Run with:
 *   npm run test:marketing-studio-weekly-reminder
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
  console.error("Failed to generate Prisma client for marketing studio weekly reminder checks.");
  process.exit(generateEarly.status ?? 1);
}

const { ForbiddenError } = await import("@/lib/authorization");
const { businessScope, assertBusinessRecord } = await import("@/lib/access-scope");
const { zonedCivilToUtc } = await import("@/lib/business-timezone");
const {
  STUDIO_WEEKLY_REMINDER_CHANNEL,
  STUDIO_WEEKLY_REMINDER_IN_APP_MESSAGE,
  STUDIO_WEEKLY_REMINDER_OPTED_IN_MESSAGE,
  STUDIO_WEEKLY_REMINDER_OPTED_OUT_MESSAGE,
  STUDIO_WEEKLY_REMINDER_OWNER_ONLY_MESSAGE,
  STUDIO_WEEKLY_REMINDER_OWNER_SMS_INVALID_MESSAGE,
  STUDIO_WEEKLY_REMINDER_SMS_ACCEPTED,
  STUDIO_WEEKLY_REMINDER_SMS_BLOCKED,
  STUDIO_WEEKLY_REMINDER_SMS_FAILED,
  STUDIO_WEEKLY_REMINDER_SMS_NO_DESTINATION,
  STUDIO_WEEKLY_REMINDER_SMS_NOT_CONNECTED,
  STUDIO_WEEKLY_REMINDER_SMS_NOT_OPTED_IN,
  STUDIO_WEEKLY_REMINDER_SMS_OPTED_OUT,
  STUDIO_WEEKLY_REMINDER_SMS_STATUS_ACCEPTED,
  STUDIO_WEEKLY_REMINDER_SMS_STATUS_BLOCKED,
  STUDIO_WEEKLY_REMINDER_SMS_STATUS_CONNECTED_UNUSED,
  STUDIO_WEEKLY_REMINDER_SMS_STATUS_FAILED,
  STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_CONNECTED,
  STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_SENT,
  STUDIO_WEEKLY_REMINDER_SMS_STOPPED,
  STUDIO_WEEKLY_REMINDER_SMS_TIMED_OUT,
  STUDIO_WEEKLY_REMINDER_UNAVAILABLE_MESSAGE,
  STUDIO_WEEKLY_REMINDER_CRON_RETRY_MESSAGE,
  STUDIO_WEEKLY_REMINDER_CRON_RETRIED_MESSAGE,
  STUDIO_WEEKLY_REMINDER_CRON_RETRY_OWNER_ONLY_MESSAGE,
  STUDIO_WEEKLY_REMINDER_CRON_SECRET_MISSING_MESSAGE,
  canManageStudioWeeklyReminder,
  isStudioWeeklyReminderSendWindow,
  maskOwnerSmsDestination,
  parseOwnerSmsE164,
  resolveOwnerStudioReminderSmsTo,
  studioWeeklyReminderCopy,
  studioWeeklyReminderDelivery,
  studioWeeklyReminderSafeSmsLabel,
  studioWeeklyReminderSmsBody,
  studioWeeklyReminderSmsConnected,
  studioWeeklyReminderWeekKey,
} = await import("@/lib/marketing");
const {
  advanceMarketingContentStatus,
  createMarketingStudioPackage,
  grantJobPhotoMarketingPermission,
  MarketingError,
} = await import("@/lib/marketing-ops");
const { loadMarketingSource } = await import("@/lib/marketing-data");
const {
  authorizeStudioWeeklyReminderCron,
  classifyStudioWeeklyReminderCronAuth,
  createStudioWeeklyReviewReminder,
  dispatchStudioWeeklyReviewReminder,
  loadStudioWeeklyReminderState,
  missingStudioWeeklyReminderSchema,
  presentStudioWeeklyReminderForViewer,
  recordOwnerStudioReminderBlocked,
  recordOwnerStudioReminderStop,
  retryStudioWeeklyReminderSchedule,
  runScheduledStudioWeeklyReminders,
  summarizeStudioWeeklyReminderCronRun,
  setStudioWeeklyReminderOwnerSms,
  setStudioWeeklyReviewReminderOptIn,
} = await import("@/lib/marketing-studio-reminder");
const {
  GET: getStudioWeeklyReminderCron,
  setStudioWeeklyReminderCronRunnerForTests,
} = await import("@/app/api/cron/studio-weekly-reminder/route");
const { emitBusinessEvent } = await import("@/lib/automation/events");
const { INVOICE_DUE_AFTER_MS, scanScheduledBusinessEvents } = await import("@/lib/automation/scan");
const {
  applyCustomerMessageDeliveryUpdate,
  applyInboundConsentEvent,
  createFakeCustomerMessagingProvider,
  isCustomerMessagePurpose,
  resetCustomerMessagingProvider,
  setCustomerMessagingProvider,
} = await import("@/lib/customer-messaging");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function readSrc(relative) {
  return readFileSync(join(root, relative), "utf8");
}

const domainSrc = readSrc("src/lib/marketing.ts");
const reminderOpsSrc = readSrc("src/lib/marketing-studio-reminder.ts");
const ownerSmsSrc = readSrc("src/lib/customer-messaging/owner-sms.ts");
const dataSrc = readSrc("src/lib/marketing-data.ts");
const reminderTestSrc = readSrc("scripts/check-marketing-studio-weekly-reminder.mjs");
const actionSrc = readSrc("src/app/actions/marketing.ts");
const queueUiSrc = readSrc("src/components/marketing/studio-approval-queue.tsx");
const reminderUiSrc = readSrc("src/components/marketing/studio-weekly-reminder.tsx");
const scanSrc = readSrc("src/lib/automation/scan.ts");
const pageSrc = readSrc("src/app/(app)/marketing/page.tsx");
const cronRouteSrc = readSrc("src/app/api/cron/studio-weekly-reminder/route.ts");
const cronPathSrc = readSrc("src/lib/studio-weekly-reminder-cron-path.ts");
const vercelSrc = readSrc("vercel.json");
const proxySrc = readSrc("src/proxy.ts");
const inboundSrc = readSrc("src/lib/customer-messaging/inbound.ts");
const twilioSrc = readSrc("src/lib/customer-messaging/twilio.ts");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_marketing_studio_weekly_reminder_test";
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
  await admin.$executeRawUnsafe(`CREATE DATABASE "${testDbName}"`);
  await admin.$disconnect();
}

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for marketing studio weekly reminder test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

async function writeOwnerSmsDestination(businessId, destination, optedIn) {
  await prisma.businessSettings.upsert({
    where: { businessId },
    create: {
      businessId,
      studioWeeklyReminderOwnerSmsTo: destination,
      studioWeeklyReminderOwnerSmsOptedIn: optedIn,
    },
    update: {
      studioWeeklyReminderOwnerSmsTo: destination,
      studioWeeklyReminderOwnerSmsOptedIn: optedIn,
    },
  });
}

async function clearOwnerSmsStopAndBlock(businessId) {
  await prisma.businessSettings.updateMany({
    where: { businessId },
    data: {
      studioWeeklyReminderOwnerSmsStopAt: null,
      studioWeeklyReminderOwnerSmsBlockedAt: null,
    },
  });
}

async function resetOwnerSmsSendWeek(businessId, destination) {
  await clearOwnerSmsStopAndBlock(businessId);
  await writeOwnerSmsDestination(businessId, destination, true);
  await prisma.marketingStudioWeeklyReminder.deleteMany({ where: { businessId } });
}

function createGate() {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

function createNotifier() {
  let notify;
  const reached = new Promise((resolve) => {
    notify = resolve;
  });
  return { reached, notify };
}

function captureConsole(method, run) {
  const lines = [];
  const previous = console[method];
  console[method] = (...args) => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  };
  return Promise.resolve()
    .then(run)
    .finally(() => {
      console[method] = previous;
    })
    .then((value) => ({ value, lines, text: lines.join("\n") }));
}

function cronRequest(headers = {}) {
  return new Request("http://tbbt.test/api/cron/studio-weekly-reminder", {
    method: "GET",
    headers,
  });
}

async function readJsonResponse(response) {
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, text };
}

async function waitUntilUngrantedAdvisoryLock(client) {
  for (;;) {
    const rows = await client.$queryRaw`
      SELECT COUNT(*)::int AS n
      FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
    `;
    if ((rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: { role, membership: { id: membershipId } },
    scope: businessScope(businessId),
    assertOwned(record) {
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

async function seedReadyPackage(db, access, title) {
  const customer = await db.customer.create({
    data: { businessId: access.businessId, name: `${title} customer` },
  });
  const job = await db.job.create({
    data: {
      businessId: access.businessId,
      customerId: customer.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  const photo = await db.jobPhoto.create({
    data: {
      businessId: access.businessId,
      jobId: job.id,
      stage: "AFTER",
      url: `https://example.test/${randomUUID()}.jpg`,
    },
  });
  await grantJobPhotoMarketingPermission(db, access, { photoId: photo.id });
  const draft = await createMarketingStudioPackage(db, access, {
    contentType: "COMPLETED_JOB",
    title,
    body: "Recorded job facts only.",
    jobId: job.id,
    photoIds: [photo.id],
  });
  return advanceMarketingContentStatus(db, access, { contentId: draft.id });
}

try {
  console.log("\nSTATIC — Weekly reminder helpers, consent, and delivery limits");
  check("OWNER can manage the weekly reminder", canManageStudioWeeklyReminder("OWNER") === true);
  check("ADMIN cannot manage the weekly reminder", canManageStudioWeeklyReminder("ADMIN") === false);
  check("MEMBER cannot manage the weekly reminder", canManageStudioWeeklyReminder("MEMBER") === false);
  check(
    "SMS is connected only with platform config and a dedicated number",
    studioWeeklyReminderSmsConnected({ platformConfigured: true, dedicatedNumberAssigned: true }) === true,
  );
  check(
    "Platform credentials alone do not mean SMS is connected",
    studioWeeklyReminderSmsConnected({ platformConfigured: true, dedicatedNumberAssigned: false }) === false,
  );
  check(
    "A dedicated number without platform config is not connected",
    studioWeeklyReminderSmsConnected({ platformConfigured: false, dedicatedNumberAssigned: true }) === false,
  );
  const smsDown = studioWeeklyReminderDelivery({
    platformConfigured: false,
    dedicatedNumberAssigned: false,
  });
  check(
    "Unconfigured SMS stays in-app and is labeled SMS not connected",
    smsDown.channel === STUDIO_WEEKLY_REMINDER_CHANNEL &&
      smsDown.smsConnected === false &&
      smsDown.smsStatus === STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_CONNECTED &&
      smsDown.smsLabel === STUDIO_WEEKLY_REMINDER_SMS_NOT_CONNECTED &&
      smsDown.customerMessageSent === false &&
      smsDown.published === false &&
      smsDown.posted === false,
  );
  const smsUp = studioWeeklyReminderDelivery({
    platformConfigured: true,
    dedicatedNumberAssigned: true,
  });
  check(
    "Configured SMS still does not send a customer or owner text",
    smsUp.channel === STUDIO_WEEKLY_REMINDER_CHANNEL &&
      smsUp.smsStatus === STUDIO_WEEKLY_REMINDER_SMS_STATUS_CONNECTED_UNUSED &&
      smsUp.smsLabel === null &&
      smsUp.customerMessageSent === false,
  );
  check(
    "Reminder copy is package-count honest",
    studioWeeklyReminderCopy(1) === "1 package awaits OWNER review this week." &&
      studioWeeklyReminderCopy(3) === "3 packages await OWNER review this week.",
  );
  check(
    "Owner SMS destination requires a valid E.164 number",
    parseOwnerSmsE164("+19415550199") === "+19415550199" &&
      parseOwnerSmsE164("+1 941 555 0199") === "+19415550199" &&
      parseOwnerSmsE164("9415550199") === null &&
      parseOwnerSmsE164("(941) 555-0199") === null &&
      parseOwnerSmsE164("9415550") === null &&
      parseOwnerSmsE164("+1941555") === null &&
      parseOwnerSmsE164("+1234567") === null &&
      resolveOwnerStudioReminderSmsTo({ ownerSmsTo: "+19415550199" }) === "+19415550199" &&
      resolveOwnerStudioReminderSmsTo({ ownerSmsTo: "" }) === null &&
      resolveOwnerStudioReminderSmsTo({ ownerSmsTo: null }) === null,
  );
  check(
    "Owner SMS destination is masked for non-OWNER page data",
    maskOwnerSmsDestination("+19415550199") === "••••0199",
  );
  check(
    "Owner SMS resolver does not accept a public company phone",
    !/function resolveOwnerStudioReminderSmsTo[\s\S]*publicPhone/.test(domainSrc),
  );
  check(
    "Owner SMS body stays on the in-app review reminder",
    studioWeeklyReminderSmsBody(2).includes("2 packages await OWNER review this week.") &&
      studioWeeklyReminderSmsBody(2).includes("will not auto-approve or message customers"),
  );

  const saturdayEt = zonedCivilToUtc(2026, 9, 26, 23, 0, 0, "America/New_York");
  const sundayEt = zonedCivilToUtc(2026, 9, 27, 0, 30, 0, "America/New_York");
  check(
    "Saturday 11:00 PM Eastern is still the prior Sunday-first week",
    studioWeeklyReminderWeekKey(saturdayEt, "America/New_York") === "2026-09-20",
  );
  check(
    "Sunday 12:30 AM Eastern starts the next reminder week",
    studioWeeklyReminderWeekKey(sundayEt, "America/New_York") === "2026-09-27",
  );
  const utcSundayMorning = new Date("2026-09-27T03:30:00.000Z");
  check(
    "The same UTC instant is Saturday in Eastern and still the prior week",
    studioWeeklyReminderWeekKey(utcSundayMorning, "America/New_York") === "2026-09-20",
  );
  check(
    "The same UTC instant is Sunday in UTC and a new week there",
    studioWeeklyReminderWeekKey(utcSundayMorning, "UTC") === "2026-09-27",
  );
  check(
    "Pacific keeps Saturday 8:30 PM as the prior week for that same instant",
    studioWeeklyReminderWeekKey(utcSundayMorning, "America/Los_Angeles") === "2026-09-20",
  );

  check(
    "Ops never import customer or publish senders",
    !reminderOpsSrc.includes("sendTransactionalEmail") &&
      !reminderOpsSrc.includes("notifyCustomer") &&
      !reminderOpsSrc.includes("attemptAppointment") &&
      !reminderOpsSrc.includes("attemptCustomer") &&
      !reminderOpsSrc.includes('"PUBLISHED"') &&
      reminderOpsSrc.includes("isCustomerMessagingConfigured") &&
      reminderOpsSrc.includes("sendOwnerSms") &&
      reminderOpsSrc.includes("deliverOwnerStudioWeeklyReminderSms") &&
      reminderOpsSrc.includes("smsSendClaimedAt") &&
      reminderOpsSrc.includes("claimOwnerStudioReminderSmsIfDestinationUnchanged") &&
      reminderOpsSrc.includes("beforeOwnerSmsClaim") &&
      reminderOpsSrc.includes("afterOwnerSmsClaimLockAcquired") &&
      reminderOpsSrc.includes("afterReminderLockAcquired") &&
      reminderOpsSrc.includes("recordOwnerStudioReminderStop") &&
      reminderOpsSrc.includes("recordOwnerStudioReminderBlocked") &&
      reminderOpsSrc.includes("currentTo !== selectedTo") &&
      reminderOpsSrc.includes("STUDIO_WEEKLY_REMINDER_CHANNEL") &&
      !reminderOpsSrc
        .slice(
          reminderOpsSrc.indexOf("async function claimOwnerStudioReminderSmsIfDestinationUnchanged"),
          reminderOpsSrc.indexOf("async function deliverOwnerStudioWeeklyReminderSms"),
        )
        .includes("sendOwnerSms") &&
      reminderOpsSrc.includes("const sent = await sendOwnerSms") &&
      ownerSmsSrc.includes("Never reads Customer") &&
      !ownerSmsSrc.includes("attemptCustomerSms") &&
      !ownerSmsSrc.includes("customer.phone") &&
      !reminderOpsSrc.includes("publicPhone") &&
      !reminderOpsSrc.includes("api.twilio.com"),
  );
  check(
    "Dedicated reminder tests use a fake provider and do not send a real SMS",
    reminderTestSrc.includes("createFakeCustomerMessagingProvider") &&
      reminderTestSrc.includes("messagingProvider: fakeSms") &&
      !ownerSmsSrc.includes("twilio.com") &&
      !reminderOpsSrc.includes("createTwilioCustomerMessagingProvider"),
  );
  check(
    "Owner studio reminder purpose cannot go through customer SMS",
    isCustomerMessagePurpose("STUDIO_WEEKLY_REMINDER") === false,
  );
  check(
    "Missing reminder schema is detected only for this table or column",
    missingStudioWeeklyReminderSchema({
      code: "P2021",
      message: "The table `MarketingStudioWeeklyReminder` does not exist in the current database.",
    }) &&
      missingStudioWeeklyReminderSchema({
        code: "P2022",
        message:
          "The column `BusinessSettings.studioWeeklyReviewReminderOptedIn` does not exist in the current database.",
      }) &&
      missingStudioWeeklyReminderSchema({
        code: "P2022",
        message:
          "The column `BusinessSettings.studioWeeklyReminderOwnerSmsTo` does not exist in the current database.",
      }) &&
      missingStudioWeeklyReminderSchema({
        code: "P2022",
        message:
          "The column `MarketingStudioWeeklyReminder.smsSendClaimedAt` does not exist in the current database.",
      }) &&
      missingStudioWeeklyReminderSchema({
        code: "P2022",
        message:
          "The column `BusinessSettings.studioWeeklyReminderOwnerSmsStopAt` does not exist in the current database.",
      }) &&
      missingStudioWeeklyReminderSchema({
        message: 'relation "MarketingStudioWeeklyReminder" does not exist',
      }) &&
      !missingStudioWeeklyReminderSchema({
        code: "P2002",
        message: "Unique constraint failed on the fields: (`MarketingStudioWeeklyReminder`)",
      }) &&
      !missingStudioWeeklyReminderSchema({
        code: "P2003",
        message: "Foreign key constraint failed on the field: `MarketingStudioWeeklyReminder.businessId`",
      }) &&
      !missingStudioWeeklyReminderSchema({
        code: "P2014",
        message:
          "The change you are trying to make would violate the required relation 'MarketingStudioWeeklyReminderToBusiness'",
      }) &&
      !missingStudioWeeklyReminderSchema({
        code: "P2025",
        message: "Record to update not found for MarketingStudioWeeklyReminder",
      }) &&
      !missingStudioWeeklyReminderSchema({
        code: "P2021",
        message: "The table `WebsitePublish` does not exist in the current database.",
      }) &&
      !missingStudioWeeklyReminderSchema({
        code: "P2022",
        message: "The column `Business.timezone` does not exist in the current database.",
      }) &&
      !missingStudioWeeklyReminderSchema(new Error("Can't reach database server at 127.0.0.1:5432")),
  );
  check(
    "Reminder ops fail closed without request-time DDL",
    reminderOpsSrc.includes("missingStudioWeeklyReminderSchema") &&
      reminderOpsSrc.includes("pg_advisory_xact_lock") &&
      reminderOpsSrc.includes("schema_unavailable") &&
      !reminderOpsSrc.includes("$executeRawUnsafe") &&
      !reminderOpsSrc.includes("ALTER TABLE") &&
      !reminderOpsSrc.includes("CREATE TABLE") &&
      !reminderOpsSrc.includes("ADD COLUMN"),
  );
  check(
    "Studio shows an unavailable reminder state",
    reminderUiSrc.includes("STUDIO_WEEKLY_REMINDER_UNAVAILABLE_MESSAGE") &&
      reminderUiSrc.includes("!reminder.available") &&
      domainSrc.includes("STUDIO_WEEKLY_REMINDER_UNAVAILABLE_MESSAGE"),
  );
  check(
    "Scan swallows only missing reminder schema",
    scanSrc.includes("missingStudioWeeklyReminderSchema") &&
      scanSrc.includes("if (!missingStudioWeeklyReminderSchema(error)) throw error"),
  );
  check(
    "Loader stays read-only for reminder state",
    dataSrc.includes("loadStudioWeeklyReminderState") &&
      !dataSrc.includes("setStudioWeeklyReviewReminderOptIn") &&
      !dataSrc.includes("dispatchStudioWeeklyReviewReminder"),
  );
  check(
    "OWNER action and UI expose opt-in and opt-out",
    actionSrc.includes("setStudioWeeklyReviewReminderOptInAction") &&
      actionSrc.includes("setStudioWeeklyReminderOwnerSmsAction") &&
      actionSrc.includes('access.workspace.role !== "OWNER"') &&
      reminderUiSrc.includes("Turn weekly reminder on") &&
      reminderUiSrc.includes("Turn weekly reminder off") &&
      reminderUiSrc.includes("Retry scheduled reminder") &&
      reminderUiSrc.includes("OWNER SMS number") &&
      reminderUiSrc.includes("STUDIO_WEEKLY_REMINDER_OWNER_SMS_OPT_IN_MESSAGE") &&
      reminderUiSrc.includes("STUDIO_WEEKLY_REMINDER_SMS_NOT_CONNECTED") &&
      reminderUiSrc.includes("STUDIO_WEEKLY_REMINDER_CRON_RETRY_MESSAGE") &&
      !reminderUiSrc.includes("STUDIO_WEEKLY_REMINDER_CRON_SECRET_MISSING_MESSAGE") &&
      !reminderUiSrc.includes("Ask the operator to set CRON_SECRET") &&
      !reminderUiSrc.includes("cronSecretConfigured") &&
      !/no messages are sent/i.test(STUDIO_WEEKLY_REMINDER_CRON_RETRY_MESSAGE) &&
      !/no messages are sent/i.test(STUDIO_WEEKLY_REMINDER_CRON_RETRIED_MESSAGE) &&
      STUDIO_WEEKLY_REMINDER_CRON_RETRY_MESSAGE.includes("can send the OWNER SMS") &&
      STUDIO_WEEKLY_REMINDER_CRON_SECRET_MISSING_MESSAGE.includes("Ask the operator to set CRON_SECRET") &&
      queueUiSrc.includes("StudioWeeklyReminderControls"),
  );
  check(
    "Page and server loaders never send or wait on owner SMS",
    !pageSrc.includes("dispatchStudioWeeklyReviewReminder") &&
      !pageSrc.includes("sendOwnerSms") &&
      !pageSrc.includes("runScheduledStudioWeeklyReminders") &&
      !dataSrc.includes("dispatchStudioWeeklyReviewReminder") &&
      !dataSrc.includes("sendOwnerSms") &&
      !actionSrc.includes("dispatchStudioWeeklyReviewReminder") &&
      !actionSrc.includes("sendOwnerSms") &&
      dataSrc.includes("presentStudioWeeklyReminderForViewer") &&
      domainSrc.includes("STUDIO_WEEKLY_REMINDER_IN_APP_MESSAGE") &&
      STUDIO_WEEKLY_REMINDER_IN_APP_MESSAGE.includes("will not send customer SMS"),
  );
  check(
    "Scan creates the in-app reminder without sending SMS",
    scanSrc.includes("createStudioWeeklyReviewReminder") &&
      !scanSrc.includes("dispatchStudioWeeklyReviewReminder") &&
      !scanSrc.includes("sendOwnerSms"),
  );
  check(
    "Weekly owner SMS is scheduled by a secret-protected cron",
    reminderOpsSrc.includes("runScheduledStudioWeeklyReminders") &&
      reminderOpsSrc.includes("isStudioWeeklyReminderSendWindow") &&
      reminderOpsSrc.includes("authorizeStudioWeeklyReminderCron") &&
      reminderOpsSrc.includes("classifyStudioWeeklyReminderCronAuth") &&
      reminderOpsSrc.includes("logStudioWeeklyReminderCron") &&
      cronRouteSrc.includes("classifyStudioWeeklyReminderCronAuth") &&
      cronRouteSrc.includes("runScheduledStudioWeeklyReminders") &&
      cronRouteSrc.includes('reason: "runner_failed"') &&
      cronPathSrc.includes("/api/cron/studio-weekly-reminder") &&
      vercelSrc.includes("/api/cron/studio-weekly-reminder") &&
      vercelSrc.includes("0 15 * * *") &&
      !vercelSrc.includes("0 * * * *") &&
      proxySrc.includes("isStudioWeeklyReminderCronPath") &&
      proxySrc.includes("api/cron/"),
  );
  check(
    "OWNER retry action stays on the scheduled reminder path",
    reminderOpsSrc.includes("retryStudioWeeklyReminderSchedule") &&
      reminderOpsSrc.includes("runScheduledStudioWeeklyReminderForBusiness") &&
      actionSrc.includes("retryStudioWeeklyReminderScheduleAction") &&
      !cronRouteSrc.includes("customerId") &&
      !cronRouteSrc.includes("businessId"),
  );
  check(
    "Provider send has a timeout and owner STOP is separate from customer consent",
    ownerSmsSrc.includes("OWNER_SMS_PROVIDER_TIMEOUT_MS") &&
      twilioSrc.includes("AbortController") &&
      twilioSrc.includes("TWILIO_SEND_TIMEOUT_MS") &&
      inboundSrc.includes("applyOwnerStudioReminderInbound") &&
      inboundSrc.includes("recordOwnerStudioReminderStop") &&
      inboundSrc.includes("recordOwnerStudioReminderStart") &&
      !inboundSrc.includes("studioWeeklyReminderOwnerSmsStopAt: new Date()") &&
      reminderOpsSrc.includes("recordOwnerStudioReminderDeliveryBlock") &&
      reminderOpsSrc.includes("recordOwnerStudioReminderBlocked") &&
      reminderOpsSrc.includes("OWNER_SMS_BLOCKED_PROVIDER_CODE"),
  );
  const stopWriteSrc = reminderOpsSrc.slice(
    reminderOpsSrc.indexOf("export async function recordOwnerStudioReminderStop"),
    reminderOpsSrc.indexOf("export async function recordOwnerStudioReminderStart"),
  );
  const startWriteSrc = reminderOpsSrc.slice(
    reminderOpsSrc.indexOf("export async function recordOwnerStudioReminderStart"),
    reminderOpsSrc.indexOf("export async function recordOwnerStudioReminderBlocked"),
  );
  const blockedWriteSrc = reminderOpsSrc.slice(
    reminderOpsSrc.indexOf("export async function recordOwnerStudioReminderBlocked"),
    reminderOpsSrc.indexOf("function asReminder"),
  );
  const deliveryBlockSrc = reminderOpsSrc.slice(
    reminderOpsSrc.indexOf("export async function recordOwnerStudioReminderDeliveryBlock"),
    reminderOpsSrc.indexOf("export async function setStudioWeeklyReminderOwnerSms"),
  );
  const sendTimeBlockSrc = reminderOpsSrc.slice(
    reminderOpsSrc.indexOf("const sent = await sendOwnerSms"),
    reminderOpsSrc.indexOf("function unavailableReminderState"),
  );
  check(
    "STOP and provider-block writes take the same per-business reminder lock",
    stopWriteSrc.includes("withReminderLock") &&
      startWriteSrc.includes("withReminderLock") &&
      blockedWriteSrc.includes("withReminderLock") &&
      blockedWriteSrc.includes("studioWeeklyReminderOwnerSmsBlockedAt") &&
      deliveryBlockSrc.includes("recordOwnerStudioReminderBlocked") &&
      !deliveryBlockSrc.includes("studioWeeklyReminderOwnerSmsBlockedAt: new Date()") &&
      sendTimeBlockSrc.includes("recordOwnerStudioReminderBlocked") &&
      !stopWriteSrc.includes("sendOwnerSms") &&
      !startWriteSrc.includes("sendOwnerSms") &&
      !blockedWriteSrc.includes("sendOwnerSms") &&
      sendTimeBlockSrc.indexOf("const sent = await sendOwnerSms") <
        sendTimeBlockSrc.indexOf("recordOwnerStudioReminderBlocked"),
  );
  check(
    "Owner SMS sends only on the business local Monday",
    isStudioWeeklyReminderSendWindow(
      zonedCivilToUtc(2026, 9, 28, 10, 0, 0, "America/New_York"),
      "America/New_York",
    ) === true &&
      isStudioWeeklyReminderSendWindow(
        zonedCivilToUtc(2026, 9, 28, 2, 0, 0, "America/New_York"),
        "America/New_York",
      ) === true &&
      isStudioWeeklyReminderSendWindow(
        zonedCivilToUtc(2026, 9, 28, 2, 0, 0, "America/New_York"),
        "America/Los_Angeles",
      ) === false &&
      isStudioWeeklyReminderSendWindow(
        zonedCivilToUtc(2026, 10, 4, 10, 0, 0, "America/New_York"),
        "America/New_York",
      ) === false,
  );
  check(
    "Safe SMS labels never include raw provider text",
    studioWeeklyReminderSafeSmsLabel("FAILED", "Fake SMS provider rejected the message.") ===
      STUDIO_WEEKLY_REMINDER_SMS_FAILED &&
      studioWeeklyReminderSafeSmsLabel("FAILED", STUDIO_WEEKLY_REMINDER_SMS_TIMED_OUT) ===
        STUDIO_WEEKLY_REMINDER_SMS_TIMED_OUT,
  );

  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Reminder",
      slug: `alpha-reminder-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: "America/New_York",
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Reminder",
      slug: `beta-reminder-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: "America/Los_Angeles",
    },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-reminder-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Amir Admin", email: `admin-reminder-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-reminder-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaOwner = await prisma.user.create({
    data: { name: "Bea Owner", email: `beta-reminder-${randomUUID()}@example.com`, passwordHash: "x" },
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
    data: { userId: betaOwner.id, businessId: businessB.id, role: "OWNER" },
  });
  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaMem.id);

  const weekInstant = zonedCivilToUtc(2026, 9, 28, 10, 0, 0, "America/New_York");
  const mondayEtSundayPt = zonedCivilToUtc(2026, 9, 28, 2, 0, 0, "America/New_York");
  const pacificMonday10 = zonedCivilToUtc(2026, 9, 28, 10, 0, 0, "America/Los_Angeles");
  const nextWeekInstant = zonedCivilToUtc(2026, 10, 4, 10, 0, 0, "America/New_York");

  console.log("\nTEST — Consent: default off, no reminder without opt-in");
  const readyA = await seedReadyPackage(prisma, ownerA, "Alpha faucet package");
  check("Seeded package is awaiting review", readyA.status === "READY_FOR_REVIEW");
  const defaultState = await loadStudioWeeklyReminderState(prisma, businessA.id, weekInstant, {
    smsPlatformConfigured: false,
  });
  check("Settings absence means opted out", defaultState.optedIn === false);
  const skipped = await dispatchStudioWeeklyReviewReminder(prisma, businessA.id, weekInstant, {
    smsPlatformConfigured: false,
  });
  check(
    "Dispatch without consent creates nothing",
    skipped.created === false && skipped.reason === "not_opted_in" && skipped.reminder === null,
  );
  const none = await prisma.marketingStudioWeeklyReminder.count({ where: { businessId: businessA.id } });
  check("No reminder row exists before opt-in", none === 0);

  console.log("\nTEST — Authorization: ADMIN and MEMBER cannot opt in or out");
  await expectError(
    "ADMIN cannot opt in",
    () => setStudioWeeklyReviewReminderOptIn(prisma, adminA, true, weekInstant, { smsPlatformConfigured: false }),
    (error) => error instanceof MarketingError && error.message === STUDIO_WEEKLY_REMINDER_OWNER_ONLY_MESSAGE,
  );
  await expectError(
    "MEMBER cannot opt in",
    () => setStudioWeeklyReviewReminderOptIn(prisma, memberA, true, weekInstant, { smsPlatformConfigured: false }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "ADMIN cannot opt out",
    () => setStudioWeeklyReviewReminderOptIn(prisma, adminA, false, weekInstant),
    (error) => error instanceof MarketingError && error.message === STUDIO_WEEKLY_REMINDER_OWNER_ONLY_MESSAGE,
  );
  const stillOff = await loadStudioWeeklyReminderState(prisma, businessA.id, weekInstant);
  check("Rejected writes leave reminders off", stillOff.optedIn === false);
  check(
    "Rejected writes did not record a reminder",
    (await prisma.marketingStudioWeeklyReminder.count({ where: { businessId: businessA.id } })) === 0,
  );

  console.log("\nTEST — Opt-in creates one honest in-app reminder");
  const optedIn = await setStudioWeeklyReviewReminderOptIn(prisma, ownerA, true, weekInstant, {
    smsPlatformConfigured: false,
  });
  check("Opt-in message is recorded", optedIn.message === STUDIO_WEEKLY_REMINDER_OPTED_IN_MESSAGE);
  check(
    "Opt-in dispatch creates the in-app reminder",
    optedIn.dispatch?.created === true &&
      optedIn.dispatch.reason === "created" &&
      optedIn.dispatch.reminder?.channel === STUDIO_WEEKLY_REMINDER_CHANNEL &&
      optedIn.dispatch.reminder?.weekKey === "2026-09-27" &&
      optedIn.dispatch.reminder?.awaitingCount === 1 &&
      optedIn.dispatch.reminder?.smsStatus === STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_CONNECTED &&
      optedIn.dispatch.reminder?.smsLabel === STUDIO_WEEKLY_REMINDER_SMS_NOT_CONNECTED,
  );
  const source = await loadMarketingSource(prisma, businessA.id, weekInstant);
  check(
    "Loader surfaces the in-app reminder and SMS not connected label",
    source.weeklyReminder.available === true &&
      source.weeklyReminder.optedIn === true &&
      source.weeklyReminder.reminder?.id === optedIn.dispatch.reminder.id &&
      source.weeklyReminder.delivery.smsLabel === STUDIO_WEEKLY_REMINDER_SMS_NOT_CONNECTED &&
      source.weeklyReminder.copy === "1 package awaits OWNER review this week.",
  );
  check(
    "Opt-in did not change package status or invent a publish",
    (await prisma.marketingContent.findFirst({ where: { id: readyA.id, businessId: businessA.id } }))
      ?.status === "READY_FOR_REVIEW" &&
      source.channels.connected === false,
  );

  console.log("\nTEST — Idempotency: same business/week cannot duplicate");
  const again = await dispatchStudioWeeklyReviewReminder(prisma, businessA.id, weekInstant, {
    smsPlatformConfigured: false,
  });
  check(
    "Second dispatch in the same week is a no-op",
    again.created === false &&
      again.reason === "already_recorded" &&
      again.reminder?.id === optedIn.dispatch.reminder.id,
  );
  const laterSameWeek = zonedCivilToUtc(2026, 10, 3, 18, 0, 0, "America/New_York");
  const saturdayStillSame = await dispatchStudioWeeklyReviewReminder(prisma, businessA.id, laterSameWeek, {
    smsPlatformConfigured: false,
  });
  check(
    "Saturday of the same Eastern week reuses the same row",
    saturdayStillSame.created === false &&
      saturdayStillSame.reminder?.id === optedIn.dispatch.reminder.id &&
      saturdayStillSame.reminder?.weekKey === "2026-09-27",
  );
  const [first, second] = await Promise.all([
    dispatchStudioWeeklyReviewReminder(prisma, businessA.id, weekInstant, { smsPlatformConfigured: false }),
    dispatchStudioWeeklyReviewReminder(prisma, businessA.id, weekInstant, { smsPlatformConfigured: false }),
  ]);
  check(
    "Concurrent same-week dispatches stay a single row",
    first.reminder?.id === optedIn.dispatch.reminder.id &&
      second.reminder?.id === optedIn.dispatch.reminder.id &&
      (await prisma.marketingStudioWeeklyReminder.count({ where: { businessId: businessA.id } })) === 1,
  );

  console.log("\nTEST — Timezone boundary creates the next week once");
  const nextWeek = await dispatchStudioWeeklyReviewReminder(prisma, businessA.id, nextWeekInstant, {
    smsPlatformConfigured: false,
  });
  check(
    "Sunday of the next Eastern week can record a second reminder",
    nextWeek.created === true &&
      nextWeek.reminder?.weekKey === "2026-10-04" &&
      nextWeek.reminder?.id !== optedIn.dispatch.reminder.id,
  );
  check(
    "Two weeks for one business are two rows",
    (await prisma.marketingStudioWeeklyReminder.count({ where: { businessId: businessA.id } })) === 2,
  );

  console.log("\nTEST — Opt-out stops further reminders");
  const optedOut = await setStudioWeeklyReviewReminderOptIn(prisma, ownerA, false, nextWeekInstant);
  check("Opt-out message is recorded", optedOut.message === STUDIO_WEEKLY_REMINDER_OPTED_OUT_MESSAGE);
  await prisma.marketingStudioWeeklyReminder.deleteMany({
    where: { businessId: businessA.id, weekKey: "2026-10-04" },
  });
  const afterOff = await dispatchStudioWeeklyReviewReminder(prisma, businessA.id, nextWeekInstant, {
    smsPlatformConfigured: false,
  });
  check(
    "Dispatch after opt-out does not recreate the week",
    afterOff.created === false && afterOff.reason === "not_opted_in",
  );
  check(
    "Earlier week row remains after opt-out",
    (await prisma.marketingStudioWeeklyReminder.count({
      where: { businessId: businessA.id, weekKey: "2026-09-27" },
    })) === 1,
  );

  console.log("\nTEST — Tenant isolation and nothing-awaiting");
  const skippedEmpty = await setStudioWeeklyReviewReminderOptIn(prisma, ownerB, true, weekInstant, {
    smsPlatformConfigured: false,
  });
  check(
    "Opted-in business with no awaiting packages creates no reminder",
    skippedEmpty.dispatch?.created === false && skippedEmpty.dispatch.reason === "nothing_awaiting",
  );
  const aAfterBOptIn = await prisma.businessSettings.findUnique({
    where: { businessId: businessA.id },
    select: { studioWeeklyReviewReminderOptedIn: true },
  });
  const bSettings = await prisma.businessSettings.findUnique({
    where: { businessId: businessB.id },
    select: { studioWeeklyReviewReminderOptedIn: true },
  });
  check("Owner B opt-in does not turn reminders on for A", aAfterBOptIn?.studioWeeklyReviewReminderOptedIn === false);
  check("Owner B opt-in writes only B's settings", bSettings?.studioWeeklyReviewReminderOptedIn === true);
  await seedReadyPackage(prisma, ownerB, "Beta secret package");
  const pacificSaturday = new Date("2026-09-27T06:30:00.000Z");
  const createdB = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, pacificSaturday, {
    smsPlatformConfigured: false,
  });
  check(
    "Business B records its own Pacific week key for the same UTC instant",
    createdB.created === true &&
      createdB.reminder?.weekKey === "2026-09-20" &&
      studioWeeklyReminderWeekKey(pacificSaturday, "America/New_York") === "2026-09-27",
  );
  const stateA = await loadStudioWeeklyReminderState(prisma, businessA.id, weekInstant, {
    smsPlatformConfigured: false,
  });
  const stateB = await loadStudioWeeklyReminderState(prisma, businessB.id, pacificSaturday, {
    smsPlatformConfigured: false,
  });
  check(
    "A's loader stays on A's reminder",
    stateA.reminder?.businessId === businessA.id &&
      stateA.reminder?.id === optedIn.dispatch.reminder.id &&
      stateA.reminder?.id !== createdB.reminder?.id,
  );
  check(
    "B's loader stays on B's reminder",
    stateB.reminder?.businessId === businessB.id && stateB.reminder?.id === createdB.reminder.id,
  );
  const leaked = await prisma.marketingStudioWeeklyReminder.findFirst({
    where: { businessId: businessA.id, id: createdB.reminder.id },
  });
  check("B's reminder id is not readable under A's businessId", leaked === null);
  check(
    "Customer records were never used as a reminder destination",
    !reminderOpsSrc.includes("customer.phone") &&
      !reminderOpsSrc.includes("customer.email") &&
      !reminderOpsSrc.includes("publicEmail") &&
      !reminderOpsSrc.includes("publicPhone") &&
      reminderOpsSrc.includes("studioWeeklyReminderOwnerSmsTo") &&
      reminderOpsSrc.includes("resolveOwnerStudioReminderSmsTo"),
  );

  console.log("\nTEST — SMS connected without destination stays in-app");
  await prisma.business.update({
    where: { id: businessB.id },
    data: { operationalSmsNumber: "1235550100" },
  });
  await writeOwnerSmsDestination(businessB.id, null, true);
  await prisma.marketingStudioWeeklyReminder.deleteMany({ where: { businessId: businessB.id } });
  const fakeUnused = createFakeCustomerMessagingProvider();
  const connected = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: fakeUnused,
  });
  check(
    "Connected SMS without an owner destination stays in-app and is not sent",
    connected.created === true &&
      connected.reminder?.channel === STUDIO_WEEKLY_REMINDER_CHANNEL &&
      connected.reminder?.smsStatus === STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_SENT &&
      connected.reminder?.smsLabel === STUDIO_WEEKLY_REMINDER_SMS_NO_DESTINATION &&
      connected.delivery.customerMessageSent === false &&
      fakeUnused.sent.length === 0,
  );

  console.log("\nTEST — Public company phone alone never receives SMS");
  const publicCompanyPhone = "2395550188";
  const ownerDest = "+19415550199";
  const tenantFrom = "1235550100";
  const tenantFromA = "1235550101";
  await prisma.business.update({
    where: { id: businessB.id },
    data: { operationalSmsNumber: tenantFrom, publicPhone: publicCompanyPhone },
  });
  await writeOwnerSmsDestination(businessB.id, null, false);
  await prisma.customer.updateMany({
    where: { businessId: businessB.id },
    data: { phone: "2395550111", smsConsentStatus: "GRANTED" },
  });
  await prisma.marketingStudioWeeklyReminder.deleteMany({ where: { businessId: businessB.id } });
  const publicOnly = createFakeCustomerMessagingProvider();
  const publicOnlyDispatch = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: publicOnly,
  });
  check(
    "A public company phone alone never receives SMS",
    publicOnlyDispatch.created === true &&
      publicOnlyDispatch.reminder?.channel === STUDIO_WEEKLY_REMINDER_CHANNEL &&
      publicOnlyDispatch.reminder?.smsStatus === STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_SENT &&
      publicOnlyDispatch.reminder?.smsLabel === STUDIO_WEEKLY_REMINDER_SMS_NOT_OPTED_IN &&
      publicOnly.sent.length === 0,
  );

  console.log("\nTEST — Optional OWNER SMS uses the fake provider only");
  await writeOwnerSmsDestination(businessB.id, ownerDest, true);
  await prisma.marketingStudioWeeklyReminder.deleteMany({ where: { businessId: businessB.id } });
  const fakeSms = createFakeCustomerMessagingProvider();
  setCustomerMessagingProvider(fakeSms);
  const ownerSms = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: fakeSms,
  });
  check(
    "Working provider and tenant number accept one OWNER SMS",
    ownerSms.created === true &&
      ownerSms.reminder?.channel === STUDIO_WEEKLY_REMINDER_CHANNEL &&
      ownerSms.reminder?.smsStatus === STUDIO_WEEKLY_REMINDER_SMS_STATUS_ACCEPTED &&
      ownerSms.reminder?.smsLabel === STUDIO_WEEKLY_REMINDER_SMS_ACCEPTED &&
      fakeSms.sent.length === 1 &&
      fakeSms.sent[0]?.from === tenantFrom &&
      fakeSms.sent[0]?.to === ownerDest &&
      fakeSms.sent[0]?.to !== publicCompanyPhone &&
      fakeSms.sent[0]?.purpose === "STUDIO_WEEKLY_REMINDER" &&
      fakeSms.sent[0]?.body.includes("OWNER review") &&
      Boolean(ownerSms.reminder?.smsSendClaimedAt) &&
      Boolean(ownerSms.reminder?.smsProviderMessageId) &&
      ownerSms.delivery.customerMessageSent === false,
  );
  check(
    "Owner SMS did not write a customer communication",
    (await prisma.customerCommunication.count({ where: { businessId: businessB.id } })) === 0,
  );
  check(
    "Owner SMS did not use a customer phone",
    fakeSms.sent[0]?.to !== "2395550111",
  );
  const ownerSmsAgain = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: fakeSms,
  });
  check(
    "Same business/week does not send a second OWNER SMS",
    ownerSmsAgain.created === false &&
      ownerSmsAgain.reason === "already_recorded" &&
      ownerSmsAgain.reminder?.id === ownerSms.reminder.id &&
      fakeSms.sent.length === 1,
  );
  check(
    "Accepted owner SMS does not approve or publish the package",
    (await prisma.marketingContent.findFirst({
      where: { businessId: businessB.id, status: "READY_FOR_REVIEW" },
    })) !== null &&
      (await prisma.marketingContent.count({
        where: { businessId: businessB.id, status: { in: ["APPROVED", "PUBLISHED"] } },
      })) === 0,
  );

  await prisma.marketingStudioWeeklyReminder.deleteMany({ where: { businessId: businessB.id } });
  const failSms = createFakeCustomerMessagingProvider();
  failSms.setFailNext(true);
  const failed = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: failSms,
  });
  check(
    "Provider rejection is recorded as failed and still leaves the in-app reminder",
    failed.created === true &&
      failed.reminder?.smsStatus === STUDIO_WEEKLY_REMINDER_SMS_STATUS_FAILED &&
      failed.reminder?.smsLabel === STUDIO_WEEKLY_REMINDER_SMS_FAILED &&
      !failed.reminder?.smsLabel.includes("Fake") &&
      failed.reminder?.channel === STUDIO_WEEKLY_REMINDER_CHANNEL &&
      failSms.sent.length === 0,
  );

  await prisma.marketingStudioWeeklyReminder.deleteMany({ where: { businessId: businessB.id } });
  const throwSms = createFakeCustomerMessagingProvider();
  throwSms.setThrowNext(true);
  const threw = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: throwSms,
  });
  check(
    "Provider throw is recorded as failed without claiming delivery",
    threw.created === true &&
      threw.reminder?.smsStatus === STUDIO_WEEKLY_REMINDER_SMS_STATUS_FAILED &&
      threw.reminder?.smsLabel.includes("failed") &&
      throwSms.sent.length === 0,
  );

  await writeOwnerSmsDestination(businessB.id, null, false);
  await prisma.business.update({
    where: { id: businessB.id },
    data: { publicPhone: publicCompanyPhone },
  });
  await prisma.marketingStudioWeeklyReminder.deleteMany({ where: { businessId: businessB.id } });
  const customerOnly = createFakeCustomerMessagingProvider();
  const skippedCustomer = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: customerOnly,
  });
  check(
    "A customer phone is not used when the owner destination is missing",
    skippedCustomer.created === true &&
      skippedCustomer.reminder?.smsStatus === STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_SENT &&
      skippedCustomer.reminder?.smsLabel === STUDIO_WEEKLY_REMINDER_SMS_NOT_OPTED_IN &&
      customerOnly.sent.length === 0,
  );

  await writeOwnerSmsDestination(businessB.id, ownerDest, true);
  await prisma.business.update({
    where: { id: businessB.id },
    data: { operationalSmsNumber: null, publicPhone: publicCompanyPhone },
  });
  await prisma.marketingStudioWeeklyReminder.deleteMany({ where: { businessId: businessB.id } });
  const noNumber = createFakeCustomerMessagingProvider();
  const missingNumber = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: noNumber,
  });
  check(
    "A working provider without a dedicated tenant number does not send",
    missingNumber.created === true &&
      missingNumber.reminder?.smsStatus === STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_CONNECTED &&
      missingNumber.reminder?.smsLabel === STUDIO_WEEKLY_REMINDER_SMS_NOT_CONNECTED &&
      noNumber.sent.length === 0,
  );

  await writeOwnerSmsDestination(businessB.id, ownerDest, true);
  await prisma.business.update({
    where: { id: businessB.id },
    data: { operationalSmsNumber: tenantFrom, publicPhone: publicCompanyPhone },
  });
  await prisma.marketingStudioWeeklyReminder.deleteMany({ where: { businessId: businessB.id } });
  await setStudioWeeklyReviewReminderOptIn(prisma, ownerB, false, weekInstant, {
    smsPlatformConfigured: true,
    messagingProvider: fakeSms,
  });
  const afterOwnerOff = createFakeCustomerMessagingProvider();
  const skippedOff = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: afterOwnerOff,
  });
  check(
    "Opt-out at dispatch skips owner SMS",
    skippedOff.created === false &&
      skippedOff.reason === "not_opted_in" &&
      afterOwnerOff.sent.length === 0,
  );
  await setStudioWeeklyReviewReminderOptIn(prisma, ownerB, true, weekInstant, {
    smsPlatformConfigured: false,
  });

  console.log("\nTEST — Opt-out at the send boundary prevents SMS");
  await writeOwnerSmsDestination(businessB.id, ownerDest, true);
  await prisma.business.update({
    where: { id: businessB.id },
    data: { operationalSmsNumber: tenantFrom },
  });
  await prisma.marketingStudioWeeklyReminder.deleteMany({ where: { businessId: businessB.id } });
  const optOutBeforeSend = createFakeCustomerMessagingProvider();
  const racedOptOut = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: optOutBeforeSend,
    beforeOwnerSmsSend: async () => {
      await setStudioWeeklyReviewReminderOptIn(prisma, ownerB, false, weekInstant, {
        smsPlatformConfigured: true,
        messagingProvider: optOutBeforeSend,
      });
    },
  });
  check(
    "Opt-out winning before send keeps the in-app reminder and sends no SMS",
    racedOptOut.created === true &&
      racedOptOut.reminder?.channel === STUDIO_WEEKLY_REMINDER_CHANNEL &&
      racedOptOut.reminder?.smsStatus === STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_SENT &&
      racedOptOut.reminder?.smsLabel === STUDIO_WEEKLY_REMINDER_SMS_OPTED_OUT &&
      optOutBeforeSend.sent.length === 0,
  );
  await setStudioWeeklyReviewReminderOptIn(prisma, ownerB, true, weekInstant, {
    smsPlatformConfigured: false,
  });

  console.log("\nTEST — Failed status write after provider acceptance is not a second send");
  await writeOwnerSmsDestination(businessB.id, ownerDest, true);
  await prisma.marketingStudioWeeklyReminder.deleteMany({ where: { businessId: businessB.id } });
  const claimSms = createFakeCustomerMessagingProvider();
  const acceptedThenFailedWrite = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: claimSms,
    afterProviderAccepted: async () => {
      throw new Error("status write failed after provider acceptance");
    },
  });
  const claimedRow = await prisma.marketingStudioWeeklyReminder.findFirst({
    where: { businessId: businessB.id, weekKey: acceptedThenFailedWrite.reminder?.weekKey },
  });
  check(
    "Provider acceptance with a failed status write still leaves one claimed in-app reminder",
    acceptedThenFailedWrite.created === true &&
      claimSms.sent.length === 1 &&
      claimedRow?.smsSendClaimedAt != null &&
      claimedRow.smsStatus !== STUDIO_WEEKLY_REMINDER_SMS_STATUS_ACCEPTED,
  );
  const retryAfterFailedWrite = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: claimSms,
  });
  check(
    "Retry after a failed status write does not send a second SMS",
    retryAfterFailedWrite.created === false &&
      retryAfterFailedWrite.reason === "already_recorded" &&
      retryAfterFailedWrite.reminder?.id === claimedRow.id &&
      retryAfterFailedWrite.reminder?.smsSendClaimedAt != null &&
      claimSms.sent.length === 1,
  );

  console.log("\nTEST — Destination change that commits first does not send the old number");
  const oldOwnerDest = ownerDest;
  const newOwnerDest = "+15551234002";
  await writeOwnerSmsDestination(businessB.id, oldOwnerDest, true);
  await prisma.business.update({
    where: { id: businessB.id },
    data: { operationalSmsNumber: tenantFrom },
  });
  await prisma.marketingStudioWeeklyReminder.deleteMany({ where: { businessId: businessB.id } });
  const destChangeSms = createFakeCustomerMessagingProvider();
  let releaseDestClaim;
  const destClaimGate = new Promise((resolve) => {
    releaseDestClaim = resolve;
  });
  let notifyDestClaimReached;
  const destClaimReached = new Promise((resolve) => {
    notifyDestClaimReached = resolve;
  });
  const destChangeFirst = dispatchStudioWeeklyReviewReminder(prisma, businessB.id, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: destChangeSms,
    async beforeOwnerSmsClaim() {
      notifyDestClaimReached();
      await destClaimGate;
    },
  });
  await destClaimReached;
  await setStudioWeeklyReminderOwnerSms(
    prisma,
    ownerB,
    { destination: newOwnerDest, optedIn: true },
    pacificMonday10,
  );
  releaseDestClaim();
  const destChangeResult = await destChangeFirst;
  const destChangeRow = await prisma.marketingStudioWeeklyReminder.findFirst({
    where: { businessId: businessB.id, weekKey: destChangeResult.reminder?.weekKey },
  });
  check(
    "A destination change that commits before revalidate+claim sends nothing to the old number",
    destChangeResult.created === true &&
      destChangeSms.sent.length === 0 &&
      destChangeSms.sent.every((row) => row.to !== oldOwnerDest) &&
      destChangeRow?.smsSendClaimedAt == null &&
      destChangeRow?.id === destChangeResult.reminder?.id,
  );

  console.log("\nTEST — Claim first then destination change keeps the once-per-week claim");
  await writeOwnerSmsDestination(businessB.id, oldOwnerDest, true);
  await prisma.marketingStudioWeeklyReminder.deleteMany({ where: { businessId: businessB.id } });
  const claimFirstSms = createFakeCustomerMessagingProvider();
  const claimedFirst = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: claimFirstSms,
  });
  await setStudioWeeklyReminderOwnerSms(
    prisma,
    ownerB,
    { destination: newOwnerDest, optedIn: true },
    pacificMonday10,
  );
  const afterClaimChange = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: claimFirstSms,
  });
  const claimedFirstRow = await prisma.marketingStudioWeeklyReminder.findFirst({
    where: { businessId: businessB.id, weekKey: claimedFirst.reminder?.weekKey },
  });
  check(
    "A later destination change does not unclaim or send a second SMS",
    claimedFirst.created === true &&
      claimedFirst.reminder?.smsSendClaimedAt != null &&
      claimFirstSms.sent.length === 1 &&
      claimFirstSms.sent[0]?.to === oldOwnerDest &&
      afterClaimChange.created === false &&
      afterClaimChange.reason === "already_recorded" &&
      afterClaimChange.reminder?.id === claimedFirst.reminder.id &&
      claimedFirstRow?.smsSendClaimedAt != null &&
      claimFirstSms.sent.length === 1,
  );
  await writeOwnerSmsDestination(businessB.id, oldOwnerDest, true);

  console.log("\nTEST — STOP that commits before claim sends nothing");
  await resetOwnerSmsSendWeek(businessB.id, ownerDest);
  await prisma.business.update({
    where: { id: businessB.id },
    data: { operationalSmsNumber: tenantFrom },
  });
  const stopBeforeSms = createFakeCustomerMessagingProvider();
  const stopBeforeClaimGate = createGate();
  const stopBeforeClaimReached = createNotifier();
  const stopBeforeClaimDispatch = dispatchStudioWeeklyReviewReminder(
    prisma,
    businessB.id,
    pacificMonday10,
    {
      smsPlatformConfigured: true,
      messagingProvider: stopBeforeSms,
      async beforeOwnerSmsClaim() {
        stopBeforeClaimReached.notify();
        await stopBeforeClaimGate.gate;
      },
    },
  );
  await stopBeforeClaimReached.reached;
  const stopBeforeClaimEvent = await applyInboundConsentEvent(prisma, {
    provider: "fake",
    providerEventId: `owner-stop-before-claim-${randomUUID()}`,
    from: ownerDest,
    to: tenantFrom,
    body: "STOP",
    optOutType: "STOP",
  });
  stopBeforeClaimGate.release();
  const stopBeforeClaimResult = await stopBeforeClaimDispatch;
  const stopBeforeClaimRow = await prisma.marketingStudioWeeklyReminder.findFirst({
    where: { businessId: businessB.id, weekKey: stopBeforeClaimResult.reminder?.weekKey },
  });
  check(
    "A STOP that commits before revalidate+claim neither claims nor sends",
    stopBeforeClaimEvent.applied === true &&
      stopBeforeClaimEvent.reason === "owner_stopped" &&
      stopBeforeClaimResult.created === true &&
      stopBeforeClaimRow?.smsSendClaimedAt == null &&
      stopBeforeSms.sent.length === 0,
  );

  console.log("\nTEST — Provider-block that commits before claim sends nothing");
  await resetOwnerSmsSendWeek(businessB.id, ownerDest);
  const blockBeforeSms = createFakeCustomerMessagingProvider();
  const blockBeforeClaimGate = createGate();
  const blockBeforeClaimReached = createNotifier();
  const blockBeforeClaimDispatch = dispatchStudioWeeklyReviewReminder(
    prisma,
    businessB.id,
    pacificMonday10,
    {
      smsPlatformConfigured: true,
      messagingProvider: blockBeforeSms,
      async beforeOwnerSmsClaim() {
        blockBeforeClaimReached.notify();
        await blockBeforeClaimGate.gate;
      },
    },
  );
  await blockBeforeClaimReached.reached;
  await recordOwnerStudioReminderBlocked(prisma, businessB.id);
  blockBeforeClaimGate.release();
  const blockBeforeClaimResult = await blockBeforeClaimDispatch;
  const blockBeforeClaimRow = await prisma.marketingStudioWeeklyReminder.findFirst({
    where: { businessId: businessB.id, weekKey: blockBeforeClaimResult.reminder?.weekKey },
  });
  const blockBeforeSettings = await prisma.businessSettings.findUnique({
    where: { businessId: businessB.id },
    select: { studioWeeklyReminderOwnerSmsBlockedAt: true },
  });
  check(
    "A provider-block write that commits before revalidate+claim neither claims nor sends",
    blockBeforeSettings?.studioWeeklyReminderOwnerSmsBlockedAt != null &&
      blockBeforeClaimResult.created === true &&
      blockBeforeClaimRow?.smsSendClaimedAt == null &&
      blockBeforeSms.sent.length === 0,
  );

  console.log("\nTEST — Claim first then STOP keeps the once-per-week send");
  await resetOwnerSmsSendWeek(businessB.id, ownerDest);
  const claimThenStopSms = createFakeCustomerMessagingProvider();
  const claimedThenStop = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: claimThenStopSms,
  });
  const stopAfterClaim = await applyInboundConsentEvent(prisma, {
    provider: "fake",
    providerEventId: `owner-stop-after-claim-${randomUUID()}`,
    from: ownerDest,
    to: tenantFrom,
    body: "STOP",
    optOutType: "STOP",
  });
  const rerunAfterStop = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: claimThenStopSms,
  });
  check(
    "STOP after a committed claim cannot send a second SMS",
    claimedThenStop.created === true &&
      claimedThenStop.reminder?.smsSendClaimedAt != null &&
      claimThenStopSms.sent.length === 1 &&
      stopAfterClaim.reason === "owner_stopped" &&
      rerunAfterStop.created === false &&
      rerunAfterStop.reason === "already_recorded" &&
      rerunAfterStop.reminder?.id === claimedThenStop.reminder.id &&
      claimThenStopSms.sent.length === 1,
  );

  console.log("\nTEST — Claim first then provider-block keeps the once-per-week send");
  await resetOwnerSmsSendWeek(businessB.id, ownerDest);
  const claimThenBlockSms = createFakeCustomerMessagingProvider();
  const claimedThenBlock = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: claimThenBlockSms,
  });
  await recordOwnerStudioReminderBlocked(prisma, businessB.id);
  const rerunAfterBlock = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: claimThenBlockSms,
  });
  check(
    "A provider-block write after a committed claim cannot send a second SMS",
    claimedThenBlock.created === true &&
      claimedThenBlock.reminder?.smsSendClaimedAt != null &&
      claimThenBlockSms.sent.length === 1 &&
      rerunAfterBlock.created === false &&
      rerunAfterBlock.reason === "already_recorded" &&
      rerunAfterBlock.reminder?.id === claimedThenBlock.reminder.id &&
      claimThenBlockSms.sent.length === 1,
  );

  console.log("\nTEST — STOP waits on the reminder lock while a claim transaction holds it");
  await resetOwnerSmsSendWeek(businessB.id, ownerDest);
  const stopWaitSms = createFakeCustomerMessagingProvider();
  const stopWaitClaimGate = createGate();
  const stopWaitClaimHeld = createNotifier();
  const stopWaitStarted = createNotifier();
  let stopWaitAcquiredLock = false;
  const lockClientStop = new PrismaClient({ datasourceUrl: testUrl });
  const stopWaitDispatch = dispatchStudioWeeklyReviewReminder(prisma, businessB.id, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: stopWaitSms,
    async afterOwnerSmsClaimLockAcquired() {
      stopWaitClaimHeld.notify();
      await stopWaitClaimGate.gate;
    },
  });
  await stopWaitClaimHeld.reached;
  const stopWaitWrite = recordOwnerStudioReminderStop(lockClientStop, businessB.id, "9415550199", {
    async beforeSerialize() {
      stopWaitStarted.notify();
    },
    async afterReminderLockAcquired() {
      stopWaitAcquiredLock = true;
    },
  });
  await stopWaitStarted.reached;
  check(
    "STOP has not entered the reminder lock while the claim transaction holds it",
    stopWaitAcquiredLock === false,
  );
  await waitUntilUngrantedAdvisoryLock(prisma);
  check(
    "STOP is waiting on the advisory lock held by the claim transaction",
    stopWaitAcquiredLock === false,
  );
  stopWaitClaimGate.release();
  const [stopWaitResult, stopWaitConsent] = await Promise.all([stopWaitDispatch, stopWaitWrite]);
  await lockClientStop.$disconnect();
  const rerunAfterStopWait = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: stopWaitSms,
  });
  check(
    "Claim that holds the lock first still sends at most once after a waiting STOP",
    stopWaitAcquiredLock === true &&
      stopWaitConsent.reason === "owner_stopped" &&
      stopWaitResult.reminder?.smsSendClaimedAt != null &&
      stopWaitSms.sent.length === 1 &&
      rerunAfterStopWait.created === false &&
      stopWaitSms.sent.length === 1,
  );

  console.log("\nTEST — Provider-block waits on the reminder lock while a claim transaction holds it");
  await resetOwnerSmsSendWeek(businessB.id, ownerDest);
  const blockWaitSms = createFakeCustomerMessagingProvider();
  const blockWaitClaimGate = createGate();
  const blockWaitClaimHeld = createNotifier();
  const blockWaitStarted = createNotifier();
  let blockWaitAcquiredLock = false;
  const lockClientBlock = new PrismaClient({ datasourceUrl: testUrl });
  const blockWaitDispatch = dispatchStudioWeeklyReviewReminder(prisma, businessB.id, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: blockWaitSms,
    async afterOwnerSmsClaimLockAcquired() {
      blockWaitClaimHeld.notify();
      await blockWaitClaimGate.gate;
    },
  });
  await blockWaitClaimHeld.reached;
  const blockWaitWrite = recordOwnerStudioReminderBlocked(lockClientBlock, businessB.id, {
    async beforeSerialize() {
      blockWaitStarted.notify();
    },
    async afterReminderLockAcquired() {
      blockWaitAcquiredLock = true;
    },
  });
  await blockWaitStarted.reached;
  check(
    "Provider-block has not entered the reminder lock while the claim transaction holds it",
    blockWaitAcquiredLock === false,
  );
  await waitUntilUngrantedAdvisoryLock(prisma);
  check(
    "Provider-block is waiting on the advisory lock held by the claim transaction",
    blockWaitAcquiredLock === false,
  );
  blockWaitClaimGate.release();
  const [blockWaitResult] = await Promise.all([blockWaitDispatch, blockWaitWrite]);
  await lockClientBlock.$disconnect();
  const rerunAfterBlockWait = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: blockWaitSms,
  });
  const blockWaitSettings = await prisma.businessSettings.findUnique({
    where: { businessId: businessB.id },
    select: { studioWeeklyReminderOwnerSmsBlockedAt: true },
  });
  check(
    "Claim that holds the lock first still sends at most once after a waiting provider-block",
    blockWaitAcquiredLock === true &&
      blockWaitSettings?.studioWeeklyReminderOwnerSmsBlockedAt != null &&
      blockWaitResult.reminder?.smsSendClaimedAt != null &&
      blockWaitSms.sent.length === 1 &&
      rerunAfterBlockWait.created === false &&
      blockWaitSms.sent.length === 1,
  );

  await clearOwnerSmsStopAndBlock(businessB.id);
  await writeOwnerSmsDestination(businessB.id, oldOwnerDest, true);

  const adminDeniedSms = await setStudioWeeklyReminderOwnerSms(
    prisma,
    adminA,
    { destination: ownerDest, optedIn: true },
    weekInstant,
  ).catch((error) => error);
  check(
    "ADMIN cannot set the OWNER SMS destination",
    adminDeniedSms instanceof MarketingError &&
      adminDeniedSms.message === STUDIO_WEEKLY_REMINDER_OWNER_ONLY_MESSAGE,
  );
  await expectError(
    "OWNER cannot save a non-E.164 destination",
    () =>
      setStudioWeeklyReminderOwnerSms(
        prisma,
        ownerB,
        { destination: "9415550199", optedIn: true },
        pacificMonday10,
      ),
    (error) =>
      error instanceof MarketingError && error.message === STUDIO_WEEKLY_REMINDER_OWNER_SMS_INVALID_MESSAGE,
  );

  resetCustomerMessagingProvider();

  console.log("\nTEST — Opt-out that commits first cannot create a later reminder");
  await prisma.marketingStudioWeeklyReminder.deleteMany({
    where: { businessId: businessA.id, weekKey: "2026-10-04" },
  });
  await setStudioWeeklyReviewReminderOptIn(prisma, ownerA, true, nextWeekInstant, {
    smsPlatformConfigured: false,
  });
  await prisma.marketingStudioWeeklyReminder.deleteMany({
    where: { businessId: businessA.id, weekKey: "2026-10-04" },
  });
  let releaseSerialize;
  const serializeGate = new Promise((resolve) => {
    releaseSerialize = resolve;
  });
  let notifySerializeReached;
  const serializeReached = new Promise((resolve) => {
    notifySerializeReached = resolve;
  });
  const delayedDispatch = dispatchStudioWeeklyReviewReminder(prisma, businessA.id, nextWeekInstant, {
    smsPlatformConfigured: false,
    async beforeSerialize() {
      notifySerializeReached();
      await serializeGate;
    },
  });
  await serializeReached;
  await setStudioWeeklyReviewReminderOptIn(prisma, ownerA, false, nextWeekInstant, {
    smsPlatformConfigured: false,
  });
  releaseSerialize();
  const raced = await delayedDispatch;
  check(
    "Dispatch after a committed opt-out does not create a reminder",
    raced.created === false && raced.reason === "not_opted_in",
  );
  check(
    "No new row exists for the raced week",
    (await prisma.marketingStudioWeeklyReminder.count({
      where: { businessId: businessA.id, weekKey: "2026-10-04" },
    })) === 0,
  );

  console.log("\nTEST — Concurrent same-week dispatch creates one row");
  await setStudioWeeklyReviewReminderOptIn(prisma, ownerA, true, nextWeekInstant, {
    smsPlatformConfigured: false,
  });
  await prisma.marketingStudioWeeklyReminder.deleteMany({
    where: { businessId: businessA.id, weekKey: "2026-10-04" },
  });
  const [raceOne, raceTwo] = await Promise.all([
    dispatchStudioWeeklyReviewReminder(prisma, businessA.id, nextWeekInstant, {
      smsPlatformConfigured: false,
    }),
    dispatchStudioWeeklyReviewReminder(prisma, businessA.id, nextWeekInstant, {
      smsPlatformConfigured: false,
    }),
  ]);
  const createdCount = [raceOne, raceTwo].filter((row) => row.created).length;
  const sameWeekRows = await prisma.marketingStudioWeeklyReminder.findMany({
    where: { businessId: businessA.id, weekKey: "2026-10-04" },
  });
  check(
    "Exactly one concurrent create wins the week",
    createdCount === 1 &&
      sameWeekRows.length === 1 &&
      [raceOne.reason, raceTwo.reason].includes("created") &&
      [raceOne.reason, raceTwo.reason].includes("already_recorded") &&
      raceOne.reminder?.id === raceTwo.reminder?.id,
  );

  console.log("\nTEST — Authorization: cron secret and no page trigger");
  const previousCronSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "studio-weekly-cron-secret";
  check(
    "Cron accepts the Bearer secret",
    authorizeStudioWeeklyReminderCron(
      new Headers({ authorization: "Bearer studio-weekly-cron-secret" }),
    ) === true,
  );
  check(
    "Cron rejects a wrong secret",
    authorizeStudioWeeklyReminderCron(new Headers({ authorization: "Bearer other" })) === false,
  );
  process.env.CRON_SECRET = "";
  check(
    "Cron fails closed without CRON_SECRET",
    authorizeStudioWeeklyReminderCron(
      new Headers({ authorization: "Bearer studio-weekly-cron-secret" }),
    ) === false,
  );
  process.env.CRON_SECRET = "";
  check(
    "Cron classifies a missing secret without echoing a bearer",
    JSON.stringify(
      classifyStudioWeeklyReminderCronAuth(
        new Headers({ authorization: "Bearer studio-weekly-cron-secret" }),
      ),
    ) === JSON.stringify({ ok: false, reason: "secret_missing" }),
  );
  process.env.CRON_SECRET = "studio-weekly-cron-secret";
  check(
    "Cron classifies a wrong secret as unauthorized",
    JSON.stringify(
      classifyStudioWeeklyReminderCronAuth(new Headers({ authorization: "Bearer other" })),
    ) === JSON.stringify({ ok: false, reason: "unauthorized" }),
  );
  console.log("\nTEST — Cron GET: secret, denial body, and runner_failed log");
  setStudioWeeklyReminderCronRunnerForTests(async () => []);
  process.env.CRON_SECRET = "";
  const missingSecret = await captureConsole("info", () =>
    getStudioWeeklyReminderCron(cronRequest()),
  );
  const missingSecretRes = await readJsonResponse(missingSecret.value);
  check(
    "Cron GET missing secret returns 401 {ok:false} and logs secret_missing",
    missingSecretRes.status === 401 &&
      JSON.stringify(missingSecretRes.body) === JSON.stringify({ ok: false }) &&
      !missingSecretRes.text.includes("secret_missing") &&
      !missingSecretRes.text.includes("unauthorized") &&
      missingSecret.text.includes("[cron] studio-weekly-reminder") &&
      missingSecret.text.includes("secret_missing") &&
      !missingSecret.text.includes("studio-weekly-cron-secret"),
  );

  process.env.CRON_SECRET = "studio-weekly-cron-secret";
  const wrongSecret = await captureConsole("info", () =>
    getStudioWeeklyReminderCron(cronRequest({ authorization: "Bearer other-secret-value" })),
  );
  const wrongSecretRes = await readJsonResponse(wrongSecret.value);
  check(
    "Cron GET wrong secret returns 401 {ok:false} and logs unauthorized",
    wrongSecretRes.status === 401 &&
      JSON.stringify(wrongSecretRes.body) === JSON.stringify({ ok: false }) &&
      !wrongSecretRes.text.includes("unauthorized") &&
      wrongSecret.text.includes("unauthorized") &&
      !wrongSecret.text.includes("studio-weekly-cron-secret") &&
      !wrongSecret.text.includes("other-secret-value"),
  );

  const malformedAuth = await captureConsole("info", () =>
    getStudioWeeklyReminderCron(
      cronRequest({ authorization: "NotBearer studio-weekly-cron-secret" }),
    ),
  );
  const malformedAuthRes = await readJsonResponse(malformedAuth.value);
  check(
    "Cron GET malformed Authorization returns 401 {ok:false}",
    malformedAuthRes.status === 401 &&
      JSON.stringify(malformedAuthRes.body) === JSON.stringify({ ok: false }) &&
      malformedAuth.text.includes("unauthorized") &&
      !malformedAuthRes.text.includes("unauthorized") &&
      !malformedAuth.text.includes("studio-weekly-cron-secret"),
  );

  const bearerOk = await captureConsole("info", () =>
    getStudioWeeklyReminderCron(
      cronRequest({ authorization: "Bearer studio-weekly-cron-secret" }),
    ),
  );
  const bearerOkRes = await readJsonResponse(bearerOk.value);
  check(
    "Cron GET accepts Authorization Bearer",
    bearerOkRes.status === 200 &&
      bearerOkRes.body?.ok === true &&
      bearerOkRes.body?.considered === 0 &&
      bearerOkRes.body?.claimed === 0 &&
      bearerOk.text.includes('"ok":true'),
  );

  const headerOk = await captureConsole("info", () =>
    getStudioWeeklyReminderCron(cronRequest({ "x-cron-secret": "studio-weekly-cron-secret" })),
  );
  const headerOkRes = await readJsonResponse(headerOk.value);
  check(
    "Cron GET accepts x-cron-secret",
    headerOkRes.status === 200 && headerOkRes.body?.ok === true && headerOkRes.body?.considered === 0,
  );

  setStudioWeeklyReminderCronRunnerForTests(async () => {
    throw new Error("forced runner failure studio-weekly-cron-secret +15555550199");
  });
  const runnerFailed = await captureConsole("info", () =>
    getStudioWeeklyReminderCron(
      cronRequest({ authorization: "Bearer studio-weekly-cron-secret" }),
    ),
  );
  const runnerFailedRes = await readJsonResponse(runnerFailed.value);
  check(
    "Cron GET runner_failed returns 500 {ok:false} with counts-only log",
    runnerFailedRes.status === 500 &&
      JSON.stringify(runnerFailedRes.body) === JSON.stringify({ ok: false }) &&
      !runnerFailedRes.text.includes("runner_failed") &&
      runnerFailed.text.includes("runner_failed") &&
      runnerFailed.text.includes('"errorName":"Error"') &&
      !runnerFailed.text.includes("forced runner failure") &&
      !runnerFailed.text.includes("studio-weekly-cron-secret") &&
      !runnerFailed.text.includes("+15555550199") &&
      !runnerFailed.text.includes("15555550199"),
  );
  setStudioWeeklyReminderCronRunnerForTests();
  process.env.CRON_SECRET = previousCronSecret;

  console.log("\nTEST — OWNER retry is scoped to the caller business");
  const ownerDestA = "+19415550191";
  const ownerDestB = "+19415550192";
  const saturdayInstant = new Date("2026-10-03T15:00:00.000Z");
  await prisma.business.update({
    where: { id: businessA.id },
    data: { operationalSmsNumber: tenantFromA },
  });
  await prisma.business.update({
    where: { id: businessB.id },
    data: { operationalSmsNumber: tenantFrom },
  });
  await resetOwnerSmsSendWeek(businessA.id, ownerDestA);
  await resetOwnerSmsSendWeek(businessB.id, ownerDestB);
  await seedReadyPackage(prisma, ownerA, "Alpha retry isolation package");
  await seedReadyPackage(prisma, ownerB, "Beta retry isolation package");
  await setStudioWeeklyReviewReminderOptIn(prisma, ownerA, true, weekInstant, {
    smsPlatformConfigured: false,
  });
  await setStudioWeeklyReviewReminderOptIn(prisma, ownerB, true, pacificMonday10, {
    smsPlatformConfigured: false,
  });
  await prisma.marketingStudioWeeklyReminder.deleteMany({
    where: { businessId: { in: [businessA.id, businessB.id] }, weekKey: "2026-09-27" },
  });

  const scopedRetryProvider = createFakeCustomerMessagingProvider();
  function isRetryRoleRejection(error) {
    return (
      error instanceof ForbiddenError ||
      (error instanceof MarketingError &&
        error.message === STUDIO_WEEKLY_REMINDER_CRON_RETRY_OWNER_ONLY_MESSAGE)
    );
  }
  let adminRetryRejected = false;
  try {
    await retryStudioWeeklyReminderSchedule(prisma, adminA, weekInstant, {
      smsPlatformConfigured: true,
      messagingProvider: scopedRetryProvider,
    });
  } catch (error) {
    adminRetryRejected = isRetryRoleRejection(error);
  }
  let memberRetryRejected = false;
  try {
    await retryStudioWeeklyReminderSchedule(prisma, memberA, weekInstant, {
      smsPlatformConfigured: true,
      messagingProvider: scopedRetryProvider,
    });
  } catch (error) {
    memberRetryRejected = isRetryRoleRejection(error);
  }
  check(
    "Non-OWNER roles are rejected from scheduled reminder retry",
    adminRetryRejected && memberRetryRejected && scopedRetryProvider.sent.length === 0,
  );

  const ownerMondayRetry = await retryStudioWeeklyReminderSchedule(prisma, ownerA, weekInstant, {
    smsPlatformConfigured: true,
    messagingProvider: scopedRetryProvider,
  });
  const reminderAfterA = await prisma.marketingStudioWeeklyReminder.findMany({
    where: { businessId: businessA.id, weekKey: "2026-09-27" },
  });
  const reminderAfterB = await prisma.marketingStudioWeeklyReminder.findMany({
    where: { businessId: businessB.id, weekKey: "2026-09-27" },
  });
  const retryJson = JSON.stringify(ownerMondayRetry);
  check(
    "Tenant A OWNER Monday retry does not dispatch or expose tenant B",
    ownerMondayRetry.created === true &&
      ownerMondayRetry.claimed === 1 &&
      ownerMondayRetry.skipped == null &&
      ownerMondayRetry.message === STUDIO_WEEKLY_REMINDER_CRON_RETRIED_MESSAGE &&
      !("considered" in ownerMondayRetry) &&
      reminderAfterA.length === 1 &&
      reminderAfterA[0]?.smsSendClaimedAt != null &&
      reminderAfterB.length === 0 &&
      scopedRetryProvider.sent.length === 1 &&
      scopedRetryProvider.sent[0]?.to === ownerDestA &&
      scopedRetryProvider.sent.every((row) => row.to !== ownerDestB) &&
      !retryJson.includes(businessA.id) &&
      !retryJson.includes(businessB.id) &&
      !retryJson.includes(ownerDestA) &&
      !retryJson.includes(ownerDestB) &&
      !retryJson.includes("considered") &&
      scopedRetryProvider.sent.every((row) => !isCustomerMessagePurpose(row.purpose)),
  );

  const ownerMondayRetryAgain = await retryStudioWeeklyReminderSchedule(prisma, ownerA, weekInstant, {
    smsPlatformConfigured: true,
    messagingProvider: scopedRetryProvider,
  });
  check(
    "Second Monday retry for the same business claims 0",
    ownerMondayRetryAgain.created === false &&
      ownerMondayRetryAgain.claimed === 0 &&
      ownerMondayRetryAgain.skipped == null &&
      scopedRetryProvider.sent.length === 1 &&
      (await prisma.marketingStudioWeeklyReminder.count({
        where: { businessId: businessA.id, weekKey: "2026-09-27" },
      })) === 1 &&
      (await prisma.marketingStudioWeeklyReminder.count({
        where: { businessId: businessB.id, weekKey: "2026-09-27" },
      })) === 0,
  );

  const [doubleOne, doubleTwo] = await Promise.all([
    retryStudioWeeklyReminderSchedule(prisma, ownerA, weekInstant, {
      smsPlatformConfigured: true,
      messagingProvider: scopedRetryProvider,
    }),
    retryStudioWeeklyReminderSchedule(prisma, ownerA, weekInstant, {
      smsPlatformConfigured: true,
      messagingProvider: scopedRetryProvider,
    }),
  ]);
  check(
    "Double-invoke Monday retry claims 0 after the week is taken",
    doubleOne.claimed === 0 &&
      doubleTwo.claimed === 0 &&
      scopedRetryProvider.sent.length === 1,
  );

  const ownerSaturdayRetry = await retryStudioWeeklyReminderSchedule(prisma, ownerA, saturdayInstant, {
    smsPlatformConfigured: true,
    messagingProvider: scopedRetryProvider,
  });
  check(
    "Non-Monday OWNER retry returns without a claim",
    ownerSaturdayRetry.created === false &&
      ownerSaturdayRetry.claimed === 0 &&
      ownerSaturdayRetry.skipped === "outside_send_window" &&
      ownerSaturdayRetry.reason === "outside_send_window" &&
      ownerSaturdayRetry.message === STUDIO_WEEKLY_REMINDER_CRON_RETRIED_MESSAGE &&
      !("considered" in ownerSaturdayRetry) &&
      scopedRetryProvider.sent.length === 1 &&
      !JSON.stringify(ownerSaturdayRetry).includes(businessA.id) &&
      !JSON.stringify(ownerSaturdayRetry).includes(businessB.id),
  );
  const optInDoesNotSend = createFakeCustomerMessagingProvider();
  await writeOwnerSmsDestination(businessA.id, ownerDest, true);
  await prisma.business.update({
    where: { id: businessA.id },
    data: { operationalSmsNumber: tenantFromA },
  });
  await prisma.marketingStudioWeeklyReminder.deleteMany({
    where: { businessId: businessA.id, weekKey: "2026-09-27" },
  });
  const pageLikeOptIn = await setStudioWeeklyReviewReminderOptIn(prisma, ownerA, true, weekInstant, {
    smsPlatformConfigured: true,
    messagingProvider: optInDoesNotSend,
  });
  const pageLikeCreate = await createStudioWeeklyReviewReminder(prisma, businessA.id, weekInstant, {
    smsPlatformConfigured: true,
    messagingProvider: optInDoesNotSend,
  });
  check(
    "Opt-in and create-only paths never call the SMS provider",
    optInDoesNotSend.sent.length === 0 &&
      pageLikeOptIn.dispatch?.reminder?.smsSendClaimedAt == null &&
      pageLikeCreate.reminder?.smsSendClaimedAt == null,
  );

  console.log("\nTEST — Scheduled dispatch sends without opening Marketing");
  await prisma.business.update({
    where: { id: businessB.id },
    data: { operationalSmsNumber: tenantFrom, publicPhone: publicCompanyPhone },
  });
  await writeOwnerSmsDestination(businessB.id, ownerDest, true);
  await setStudioWeeklyReviewReminderOptIn(prisma, ownerB, true, pacificMonday10, {
    smsPlatformConfigured: false,
  });
  await prisma.marketingStudioWeeklyReminder.deleteMany({
    where: { businessId: businessB.id, weekKey: "2026-09-27" },
  });
  const scheduledSms = createFakeCustomerMessagingProvider();
  const pageLoadBeforeSchedule = await loadMarketingSource(
    prisma,
    businessB.id,
    pacificMonday10,
    "ADMIN",
  );
  check(
    "Loading Marketing does not send owner SMS",
    scheduledSms.sent.length === 0 && pageLoadBeforeSchedule.weeklyReminder.reminder === null,
  );
  const scheduled = await runScheduledStudioWeeklyReminders(prisma, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: scheduledSms,
  });
  const scheduledB = scheduled.find((row) => row.businessId === businessB.id);
  check(
    "Daily schedule sends OWNER SMS without a Marketing page view",
    scheduledB?.created === true &&
      scheduledB.skipped == null &&
      scheduledB.reminder?.smsStatus === STUDIO_WEEKLY_REMINDER_SMS_STATUS_ACCEPTED &&
      scheduledSms.sent.some((row) => row.to === ownerDest) &&
      scheduledSms.sent.every((row) => row.to !== publicCompanyPhone),
  );

  console.log("\nTEST — Cron claimed counts only this run");
  await resetOwnerSmsSendWeek(businessB.id, ownerDest);
  await prisma.business.update({
    where: { id: businessB.id },
    data: { operationalSmsNumber: tenantFrom },
  });
  await setStudioWeeklyReviewReminderOptIn(prisma, ownerB, true, pacificMonday10, {
    smsPlatformConfigured: false,
  });
  await prisma.marketingStudioWeeklyReminder.deleteMany({
    where: { businessId: { in: [businessA.id, businessB.id] }, weekKey: "2026-09-27" },
  });
  const thisRunSms = createFakeCustomerMessagingProvider();
  const cronFirst = await runScheduledStudioWeeklyReminders(prisma, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: thisRunSms,
  });
  const cronFirstB = cronFirst.filter((row) => row.businessId === businessB.id);
  const cronFirstSummary = summarizeStudioWeeklyReminderCronRun(cronFirstB);
  check(
    "First Monday cron claims once and calls the fake provider once",
    cronFirstB.length === 1 &&
      cronFirstB[0]?.smsClaimedThisRun === true &&
      cronFirstSummary.claimed === 1 &&
      thisRunSms.sent.filter((row) => row.to === ownerDest).length === 1,
  );
  const cronSecond = await runScheduledStudioWeeklyReminders(prisma, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: thisRunSms,
  });
  const cronSecondB = cronSecond.filter((row) => row.businessId === businessB.id);
  const cronSecondSummary = summarizeStudioWeeklyReminderCronRun(cronSecondB);
  check(
    "Second Monday cron reports claimed 0 and does not send again",
    cronSecondB.length === 1 &&
      cronSecondB[0]?.smsClaimedThisRun !== true &&
      cronSecondB[0]?.reminder?.smsSendClaimedAt != null &&
      cronSecondSummary.claimed === 0 &&
      thisRunSms.sent.filter((row) => row.to === ownerDest).length === 1,
  );

  await resetOwnerSmsSendWeek(businessB.id, ownerDest);
  await setStudioWeeklyReviewReminderOptIn(prisma, ownerB, true, pacificMonday10, {
    smsPlatformConfigured: false,
  });
  await prisma.marketingStudioWeeklyReminder.deleteMany({
    where: { businessId: { in: [businessA.id, businessB.id] }, weekKey: "2026-09-27" },
  });
  const retryThenCronSms = createFakeCustomerMessagingProvider();
  const ownerRetryFirst = await retryStudioWeeklyReminderSchedule(prisma, ownerB, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: retryThenCronSms,
  });
  const cronAfterRetry = await runScheduledStudioWeeklyReminders(prisma, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: retryThenCronSms,
  });
  const cronAfterRetryB = cronAfterRetry.filter((row) => row.businessId === businessB.id);
  check(
    "Cron after OWNER Monday retry reports claimed 0",
    ownerRetryFirst.claimed === 1 &&
      retryThenCronSms.sent.filter((row) => row.to === ownerDest).length === 1 &&
      cronAfterRetryB[0]?.smsClaimedThisRun !== true &&
      summarizeStudioWeeklyReminderCronRun(cronAfterRetryB).claimed === 0,
  );

  console.log("\nTEST — Scheduling / timezone send window");
  await writeOwnerSmsDestination(businessA.id, "+15551234001", true);
  await prisma.marketingStudioWeeklyReminder.deleteMany({
    where: { businessId: { in: [businessA.id, businessB.id] }, weekKey: "2026-09-27" },
  });
  const tzSms = createFakeCustomerMessagingProvider();
  const sameUtcWindow = await runScheduledStudioWeeklyReminders(prisma, mondayEtSundayPt, {
    smsPlatformConfigured: true,
    messagingProvider: tzSms,
  });
  const windowA = sameUtcWindow.find((row) => row.businessId === businessA.id);
  const windowB = sameUtcWindow.find((row) => row.businessId === businessB.id);
  check(
    "Monday 02:00 Eastern is a local Monday send day",
    windowA?.skipped == null && windowA?.reminder?.smsStatus === STUDIO_WEEKLY_REMINDER_SMS_STATUS_ACCEPTED,
  );
  check(
    "The same UTC instant is Sunday evening Pacific and is skipped",
    windowB?.skipped === "outside_send_window" &&
      tzSms.sent.length === 1 &&
      tzSms.sent[0]?.to === "+15551234001",
  );
  const laterPacific = await runScheduledStudioWeeklyReminders(prisma, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: tzSms,
  });
  const laterB = laterPacific.find((row) => row.businessId === businessB.id);
  check(
    "Pacific Monday later sends B once the local Monday begins",
    laterB?.skipped == null &&
      laterB?.reminder?.smsStatus === STUDIO_WEEKLY_REMINDER_SMS_STATUS_ACCEPTED &&
      tzSms.sent.length === 2 &&
      tzSms.sent[1]?.to === ownerDest,
  );

  console.log("\nTEST — Tenant isolation of scheduled send and owner STOP");
  const isolatedA = tzSms.sent.filter((row) => row.to === "+15551234001");
  const isolatedB = tzSms.sent.filter((row) => row.to === ownerDest);
  check("A's scheduled SMS never used B's destination", isolatedA.length === 1 && isolatedB.length === 1);
  const customerOnOwnerPhone = await prisma.customer.create({
    data: {
      businessId: businessB.id,
      name: "Same digits customer",
      phone: "9415550199",
      smsConsentStatus: "GRANTED",
    },
  });
  const ownerStop = await applyInboundConsentEvent(prisma, {
    provider: "fake",
    providerEventId: `owner-stop-${randomUUID()}`,
    from: ownerDest,
    to: tenantFrom,
    body: "STOP",
    optOutType: "STOP",
  });
  const afterOwnerStop = await prisma.businessSettings.findUnique({
    where: { businessId: businessB.id },
    select: {
      studioWeeklyReminderOwnerSmsOptedIn: true,
      studioWeeklyReminderOwnerSmsStopAt: true,
    },
  });
  const afterOwnerStopA = await prisma.businessSettings.findUnique({
    where: { businessId: businessA.id },
    select: { studioWeeklyReminderOwnerSmsStopAt: true },
  });
  const customerAfterOwnerStop = await prisma.customer.findFirst({
    where: { id: customerOnOwnerPhone.id, businessId: businessB.id },
    select: { smsConsentStatus: true },
  });
  check(
    "Owner STOP records on the owner setting and leaves customer consent alone",
    ownerStop.applied === true &&
      ownerStop.reason === "owner_stopped" &&
      afterOwnerStop?.studioWeeklyReminderOwnerSmsOptedIn === false &&
      afterOwnerStop?.studioWeeklyReminderOwnerSmsStopAt != null &&
      afterOwnerStopA?.studioWeeklyReminderOwnerSmsStopAt == null &&
      customerAfterOwnerStop?.smsConsentStatus === "GRANTED",
  );
  await writeOwnerSmsDestination(businessB.id, ownerDest, true);
  await prisma.marketingStudioWeeklyReminder.deleteMany({
    where: { businessId: businessB.id, weekKey: "2026-09-27" },
  });
  const afterStopSms = createFakeCustomerMessagingProvider();
  const stoppedDispatch = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: afterStopSms,
  });
  check(
    "A recorded owner STOP prevents the weekly SMS",
    stoppedDispatch.created === true &&
      stoppedDispatch.reminder?.smsStatus === STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_SENT &&
      stoppedDispatch.reminder?.smsLabel === STUDIO_WEEKLY_REMINDER_SMS_STOPPED &&
      afterStopSms.sent.length === 0,
  );

  console.log("\nTEST — Owner 21610 blocked is not a generic failure");
  await prisma.businessSettings.update({
    where: { businessId: businessB.id },
    data: { studioWeeklyReminderOwnerSmsStopAt: null, studioWeeklyReminderOwnerSmsBlockedAt: null },
  });
  await writeOwnerSmsDestination(businessB.id, ownerDest, true);
  await prisma.marketingStudioWeeklyReminder.deleteMany({
    where: { businessId: businessB.id, weekKey: "2026-09-27" },
  });
  const blockedSms = createFakeCustomerMessagingProvider();
  blockedSms.setErrorCodeNext("21610");
  const blockedDispatch = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: blockedSms,
  });
  const blockedSettings = await prisma.businessSettings.findUnique({
    where: { businessId: businessB.id },
    select: { studioWeeklyReminderOwnerSmsBlockedAt: true },
  });
  const customerAfterBlock = await prisma.customer.findFirst({
    where: { id: customerOnOwnerPhone.id, businessId: businessB.id },
    select: { smsConsentStatus: true },
  });
  check(
    "Twilio 21610 records owner blocked and keeps customer consent",
    blockedDispatch.reminder?.smsStatus === STUDIO_WEEKLY_REMINDER_SMS_STATUS_BLOCKED &&
      blockedDispatch.reminder?.smsLabel === STUDIO_WEEKLY_REMINDER_SMS_BLOCKED &&
      blockedSettings?.studioWeeklyReminderOwnerSmsBlockedAt != null &&
      customerAfterBlock?.smsConsentStatus === "GRANTED" &&
      blockedSms.sent.length === 0,
  );
  await prisma.businessSettings.update({
    where: { businessId: businessB.id },
    data: { studioWeeklyReminderOwnerSmsBlockedAt: null },
  });
  await writeOwnerSmsDestination(businessB.id, ownerDest, true);
  await prisma.marketingStudioWeeklyReminder.deleteMany({
    where: { businessId: businessB.id, weekKey: "2026-09-27" },
  });
  const webhookSms = createFakeCustomerMessagingProvider();
  const acceptedForWebhook = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: webhookSms,
  });
  const webhookBlock = await applyCustomerMessageDeliveryUpdate(prisma, {
    provider: "fake",
    providerMessageId: acceptedForWebhook.reminder.smsProviderMessageId,
    status: "FAILED",
    errorCode: "21610",
    failureReason: "21610",
    claimedBusinessId: businessB.id,
  });
  const webhookSettings = await prisma.businessSettings.findUnique({
    where: { businessId: businessB.id },
    select: { studioWeeklyReminderOwnerSmsBlockedAt: true },
  });
  check(
    "A 21610 delivery update blocks the owner destination, not a customer",
    webhookBlock.applied === true &&
      webhookBlock.reason === "owner_blocked" &&
      webhookSettings?.studioWeeklyReminderOwnerSmsBlockedAt != null &&
      (await prisma.customer.findFirst({
        where: { id: customerOnOwnerPhone.id, businessId: businessB.id },
      }))?.smsConsentStatus === "GRANTED",
  );

  console.log("\nTEST — Timeout is a handled failure");
  await prisma.businessSettings.update({
    where: { businessId: businessB.id },
    data: { studioWeeklyReminderOwnerSmsBlockedAt: null, studioWeeklyReminderOwnerSmsStopAt: null },
  });
  await writeOwnerSmsDestination(businessB.id, ownerDest, true);
  await prisma.marketingStudioWeeklyReminder.deleteMany({
    where: { businessId: businessB.id, weekKey: "2026-09-27" },
  });
  const timeoutSms = createFakeCustomerMessagingProvider();
  timeoutSms.setTimeoutNext(true);
  const timedOut = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: timeoutSms,
  });
  check(
    "Provider timeout is recorded as a handled failure",
    timedOut.created === true &&
      timedOut.reminder?.smsStatus === STUDIO_WEEKLY_REMINDER_SMS_STATUS_FAILED &&
      timedOut.reminder?.smsLabel === STUDIO_WEEKLY_REMINDER_SMS_TIMED_OUT &&
      timeoutSms.sent.length === 0,
  );

  console.log("\nTEST — ADMIN/manager page data masks phone and provider errors");
  const failedForMask = createFakeCustomerMessagingProvider();
  failedForMask.setFailNext(true);
  await prisma.marketingStudioWeeklyReminder.deleteMany({
    where: { businessId: businessB.id, weekKey: "2026-09-27" },
  });
  await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, pacificMonday10, {
    smsPlatformConfigured: true,
    messagingProvider: failedForMask,
  });
  const adminSource = await loadMarketingSource(prisma, businessB.id, pacificMonday10, "ADMIN");
  const ownerSource = await loadMarketingSource(prisma, businessB.id, pacificMonday10, "OWNER");
  const adminPresented = presentStudioWeeklyReminderForViewer(
    await loadStudioWeeklyReminderState(prisma, businessB.id, pacificMonday10),
    "ADMIN",
  );
  const adminJson = JSON.stringify(adminSource.weeklyReminder);
  check(
    "ADMIN page data receives a masked owner number and a safe SMS label",
    adminSource.weeklyReminder.ownerSmsTo === "••••0199" &&
      adminSource.weeklyReminder.ownerSmsToMasked === "••••0199" &&
      adminPresented.ownerSmsTo === "••••0199" &&
      ownerSource.weeklyReminder.ownerSmsTo === ownerDest &&
      adminSource.weeklyReminder.reminder?.smsLabel === STUDIO_WEEKLY_REMINDER_SMS_FAILED &&
      !adminJson.includes(ownerDest) &&
      !adminJson.includes("9415550199") &&
      !adminJson.includes("Fake SMS provider") &&
      !adminJson.includes("smsProviderError"),
  );

  console.log("\nTEST — Duplicate-send: concurrent scheduled runs send at most once");
  await prisma.businessSettings.update({
    where: { businessId: businessB.id },
    data: { studioWeeklyReminderOwnerSmsBlockedAt: null, studioWeeklyReminderOwnerSmsStopAt: null },
  });
  await writeOwnerSmsDestination(businessB.id, ownerDest, true);
  await prisma.marketingStudioWeeklyReminder.deleteMany({
    where: { businessId: businessB.id, weekKey: "2026-09-27" },
  });
  const concurrentSms = createFakeCustomerMessagingProvider();
  const [cronOne, cronTwo] = await Promise.all([
    runScheduledStudioWeeklyReminders(prisma, pacificMonday10, {
      smsPlatformConfigured: true,
      messagingProvider: concurrentSms,
    }),
    runScheduledStudioWeeklyReminders(prisma, pacificMonday10, {
      smsPlatformConfigured: true,
      messagingProvider: concurrentSms,
    }),
  ]);
  const concurrentB = [...cronOne, ...cronTwo].filter((row) => row.businessId === businessB.id);
  const concurrentRows = await prisma.marketingStudioWeeklyReminder.findMany({
    where: { businessId: businessB.id, weekKey: "2026-09-27" },
  });
  check(
    "Concurrent weekly dispatches send at most one SMS per business/week",
    concurrentSms.sent.filter((row) => row.to === ownerDest).length === 1 &&
      concurrentRows.length === 1 &&
      concurrentRows[0]?.smsSendClaimedAt != null &&
      concurrentB.some((row) => row.created === true) &&
      concurrentB.some((row) => row.created === false || row.reminder?.id === concurrentRows[0]?.id),
  );

  console.log("\nTEST — Other live database errors are not missing schema");
  try {
    await prisma.marketingStudioWeeklyReminder.create({
      data: {
        businessId: "not-a-business",
        weekKey: "2026-10-04",
        awaitingCount: 1,
        channel: STUDIO_WEEKLY_REMINDER_CHANNEL,
        smsStatus: STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_CONNECTED,
      },
    });
    check("Foreign-key create should fail", false);
  } catch (error) {
    check(
      "Live foreign-key failure is not missing reminder schema",
      missingStudioWeeklyReminderSchema(error) === false,
    );
  }

  const scanOwner = await prisma.user.create({
    data: { name: "Scan Owner", email: `scan-reminder-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const scanBusiness = await prisma.business.create({
    data: {
      name: "Scan Reminder",
      slug: `scan-reminder-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: "America/New_York",
    },
  });
  await prisma.membership.create({
    data: { userId: scanOwner.id, businessId: scanBusiness.id, role: "OWNER" },
  });
  const scanCustomer = await prisma.customer.create({
    data: { businessId: scanBusiness.id, name: "Scan Customer" },
  });
  const oldSentAt = new Date(Date.now() - INVOICE_DUE_AFTER_MS - 60_000);
  const dueInvoice = await prisma.invoice.create({
    data: {
      businessId: scanBusiness.id,
      customerId: scanCustomer.id,
      status: "SENT",
      total: 80,
      createdAt: oldSentAt,
    },
  });
  await emitBusinessEvent(prisma, {
    businessId: scanBusiness.id,
    type: "INVOICE_SENT",
    subjectType: "INVOICE",
    subjectId: dueInvoice.id,
    payload: { customerId: scanCustomer.id },
    idempotencyKey: `INVOICE_SENT:${dueInvoice.id}`,
    occurredAt: oldSentAt,
  });

  console.log("\nTEST — Missing reminder table fails closed and scan continues");
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "MarketingStudioWeeklyReminder"`);
  const tableMissing = await loadStudioWeeklyReminderState(prisma, businessA.id, weekInstant, {
    smsPlatformConfigured: false,
  });
  const tableMissingSource = await loadMarketingSource(prisma, businessA.id, weekInstant);
  const tableMissingDispatch = await dispatchStudioWeeklyReviewReminder(prisma, businessA.id, weekInstant, {
    smsPlatformConfigured: false,
  });
  await expectError(
    "Opt-in fails closed when the reminder table is missing",
    () =>
      setStudioWeeklyReviewReminderOptIn(prisma, ownerA, true, weekInstant, {
        smsPlatformConfigured: false,
      }),
    (error) =>
      error instanceof MarketingError && error.message === STUDIO_WEEKLY_REMINDER_UNAVAILABLE_MESSAGE,
  );
  await scanScheduledBusinessEvents(prisma, scanBusiness.id);
  const dueAfterTableDrop = await prisma.businessEvent.findMany({
    where: { businessId: scanBusiness.id, type: "INVOICE_DUE", subjectId: dueInvoice.id },
  });
  check(
    "Missing table shows an unavailable reminder state",
    tableMissing.available === false &&
      tableMissing.optedIn === false &&
      tableMissing.reminder === null &&
      tableMissing.inAppMessage === STUDIO_WEEKLY_REMINDER_UNAVAILABLE_MESSAGE &&
      tableMissingSource.weeklyReminder.available === false &&
      tableMissingSource.approvalQueue.total >= 0,
  );
  check(
    "Missing table dispatch does not invent a reminder",
    tableMissingDispatch.created === false && tableMissingDispatch.reason === "schema_unavailable",
  );
  check("Scan still emits INVOICE_DUE when the reminder table is missing", dueAfterTableDrop.length === 1);

  console.log("\nTEST — Missing reminder column fails closed and scan continues");
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "MarketingStudioWeeklyReminder" (
      "id" TEXT NOT NULL,
      "businessId" TEXT NOT NULL,
      "weekKey" TEXT NOT NULL,
      "awaitingCount" INTEGER NOT NULL,
      "channel" TEXT NOT NULL DEFAULT 'IN_APP',
      "smsStatus" TEXT NOT NULL,
      "smsLabel" TEXT NOT NULL DEFAULT '',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "MarketingStudioWeeklyReminder_pkey" PRIMARY KEY ("id")
    )
  `);
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "BusinessSettings" DROP COLUMN IF EXISTS "studioWeeklyReviewReminderOptedIn"`,
  );
  const columnMissing = await loadStudioWeeklyReminderState(prisma, businessA.id, weekInstant, {
    smsPlatformConfigured: false,
  });
  const columnMissingDispatch = await dispatchStudioWeeklyReviewReminder(prisma, businessA.id, nextWeekInstant, {
    smsPlatformConfigured: false,
  });
  await expectError(
    "Opt-out fails closed when the reminder column is missing",
    () =>
      setStudioWeeklyReviewReminderOptIn(prisma, ownerA, false, nextWeekInstant, {
        smsPlatformConfigured: false,
      }),
    (error) =>
      error instanceof MarketingError && error.message === STUDIO_WEEKLY_REMINDER_UNAVAILABLE_MESSAGE,
  );
  const dueBeforeColumnScan = await prisma.businessEvent.count({
    where: { businessId: scanBusiness.id, type: "INVOICE_DUE", subjectId: dueInvoice.id },
  });
  await scanScheduledBusinessEvents(prisma, scanBusiness.id);
  const dueAfterColumnScan = await prisma.businessEvent.count({
    where: { businessId: scanBusiness.id, type: "INVOICE_DUE", subjectId: dueInvoice.id },
  });
  check(
    "Missing column shows an unavailable reminder state",
    columnMissing.available === false &&
      columnMissing.inAppMessage === STUDIO_WEEKLY_REMINDER_UNAVAILABLE_MESSAGE,
  );
  check(
    "Missing column dispatch does not invent a reminder",
    columnMissingDispatch.created === false && columnMissingDispatch.reason === "schema_unavailable",
  );
  check(
    "Scan stays idempotent and does not throw when the reminder column is missing",
    dueAfterColumnScan === dueBeforeColumnScan,
  );
} finally {
  resetCustomerMessagingProvider();
  await prisma.$disconnect();
}

console.log(
  failures === 0
    ? "\nAll marketing studio weekly reminder checks passed."
    : `\n${failures} marketing studio weekly reminder check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
