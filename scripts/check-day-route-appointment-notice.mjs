/**
 * OWNER day-route appointment notice proofs.
 *
 * Dedicated database: tbbt_day_route_appointment_notice_test
 *
 * After an OWNER records an appointment change, a separate review-and-send
 * can notify the customer through the existing communication provider and
 * consent rules. Page load and reschedule never send. Fake providers only.
 *
 * Run with:
 *   npm run test:day-route-appointment-notice
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
  console.error("Failed to generate Prisma client for day-route appointment notice checks.");
  process.exit(generateEarly.status ?? 1);
}

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run the day-route appointment notice check.");
  process.exit(1);
}

const sourceUrl = new URL(baseUrl);
const databaseHost = sourceUrl.hostname.toLowerCase();
if (databaseHost !== "localhost" && databaseHost !== "127.0.0.1" && databaseHost !== "::1") {
  console.error(
    "Day-route appointment notice checks refuse a remote DATABASE_URL. Host must be localhost, 127.0.0.1, or ::1.",
  );
  process.exit(1);
}

const testDbName = "tbbt_day_route_appointment_notice_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;
process.env.NEXT_PUBLIC_APP_URL = "http://day-route-notice.test";
process.env.RESEND_API_KEY = "re_test_day_route_notice";
process.env.EMAIL_FROM = "TBBT <notice@example.com>";
process.env.TBBT_CUSTOMER_MESSAGING_ADAPTER = "fake";
delete process.env.VERCEL_ENV;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_MESSAGING_SERVICE_SID;
delete process.env.TWILIO_FROM_NUMBER;

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
if (push.status !== 0) {
  console.error("Failed to push schema for day-route appointment notice test database.");
  process.exit(push.status ?? 1);
}

const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const { ForbiddenError } = await import("@/lib/authorization");
const { parseScheduleStart } = await import("@/lib/job-schedule");
const {
  FORBIDDEN_DAY_ROUTE_CLAIM_PATTERNS,
  OWNER_DAY_ROUTE_PATH,
  loadOwnerDayRoute,
  ownerDayRouteTextHasForbiddenClaim,
  scheduleSnapshotFromJob,
} = await import("@/lib/owner-day-route");
const { changeOwnerDayRouteAppointment } = await import("@/lib/owner-day-route-appointment-ops");
const {
  DAY_ROUTE_APPOINTMENT_NOTICE_CONFIRM_VALUE,
  DAY_ROUTE_APPOINTMENT_NOTICE_DUPLICATE_MESSAGE,
  DAY_ROUTE_APPOINTMENT_NOTICE_FOREIGN_MESSAGE,
  DAY_ROUTE_APPOINTMENT_NOTICE_FORM_NOTE,
  DAY_ROUTE_APPOINTMENT_NOTICE_MISSING_JOB_MESSAGE,
  DAY_ROUTE_APPOINTMENT_NOTICE_OWNER_ONLY_MESSAGE,
  DAY_ROUTE_APPOINTMENT_NOTICE_STALE_MESSAGE,
  DAY_ROUTE_APPOINTMENT_NOTICE_NOT_RECORDED_MESSAGE,
  DAY_ROUTE_APPOINTMENT_NOTICE_UNAVAILABLE_MESSAGE,
  DAY_ROUTE_APPOINTMENT_NOTICE_UNCONFIRMED_MESSAGE,
  buildDayRouteAppointmentNoticeBody,
  buildDayRouteAppointmentNoticeSubject,
  describeRecordedAppointmentWindow,
} = await import("@/lib/owner-day-route-appointment-notice");
const {
  dayRouteAppointmentNoticeErrorMessage,
  loadOwnerDayRouteAppointmentNotices,
  previewOwnerDayRouteAppointmentNotice,
  sendOwnerDayRouteAppointmentNotice,
} = await import("@/lib/owner-day-route-appointment-notice-ops");
const {
  resetCommunicationEmailSender,
  setCommunicationEmailSender,
} = await import("@/lib/communications");
const {
  createFakeCustomerMessagingProvider,
  resetCustomerMessagingProvider,
  setCustomerMessagingProvider,
} = await import("@/lib/customer-messaging");
const { PRODUCT_CAPABILITIES } = await import("@/lib/product-catalog/codes");

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

function makeAccess(businessId, role, membershipId, userId, timezone, name) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      user: { id: userId, email: `${role.toLowerCase()}@example.com`, name: role },
      business: { id: businessId, name: name ?? "Notice Co", timezone },
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
  "src/lib/owner-day-route-appointment-notice.ts",
  "src/lib/owner-day-route-appointment-notice-ops.ts",
  "src/app/actions/owner-day-route.ts",
  "src/components/today/owner-day-route-appointment-notice.tsx",
  "src/components/today/owner-day-route.tsx",
  "src/app/(app)/today/day-route/page.tsx",
];
const featureSrc = featureFiles.map(read).join("\n");
const noticeSrc = read("src/lib/owner-day-route-appointment-notice.ts");
const opsSrc = read("src/lib/owner-day-route-appointment-notice-ops.ts");
const rescheduleOpsSrc = read("src/lib/owner-day-route-appointment-ops.ts");
const actionSrc = read("src/app/actions/owner-day-route.ts");
const formSrc = read("src/components/today/owner-day-route-appointment-notice.tsx");
const changeFormSrc = read("src/components/today/owner-day-route-appointment-form.tsx");
const pageSrc = read("src/app/(app)/today/day-route/page.tsx");
const loadSrc = read("src/lib/owner-day-route/load.ts");
const navSrc = read("src/lib/nav.ts");
const appShellSrc = read("src/components/app-shell.tsx");
const packageSrc = read("package.json");

const NY = "America/New_York";
const HONOLULU = "Pacific/Honolulu";
const dayIso = "2026-09-28";
const morning = new Date("2026-09-28T13:00:00.000Z"); // 9:00 AM ET
const laterStart = parseScheduleStart(dayIso, "16:00", NY);

const sentEmails = [];
let failEmailNext = false;
let emailDelayMs = 0;
setCommunicationEmailSender(async (input) => {
  if (emailDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, emailDelayMs));
  }
  if (failEmailNext) {
    failEmailNext = false;
    return { error: "The email provider failed." };
  }
  sentEmails.push(input);
  return { id: `fake-email:${input.idempotencyKey}` };
});
const fakeSms = createFakeCustomerMessagingProvider();
let smsDelayMs = 0;
const originalSmsSend = fakeSms.send.bind(fakeSms);
fakeSms.send = async (input) => {
  if (smsDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, smsDelayMs));
  }
  return originalSmsSend(input);
};
setCustomerMessagingProvider(fakeSms);

function reviewFromPreview(preview) {
  return {
    ...preview.snapshot,
    customerId: preview.customerId,
    destinationFingerprint: preview.destinationFingerprint,
  };
}

function noticeSendInput(preview, overrides = {}) {
  return {
    jobId: preview.jobId,
    snapshot: reviewFromPreview(preview),
    confirmSend: DAY_ROUTE_APPOINTMENT_NOTICE_CONFIRM_VALUE,
    timeZone: HONOLULU,
    reviewedChannel: preview.channel,
    reviewedProposalId: preview.proposalId,
    reviewedCustomerId: preview.customerId,
    reviewedDestinationFingerprint: preview.destinationFingerprint,
    ...overrides,
  };
}

async function markRecordedChange(jobId) {
  return prisma.job.update({
    where: { id: jobId },
    data: { appointmentProposalId: { increment: 1 } },
  });
}

console.log("\nSTATIC — separate review-and-send, no load/reschedule send, no overclaim");
check(
  "Day-route path and OWNER-only notice copy stay in place",
  OWNER_DAY_ROUTE_PATH === "/today/day-route" &&
    pageSrc.includes("canChangeAppointment={access.workspace.role === \"OWNER\"}") &&
    pageSrc.includes("loadOwnerDayRouteAppointmentNotices") &&
    formSrc.includes("OwnerDayRouteAppointmentNoticeForm") &&
    DAY_ROUTE_APPOINTMENT_NOTICE_OWNER_ONLY_MESSAGE.includes("business owner") &&
    DAY_ROUTE_APPOINTMENT_NOTICE_FORM_NOTE.includes("does not invent an arrival time"),
);
check(
  "Shared nav was not given a Day route or notice link",
  !navSrc.includes("day-route") &&
    !navSrc.includes("appointment-notice") &&
    !appShellSrc.includes("day-route") &&
    !appShellSrc.includes("appointment-notice"),
);
check(
  "Package script is dedicated to this proof",
  packageSrc.includes("test:day-route-appointment-notice") &&
    packageSrc.includes("check-day-route-appointment-notice.mjs"),
);
check(
  "Reschedule write path still does not send",
  !rescheduleOpsSrc.includes("composeCustomerCommunication") &&
    !rescheduleOpsSrc.includes("notifyCustomerAppointmentProposed") &&
    !changeFormSrc.includes("sendOwnerDayRouteAppointmentNotice"),
);
check(
  "Page load and notice preview never compose or send",
  !loadSrc.includes("composeCustomerCommunication") &&
    !loadSrc.includes("notifyCustomerAppointmentProposed") &&
    !pageSrc.includes("sendOwnerDayRouteAppointmentNotice(") &&
    !opsSrc.includes("sendTransactionalEmail") &&
    opsSrc.includes("confirmSend") &&
    opsSrc.includes("composeCustomerCommunication"),
);
check(
  "Send requires explicit confirm and uses consent plus provider",
  opsSrc.includes("DAY_ROUTE_APPOINTMENT_NOTICE_CONFIRM_VALUE") &&
    opsSrc.includes("evaluateComposeChannelEligibility") === false &&
    noticeSrc.includes("evaluateComposeChannelEligibility") &&
    noticeSrc.includes("SCHEDULE_CHANGE") &&
    actionSrc.includes("sendOwnerDayRouteAppointmentNoticeAction") &&
    actionSrc.includes("MANAGE_COMMUNICATIONS") &&
    formSrc.includes("DAY_ROUTE_APPOINTMENT_NOTICE_SUBMIT_LABEL"),
);
check(
  "Feature copy does not claim traffic optimization or automatic ETA",
  !ownerDayRouteTextHasForbiddenClaim(featureSrc) &&
    !FORBIDDEN_DAY_ROUTE_CLAIM_PATTERNS.some((pattern) => pattern.test(featureSrc)) &&
    !/automatic ETA|optimized route|live traffic/i.test(
      buildDayRouteAppointmentNoticeBody({
        businessName: "Notice Co",
        appointmentWindowLabel: "Sep 28, 2026, 4:00 PM – 5:00 PM",
        projectUrl: "http://day-route-notice.test/p/token",
      }),
    ),
);
check(
  "Hidden confirm field is only on the review form, not the change form",
  formSrc.includes('name="confirmSend"') && !changeFormSrc.includes("confirmSend"),
);
check(
  "Review form binds the reviewed customer and destination, and send ignores client timezone",
  formSrc.includes('name="customerId"') &&
    formSrc.includes('name="destinationFingerprint"') &&
    formSrc.includes("serializeDayRouteAppointmentNoticeReviewSnapshot") &&
    actionSrc.includes("reviewedCustomerId") &&
    actionSrc.includes("reviewedDestinationFingerprint") &&
    opsSrc.includes("claimDayRouteAppointmentNotice") &&
    opsSrc.includes('const NOTICE_CLAIM_STATUS = "READY"') &&
    opsSrc.includes("assertReviewedRecipient") &&
    !opsSrc.includes("input.timeZone?.trim()") &&
    opsSrc.includes("resolveBusinessTimeZone(access.workspace.business)"),
);
check(
  "Subject is a recorded update and strips CR/LF from the business name",
  buildDayRouteAppointmentNoticeSubject("Alpha\r\nNotice") ===
    "Your appointment with Alpha Notice was updated" &&
    !/[\r\n]/.test(buildDayRouteAppointmentNoticeSubject("Alpha\r\nNotice")) &&
    !noticeSrc.includes("has been rescheduled") &&
    noticeSrc.includes("recordedDayRouteAppointmentNoticeEligible") &&
    noticeSrc.includes('job.status === "CANCELLED"'),
);

try {
  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Notice",
      slug: `alpha-notice-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: NY,
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Notice",
      slug: `beta-notice-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: "America/Los_Angeles",
    },
  });
  await prisma.businessSettings.create({
    data: {
      businessId: businessA.id,
      workingWeekdays: "1,2,3,4,5",
      workStartMinutes: 8 * 60,
      workEndMinutes: 17 * 60,
      schedulingBufferMinutes: 30,
      scheduleNotificationEnabled: true,
    },
  });
  await prisma.businessSettings.create({
    data: {
      businessId: businessB.id,
      workingWeekdays: "1,2,3,4,5",
      workStartMinutes: 8 * 60,
      workEndMinutes: 17 * 60,
      scheduleNotificationEnabled: true,
    },
  });
  await prisma.businessProductGrant.create({
    data: {
      businessId: businessA.id,
      grantType: "CAPABILITY",
      code: PRODUCT_CAPABILITIES.SMS_MESSAGING,
      status: "ACTIVE",
      source: "MANUAL",
      sourceRef: `sms-${randomUUID()}`,
    },
  });

  const ownerUser = await prisma.user.create({
    data: { name: "Olivia", email: `owner-notice-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Avery", email: `admin-notice-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia", email: `member-notice-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerBUser = await prisma.user.create({
    data: { name: "Bea", email: `owner-b-notice-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerMembership = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const adminMembership = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: businessA.id, role: "ADMIN" },
  });
  const memberMembership = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const ownerBMembership = await prisma.membership.create({
    data: { userId: ownerBUser.id, businessId: businessB.id, role: "OWNER" },
  });

  const ownerAccess = makeAccess(businessA.id, "OWNER", ownerMembership.id, ownerUser.id, NY, "Alpha Notice");
  const adminAccess = makeAccess(businessA.id, "ADMIN", adminMembership.id, adminUser.id, NY, "Alpha Notice");
  const memberAccess = makeAccess(businessA.id, "MEMBER", memberMembership.id, memberUser.id, NY, "Alpha Notice");
  const ownerBAccess = makeAccess(
    businessB.id,
    "OWNER",
    ownerBMembership.id,
    ownerBUser.id,
    "America/Los_Angeles",
    "Beta Notice",
  );

  const customerA = await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: "Ada Homeowner",
      email: "ada@example.com",
      phone: "5550001111",
      smsConsentStatus: "GRANTED",
    },
  });
  const customerNoChannel = await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: "No Channel",
      smsConsentStatus: "UNKNOWN",
    },
  });
  const customerSms = await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: "Sam Phone",
      phone: "5552223333",
      smsConsentStatus: "GRANTED",
    },
  });
  const customerB = await prisma.customer.create({
    data: {
      businessId: businessB.id,
      name: "Beta Secret",
      email: "secret@example.com",
    },
  });
  const propertyA = await prisma.property.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      addressLine1: "10 Maple St",
      city: "Austin",
      region: "TX",
      postalCode: "78701",
    },
  });
  const propertySms = await prisma.property.create({
    data: {
      businessId: businessA.id,
      customerId: customerSms.id,
      addressLine1: "22 Pine St",
      city: "Austin",
      region: "TX",
      postalCode: "78702",
    },
  });
  const propertyNone = await prisma.property.create({
    data: {
      businessId: businessA.id,
      customerId: customerNoChannel.id,
      addressLine1: "90 Mute Ln",
      city: "Austin",
      region: "TX",
      postalCode: "78703",
    },
  });
  const propertyB = await prisma.property.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      addressLine1: "77 Foreign Secret Ave",
      city: "Dallas",
      region: "TX",
      postalCode: "75002",
    },
  });

  const emailJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      status: "SCHEDULED",
      scheduledAt: morning,
      scheduledDurationMinutes: 60,
      projectToken: randomUUID(),
    },
  });
  const smsJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerSms.id,
      propertyId: propertySms.id,
      status: "SCHEDULED",
      scheduledAt: new Date("2026-09-28T18:00:00.000Z"),
      scheduledDurationMinutes: 60,
      projectToken: randomUUID(),
    },
  });
  const blockedJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerNoChannel.id,
      propertyId: propertyNone.id,
      status: "SCHEDULED",
      scheduledAt: new Date("2026-09-28T15:00:00.000Z"),
      scheduledDurationMinutes: 60,
      projectToken: randomUUID(),
    },
  });
  const foreignJob = await prisma.job.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      propertyId: propertyB.id,
      status: "SCHEDULED",
      scheduledAt: morning,
      scheduledDurationMinutes: 60,
      projectToken: randomUUID(),
    },
  });
  const recipientCustomer = await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: "Reviewed Recipient",
      email: "reviewed@example.com",
      phone: "5554445555",
      smsConsentStatus: "GRANTED",
    },
  });
  const swapCustomer = await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: "Swap Recipient",
      email: "swap@example.com",
      phone: "5556667777",
      smsConsentStatus: "GRANTED",
    },
  });
  const recipientProperty = await prisma.property.create({
    data: {
      businessId: businessA.id,
      customerId: recipientCustomer.id,
      addressLine1: "40 Review St",
      city: "Austin",
      region: "TX",
      postalCode: "78704",
    },
  });
  const recipientJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: recipientCustomer.id,
      propertyId: recipientProperty.id,
      status: "SCHEDULED",
      scheduledAt: new Date("2026-09-29T14:00:00.000Z"),
      scheduledDurationMinutes: 60,
      appointmentProposalId: 1,
      projectToken: randomUUID(),
    },
  });
  const cancelledJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      status: "CANCELLED",
      scheduledAt: new Date("2026-09-29T16:00:00.000Z"),
      scheduledDurationMinutes: 60,
      appointmentProposalId: 2,
      projectToken: randomUUID(),
    },
  });
  const concurrentEmailJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      status: "SCHEDULED",
      scheduledAt: new Date("2026-09-29T17:00:00.000Z"),
      scheduledDurationMinutes: 60,
      appointmentProposalId: 1,
      projectToken: randomUUID(),
    },
  });
  const concurrentSmsJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerSms.id,
      propertyId: propertySms.id,
      status: "SCHEDULED",
      scheduledAt: new Date("2026-09-29T19:00:00.000Z"),
      scheduledDurationMinutes: 60,
      appointmentProposalId: 1,
      projectToken: randomUUID(),
    },
  });
  const staleCasesJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      status: "SCHEDULED",
      scheduledAt: new Date("2026-09-29T12:00:00.000Z"),
      scheduledDurationMinutes: 60,
      appointmentProposalId: 1,
      arrivalWindowMinutes: 60,
      projectToken: randomUUID(),
    },
  });

  console.log("\nTEST — page load, preview, and reschedule never send");
  sentEmails.length = 0;
  fakeSms.sent.length = 0;
  const loaded = await loadOwnerDayRoute(prisma, {
    businessId: businessA.id,
    role: "OWNER",
    date: dayIso,
    timeZone: NY,
  });
  const noticesBefore = await loadOwnerDayRouteAppointmentNotices(prisma, ownerAccess, {
    jobIds: loaded.stops.map((stop) => stop.jobId),
    timeZone: NY,
  });
  const previewBefore = await previewOwnerDayRouteAppointmentNotice(prisma, ownerAccess, {
    jobId: emailJob.id,
    timeZone: NY,
  });
  check(
    "Load and preview do not send, and a never-changed job has no notice card",
    sentEmails.length === 0 &&
      fakeSms.sent.length === 0 &&
      loaded.mutationsOnLoad === false &&
      !noticesBefore[emailJob.id] &&
      previewBefore == null,
  );
  await expectThrow(
    "Never-changed job send is refused even with a destination binding",
    () =>
      sendOwnerDayRouteAppointmentNotice(prisma, ownerAccess, {
        jobId: emailJob.id,
        snapshot: {
          ...scheduleSnapshotFromJob(emailJob),
          customerId: customerA.id,
          destinationFingerprint: "not-a-real-destination",
        },
        confirmSend: DAY_ROUTE_APPOINTMENT_NOTICE_CONFIRM_VALUE,
        timeZone: HONOLULU,
        reviewedChannel: "EMAIL",
        reviewedProposalId: 0,
        reviewedCustomerId: customerA.id,
        reviewedDestinationFingerprint: "not-a-real-destination",
      }),
    (error) =>
      dayRouteAppointmentNoticeErrorMessage(error, "") ===
      DAY_ROUTE_APPOINTMENT_NOTICE_NOT_RECORDED_MESSAGE,
  );

  const changed = await changeOwnerDayRouteAppointment(prisma, ownerAccess, {
    jobId: emailJob.id,
    date: dayIso,
    time: "16:00",
    snapshot: scheduleSnapshotFromJob(emailJob),
  });
  check(
    "Reschedule still does not send a customer notice",
    sentEmails.length === 0 &&
      fakeSms.sent.length === 0 &&
      changed.scheduledAt.toISOString() === laterStart?.toISOString(),
  );

  const afterChange = await prisma.job.findFirst({ where: { id: emailJob.id } });
  const previewAfterChange = await previewOwnerDayRouteAppointmentNotice(prisma, ownerAccess, {
    jobId: emailJob.id,
    timeZone: NY,
  });
  check(
    "After a recorded change the review card shows the new window and recipient",
    afterChange?.appointmentNotificationStatus == null &&
      afterChange.appointmentProposalId > 0 &&
      previewAfterChange?.offerSend === true &&
      previewAfterChange.channel === "EMAIL" &&
      previewAfterChange.customerId === customerA.id &&
      Boolean(previewAfterChange.destinationFingerprint) &&
      previewAfterChange.appointmentWindowLabel ===
        describeRecordedAppointmentWindow(
          {
            scheduledAt: afterChange.scheduledAt,
            scheduledDurationMinutes: afterChange.scheduledDurationMinutes,
            arrivalWindowMinutes: afterChange.arrivalWindowMinutes,
          },
          NY,
        ) &&
      /Sep 28, 2026/.test(previewAfterChange.appointmentWindowLabel) &&
      !/ETA|optimized/i.test(previewAfterChange.appointmentWindowLabel),
  );

  console.log("\nTEST — auth, foreign job, unavailable channel, unconfirmed");
  await expectThrow(
    "ADMIN cannot send a day-route appointment notice",
    () => sendOwnerDayRouteAppointmentNotice(prisma, adminAccess, noticeSendInput(previewAfterChange)),
    (error) =>
      error instanceof ForbiddenError &&
      dayRouteAppointmentNoticeErrorMessage(error, "") ===
        DAY_ROUTE_APPOINTMENT_NOTICE_OWNER_ONLY_MESSAGE,
  );
  await expectThrow(
    "MEMBER cannot send a day-route appointment notice",
    () => sendOwnerDayRouteAppointmentNotice(prisma, memberAccess, noticeSendInput(previewAfterChange)),
    (error) =>
      error instanceof ForbiddenError &&
      dayRouteAppointmentNoticeErrorMessage(error, "") ===
        DAY_ROUTE_APPOINTMENT_NOTICE_OWNER_ONLY_MESSAGE,
  );
  await expectThrow(
    "Foreign-tenant OWNER cannot notify another business job",
    () => sendOwnerDayRouteAppointmentNotice(prisma, ownerBAccess, noticeSendInput(previewAfterChange)),
    (error) =>
      /authorized business|could not be notified|not in the authorized/i.test(
        dayRouteAppointmentNoticeErrorMessage(error, ""),
      ) ||
      dayRouteAppointmentNoticeErrorMessage(error, "") ===
        DAY_ROUTE_APPOINTMENT_NOTICE_FOREIGN_MESSAGE,
  );
  await expectThrow(
    "Send without explicit confirmation is refused and does not send",
    () =>
      sendOwnerDayRouteAppointmentNotice(
        prisma,
        ownerAccess,
        noticeSendInput(previewAfterChange, { confirmSend: "" }),
      ),
    (error) =>
      dayRouteAppointmentNoticeErrorMessage(error, "") ===
      DAY_ROUTE_APPOINTMENT_NOTICE_UNCONFIRMED_MESSAGE,
  );
  const neverChangedBlocked = await previewOwnerDayRouteAppointmentNotice(prisma, ownerAccess, {
    jobId: blockedJob.id,
    timeZone: NY,
  });
  await markRecordedChange(blockedJob.id);
  const blockedCurrent = await prisma.job.findFirst({ where: { id: blockedJob.id } });
  const blockedPreview = await previewOwnerDayRouteAppointmentNotice(prisma, ownerAccess, {
    jobId: blockedJob.id,
    timeZone: NY,
  });
  await expectThrow(
    "Unavailable channel is refused",
    () =>
      sendOwnerDayRouteAppointmentNotice(prisma, ownerAccess, {
        jobId: blockedJob.id,
        snapshot: {
          ...scheduleSnapshotFromJob(blockedCurrent),
          customerId: customerNoChannel.id,
          destinationFingerprint: "unavailable-channel",
        },
        confirmSend: DAY_ROUTE_APPOINTMENT_NOTICE_CONFIRM_VALUE,
        timeZone: HONOLULU,
        reviewedChannel: blockedPreview?.channel,
        reviewedProposalId: blockedCurrent.appointmentProposalId,
        reviewedCustomerId: customerNoChannel.id,
        reviewedDestinationFingerprint: "unavailable-channel",
      }),
    (error) => {
      const message = dayRouteAppointmentNoticeErrorMessage(error, "");
      return (
        message === blockedPreview?.unavailableReason ||
        message === DAY_ROUTE_APPOINTMENT_NOTICE_UNAVAILABLE_MESSAGE ||
        message === DAY_ROUTE_APPOINTMENT_NOTICE_STALE_MESSAGE
      );
    },
  );
  check(
    "Auth, foreign, unconfirmed, and unavailable paths did not send",
    sentEmails.length === 0 &&
      fakeSms.sent.length === 0 &&
      neverChangedBlocked == null &&
      blockedPreview?.offerSend === false &&
      Boolean(blockedPreview?.unavailableReason),
  );

  console.log("\nTEST — retry after provider failure, then refuse duplicate");
  failEmailNext = true;
  await expectThrow(
    "Provider failure is returned and does not mark the notice sent",
    () => sendOwnerDayRouteAppointmentNotice(prisma, ownerAccess, noticeSendInput(previewAfterChange)),
    (error) => /could not be sent|provider failed|not sent/i.test(error.message),
  );
  const afterFail = await prisma.job.findFirst({ where: { id: emailJob.id } });
  check(
    "Failed send leaves a retryable unsent recorded change",
    sentEmails.length === 0 &&
      afterFail?.appointmentNotificationStatus === "FAILED" &&
      afterFail.appointmentNotifiedForProposalId === afterChange.appointmentProposalId,
  );

  const sent = await sendOwnerDayRouteAppointmentNotice(
    prisma,
    ownerAccess,
    noticeSendInput(previewAfterChange),
  );
  const afterSent = await prisma.job.findFirst({ where: { id: emailJob.id } });
  const comms = await prisma.customerCommunication.findMany({
    where: { businessId: businessA.id, relatedId: emailJob.id },
  });
  const nyWindow = describeRecordedAppointmentWindow(
    {
      scheduledAt: afterChange.scheduledAt,
      scheduledDurationMinutes: afterChange.scheduledDurationMinutes,
      arrivalWindowMinutes: afterChange.arrivalWindowMinutes,
    },
    NY,
  );
  const honoluluWindow = describeRecordedAppointmentWindow(
    {
      scheduledAt: afterChange.scheduledAt,
      scheduledDurationMinutes: afterChange.scheduledDurationMinutes,
      arrivalWindowMinutes: afterChange.arrivalWindowMinutes,
    },
    HONOLULU,
  );
  check(
    "Confirmed OWNER send uses the fake email provider, business timezone, and recorded window",
    sent.channel === "EMAIL" &&
      sentEmails.length === 1 &&
      sentEmails[0].to === "ada@example.com" &&
      sentEmails[0].subject === "Your appointment with Alpha Notice was updated" &&
      !/[\r\n]/.test(sentEmails[0].subject) &&
      sent.appointmentWindowLabel === nyWindow &&
      sentEmails[0].text.includes(nyWindow) &&
      sentEmails[0].text.includes(sent.appointmentWindowLabel) &&
      honoluluWindow !== nyWindow &&
      !sentEmails[0].text.includes(honoluluWindow) &&
      !/optimized route|automatic ETA/i.test(sentEmails[0].text) &&
      afterSent?.appointmentNotificationStatus === "SENT" &&
      comms.some((row) => row.status === "SENT" && row.purpose === "SCHEDULE_CHANGE"),
  );

  await expectThrow(
    "Duplicate notice for the same recorded change is refused",
    () =>
      sendOwnerDayRouteAppointmentNotice(
        prisma,
        ownerAccess,
        noticeSendInput({
          ...previewAfterChange,
          snapshot: scheduleSnapshotFromJob(afterSent),
        }),
      ),
    (error) =>
      dayRouteAppointmentNoticeErrorMessage(error, "") ===
      DAY_ROUTE_APPOINTMENT_NOTICE_DUPLICATE_MESSAGE,
  );
  check("Duplicate attempt does not send again", sentEmails.length === 1 && fakeSms.sent.length === 0);

  const noticesAfterSend = await loadOwnerDayRouteAppointmentNotices(prisma, ownerAccess, {
    jobIds: [emailJob.id],
    timeZone: NY,
  });
  check("Sent notice is no longer offered on reload", !noticesAfterSend[emailJob.id]);

  console.log("\nTEST — stale snapshot after another recorded change");
  const staleSnapshot = scheduleSnapshotFromJob(afterSent);
  const movedAgain = await changeOwnerDayRouteAppointment(prisma, ownerAccess, {
    jobId: emailJob.id,
    date: dayIso,
    time: "09:00",
    snapshot: staleSnapshot,
  });
  await expectThrow(
    "Stale review snapshot is refused after the appointment changes again",
    () =>
      sendOwnerDayRouteAppointmentNotice(
        prisma,
        ownerAccess,
        noticeSendInput(previewAfterChange, {
          snapshot: {
            ...staleSnapshot,
            customerId: previewAfterChange.customerId,
            destinationFingerprint: previewAfterChange.destinationFingerprint,
          },
          reviewedProposalId: afterSent.appointmentProposalId,
        }),
      ),
    (error) =>
      dayRouteAppointmentNoticeErrorMessage(error, "") ===
      DAY_ROUTE_APPOINTMENT_NOTICE_STALE_MESSAGE,
  );
  check(
    "Stale send did not notify the newer recorded change",
    sentEmails.length === 1 &&
      movedAgain.scheduledAt.toISOString() === "2026-09-28T13:00:00.000Z",
  );

  console.log("\nTEST — SMS channel when email is unavailable");
  await markRecordedChange(smsJob.id);
  const smsPreview = await previewOwnerDayRouteAppointmentNotice(prisma, ownerAccess, {
    jobId: smsJob.id,
    timeZone: NY,
  });
  const smsSent = await sendOwnerDayRouteAppointmentNotice(
    prisma,
    ownerAccess,
    noticeSendInput(smsPreview),
  );
  check(
    "SMS-only consented customer uses the fake messaging provider",
    smsPreview?.channel === "SMS" &&
      smsPreview.offerSend === true &&
      smsSent.channel === "SMS" &&
      fakeSms.sent.length === 1 &&
      /updated your appointment/i.test(fakeSms.sent[0].body) &&
      fakeSms.sent[0].body.includes(smsSent.appointmentWindowLabel),
  );

  const betaBefore = await prisma.customerCommunication.count({
    where: { businessId: businessB.id },
  });
  check("Alpha sends do not create Beta communications", betaBefore === 0);

  const foreignPreview = await loadOwnerDayRouteAppointmentNotices(prisma, ownerAccess, {
    jobIds: [foreignJob.id],
    timeZone: NY,
  });
  check("OWNER load does not attach a foreign job notice", !foreignPreview[foreignJob.id]);

  console.log("\nTEST — cancelled and never-changed jobs have no card");
  const cancelledPreview = await previewOwnerDayRouteAppointmentNotice(prisma, ownerAccess, {
    jobId: cancelledJob.id,
    timeZone: NY,
  });
  const cancelledNotices = await loadOwnerDayRouteAppointmentNotices(prisma, ownerAccess, {
    jobIds: [cancelledJob.id, emailJob.id],
    timeZone: NY,
  });
  await expectThrow(
    "CANCELLED job send is refused",
    () =>
      sendOwnerDayRouteAppointmentNotice(prisma, ownerAccess, {
        jobId: cancelledJob.id,
        snapshot: {
          ...scheduleSnapshotFromJob(cancelledJob),
          customerId: customerA.id,
          destinationFingerprint: previewAfterChange.destinationFingerprint,
        },
        confirmSend: DAY_ROUTE_APPOINTMENT_NOTICE_CONFIRM_VALUE,
        timeZone: HONOLULU,
        reviewedChannel: "EMAIL",
        reviewedProposalId: 2,
        reviewedCustomerId: customerA.id,
        reviewedDestinationFingerprint: previewAfterChange.destinationFingerprint,
      }),
    (error) => {
      const message = dayRouteAppointmentNoticeErrorMessage(error, "");
      return (
        message === DAY_ROUTE_APPOINTMENT_NOTICE_MISSING_JOB_MESSAGE ||
        message === DAY_ROUTE_APPOINTMENT_NOTICE_NOT_RECORDED_MESSAGE
      );
    },
  );
  check(
    "Never-changed and CANCELLED jobs show no review card",
    cancelledPreview == null &&
      !cancelledNotices[cancelledJob.id] &&
      sentEmails.length === 1 &&
      fakeSms.sent.length === 1,
  );

  console.log("\nTEST — reviewed recipient must still be the recipient used");
  const recipientPreview = await previewOwnerDayRouteAppointmentNotice(prisma, ownerAccess, {
    jobId: recipientJob.id,
    timeZone: NY,
  });
  await prisma.customer.update({
    where: { id: recipientCustomer.id },
    data: { email: "changed-after-review@example.com" },
  });
  await expectThrow(
    "Changed email after review is refused",
    () => sendOwnerDayRouteAppointmentNotice(prisma, ownerAccess, noticeSendInput(recipientPreview)),
    (error) =>
      dayRouteAppointmentNoticeErrorMessage(error, "") ===
      DAY_ROUTE_APPOINTMENT_NOTICE_STALE_MESSAGE,
  );
  await prisma.customer.update({
    where: { id: recipientCustomer.id },
    data: { email: "reviewed@example.com" },
  });
  await prisma.job.update({
    where: { id: recipientJob.id },
    data: { customerId: swapCustomer.id },
  });
  await expectThrow(
    "Swapped customer after review is refused",
    () => sendOwnerDayRouteAppointmentNotice(prisma, ownerAccess, noticeSendInput(recipientPreview)),
    (error) =>
      dayRouteAppointmentNoticeErrorMessage(error, "") ===
      DAY_ROUTE_APPOINTMENT_NOTICE_STALE_MESSAGE,
  );
  check(
    "Recipient tampering did not send a notice",
    sentEmails.length === 1 && fakeSms.sent.length === 1,
  );

  console.log("\nTEST — status, assignment, and non-material stale snapshots");
  const stalePreview = await previewOwnerDayRouteAppointmentNotice(prisma, ownerAccess, {
    jobId: staleCasesJob.id,
    timeZone: NY,
  });
  await prisma.job.update({
    where: { id: staleCasesJob.id },
    data: { status: "IN_PROGRESS" },
  });
  await expectThrow(
    "Status change after review is refused",
    () => sendOwnerDayRouteAppointmentNotice(prisma, ownerAccess, noticeSendInput(stalePreview)),
    (error) =>
      dayRouteAppointmentNoticeErrorMessage(error, "") ===
      DAY_ROUTE_APPOINTMENT_NOTICE_STALE_MESSAGE,
  );
  await prisma.job.update({
    where: { id: staleCasesJob.id },
    data: { status: "SCHEDULED", assignedMembershipId: ownerMembership.id },
  });
  await expectThrow(
    "Assignment change after review is refused",
    () => sendOwnerDayRouteAppointmentNotice(prisma, ownerAccess, noticeSendInput(stalePreview)),
    (error) =>
      dayRouteAppointmentNoticeErrorMessage(error, "") ===
      DAY_ROUTE_APPOINTMENT_NOTICE_STALE_MESSAGE,
  );
  await prisma.job.update({
    where: { id: staleCasesJob.id },
    data: { assignedMembershipId: null, arrivalWindowMinutes: 90 },
  });
  await expectThrow(
    "Non-material arrival-window change after review is refused",
    () => sendOwnerDayRouteAppointmentNotice(prisma, ownerAccess, noticeSendInput(stalePreview)),
    (error) =>
      dayRouteAppointmentNoticeErrorMessage(error, "") ===
      DAY_ROUTE_APPOINTMENT_NOTICE_STALE_MESSAGE,
  );
  check(
    "Stale status, assignment, and window edits did not send",
    sentEmails.length === 1 && fakeSms.sent.length === 1,
  );

  console.log("\nTEST — concurrent sends claim once for email and SMS");
  const concurrentEmailPreview = await previewOwnerDayRouteAppointmentNotice(prisma, ownerAccess, {
    jobId: concurrentEmailJob.id,
    timeZone: NY,
  });
  const emailBefore = sentEmails.length;
  emailDelayMs = 40;
  const concurrentEmailResults = await Promise.allSettled(
    Array.from({ length: 4 }, () =>
      sendOwnerDayRouteAppointmentNotice(
        prisma,
        ownerAccess,
        noticeSendInput(concurrentEmailPreview),
      ),
    ),
  );
  emailDelayMs = 0;
  const emailFulfilled = concurrentEmailResults.filter((row) => row.status === "fulfilled");
  const emailRejected = concurrentEmailResults.filter((row) => row.status === "rejected");
  const concurrentEmailComms = await prisma.customerCommunication.findMany({
    where: { businessId: businessA.id, relatedId: concurrentEmailJob.id },
  });
  check(
    "Four concurrent email sends make exactly one provider call",
    emailFulfilled.length === 1 &&
      emailRejected.length === 3 &&
      emailRejected.every(
        (row) =>
          dayRouteAppointmentNoticeErrorMessage(row.reason, "") ===
          DAY_ROUTE_APPOINTMENT_NOTICE_DUPLICATE_MESSAGE,
      ) &&
      sentEmails.length === emailBefore + 1 &&
      concurrentEmailComms.filter((row) => row.status === "SENT").length === 1,
  );

  const concurrentSmsPreview = await previewOwnerDayRouteAppointmentNotice(prisma, ownerAccess, {
    jobId: concurrentSmsJob.id,
    timeZone: NY,
  });
  const smsBefore = fakeSms.sent.length;
  smsDelayMs = 40;
  const concurrentSmsResults = await Promise.allSettled(
    Array.from({ length: 4 }, () =>
      sendOwnerDayRouteAppointmentNotice(prisma, ownerAccess, noticeSendInput(concurrentSmsPreview)),
    ),
  );
  smsDelayMs = 0;
  const smsFulfilled = concurrentSmsResults.filter((row) => row.status === "fulfilled");
  const smsRejected = concurrentSmsResults.filter((row) => row.status === "rejected");
  const concurrentSmsComms = await prisma.customerCommunication.findMany({
    where: { businessId: businessA.id, relatedId: concurrentSmsJob.id },
  });
  check(
    "Four concurrent SMS sends make exactly one provider call",
    smsFulfilled.length === 1 &&
      smsRejected.length === 3 &&
      smsRejected.every(
        (row) =>
          dayRouteAppointmentNoticeErrorMessage(row.reason, "") ===
          DAY_ROUTE_APPOINTMENT_NOTICE_DUPLICATE_MESSAGE,
      ) &&
      fakeSms.sent.length === smsBefore + 1 &&
      concurrentSmsComms.filter((row) =>
        ["SENT", "ACCEPTED", "QUEUED", "DELIVERED"].includes(row.status),
      ).length === 1,
  );

  if (failed > 0) {
    console.error(`\n${failed} day-route appointment notice check(s) failed; ${passed} passed.`);
    process.exit(1);
  }
  console.log(`\nDay-route appointment notice checks passed (${passed}).`);
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  resetCommunicationEmailSender();
  resetCustomerMessagingProvider();
  await prisma.$disconnect();
}
