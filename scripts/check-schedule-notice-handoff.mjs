/**
 * Handoff proofs: public preferred windows (#308) → OWNER scheduleJob
 * → worker assignment / material-reschedule push (#316) → explicit
 * customer reschedule notice (#262).
 *
 * First scheduling must not masquerade as rescheduling. A real
 * assignment or material reschedule creates at most the intended worker
 * alert. Customer SCHEDULE_CHANGE notices never send until OWNER
 * reviews and clicks Send.
 *
 * Fake push / email / SMS providers only. Real concurrent Prisma
 * clients. Dedicated disposable localhost Postgres. No migrate.
 *
 * Run with:
 *   npm run test:schedule-notice-handoff
 */
import { register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  assertLocalDatabaseUrl,
  openDisposableTestDatabase,
} from "./disposable-test-database.mjs";

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for schedule-notice-handoff checks.");
  process.exit(generateEarly.status ?? 1);
}

register(new URL("./estimate-options-test-loader.mjs", import.meta.url), import.meta.url);

process.env.TZ = process.env.TZ || "America/New_York";
process.env.TBBT_CUSTOMER_MESSAGING_ADAPTER =
  process.env.TBBT_CUSTOMER_MESSAGING_ADAPTER || "fake";
process.env.TBBT_NATIVE_PUSH_ADAPTER = process.env.TBBT_NATIVE_PUSH_ADAPTER || "fake";
process.env.TBBT_NATIVE_PUSH_TEST_FLUSH = "1";
process.env.NEXT_PUBLIC_APP_URL =
  process.env.NEXT_PUBLIC_APP_URL || "http://schedule-notice-handoff.test";
delete process.env.VERCEL_ENV;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_MESSAGING_SERVICE_SID;
delete process.env.TWILIO_FROM_NUMBER;

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

async function expectThrow(label, fn, predicate) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

console.log("\nSTATIC — four existing systems, no new scheduler or notifier");
const preferredSrc = readRepo("src/lib/request-preferred-windows.ts");
const intakeSrc = readRepo("src/lib/public-intake.ts");
const jobActionSrc = readRepo("src/app/actions/job.ts");
const assignSrc = readRepo("src/lib/job-assignment-ops.ts");
const dayRouteSrc = readRepo("src/lib/owner-day-route-appointment-ops.ts");
const noticeSrc = readRepo("src/lib/owner-day-route-appointment-notice.ts");
const noticeOpsSrc = readRepo("src/lib/owner-day-route-appointment-notice-ops.ts");
const packageSrc = readRepo("package.json");

check(
  "Handoff stays on scheduleJob, assignment write, day-route change, and review-and-send",
  preferredSrc.includes("applyPreferredWindowForScheduling") &&
    !preferredSrc.includes("scheduleJob(") &&
    intakeSrc.includes("appendPreferredWindowsToDescription") &&
    !intakeSrc.includes("scheduleJob(") &&
    jobActionSrc.includes("rescheduled: Boolean(fresh.scheduledAt) && materialChange") &&
    jobActionSrc.includes("if (rescheduled)") &&
    jobActionSrc.includes("notifyHandymanJobRescheduled") &&
    assignSrc.includes("notifyHandymanJobAssigned") &&
    dayRouteSrc.includes("notifyHandymanJobRescheduled") &&
    !dayRouteSrc.includes("composeCustomerCommunication") &&
    !dayRouteSrc.includes("notifyCustomerAppointmentProposed") &&
    noticeOpsSrc.includes('confirmSend.trim() !== DAY_ROUTE_APPOINTMENT_NOTICE_CONFIRM_VALUE') &&
    noticeOpsSrc.includes('purpose: "SCHEDULE_CHANGE"') &&
    noticeSrc.includes("recordedDayRouteAppointmentNoticeEligible") &&
    noticeSrc.includes("recordedReschedule") &&
    noticeOpsSrc.includes("APPOINTMENT_RESCHEDULED") &&
    packageSrc.includes("test:schedule-notice-handoff"),
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "schedule-notice-handoff disposable database");

const session = await openDisposableTestDatabase({
  databaseUrl: baseUrl,
  namePrefix: "tbbt_sched_notice_handoff",
  setProcessEnv: true,
});
const prisma = session.prisma;

try {
  const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
  const { createPublicServiceRequest } = await import("@/lib/public-intake");
  const { createJobFromApprovedEstimate } = await import("@/lib/job-from-estimate");
  const { scheduleJob, assignJobMember } = await import("@/app/actions/job");
  const { writeAssignedMembershipAndLaneWindows } = await import("@/lib/job-assignment-ops");
  const { writeTeamMemberActive } = await import("@/lib/team-member-active-ops");
  const {
    applyPreferredWindowForScheduling,
    parsePreferredWindowsFromDescription,
    preferredWindowsFingerprint,
  } = await import("@/lib/request-preferred-windows");
  const { zonedCivilToUtc } = await import("@/lib/business-timezone");
  const { parseScheduleStart } = await import("@/lib/job-schedule");
  const { setTestAccess } = await import("./estimate-options-test-access.mjs");
  const { hashToken } = await import("@/lib/auth-crypto");
  const {
    createFakeNativePushProvider,
    flushNativePushNotifies,
    registerNativePushDevice,
    setNativePushProvider,
  } = await import("@/lib/native-push");
  const { changeOwnerDayRouteAppointment } = await import(
    "@/lib/owner-day-route-appointment-ops"
  );
  const {
    DAY_ROUTE_APPOINTMENT_CANCELLED_MESSAGE,
    DAY_ROUTE_APPOINTMENT_STALE_MESSAGE,
  } = await import("@/lib/owner-day-route-appointment");
  const { scheduleSnapshotFromJob } = await import("@/lib/owner-day-route/snapshot");
  const {
    DAY_ROUTE_APPOINTMENT_NOTICE_CONFIRM_VALUE,
    DAY_ROUTE_APPOINTMENT_NOTICE_NOT_RECORDED_MESSAGE,
    DAY_ROUTE_APPOINTMENT_NOTICE_UNCONFIRMED_MESSAGE,
    buildDayRouteAppointmentNoticeSubject,
    recordedDayRouteAppointmentNoticeEligible,
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
  const { resetTransactionalEmailSender, setTransactionalEmailSender } = await import("@/lib/mail");
  const {
    createFakeCustomerMessagingProvider,
    resetCustomerMessagingProvider,
    setCustomerMessagingProvider,
  } = await import("@/lib/customer-messaging");
  const { PRODUCT_CAPABILITIES } = await import("@/lib/product-catalog/codes");
  const {
    JOB_CANCELLED_CANNOT_ASSIGN_MESSAGE,
    JOB_CANCELLED_CANNOT_RESCHEDULE_MESSAGE,
  } = await import("@/lib/job-lifecycle");
  const { ForbiddenError } = await import("@/lib/authorization");

  const fakePush = createFakeNativePushProvider();
  setNativePushProvider(fakePush);
  setTransactionalEmailSender(async (input) => {
    return { id: `fake-appointment-email:${input.idempotencyKey}` };
  });
  const sentNoticeEmails = [];
  setCommunicationEmailSender(async (input) => {
    sentNoticeEmails.push(input);
    return { id: `fake-notice-email:${input.idempotencyKey}` };
  });
  const fakeSms = createFakeCustomerMessagingProvider();
  setCustomerMessagingProvider(fakeSms);

  function makeAccess(business, role, membership, user) {
    return {
      businessId: business.id,
      workspace: {
        role,
        membership: { id: membership.id },
        user: { id: user.id, email: user.email, name: user.name },
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

  function fieldAccess({ userId, businessId, membershipId, role, name, email, sessionId }) {
    return {
      userId,
      sessionId: sessionId ?? "handoff-session",
      viewer: { id: userId, name, email, role },
      workspace: { businessId, businessName: "Handoff Co", membershipId, role },
      businessId,
      membershipId,
    };
  }

  function noticeSendInput(preview, overrides = {}) {
    return {
      jobId: preview.jobId,
      snapshot: {
        ...preview.snapshot,
        customerId: preview.customerId,
        destinationFingerprint: preview.destinationFingerprint,
      },
      confirmSend: DAY_ROUTE_APPOINTMENT_NOTICE_CONFIRM_VALUE,
      timeZone: "Pacific/Honolulu",
      reviewedChannel: preview.channel,
      reviewedProposalId: preview.proposalId,
      reviewedCustomerId: preview.customerId,
      reviewedDestinationFingerprint: preview.destinationFingerprint,
      ...overrides,
    };
  }

  async function appointmentEvents(jobId) {
    return prisma.jobAppointmentEvent.findMany({
      where: { jobId },
      orderBy: { createdAt: "asc" },
    });
  }

  async function scheduleChangeComms(jobId) {
    return prisma.customerCommunication.findMany({
      where: { relatedType: "JOB", relatedId: jobId, purpose: "SCHEDULE_CHANGE" },
    });
  }

  const suffix = randomUUID().slice(0, 8);
  const NY = "America/New_York";
  const onboardingDone = new Date();
  const business = await prisma.business.create({
    data: {
      name: "Handoff Handyman",
      slug: `handoff-sched-${suffix}`,
      tradeCode: "HANDYMAN",
      timezone: NY,
      firstRunSetupCompletedAt: onboardingDone,
      starterServicesSetupCompletedAt: onboardingDone,
      starterServicesSetupChoice: "SKIPPED",
      websiteSetupCompletedAt: onboardingDone,
      websiteSetupChoice: "SKIPPED",
    },
  });
  await prisma.businessSettings.create({
    data: {
      businessId: business.id,
      workingWeekdays: "1,2,3,4,5",
      workStartMinutes: 8 * 60,
      workEndMinutes: 17 * 60,
      schedulingBufferMinutes: 30,
      scheduleNotificationEnabled: true,
    },
  });
  await prisma.businessProductGrant.create({
    data: {
      businessId: business.id,
      grantType: "CAPABILITY",
      code: PRODUCT_CAPABILITIES.SMS_MESSAGING,
      status: "ACTIVE",
      source: "MANUAL",
      sourceRef: `sms-${randomUUID()}`,
    },
  });

  const ownerUser = await prisma.user.create({
    data: { name: "Owner Handoff", email: `owner-handoff-${suffix}@example.com`, passwordHash: "x" },
  });
  const workerAUser = await prisma.user.create({
    data: { name: "Ava Handoff", email: `ava-handoff-${suffix}@example.com`, passwordHash: "x" },
  });
  const workerBUser = await prisma.user.create({
    data: { name: "Ben Handoff", email: `ben-handoff-${suffix}@example.com`, passwordHash: "x" },
  });
  const inactiveUser = await prisma.user.create({
    data: { name: "Ike Handoff", email: `ike-handoff-${suffix}@example.com`, passwordHash: "x" },
  });
  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: business.id, role: "OWNER" },
  });
  const workerA = await prisma.membership.create({
    data: { userId: workerAUser.id, businessId: business.id, role: "MEMBER" },
  });
  const workerB = await prisma.membership.create({
    data: { userId: workerBUser.id, businessId: business.id, role: "MEMBER" },
  });
  const inactiveMem = await prisma.membership.create({
    data: { userId: inactiveUser.id, businessId: business.id, role: "MEMBER" },
  });
  const ownerAccess = makeAccess(business, "OWNER", ownerMem, ownerUser);
  setTestAccess(ownerAccess);

  async function createUserSession(userId) {
    return prisma.session.create({
      data: {
        tokenHash: hashToken(`handoff-session-${userId}-${randomUUID()}`),
        userId,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
  }
  const sessionA = await createUserSession(workerAUser.id);
  const sessionB = await createUserSession(workerBUser.id);
  const sessionInactive = await createUserSession(inactiveUser.id);
  await registerNativePushDevice(
    prisma,
    fieldAccess({
      userId: workerAUser.id,
      businessId: business.id,
      membershipId: workerA.id,
      role: "MEMBER",
      name: workerAUser.name,
      email: workerAUser.email,
      sessionId: sessionA.id,
    }),
    { token: `token-ava-${randomUUID()}`, platform: "test", optedIn: true },
  );
  await registerNativePushDevice(
    prisma,
    fieldAccess({
      userId: workerBUser.id,
      businessId: business.id,
      membershipId: workerB.id,
      role: "MEMBER",
      name: workerBUser.name,
      email: workerBUser.email,
      sessionId: sessionB.id,
    }),
    { token: `token-ben-${randomUUID()}`, platform: "test", optedIn: true },
  );
  await registerNativePushDevice(
    prisma,
    fieldAccess({
      userId: inactiveUser.id,
      businessId: business.id,
      membershipId: inactiveMem.id,
      role: "MEMBER",
      name: inactiveUser.name,
      email: inactiveUser.email,
      sessionId: sessionInactive.id,
    }),
    { token: `token-ike-${randomUUID()}`, platform: "test", optedIn: true },
  );

  async function submitRequest(extras = {}) {
    return createPublicServiceRequest(prisma, {
      slug: business.slug,
      name: extras.name ?? "Pat Homeowner",
      email: extras.email ?? `pat-${randomUUID().slice(0, 8)}@example.com`,
      phone: extras.phone ?? "5550100111",
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
      requestedTradeCode: "HANDYMAN",
    });
  }

  async function jobFromRequest(requestId) {
    const request = await prisma.serviceRequest.findFirstOrThrow({
      where: { id: requestId, businessId: business.id },
    });
    const estimate = await prisma.estimate.create({
      data: {
        businessId: business.id,
        customerId: request.customerId,
        propertyId: request.propertyId,
        serviceRequestId: request.id,
        status: "APPROVED",
        publicToken: randomUUID(),
      },
    });
    const converted = await createJobFromApprovedEstimate(prisma, ownerAccess, estimate.id);
    if (!converted.ok) throw new Error(converted.error);
    return prisma.job.findFirstOrThrow({
      where: { id: converted.jobId, businessId: business.id },
      include: { customer: true },
    });
  }

  const futureDay = "2027-07-15";
  const laterDay = "2027-07-16";
  const created = await submitRequest({
    preferredWindows: [
      { kind: "WINDOW", localDate: futureDay, startLocal: "09:00", endLocal: "11:00" },
      { kind: "DAY", localDate: laterDay },
    ],
  });
  check("Public Handyman request with preferred windows succeeds", created.ok === true);
  const stored = created.ok
    ? await prisma.serviceRequest.findFirstOrThrow({
        where: { id: created.requestId, businessId: business.id },
      })
    : null;
  const record = parsePreferredWindowsFromDescription(stored?.description);
  const job = created.ok ? await jobFromRequest(created.requestId) : null;
  check(
    "Preferences stay on the request; the new job is unscheduled",
    Boolean(record?.windows.length === 2 && job && job.status === "UNSCHEDULED" && !job.scheduledAt),
  );

  const applied = applyPreferredWindowForScheduling({
    record,
    windowId: record.windows[0].id,
    fingerprint: preferredWindowsFingerprint(record),
    now: new Date("2027-01-01T12:00:00.000Z"),
  });
  check(
    "Using a preferred window prefills the schedule form and does not book",
    applied.ok === true &&
      applied.date === futureDay &&
      applied.time === "09:00" &&
      job.status === "UNSCHEDULED" &&
      job.scheduledAt == null,
  );

  console.log("\nBEHAVIOR — first schedule is not a reschedule");
  fakePush.sent.length = 0;
  sentNoticeEmails.length = 0;
  fakeSms.sent.length = 0;
  const firstScheduled = await scheduleJob(
    {},
    form({
      jobId: job.id,
      date: applied.date,
      time: applied.time,
      durationPreset: "60",
    }),
  );
  await flushNativePushNotifies();
  const firstRow = await prisma.job.findFirstOrThrow({
    where: { id: job.id, businessId: business.id },
  });
  const firstEvents = await appointmentEvents(job.id);
  const firstComms = await scheduleChangeComms(job.id);
  const firstPreview = await previewOwnerDayRouteAppointmentNotice(prisma, ownerAccess, {
    jobId: job.id,
    timeZone: NY,
  });
  const firstNotices = await loadOwnerDayRouteAppointmentNotices(prisma, ownerAccess, {
    jobIds: [job.id],
    timeZone: NY,
  });
  const firstStart = zonedCivilToUtc(2027, 7, 15, 9, 0, 0, NY);
  check("First scheduleJob from a preferred window succeeds", !firstScheduled?.error);
  check(
    "First schedule books the exact preferred slot",
    firstRow.status === "SCHEDULED" &&
      firstRow.scheduledAt?.toISOString() === firstStart.toISOString() &&
      firstRow.appointmentProposalId === 1,
  );
  check(
    "First schedule records APPOINTMENT_PROPOSED, not APPOINTMENT_RESCHEDULED",
    firstEvents.some((row) => row.eventType === "APPOINTMENT_PROPOSED") &&
      !firstEvents.some((row) => row.eventType === "APPOINTMENT_RESCHEDULED"),
  );
  check("First schedule does not send a worker reschedule alert", fakePush.sent.length === 0);
  check(
    "First schedule does not create a customer SCHEDULE_CHANGE notice",
    firstComms.length === 0 && sentNoticeEmails.length === 0 && fakeSms.sent.length === 0,
  );
  check(
    "First schedule does not offer the reschedule review-and-send card",
    firstPreview == null && !firstNotices[job.id],
  );
  check(
    "A first-scheduled job is not a recorded reschedule for the notice card",
    recordedDayRouteAppointmentNoticeEligible(firstRow, { recordedReschedule: false }) === false &&
      recordedDayRouteAppointmentNoticeEligible(firstRow) === false &&
      !firstEvents.some((row) => row.eventType === "APPOINTMENT_RESCHEDULED"),
  );

  await expectThrow(
    "Send is refused on a first-scheduled job even with a destination binding",
    () =>
      sendOwnerDayRouteAppointmentNotice(prisma, ownerAccess, {
        jobId: job.id,
        snapshot: {
          ...scheduleSnapshotFromJob(firstRow),
          customerId: job.customerId,
          destinationFingerprint: "not-a-real-destination",
        },
        confirmSend: DAY_ROUTE_APPOINTMENT_NOTICE_CONFIRM_VALUE,
        reviewedChannel: "EMAIL",
        reviewedProposalId: firstRow.appointmentProposalId,
        reviewedCustomerId: job.customerId,
        reviewedDestinationFingerprint: "not-a-real-destination",
      }),
    (error) =>
      dayRouteAppointmentNoticeErrorMessage(error, "") ===
      DAY_ROUTE_APPOINTMENT_NOTICE_NOT_RECORDED_MESSAGE,
  );

  console.log("\nBEHAVIOR — assignment, unchanged save, and reassignment");
  fakePush.sent.length = 0;
  const assigned = await assignJobMember(
    {},
    form({ jobId: job.id, membershipId: workerA.id }),
  );
  await flushNativePushNotifies();
  check("OWNER assignment write succeeds", !assigned?.error);
  check(
    "Assignment creates exactly one JOB_ASSIGNED alert for the new worker",
    fakePush.sent.length === 1 &&
      fakePush.sent[0].kind === "JOB_ASSIGNED" &&
      fakePush.sent[0].membershipId === workerA.id,
  );

  fakePush.sent.length = 0;
  sentNoticeEmails.length = 0;
  const unchanged = await scheduleJob(
    {},
    form({
      jobId: job.id,
      date: applied.date,
      time: applied.time,
      durationPreset: "60",
    }),
  );
  await flushNativePushNotifies();
  const unchangedRow = await prisma.job.findFirstOrThrow({
    where: { id: job.id, businessId: business.id },
  });
  const unchangedPreview = await previewOwnerDayRouteAppointmentNotice(prisma, ownerAccess, {
    jobId: job.id,
    timeZone: NY,
  });
  check("Unchanged scheduleJob save succeeds", !unchanged?.error && !unchanged?.warning);
  check(
    "Unchanged save does not bump the proposal or send alerts or notices",
    unchangedRow.appointmentProposalId === firstRow.appointmentProposalId &&
      fakePush.sent.length === 0 &&
      sentNoticeEmails.length === 0 &&
      unchangedPreview == null,
  );

  fakePush.sent.length = 0;
  const reassigned = await assignJobMember(
    {},
    form({ jobId: job.id, membershipId: workerB.id }),
  );
  await flushNativePushNotifies();
  check("Reassignment write succeeds", !reassigned?.error);
  check(
    "Reassignment creates exactly one JOB_ASSIGNED alert and no reschedule alert",
    fakePush.sent.length === 1 &&
      fakePush.sent[0].kind === "JOB_ASSIGNED" &&
      fakePush.sent[0].membershipId === workerB.id,
  );

  console.log("\nBEHAVIOR — material day-route reschedule holds the customer notice");
  process.env.RESEND_API_KEY = "re_test_schedule_notice_handoff";
  process.env.EMAIL_FROM = "TBBT <handoff@example.com>";
  fakePush.sent.length = 0;
  sentNoticeEmails.length = 0;
  fakeSms.sent.length = 0;
  const beforeChange = await prisma.job.findFirstOrThrow({
    where: { id: job.id, businessId: business.id },
  });
  const changed = await changeOwnerDayRouteAppointment(prisma, ownerAccess, {
    jobId: job.id,
    date: futureDay,
    time: "11:00",
    snapshot: scheduleSnapshotFromJob(beforeChange),
  });
  await flushNativePushNotifies();
  const afterChange = await prisma.job.findFirstOrThrow({
    where: { id: job.id, businessId: business.id },
  });
  const changeEvents = await appointmentEvents(job.id);
  const changeComms = await scheduleChangeComms(job.id);
  const previewAfterChange = await previewOwnerDayRouteAppointmentNotice(prisma, ownerAccess, {
    jobId: job.id,
    timeZone: NY,
  });
  const eleven = zonedCivilToUtc(2027, 7, 15, 11, 0, 0, NY);
  check(
    "Material day-route reschedule writes the new window",
    changed.materialChange === true &&
      afterChange.scheduledAt?.toISOString() === eleven.toISOString() &&
      afterChange.appointmentProposalId === 2,
  );
  check(
    "Material reschedule records APPOINTMENT_RESCHEDULED and one worker alert",
    changeEvents.some(
      (row) =>
        row.eventType === "APPOINTMENT_RESCHEDULED" &&
        row.appointmentProposalId === afterChange.appointmentProposalId,
    ) &&
      fakePush.sent.length === 1 &&
      fakePush.sent[0].kind === "JOB_RESCHEDULED" &&
      fakePush.sent[0].membershipId === workerB.id,
  );
  check(
    "Day-route reschedule does not send a customer notice",
    changeComms.length === 0 &&
      sentNoticeEmails.length === 0 &&
      fakeSms.sent.length === 0 &&
      afterChange.appointmentNotificationStatus == null,
  );
  check(
    "After a recorded change the OWNER review card is offered and not sent",
    previewAfterChange?.offerSend === true &&
      previewAfterChange.channel === "EMAIL" &&
      previewAfterChange.customerId === job.customerId &&
      buildDayRouteAppointmentNoticeSubject(business.name).includes("was updated"),
  );

  await expectThrow(
    "Send without the OWNER confirm value is refused",
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
  check(
    "Unconfirmed send still created no customer message",
    sentNoticeEmails.length === 0 && fakeSms.sent.length === 0,
  );

  const sent = await sendOwnerDayRouteAppointmentNotice(
    prisma,
    ownerAccess,
    noticeSendInput(previewAfterChange),
  );
  const afterSend = await prisma.job.findFirstOrThrow({
    where: { id: job.id, businessId: business.id },
  });
  const sentComms = await scheduleChangeComms(job.id);
  const previewAfterSend = await previewOwnerDayRouteAppointmentNotice(prisma, ownerAccess, {
    jobId: job.id,
    timeZone: NY,
  });
  check("OWNER Send records exactly one SCHEDULE_CHANGE email", sent.channel === "EMAIL");
  check(
    "Customer notice is one SENT communication after explicit Send",
    sentNoticeEmails.length === 1 &&
      fakeSms.sent.length === 0 &&
      sentComms.length === 1 &&
      sentComms[0].status === "SENT" &&
      sentComms[0].purpose === "SCHEDULE_CHANGE" &&
      afterSend.appointmentNotificationStatus === "SENT" &&
      previewAfterSend == null,
  );

  console.log("\nBEHAVIOR — rapid concurrent reschedule with real clients");
  const raceJob = await jobFromRequest(
    (
      await submitRequest({
        name: "Race Homeowner",
        email: `race-${suffix}@example.com`,
        streetAddress: "88 Race Rd",
        preferredWindows: [{ kind: "WINDOW", localDate: laterDay, startLocal: "10:00", endLocal: "12:00" }],
      })
    ).requestId,
  );
  setTestAccess(ownerAccess);
  const raceScheduled = await scheduleJob(
    {},
    form({ jobId: raceJob.id, date: laterDay, time: "10:00", durationPreset: "60" }),
  );
  check("Race job first schedule succeeds", !raceScheduled?.error);
  await assignJobMember({}, form({ jobId: raceJob.id, membershipId: workerA.id }));
  await flushNativePushNotifies();
  const raceBefore = await prisma.job.findFirstOrThrow({
    where: { id: raceJob.id, businessId: business.id },
  });
  fakePush.sent.length = 0;
  sentNoticeEmails.length = 0;
  const clientA = session.createClient();
  const clientB = session.createClient();
  const snapshot = scheduleSnapshotFromJob(raceBefore);
  const concurrent = await Promise.allSettled([
    changeOwnerDayRouteAppointment(clientA, ownerAccess, {
      jobId: raceJob.id,
      date: laterDay,
      time: "13:00",
      snapshot,
    }),
    changeOwnerDayRouteAppointment(clientB, ownerAccess, {
      jobId: raceJob.id,
      date: laterDay,
      time: "14:00",
      snapshot,
    }),
  ]);
  await flushNativePushNotifies();
  const winners = concurrent.filter((row) => row.status === "fulfilled");
  const losers = concurrent.filter((row) => row.status === "rejected");
  const raceAfter = await prisma.job.findFirstOrThrow({
    where: { id: raceJob.id, businessId: business.id },
  });
  const raceComms = await scheduleChangeComms(raceJob.id);
  const racePreview = await previewOwnerDayRouteAppointmentNotice(prisma, ownerAccess, {
    jobId: raceJob.id,
    timeZone: NY,
  });
  check(
    "Concurrent day-route clients serialize: one write, one stale",
    winners.length === 1 &&
      losers.length === 1 &&
      losers[0].status === "rejected" &&
      dayRouteAppointmentNoticeErrorMessage(losers[0].reason, "") ===
        DAY_ROUTE_APPOINTMENT_STALE_MESSAGE,
  );
  check(
    "Rapid reschedule creates at most one worker alert and no customer send",
    fakePush.sent.length === 1 &&
      fakePush.sent[0].kind === "JOB_RESCHEDULED" &&
      raceComms.length === 0 &&
      sentNoticeEmails.length === 0 &&
      racePreview?.offerSend === true &&
      raceAfter.appointmentProposalId === (raceBefore.appointmentProposalId ?? 0) + 1,
  );

  console.log("\nBEHAVIOR — inactive worker, cancelled job, DST dates");
  const deactivated = await writeTeamMemberActive(prisma, {
    businessId: business.id,
    membershipId: inactiveMem.id,
    actorMembershipId: ownerMem.id,
    active: false,
  });
  check("Inactive-worker deactivation write succeeds", !deactivated?.error);
  const inactiveJob = await jobFromRequest(
    (
      await submitRequest({
        name: "Inactive Job",
        email: `inactive-${suffix}@example.com`,
        streetAddress: "12 Quiet Ln",
        preferredWindows: [{ kind: "DAY", localDate: "2027-07-20" }],
      })
    ).requestId,
  );
  setTestAccess(ownerAccess);
  await scheduleJob(
    {},
    form({ jobId: inactiveJob.id, date: "2027-07-20", time: "09:00", durationPreset: "60" }),
  );
  fakePush.sent.length = 0;
  const assignInactive = await assignJobMember(
    {},
    form({ jobId: inactiveJob.id, membershipId: inactiveMem.id }),
  );
  await flushNativePushNotifies();
  check(
    "Inactive membership cannot be assigned",
    /team member/i.test(assignInactive?.error ?? "") && fakePush.sent.length === 0,
  );
  await assignJobMember({}, form({ jobId: inactiveJob.id, membershipId: workerA.id }));
  await flushNativePushNotifies();
  fakePush.sent.length = 0;
  await writeTeamMemberActive(prisma, {
    businessId: business.id,
    membershipId: workerA.id,
    actorMembershipId: ownerMem.id,
    active: false,
  });
  const inactiveBefore = await prisma.job.findFirstOrThrow({
    where: { id: inactiveJob.id, businessId: business.id },
  });
  await changeOwnerDayRouteAppointment(prisma, ownerAccess, {
    jobId: inactiveJob.id,
    date: "2027-07-20",
    time: "15:00",
    snapshot: scheduleSnapshotFromJob(inactiveBefore),
  });
  await flushNativePushNotifies();
  check(
    "Material reschedule for an inactive assignee creates no worker alert",
    fakePush.sent.length === 0,
  );

  const cancelledJob = await jobFromRequest(
    (
      await submitRequest({
        name: "Cancel Job",
        email: `cancel-${suffix}@example.com`,
        streetAddress: "9 Stop St",
        preferredWindows: [{ kind: "DAY", localDate: "2027-07-21" }],
      })
    ).requestId,
  );
  setTestAccess(ownerAccess);
  await scheduleJob(
    {},
    form({ jobId: cancelledJob.id, date: "2027-07-21", time: "08:00", durationPreset: "60" }),
  );
  await assignJobMember({}, form({ jobId: cancelledJob.id, membershipId: workerB.id }));
  const cancelledScheduled = await prisma.job.findFirstOrThrow({
    where: { id: cancelledJob.id, businessId: business.id },
  });
  await prisma.job.update({
    where: { id: cancelledJob.id },
    data: { status: "CANCELLED" },
  });
  fakePush.sent.length = 0;
  sentNoticeEmails.length = 0;
  const cancelledSchedule = await scheduleJob(
    {},
    form({ jobId: cancelledJob.id, date: "2027-07-21", time: "16:00", durationPreset: "60" }),
  );
  const cancelledAssign = await assignJobMember(
    {},
    form({ jobId: cancelledJob.id, membershipId: workerB.id }),
  );
  let cancelledDayRoute = null;
  try {
    await changeOwnerDayRouteAppointment(prisma, ownerAccess, {
      jobId: cancelledJob.id,
      date: "2027-07-21",
      time: "16:00",
      snapshot: scheduleSnapshotFromJob({ ...cancelledScheduled, status: "CANCELLED" }),
    });
  } catch (error) {
    cancelledDayRoute = error;
  }
  const cancelledPreview = await previewOwnerDayRouteAppointmentNotice(prisma, ownerAccess, {
    jobId: cancelledJob.id,
    timeZone: NY,
  });
  await expectThrow(
    "Cancelled job cannot receive a customer reschedule notice",
    () =>
      sendOwnerDayRouteAppointmentNotice(prisma, ownerAccess, {
        jobId: cancelledJob.id,
        snapshot: {
          ...scheduleSnapshotFromJob({ ...cancelledScheduled, status: "CANCELLED" }),
          customerId: cancelledJob.customerId,
          destinationFingerprint: "cancelled",
        },
        confirmSend: DAY_ROUTE_APPOINTMENT_NOTICE_CONFIRM_VALUE,
        reviewedCustomerId: cancelledJob.customerId,
        reviewedDestinationFingerprint: "cancelled",
      }),
    (error) =>
      error instanceof ForbiddenError === false &&
      /could not be notified|cancelled|not recorded/i.test(
        dayRouteAppointmentNoticeErrorMessage(error, ""),
      ),
  );
  check(
    "Cancelled job cannot be rescheduled or assigned",
    cancelledSchedule?.error === JOB_CANCELLED_CANNOT_RESCHEDULE_MESSAGE &&
      cancelledAssign?.error === JOB_CANCELLED_CANNOT_ASSIGN_MESSAGE &&
      dayRouteAppointmentNoticeErrorMessage(cancelledDayRoute, "") ===
        DAY_ROUTE_APPOINTMENT_CANCELLED_MESSAGE &&
      cancelledPreview == null &&
      fakePush.sent.length === 0 &&
      sentNoticeEmails.length === 0,
  );

  const dstGap = await scheduleJob(
    {},
    form({
      jobId: (
        await jobFromRequest(
          (
            await submitRequest({
              name: "DST Gap",
              email: `dst-gap-${suffix}@example.com`,
              streetAddress: "1 Spring St",
            })
          ).requestId,
        )
      ).id,
      date: "2026-03-08",
      time: "02:30",
      durationPreset: "60",
    }),
  );
  check(
    "Spring-forward gap 02:30 America/New_York is refused",
    /valid date and start time/i.test(dstGap?.error ?? ""),
  );

  const dstJob = await jobFromRequest(
    (
      await submitRequest({
        name: "DST Job",
        email: `dst-${suffix}@example.com`,
        streetAddress: "2 Spring St",
        preferredWindows: [{ kind: "DAY", localDate: "2026-03-08" }],
      })
    ).requestId,
  );
  setTestAccess(ownerAccess);
  fakePush.sent.length = 0;
  const dstFirst = await scheduleJob(
    {},
    form({ jobId: dstJob.id, date: "2026-03-08", time: "01:30", durationPreset: "60" }),
  );
  await flushNativePushNotifies();
  const dstFirstRow = await prisma.job.findFirstOrThrow({
    where: { id: dstJob.id, businessId: business.id },
  });
  const dstFirstPreview = await previewOwnerDayRouteAppointmentNotice(prisma, ownerAccess, {
    jobId: dstJob.id,
    timeZone: NY,
  });
  check(
    "DST first schedule stores the EST instant and is not a reschedule",
    !dstFirst?.error &&
      dstFirstRow.scheduledAt?.toISOString() ===
        parseScheduleStart("2026-03-08", "01:30", NY)?.toISOString() &&
      fakePush.sent.length === 0 &&
      dstFirstPreview == null,
  );
  await assignJobMember({}, form({ jobId: dstJob.id, membershipId: workerB.id }));
  await flushNativePushNotifies();
  fakePush.sent.length = 0;
  sentNoticeEmails.length = 0;
  const dstChanged = await changeOwnerDayRouteAppointment(prisma, ownerAccess, {
    jobId: dstJob.id,
    date: "2026-03-08",
    time: "03:30",
    snapshot: scheduleSnapshotFromJob(dstFirstRow),
  });
  await flushNativePushNotifies();
  const dstAfter = await prisma.job.findFirstOrThrow({
    where: { id: dstJob.id, businessId: business.id },
  });
  const dstPreview = await previewOwnerDayRouteAppointmentNotice(prisma, ownerAccess, {
    jobId: dstJob.id,
    timeZone: NY,
  });
  check(
    "DST material reschedule stores the EDT instant, one worker alert, no customer send",
    dstChanged.materialChange === true &&
      dstAfter.scheduledAt?.toISOString() ===
        parseScheduleStart("2026-03-08", "03:30", NY)?.toISOString() &&
      dstAfter.scheduledAt?.toISOString() !== dstFirstRow.scheduledAt?.toISOString() &&
      fakePush.sent.length === 1 &&
      fakePush.sent[0].kind === "JOB_RESCHEDULED" &&
      sentNoticeEmails.length === 0 &&
      dstPreview?.offerSend === true,
  );

  resetCommunicationEmailSender();
  resetCustomerMessagingProvider();
  resetTransactionalEmailSender();

  if (failed > 0) {
    throw new Error(`${failed} check(s) failed`);
  }
  console.log(`\n${passed} checks passed`);
} finally {
  await session.cleanup();
}
