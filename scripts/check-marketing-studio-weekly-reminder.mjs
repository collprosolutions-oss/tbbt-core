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
  STUDIO_WEEKLY_REMINDER_SMS_ACCEPTED,
  STUDIO_WEEKLY_REMINDER_SMS_FAILED,
  STUDIO_WEEKLY_REMINDER_SMS_NO_DESTINATION,
  STUDIO_WEEKLY_REMINDER_SMS_NOT_CONNECTED,
  STUDIO_WEEKLY_REMINDER_SMS_STATUS_ACCEPTED,
  STUDIO_WEEKLY_REMINDER_SMS_STATUS_CONNECTED_UNUSED,
  STUDIO_WEEKLY_REMINDER_SMS_STATUS_FAILED,
  STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_CONNECTED,
  STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_SENT,
  STUDIO_WEEKLY_REMINDER_UNAVAILABLE_MESSAGE,
  canManageStudioWeeklyReminder,
  resolveOwnerStudioReminderSmsTo,
  studioWeeklyReminderCopy,
  studioWeeklyReminderDelivery,
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
  dispatchStudioWeeklyReviewReminder,
  loadStudioWeeklyReminderState,
  missingStudioWeeklyReminderSchema,
  setStudioWeeklyReviewReminderOptIn,
} = await import("@/lib/marketing-studio-reminder");
const { emitBusinessEvent } = await import("@/lib/automation/events");
const { INVOICE_DUE_AFTER_MS, scanScheduledBusinessEvents } = await import("@/lib/automation/scan");
const {
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
    "Owner SMS destination uses the business contact phone, not a customer number",
    resolveOwnerStudioReminderSmsTo({ publicPhone: "(239) 555-0188" }) === "2395550188" &&
      resolveOwnerStudioReminderSmsTo({ publicPhone: "2395550188", override: null }) === null &&
      resolveOwnerStudioReminderSmsTo({ publicPhone: "", override: "555-0199" }) === "5550199",
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
      reminderOpsSrc.includes("STUDIO_WEEKLY_REMINDER_CHANNEL") &&
      ownerSmsSrc.includes("Never reads Customer") &&
      !ownerSmsSrc.includes("attemptCustomerSms") &&
      !ownerSmsSrc.includes("customer.phone") &&
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
      actionSrc.includes('access.workspace.role !== "OWNER"') &&
      reminderUiSrc.includes("Turn weekly reminder on") &&
      reminderUiSrc.includes("Turn weekly reminder off") &&
      reminderUiSrc.includes("STUDIO_WEEKLY_REMINDER_SMS_NOT_CONNECTED") &&
      queueUiSrc.includes("StudioWeeklyReminderControls"),
  );
  check(
    "Page and scan dispatch the existing in-app reminder only",
    pageSrc.includes("dispatchStudioWeeklyReviewReminder") &&
      scanSrc.includes("dispatchStudioWeeklyReviewReminder") &&
      domainSrc.includes("STUDIO_WEEKLY_REMINDER_IN_APP_MESSAGE") &&
      STUDIO_WEEKLY_REMINDER_IN_APP_MESSAGE.includes("will not send customer SMS"),
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
      reminderOpsSrc.includes("publicPhone") &&
      reminderOpsSrc.includes("resolveOwnerStudioReminderSmsTo"),
  );

  console.log("\nTEST — SMS connected without destination stays in-app");
  await prisma.business.update({
    where: { id: businessB.id },
    data: { operationalSmsNumber: "1235550100" },
  });
  await prisma.marketingStudioWeeklyReminder.deleteMany({ where: { businessId: businessB.id } });
  const fakeUnused = createFakeCustomerMessagingProvider();
  const connected = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, weekInstant, {
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

  console.log("\nTEST — Optional OWNER SMS uses the fake provider only");
  const ownerDest = "2395550188";
  const tenantFrom = "1235550100";
  await prisma.business.update({
    where: { id: businessB.id },
    data: { operationalSmsNumber: tenantFrom, publicPhone: ownerDest },
  });
  await prisma.customer.updateMany({
    where: { businessId: businessB.id },
    data: { phone: "2395550111", smsConsentStatus: "GRANTED" },
  });
  await prisma.marketingStudioWeeklyReminder.deleteMany({ where: { businessId: businessB.id } });
  const fakeSms = createFakeCustomerMessagingProvider();
  setCustomerMessagingProvider(fakeSms);
  const ownerSms = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, weekInstant, {
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
      fakeSms.sent[0]?.purpose === "STUDIO_WEEKLY_REMINDER" &&
      fakeSms.sent[0]?.body.includes("OWNER review") &&
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
  const ownerSmsAgain = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, weekInstant, {
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
  const failed = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, weekInstant, {
    smsPlatformConfigured: true,
    messagingProvider: failSms,
  });
  check(
    "Provider rejection is recorded as failed and still leaves the in-app reminder",
    failed.created === true &&
      failed.reminder?.smsStatus === STUDIO_WEEKLY_REMINDER_SMS_STATUS_FAILED &&
      failed.reminder?.smsLabel.startsWith(STUDIO_WEEKLY_REMINDER_SMS_FAILED) &&
      failed.reminder?.channel === STUDIO_WEEKLY_REMINDER_CHANNEL &&
      failSms.sent.length === 0,
  );

  await prisma.marketingStudioWeeklyReminder.deleteMany({ where: { businessId: businessB.id } });
  const throwSms = createFakeCustomerMessagingProvider();
  throwSms.setThrowNext(true);
  const threw = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, weekInstant, {
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

  await prisma.business.update({
    where: { id: businessB.id },
    data: { publicPhone: null },
  });
  await prisma.marketingStudioWeeklyReminder.deleteMany({ where: { businessId: businessB.id } });
  const customerOnly = createFakeCustomerMessagingProvider();
  const skippedCustomer = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, weekInstant, {
    smsPlatformConfigured: true,
    messagingProvider: customerOnly,
  });
  check(
    "A customer phone is not used when the owner destination is missing",
    skippedCustomer.created === true &&
      skippedCustomer.reminder?.smsStatus === STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_SENT &&
      skippedCustomer.reminder?.smsLabel === STUDIO_WEEKLY_REMINDER_SMS_NO_DESTINATION &&
      customerOnly.sent.length === 0,
  );

  await prisma.business.update({
    where: { id: businessB.id },
    data: { operationalSmsNumber: null, publicPhone: ownerDest },
  });
  await prisma.marketingStudioWeeklyReminder.deleteMany({ where: { businessId: businessB.id } });
  const noNumber = createFakeCustomerMessagingProvider();
  const missingNumber = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, weekInstant, {
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

  await prisma.business.update({
    where: { id: businessB.id },
    data: { operationalSmsNumber: tenantFrom, publicPhone: ownerDest },
  });
  await prisma.marketingStudioWeeklyReminder.deleteMany({ where: { businessId: businessB.id } });
  await setStudioWeeklyReviewReminderOptIn(prisma, ownerB, false, weekInstant, {
    smsPlatformConfigured: true,
    messagingProvider: fakeSms,
  });
  const afterOwnerOff = createFakeCustomerMessagingProvider();
  const skippedOff = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, weekInstant, {
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
