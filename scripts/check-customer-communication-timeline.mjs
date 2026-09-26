/**
 * Unified customer communication timeline — recorded truth only.
 *
 * Proves chronological merge of persisted SMS/email/phone records,
 * direction and delivery-state honesty, Business.timezone display,
 * context-link ownership, tenant isolation, and Communications
 * specialist reuse of the canonical history loader.
 *
 * Does not infer sends from Estimate.status or Invoice.status.
 * Does not call live Resend/Twilio.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-customer-communication-timeline.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_customer_communication_timeline_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;
process.env.NEXT_PUBLIC_APP_URL = "http://customer-communication-timeline.test";
process.env.RESEND_API_KEY = "re_test_timeline";
process.env.EMAIL_FROM = "TBBT <comms@example.com>";
delete process.env.TBBT_CUSTOMER_MESSAGING_ADAPTER;
delete process.env.VERCEL_ENV;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for customer communication timeline test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

const { ForbiddenError } = await import("@/lib/authorization");
const {
  composeCustomerCommunication,
  loadCustomerCommunicationHistory,
  loadCustomerCommunicationTimeline,
  resetCommunicationEmailSender,
  setCommunicationEmailSender,
} = await import("@/lib/communications");
const { formatDateTime } = await import("@/lib/format");
const {
  getLastCommunicationsProjection,
  projectCommunicationsFacts,
  resetLastCommunicationsProjection,
  runCommunicationsSpecialist,
} = await import("@/lib/chief-of-staff/communications-specialist");

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  ok  - ${label}`);
  else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

function makeAccess(businessId, role, membershipId, userId) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      user: { id: userId },
      business: { id: businessId, name: "Timeline Co" },
    },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

function emptyCatalog() {
  return {
    facts: {},
    recommendations: [],
    activeRecommendations: [],
    historyRecommendations: [],
    states: [],
    workforceRecommendationKeys: [],
    financial: { entitled: false, failed: false, intelligence: null },
    growth: { entitled: false, source: null, failed: false, missingCapabilities: [] },
    workforceSnapshot: null,
  };
}

async function seedBusiness(name, timezone) {
  const ownerUser = await prisma.user.create({
    data: {
      name: `${name} Owner`,
      email: `${name.toLowerCase().replace(/\s+/g, ".")}.${randomUUID().slice(0, 8)}@example.com`,
      passwordHash: "x",
    },
  });
  const memberUser = await prisma.user.create({
    data: {
      name: `${name} Member`,
      email: `${name.toLowerCase().replace(/\s+/g, ".")}.member.${randomUUID().slice(0, 8)}@example.com`,
      passwordHash: "x",
    },
  });
  const business = await prisma.business.create({
    data: {
      name,
      slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID().slice(0, 8)}`,
      timezone,
    },
  });
  const membership = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: business.id, role: "OWNER" },
  });
  const memberMembership = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: business.id, role: "MEMBER" },
  });
  return {
    business,
    membership,
    memberMembership,
    access: makeAccess(business.id, "OWNER", membership.id, ownerUser.id),
    memberAccess: makeAccess(business.id, "MEMBER", memberMembership.id, memberUser.id),
  };
}

async function createCommunication(data) {
  return prisma.customerCommunication.create({
    data: {
      direction: "OUTBOUND",
      channel: "EMAIL",
      purpose: "GENERAL",
      bodySnapshot: "",
      provider: "test",
      ...data,
    },
  });
}

try {
  const timelineSrc = readFileSync(new URL("../src/lib/communications/timeline.ts", import.meta.url), "utf8");
  const specialistSrc = readFileSync(
    new URL("../src/lib/chief-of-staff/communications-specialist.ts", import.meta.url),
    "utf8",
  );
  const customerPageSrc = readFileSync(
    new URL("../src/app/(app)/customers/[customerId]/page.tsx", import.meta.url),
    "utf8",
  );
  const listSrc = readFileSync(
    new URL("../src/components/communications/timeline-list.tsx", import.meta.url),
    "utf8",
  );
  const schemaSrc = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

  console.log("\nSTATIC — Recorded-truth loader and no parallel model");
  check(
    "Timeline does not project estimate/invoice/job lifecycle status",
    !timelineSrc.includes('source: "projected"') &&
      !timelineSrc.includes('channel: "PROJECTED"') &&
      !timelineSrc.includes("addProjected") &&
      !timelineSrc.includes('status: "SENT"') &&
      timelineSrc.includes("Lifecycle status on estimates, invoices, jobs, or review requests is never"),
  );
  check(
    "Timeline queries CustomerCommunication and PhoneInteraction only",
    timelineSrc.includes("customerCommunication.findMany") &&
      timelineSrc.includes("phoneInteraction.findMany"),
  );
  check(
    "Specialist reuses the canonical history loader",
    specialistSrc.includes("loadCustomerCommunicationHistory"),
  );
  check(
    "Customer profile loads the canonical history for MANAGE_COMMUNICATIONS",
    customerPageSrc.includes("loadCustomerCommunicationHistory") &&
      customerPageSrc.includes("MANAGE_COMMUNICATIONS"),
  );
  check(
    "UI formats timestamps with Business.timezone",
    listSrc.includes("formatDateTime(new Date(item.occurredAt), timeZone)"),
  );
  check(
    "Schema was not rewritten in this lane",
    schemaSrc.includes("model CustomerCommunication") && schemaSrc.includes("model CommunicationThread"),
  );

  const tenantA = await seedBusiness("Alpha Timeline", "America/Los_Angeles");
  const tenantB = await seedBusiness("Beta Timeline", "America/New_York");
  const customerA = await prisma.customer.create({
    data: {
      businessId: tenantA.business.id,
      name: "Ava Timeline",
      email: "ava.timeline@example.com",
      phone: "5551112222",
      smsConsentStatus: "GRANTED",
    },
  });
  const customerSibling = await prisma.customer.create({
    data: {
      businessId: tenantA.business.id,
      name: "Cam Timeline",
      email: "cam.timeline@example.com",
      phone: "5550001111",
      smsConsentStatus: "GRANTED",
    },
  });
  const customerB = await prisma.customer.create({
    data: {
      businessId: tenantB.business.id,
      name: "Bea Timeline",
      email: "bea.timeline@example.com",
      phone: "5553334444",
      smsConsentStatus: "GRANTED",
    },
  });

  const estimateA = await prisma.estimate.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      status: "SENT",
      publicToken: randomUUID(),
    },
  });
  const estimateSibling = await prisma.estimate.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerSibling.id,
      status: "SENT",
      publicToken: randomUUID(),
    },
  });
  const estimateB = await prisma.estimate.create({
    data: {
      businessId: tenantB.business.id,
      customerId: customerB.id,
      status: "SENT",
      publicToken: randomUUID(),
    },
  });
  const invoiceA = await prisma.invoice.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      status: "SENT",
    },
  });
  const jobA = await prisma.job.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      projectToken: randomUUID(),
      scheduledAt: new Date("2026-04-02T17:00:00.000Z"),
      appointmentNotificationStatus: "SENT",
    },
  });
  const requestA = await prisma.serviceRequest.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      summary: "Timeline request",
    },
  });

  const olderEmailAt = new Date("2026-01-10T18:00:00.000Z");
  const inboundSmsAt = new Date("2026-01-12T18:00:00.000Z");
  const sentEmailAt = new Date("2026-01-15T08:00:00.000Z");
  const failedAt = new Date("2026-01-16T09:00:00.000Z");
  const sameInstant = new Date("2026-01-20T16:30:00.000Z");

  const outboundEmail = await createCommunication({
    id: "comm-email-sent",
    businessId: tenantA.business.id,
    customerId: customerA.id,
    direction: "OUTBOUND",
    channel: "EMAIL",
    purpose: "ESTIMATE_READY",
    relatedType: "ESTIMATE",
    relatedId: estimateA.id,
    bodySnapshot: "Estimate ready email body",
    status: "SENT",
    idempotencyKey: `email-sent-${randomUUID()}`,
    createdAt: olderEmailAt,
    attemptedAt: olderEmailAt,
  });
  const inboundSms = await createCommunication({
    id: "comm-sms-in",
    businessId: tenantA.business.id,
    customerId: customerA.id,
    direction: "INBOUND",
    channel: "SMS",
    purpose: "GENERAL",
    bodySnapshot: "Customer replied by SMS",
    status: "RECEIVED",
    idempotencyKey: `sms-in-${randomUUID()}`,
    createdAt: inboundSmsAt,
    attemptedAt: inboundSmsAt,
  });
  await createCommunication({
    id: "comm-email-queued",
    businessId: tenantA.business.id,
    customerId: customerA.id,
    direction: "OUTBOUND",
    channel: "EMAIL",
    purpose: "INVOICE_READY",
    relatedType: "INVOICE",
    relatedId: invoiceA.id,
    bodySnapshot: "Invoice email still queued",
    status: "QUEUED",
    idempotencyKey: `email-queued-${randomUUID()}`,
    createdAt: sentEmailAt,
    attemptedAt: sentEmailAt,
  });
  const failedSms = await createCommunication({
    id: "comm-sms-failed",
    businessId: tenantA.business.id,
    customerId: customerA.id,
    direction: "OUTBOUND",
    channel: "SMS",
    purpose: "APPOINTMENT_CONFIRMATION",
    relatedType: "JOB",
    relatedId: jobA.id,
    bodySnapshot: "Appointment SMS failed",
    status: "FAILED",
    failureReason: "Provider rejected the message.",
    idempotencyKey: `sms-failed-${randomUUID()}`,
    createdAt: failedAt,
    attemptedAt: failedAt,
  });
  await createCommunication({
    id: "comm-same-a",
    businessId: tenantA.business.id,
    customerId: customerA.id,
    direction: "OUTBOUND",
    channel: "EMAIL",
    purpose: "GENERAL",
    relatedType: "SERVICE_REQUEST",
    relatedId: requestA.id,
    bodySnapshot: "Same-timestamp A",
    status: "DELIVERED",
    idempotencyKey: `same-a-${randomUUID()}`,
    createdAt: sameInstant,
    attemptedAt: sameInstant,
  });
  await createCommunication({
    id: "comm-same-z",
    businessId: tenantA.business.id,
    customerId: customerA.id,
    direction: "UNKNOWN",
    channel: "MANUAL",
    purpose: "OWNER_FOLLOW_UP",
    relatedType: "ESTIMATE",
    relatedId: estimateSibling.id,
    bodySnapshot: "Same-timestamp Z unknown direction",
    status: "SENT",
    idempotencyKey: `same-z-${randomUUID()}`,
    createdAt: sameInstant,
    attemptedAt: sameInstant,
  });
  await createCommunication({
    id: "comm-foreign-link",
    businessId: tenantA.business.id,
    customerId: customerA.id,
    direction: "OUTBOUND",
    channel: "EMAIL",
    purpose: "ESTIMATE_FOLLOW_UP",
    relatedType: "ESTIMATE",
    relatedId: estimateB.id,
    bodySnapshot: "Foreign estimate id must not link",
    status: "SENT",
    idempotencyKey: `foreign-link-${randomUUID()}`,
    createdAt: new Date("2026-01-08T12:00:00.000Z"),
    attemptedAt: new Date("2026-01-08T12:00:00.000Z"),
  });
  await createCommunication({
    id: "comm-missing-link",
    businessId: tenantA.business.id,
    customerId: customerA.id,
    direction: "OUTBOUND",
    channel: "EMAIL",
    purpose: "GENERAL",
    relatedType: "JOB",
    relatedId: "job_does_not_exist",
    bodySnapshot: "Missing job must not link",
    status: "SENT",
    idempotencyKey: `missing-link-${randomUUID()}`,
    createdAt: new Date("2026-01-07T12:00:00.000Z"),
    attemptedAt: new Date("2026-01-07T12:00:00.000Z"),
  });
  await createCommunication({
    id: "comm-sibling",
    businessId: tenantA.business.id,
    customerId: customerSibling.id,
    direction: "OUTBOUND",
    channel: "SMS",
    purpose: "GENERAL",
    bodySnapshot: "Sibling customer secret SMS",
    status: "DELIVERED",
    idempotencyKey: `sibling-${randomUUID()}`,
  });
  await createCommunication({
    id: "comm-tenant-b",
    businessId: tenantB.business.id,
    customerId: customerB.id,
    direction: "OUTBOUND",
    channel: "EMAIL",
    purpose: "GENERAL",
    bodySnapshot: "Tenant B secret email",
    status: "SENT",
    idempotencyKey: `tenant-b-${randomUUID()}`,
  });
  await createCommunication({
    id: "comm-dirty-cross",
    businessId: tenantB.business.id,
    customerId: customerA.id,
    direction: "OUTBOUND",
    channel: "EMAIL",
    purpose: "GENERAL",
    bodySnapshot: "Dirty cross-tenant row",
    status: "SENT",
    idempotencyKey: `dirty-${randomUUID()}`,
  });

  console.log("\nDB — Chronology, direction, and delivery truth");
  const history = await loadCustomerCommunicationHistory(prisma, tenantA.access, {
    customerId: customerA.id,
  });
  const ids = history.items.map((item) => item.id);
  check("SMS and email records both appear", ids.includes(outboundEmail.id) && ids.includes(inboundSms.id));
  check(
    "Newest-first order keeps failed SMS ahead of older email",
    ids.indexOf(failedSms.id) < ids.indexOf(outboundEmail.id) &&
      ids.indexOf(inboundSms.id) < ids.indexOf(outboundEmail.id),
  );
  check(
    "Same timestamp ordering is deterministic by id desc",
    ids.indexOf("comm-same-z") < ids.indexOf("comm-same-a") &&
      history.items.filter((item) => item.occurredAt === sameInstant.toISOString()).length === 2,
  );
  const inbound = history.items.find((item) => item.id === inboundSms.id);
  const outbound = history.items.find((item) => item.id === outboundEmail.id);
  const queued = history.items.find((item) => item.id === "comm-email-queued");
  const failed = history.items.find((item) => item.id === failedSms.id);
  const unknownDirection = history.items.find((item) => item.id === "comm-same-z");
  check("Incoming direction is preserved", inbound?.direction === "INBOUND");
  check("Outgoing direction is preserved", outbound?.direction === "OUTBOUND");
  check("Unknown direction stays neutral", unknownDirection?.direction === null);
  check("SENT is not rewritten as DELIVERED", outbound?.status === "SENT");
  check("QUEUED stays queued", queued?.status === "QUEUED");
  check("FAILED stays failed", failed?.status === "FAILED" && failed.failureReason === "Provider rejected the message.");
  check("RECEIVED stays received", inbound?.status === "RECEIVED");
  check(
    "Estimate.status SENT is not inferred as a communication",
    history.items.every((item) => item.id !== `projected:estimate:${estimateA.id}`),
  );
  check(
    "Invoice.status SENT is not inferred as a communication",
    history.items.every((item) => item.id !== `projected:invoice:${invoiceA.id}` && item.source !== "projected"),
  );
  check(
    "Appointment notification status is not inferred as a send",
    history.items.every((item) => item.id !== `projected:job:${jobA.id}`),
  );

  console.log("\nDB — Timezone and last recorded communication");
  check("Loader uses Business.timezone", history.timeZone === "America/Los_Angeles");
  const displayedLa = formatDateTime(new Date(sentEmailAt), history.timeZone);
  const displayedNy = formatDateTime(new Date(sentEmailAt), "America/New_York");
  check("Business timezone display differs from another zone", displayedLa !== displayedNy);
  check(
    "Stored event timestamp stays the recorded UTC instant",
    queued?.occurredAt === sentEmailAt.toISOString(),
  );
  check(
    "Last recorded communication is the newest deterministic row",
    history.summary.lastOccurredAt === sameInstant.toISOString() &&
      history.summary.lastChannel === "MANUAL" &&
      history.summary.lastDirection === null &&
      history.summary.lastStatus === "SENT" &&
      history.summary.lastPurpose === "OWNER_FOLLOW_UP",
  );

  console.log("\nDB — Context links only for owned records");
  check(
    "Owned estimate/job/invoice/request links are present",
    history.items.find((item) => item.id === outboundEmail.id)?.relatedHref === `/estimates/${estimateA.id}` &&
      history.items.find((item) => item.id === failedSms.id)?.relatedHref === `/jobs/${jobA.id}` &&
      history.items.find((item) => item.id === "comm-email-queued")?.relatedHref === `/invoices/${invoiceA.id}` &&
      history.items.find((item) => item.id === "comm-same-a")?.relatedHref === `/requests/${requestA.id}`,
  );
  check(
    "Sibling-customer estimate does not get a link",
    history.items.find((item) => item.id === "comm-same-z")?.relatedHref === null,
  );
  check(
    "Foreign estimate id does not get a link",
    history.items.find((item) => item.id === "comm-foreign-link")?.relatedHref === null,
  );
  check(
    "Missing related id does not get a link",
    history.items.find((item) => item.id === "comm-missing-link")?.relatedHref === null,
  );

  console.log("\nDB — Tenant and customer isolation");
  let foreignCustomerDenied = false;
  try {
    await loadCustomerCommunicationHistory(prisma, tenantA.access, { customerId: customerB.id });
  } catch (error) {
    foreignCustomerDenied = error instanceof ForbiddenError;
  }
  check("Foreign tenant customer fails closed", foreignCustomerDenied);

  let memberDenied = false;
  try {
    await loadCustomerCommunicationTimeline(prisma, tenantA.memberAccess, {
      customerId: customerA.id,
    });
  } catch (error) {
    memberDenied = error instanceof ForbiddenError;
  }
  check("MEMBER cannot read whole-customer communication history", memberDenied);

  check(
    "Foreign communication row does not leak into the local customer",
    history.items.every((item) => item.body !== "Dirty cross-tenant row" && item.body !== "Tenant B secret email"),
  );
  check(
    "Another customer in the same business does not leak",
    history.items.every((item) => item.body !== "Sibling customer secret SMS"),
  );

  const siblingHistory = await loadCustomerCommunicationHistory(prisma, tenantA.access, {
    customerId: customerSibling.id,
  });
  check(
    "Sibling timeline stays on that customer",
    siblingHistory.items.some((item) => item.body === "Sibling customer secret SMS") &&
      siblingHistory.items.every((item) => item.body !== "Estimate ready email body"),
  );

  const tenantBHistory = await loadCustomerCommunicationHistory(prisma, tenantB.access, {
    customerId: customerB.id,
  });
  check(
    "Tenant B timeline does not include tenant A records",
    tenantBHistory.items.every((item) => item.body !== "Estimate ready email body") &&
      tenantBHistory.timeZone === "America/New_York",
  );

  console.log("\nDB — Communications specialist reuses canonical history");
  resetLastCommunicationsProjection();
  const specialist = await runCommunicationsSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "When did we last contact this customer? Did the last recorded message fail? What channel was last used?",
    entityHints: { customerId: customerA.id },
  });
  const projection = getLastCommunicationsProjection();
  const facts = projectCommunicationsFacts(projection).facts;
  check("Specialist run succeeds", specialist.status === "OK");
  check("Specialist reused the canonical history loader", projection.history.reusedCanonicalLoader === true);
  check(
    "Specialist last-contact facts match the unified loader",
    facts["communications-last-occurred-at"] === history.summary.lastOccurredAt &&
      facts["communications-last-channel"] === history.summary.lastChannel &&
      facts["communications-last-direction"] === "none" &&
      facts["communications-last-status"] === history.summary.lastStatus &&
      facts["communications-last-failed"] === "no" &&
      facts["communications-history-loader"] === "canonical",
  );
  check(
    "Specialist does not invent message bodies",
    !JSON.stringify(projection).includes("Estimate ready email body") &&
      !JSON.stringify(projection).includes("Appointment SMS failed") &&
      !JSON.stringify(specialist).includes("Estimate ready email body"),
  );

  resetLastCommunicationsProjection();
  const failedLatest = await createCommunication({
    businessId: tenantA.business.id,
    customerId: customerA.id,
    direction: "OUTBOUND",
    channel: "SMS",
    purpose: "GENERAL",
    bodySnapshot: "Newest failed SMS",
    status: "FAILED",
    idempotencyKey: `newest-fail-${randomUUID()}`,
    createdAt: new Date("2026-02-01T12:00:00.000Z"),
    attemptedAt: new Date("2026-02-01T12:00:00.000Z"),
  });
  const afterFail = await runCommunicationsSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "Did the last recorded message fail?",
    entityHints: { customerId: customerA.id },
  });
  const afterFailFacts = projectCommunicationsFacts(getLastCommunicationsProjection()).facts;
  check(
    "Specialist reports the last recorded message failed",
    afterFail.status === "OK" &&
      afterFailFacts["communications-last-status"] === "FAILED" &&
      afterFailFacts["communications-last-failed"] === "yes" &&
      afterFailFacts["communications-last-channel"] === "SMS",
  );
  const refreshed = await loadCustomerCommunicationHistory(prisma, tenantA.access, {
    customerId: customerA.id,
  });
  check("Unified loader last row is the newest failed SMS", refreshed.summary.lastStatus === "FAILED" && refreshed.items[0]?.id === failedLatest.id);

  console.log("\nDB — Existing send behavior is unchanged");
  setCommunicationEmailSender(async (input) => ({ id: `fake-email:${input.idempotencyKey}` }));
  const composed = await composeCustomerCommunication(prisma, tenantA.access, {
    customerId: customerA.id,
    channel: "EMAIL",
    purpose: "GENERAL",
    subject: "Owner follow-up",
    body: "Compose still records a send.",
    idempotencyKey: `compose-${randomUUID()}`,
  });
  check("Compose still records an outbound email", composed.ok && Boolean(composed.communicationId));
  const composedRow = await prisma.customerCommunication.findFirst({
    where: { id: composed.communicationId ?? "", businessId: tenantA.business.id },
  });
  check(
    "Composed send keeps recorded status and is not marked delivered",
    composedRow?.status === composed.status && composedRow?.status !== "DELIVERED" && composedRow?.direction === "OUTBOUND",
  );

  resetCommunicationEmailSender();
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

process.exit(failures === 0 ? 0 : 1);
