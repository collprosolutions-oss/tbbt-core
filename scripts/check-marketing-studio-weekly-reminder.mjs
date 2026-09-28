/**
 * OWNER weekly Marketing Studio review reminder.
 *
 * Proves consent (default off / explicit opt-in), opt-out, timezone
 * week boundaries, idempotency for the same business/week,
 * authorization, and tenant isolation on a dedicated test database.
 * Delivery stays on the existing OWNER in-app path. SMS is labeled
 * honestly when it is not actually configured. Never messages
 * customers, auto-approves, publishes, or posts.
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

const { businessScope, assertBusinessRecord } = await import("@/lib/access-scope");
const { zonedCivilToUtc } = await import("@/lib/business-timezone");
const {
  STUDIO_WEEKLY_REMINDER_CHANNEL,
  STUDIO_WEEKLY_REMINDER_IN_APP_MESSAGE,
  STUDIO_WEEKLY_REMINDER_OPTED_IN_MESSAGE,
  STUDIO_WEEKLY_REMINDER_OPTED_OUT_MESSAGE,
  STUDIO_WEEKLY_REMINDER_OWNER_ONLY_MESSAGE,
  STUDIO_WEEKLY_REMINDER_SMS_NOT_CONNECTED,
  STUDIO_WEEKLY_REMINDER_SMS_STATUS_CONNECTED_UNUSED,
  STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_CONNECTED,
  canManageStudioWeeklyReminder,
  studioWeeklyReminderCopy,
  studioWeeklyReminderDelivery,
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
  setStudioWeeklyReviewReminderOptIn,
} = await import("@/lib/marketing-studio-reminder");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function readSrc(relative) {
  return readFileSync(join(root, relative), "utf8");
}

const domainSrc = readSrc("src/lib/marketing.ts");
const reminderOpsSrc = readSrc("src/lib/marketing-studio-reminder.ts");
const dataSrc = readSrc("src/lib/marketing-data.ts");
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
    !reminderOpsSrc.includes("attempt") &&
      !reminderOpsSrc.includes("sendTransactionalEmail") &&
      !reminderOpsSrc.includes("notifyCustomer") &&
      !reminderOpsSrc.includes("PUBLISHED") &&
      !reminderOpsSrc.includes("auto-approve") &&
      reminderOpsSrc.includes("isCustomerMessagingConfigured") &&
      reminderOpsSrc.includes("STUDIO_WEEKLY_REMINDER_CHANNEL"),
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
    (error) =>
      error instanceof MarketingError &&
      error.message === STUDIO_WEEKLY_REMINDER_OWNER_ONLY_MESSAGE,
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
      !reminderOpsSrc.includes("publicPhone"),
  );

  console.log("\nTEST — SMS connected still stays in-app");
  await prisma.business.update({
    where: { id: businessB.id },
    data: { operationalSmsNumber: "1235550100" },
  });
  await prisma.marketingStudioWeeklyReminder.deleteMany({ where: { businessId: businessB.id } });
  const connected = await dispatchStudioWeeklyReviewReminder(prisma, businessB.id, weekInstant, {
    smsPlatformConfigured: true,
  });
  check(
    "Connected SMS is labeled unused and still in-app",
    connected.created === true &&
      connected.reminder?.channel === STUDIO_WEEKLY_REMINDER_CHANNEL &&
      connected.reminder?.smsStatus === STUDIO_WEEKLY_REMINDER_SMS_STATUS_CONNECTED_UNUSED &&
      connected.reminder?.smsLabel === "" &&
      connected.delivery.customerMessageSent === false,
  );
} finally {
  await prisma.$disconnect();
}

console.log(
  failures === 0
    ? "\nAll marketing studio weekly reminder checks passed."
    : `\n${failures} marketing studio weekly reminder check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
