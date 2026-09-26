/**
 * Business Timeline — recorded facts only.
 *
 * Proves newest-first mixed events, deterministic same-timestamp order,
 * Business.timezone display, truthful communication statuses, no
 * lifecycle-to-message inference, no AI provenance inference, tenant
 * isolation, customer-filter isolation, owned links, and bounded reads.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-business-timeline.mjs
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

const testDbName = "tbbt_business_timeline_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;
process.env.NEXT_PUBLIC_APP_URL = "http://business-timeline.test";

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for business timeline test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

const { ForbiddenError } = await import("@/lib/authorization");
const { formatDateTime } = await import("@/lib/format");
const {
  BUSINESS_TIMELINE_EXCLUSIONS,
  BUSINESS_TIMELINE_LIMIT,
  compareBusinessTimelineItems,
  describeInvoicePaid,
  describeRecordedCommunication,
  describeRecommendationRecorded,
  loadBusinessTimeline,
  sortBusinessTimelineItems,
} = await import("@/lib/business-timeline");

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  ok  - ${label}`);
  else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

function makeAccess(businessId, role, membershipId, userId, timezone = "America/Los_Angeles") {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      user: { id: userId },
      business: { id: businessId, name: "Timeline Co", timezone },
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
    access: makeAccess(business.id, "OWNER", membership.id, ownerUser.id, timezone),
    memberAccess: makeAccess(business.id, "MEMBER", memberMembership.id, memberUser.id, timezone),
  };
}

const FAR_SINCE = new Date("2020-01-01T00:00:00.000Z");

try {
  const libSrc = readFileSync(new URL("../src/lib/business-timeline/load.ts", import.meta.url), "utf8");
  const describeSrc = readFileSync(
    new URL("../src/lib/business-timeline/describe.ts", import.meta.url),
    "utf8",
  );
  const pageSrc = readFileSync(new URL("../src/app/(app)/timeline/page.tsx", import.meta.url), "utf8");
  const listSrc = readFileSync(
    new URL("../src/components/timeline/timeline-list.tsx", import.meta.url),
    "utf8",
  );
  const navSrc = readFileSync(new URL("../src/lib/nav.ts", import.meta.url), "utf8");
  const commsTimelineSrc = readFileSync(
    new URL("../src/lib/communications/timeline.ts", import.meta.url),
    "utf8",
  );
  const schemaSrc = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

  console.log("\nSTATIC — Isolated read-only lane and recorded-truth rules");
  check(
    "Page uses requireManagementPageAccess and does not add a capability",
    pageSrc.includes("requireManagementPageAccess") &&
      !pageSrc.includes("requireBusinessCapability") &&
      pageSrc.includes("loadBusinessTimeline"),
  );
  check("Global nav does not include /timeline", !navSrc.includes("/timeline"));
  check(
    "Business timeline does not import the communications timeline loader",
    !libSrc.includes("loadCustomerCommunicationHistory") &&
      !libSrc.includes("@/lib/communications/timeline"),
  );
  check(
    "Communications timeline implementation is unchanged in this check",
    commsTimelineSrc.includes("Lifecycle status on estimates, invoices, jobs, or review requests is never"),
  );
  check(
    "UI formats timestamps with Business.timezone",
    listSrc.includes("formatDateTime(new Date(item.occurredAt), timeZone)"),
  );
  check(
    "Queries stay tenant-scoped and bounded",
    libSrc.includes("businessId: access.businessId") &&
      libSrc.includes("businessId: input.businessId") &&
      libSrc.includes("take: input.take") &&
      libSrc.includes("gte: input.since"),
  );
  check(
    "Descriptions stay at recorded status and do not infer reads or AI origin",
    describeSrc.includes("status recorded as") &&
      !describeSrc.toLowerCase().includes("customer read") &&
      !describeSrc.toLowerCase().includes("ai-origin") &&
      !describeSrc.toLowerCase().includes("ai recommended") &&
      !describeSrc.toLowerCase().includes("customer was happy"),
  );
  check(
    "Schema models used by the timeline still exist and were not rewritten here",
    schemaSrc.includes("model Invoice") &&
      schemaSrc.includes("model CustomerCommunication") &&
      schemaSrc.includes("model BusinessEvent") &&
      schemaSrc.includes("model BusinessVaultRecord"),
  );
  check(
    "Documented exclusions include lifecycle and AI inference gaps",
    BUSINESS_TIMELINE_EXCLUSIONS.some((item) => item.includes("Invoice.status PAID without Invoice.paidAt")) &&
      BUSINESS_TIMELINE_EXCLUSIONS.some((item) => item.includes("never labeled AI-originated")),
  );

  console.log("\nUNIT — Deterministic order and truthful copy");
  const sameInstant = new Date("2026-08-20T16:30:00.000Z");
  const sameStampItems = [
    { id: "invoice:z:paid", occurredAt: sameInstant.toISOString(), eventType: "INVOICE_PAID" },
    { id: "invoice:a:paid", occurredAt: sameInstant.toISOString(), eventType: "INVOICE_PAID" },
    { id: "comm:1", occurredAt: sameInstant.toISOString(), eventType: "COMMUNICATION_RECORDED" },
  ];
  const sortedOnce = sortBusinessTimelineItems(sameStampItems).map((item) => item.id);
  const sortedTwice = sortBusinessTimelineItems(sameStampItems).map((item) => item.id);
  check(
    "Same timestamp orders by eventType then id",
    sortedOnce.join(",") === "comm:1,invoice:a:paid,invoice:z:paid",
  );
  check("Same-timestamp sort is deterministic across runs", sortedOnce.join(",") === sortedTwice.join(","));
  check(
    "Newest-first beats secondary keys",
    compareBusinessTimelineItems(
      { id: "old", occurredAt: "2026-01-01T00:00:00.000Z", eventType: "ZZZ" },
      { id: "new", occurredAt: "2026-09-01T00:00:00.000Z", eventType: "AAA" },
    ) > 0,
  );
  check(
    "Paid copy names the invoice and does not invent a time phrase",
    describeInvoicePaid("invoice104xx").includes("was marked paid") &&
      !describeInvoicePaid("invoice104xx").includes("happy"),
  );
  check(
    "SMS copy stays at recorded delivery status",
    describeRecordedCommunication("SMS", "DELIVERED") === "SMS status recorded as DELIVERED.",
  );
  check(
    "Recommendation copy does not claim AI provenance",
    !describeRecommendationRecorded("cash-flow").toLowerCase().includes("ai"),
  );

  const tenantA = await seedBusiness("Alpha Timeline", "America/Los_Angeles");
  const tenantB = await seedBusiness("Beta Timeline", "America/New_York");

  const customerA = await prisma.customer.create({
    data: {
      businessId: tenantA.business.id,
      name: "Ava Timeline",
      email: "ava.timeline@example.com",
      createdAt: new Date("2026-07-01T15:00:00.000Z"),
    },
  });
  const customerSibling = await prisma.customer.create({
    data: {
      businessId: tenantA.business.id,
      name: "Cam Timeline",
      email: "cam.timeline@example.com",
      createdAt: new Date("2026-07-02T15:00:00.000Z"),
    },
  });
  const customerB = await prisma.customer.create({
    data: {
      businessId: tenantB.business.id,
      name: "Bea Timeline",
      email: "bea.timeline@example.com",
    },
  });

  const requestA = await prisma.serviceRequest.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      summary: "Fence repair",
      createdAt: new Date("2026-07-03T16:00:00.000Z"),
    },
  });
  const estimateA = await prisma.estimate.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      status: "SENT",
      publicToken: randomUUID(),
      createdAt: new Date("2026-07-04T16:00:00.000Z"),
    },
  });
  await prisma.estimateVersion.create({
    data: {
      businessId: tenantA.business.id,
      estimateId: estimateA.id,
      versionNumber: 1,
      total: 100,
      laborMinimumWaived: false,
      laborMinimumAdjustment: 0,
      sentAt: new Date("2026-07-05T17:00:00.000Z"),
      approvedAt: new Date("2026-07-06T18:00:00.000Z"),
    },
  });
  const estimateSentOnly = await prisma.estimate.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      status: "SENT",
      publicToken: randomUUID(),
      createdAt: new Date("2026-07-07T12:00:00.000Z"),
    },
  });
  const jobA = await prisma.job.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      estimateId: estimateA.id,
      projectToken: randomUUID(),
      status: "COMPLETED",
      scheduledAt: new Date("2026-09-01T17:00:00.000Z"),
      createdAt: new Date("2026-07-08T13:00:00.000Z"),
    },
  });
  await prisma.jobAppointmentEvent.create({
    data: {
      businessId: tenantA.business.id,
      jobId: jobA.id,
      eventType: "APPOINTMENT_CONFIRMED",
      actorKind: "OWNER",
      createdAt: new Date("2026-07-09T14:00:00.000Z"),
    },
  });
  const invoiceA = await prisma.invoice.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      jobId: jobA.id,
      status: "PAID",
      paidAt: new Date("2026-07-12T22:42:00.000Z"),
      createdAt: new Date("2026-07-10T15:00:00.000Z"),
    },
  });
  const invoicePaidWithoutStamp = await prisma.invoice.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      status: "PAID",
      paidAt: null,
      createdAt: new Date("2026-07-11T15:00:00.000Z"),
    },
  });
  const invoiceSentOnly = await prisma.invoice.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      status: "SENT",
      createdAt: new Date("2026-07-11T16:00:00.000Z"),
    },
  });
  await prisma.businessEvent.create({
    data: {
      businessId: tenantA.business.id,
      type: "INVOICE_SENT",
      subjectType: "INVOICE",
      subjectId: invoiceA.id,
      idempotencyKey: `invoice-sent-${invoiceA.id}`,
      occurredAt: new Date("2026-07-10T16:00:00.000Z"),
    },
  });
  const jobCompletedEvent = await prisma.businessEvent.create({
    data: {
      businessId: tenantA.business.id,
      type: "JOB_COMPLETED",
      subjectType: "JOB",
      subjectId: jobA.id,
      idempotencyKey: `job-completed-${jobA.id}`,
      occurredAt: new Date("2026-07-11T19:00:00.000Z"),
    },
  });
  const paymentA = await prisma.payment.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      invoiceId: invoiceA.id,
      purpose: "INVOICE_BALANCE",
      amount: 250,
      method: "CHECK",
      receivedAt: new Date("2026-07-12T20:00:00.000Z"),
    },
  });
  const changeOrderA = await prisma.changeOrder.create({
    data: {
      businessId: tenantA.business.id,
      jobId: jobA.id,
      title: "Add railing",
      status: "APPROVED",
      sentAt: new Date("2026-07-13T15:00:00.000Z"),
      approvedAt: new Date("2026-07-14T15:00:00.000Z"),
      createdAt: new Date("2026-07-13T14:00:00.000Z"),
    },
  });
  await prisma.customerCommunication.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      channel: "SMS",
      purpose: "GENERAL",
      status: "DELIVERED",
      provider: "test",
      bodySnapshot: "SMS body stays out of inferred read claims",
      idempotencyKey: `sms-delivered-${randomUUID()}`,
      relatedType: "INVOICE",
      relatedId: invoiceA.id,
      createdAt: new Date("2026-07-15T18:00:00.000Z"),
      attemptedAt: new Date("2026-07-15T18:00:00.000Z"),
    },
  });
  await prisma.customerCommunication.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      channel: "EMAIL",
      purpose: "ESTIMATE_READY",
      status: "SENT",
      provider: "test",
      bodySnapshot: "Estimate email",
      idempotencyKey: `email-sent-${randomUUID()}`,
      relatedType: "ESTIMATE",
      relatedId: estimateA.id,
      createdAt: new Date("2026-07-05T17:05:00.000Z"),
      attemptedAt: new Date("2026-07-05T17:05:00.000Z"),
    },
  });
  await prisma.customerCommunication.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      channel: "EMAIL",
      purpose: "GENERAL",
      status: "SENT",
      provider: "test",
      bodySnapshot: "Foreign estimate link must not resolve",
      idempotencyKey: `foreign-link-${randomUUID()}`,
      relatedType: "ESTIMATE",
      relatedId: "est_from_other_tenant",
      createdAt: new Date("2026-07-16T12:00:00.000Z"),
      attemptedAt: new Date("2026-07-16T12:00:00.000Z"),
    },
  });
  await prisma.phoneInteraction.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      kind: "MISSED_CALL",
      status: "LOGGED",
      direction: "INBOUND",
      summary: "Missed call log",
      idempotencyKey: `phone-${randomUUID()}`,
      occurredAt: new Date("2026-07-17T13:00:00.000Z"),
    },
  });
  const siblingInvoice = await prisma.invoice.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerSibling.id,
      status: "PAID",
      paidAt: new Date("2026-07-18T15:00:00.000Z"),
      createdAt: new Date("2026-07-18T14:00:00.000Z"),
    },
  });
  await prisma.customerCommunication.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerSibling.id,
      channel: "SMS",
      purpose: "GENERAL",
      status: "DELIVERED",
      provider: "test",
      bodySnapshot: "Sibling secret SMS",
      idempotencyKey: `sibling-sms-${randomUUID()}`,
      createdAt: new Date("2026-07-18T16:00:00.000Z"),
      attemptedAt: new Date("2026-07-18T16:00:00.000Z"),
    },
  });

  const invoiceB = await prisma.invoice.create({
    data: {
      businessId: tenantB.business.id,
      customerId: customerB.id,
      status: "PAID",
      paidAt: new Date("2026-07-19T15:00:00.000Z"),
      createdAt: new Date("2026-07-19T14:00:00.000Z"),
    },
  });
  await prisma.customerCommunication.create({
    data: {
      businessId: tenantB.business.id,
      customerId: customerB.id,
      channel: "EMAIL",
      purpose: "GENERAL",
      status: "SENT",
      provider: "test",
      bodySnapshot: "Tenant B secret email",
      idempotencyKey: `tenant-b-${randomUUID()}`,
    },
  });
  await prisma.customerCommunication.create({
    data: {
      businessId: tenantB.business.id,
      customerId: customerA.id,
      channel: "EMAIL",
      purpose: "GENERAL",
      status: "SENT",
      provider: "test",
      bodySnapshot: "Dirty cross-tenant row",
      idempotencyKey: `dirty-${randomUUID()}`,
    },
  });

  await prisma.businessActionItem.create({
    data: {
      businessId: tenantA.business.id,
      recommendationKey: "cash-flow",
      title: "Call past-due invoices",
      status: "DONE",
      createdAt: new Date("2026-07-20T12:00:00.000Z"),
    },
  });
  await prisma.bsosRecommendationState.create({
    data: {
      businessId: tenantA.business.id,
      recommendationKey: "cash-flow",
      status: "COMPLETED",
      createdAt: new Date("2026-07-20T12:05:00.000Z"),
      history: [
        {
          status: "DISMISSED",
          at: "2026-07-19T12:00:00.000Z",
          evidenceKey: "old",
        },
      ],
    },
  });
  await prisma.businessVaultRecord.create({
    data: {
      businessId: tenantA.business.id,
      title: "General liability",
      category: "INSURANCE",
      createdByMembershipId: tenantA.membership.id,
      createdAt: new Date("2026-07-21T12:00:00.000Z"),
    },
  });

  const samePaidAt = new Date("2026-07-22T16:30:00.000Z");
  const sameInvoiceOne = await prisma.invoice.create({
    data: {
      id: "inv_same_aaa",
      businessId: tenantA.business.id,
      customerId: customerA.id,
      status: "PAID",
      paidAt: samePaidAt,
      createdAt: new Date("2026-07-22T10:00:00.000Z"),
    },
  });
  const sameInvoiceTwo = await prisma.invoice.create({
    data: {
      id: "inv_same_zzz",
      businessId: tenantA.business.id,
      customerId: customerA.id,
      status: "PAID",
      paidAt: samePaidAt,
      createdAt: new Date("2026-07-22T11:00:00.000Z"),
    },
  });

  console.log("\nDB — Mixed chronology, timezone, and recorded truth");
  const timeline = await loadBusinessTimeline(prisma, tenantA.access, { since: FAR_SINCE });
  const ids = timeline.items.map((item) => item.id);
  const descriptions = timeline.items.map((item) => item.description);
  const paidItem = timeline.items.find((item) => item.id === `invoice:${invoiceA.id}:paid`);
  const smsItem = timeline.items.find((item) => item.description.includes("SMS status recorded as DELIVERED"));
  const sentOnlyEstimateEvents = timeline.items.filter(
    (item) => item.relatedId === estimateSentOnly.id && item.eventType === "ESTIMATE_SENT",
  );
  const paidWithoutStampEvents = timeline.items.filter(
    (item) => item.id === `invoice:${invoicePaidWithoutStamp.id}:paid`,
  );
  const sentOnlyInvoiceMessage = timeline.items.filter(
    (item) =>
      item.relatedId === invoiceSentOnly.id &&
      (item.eventType === "COMMUNICATION_RECORDED" || item.eventType === "INVOICE_SENT"),
  );

  check("Loader uses Business.timezone", timeline.timeZone === "America/Los_Angeles");
  check(
    "Stored paid instant stays UTC",
    paidItem?.occurredAt === "2026-07-12T22:42:00.000Z",
  );
  const displayedLa = formatDateTime(new Date(paidItem.occurredAt), timeline.timeZone);
  const displayedNy = formatDateTime(new Date(paidItem.occurredAt), "America/New_York");
  check("Business timezone formatting differs from another zone", displayedLa !== displayedNy);
  check(
    "Invoice paid description is a recorded fact",
    paidItem?.description.includes("was marked paid") &&
      !paidItem.description.toLowerCase().includes("happy"),
  );
  check("SMS delivery stays at recorded status", smsItem?.sourceStatus === "DELIVERED");
  check(
    "SMS copy does not claim the customer read the text",
    smsItem?.description === "SMS status recorded as DELIVERED." &&
      !descriptions.some((text) => text.toLowerCase().includes("customer read")),
  );
  check(
    "Estimate.status SENT without a sent version does not fabricate a send",
    sentOnlyEstimateEvents.length === 0,
  );
  check(
    "Invoice.status PAID without paidAt does not fabricate a paid event",
    paidWithoutStampEvents.length === 0,
  );
  check(
    "Invoice.status SENT does not fabricate a message or send event",
    sentOnlyInvoiceMessage.length === 0,
  );
  check(
    "Job.status COMPLETED is only a timeline event when BusinessEvent JOB_COMPLETED exists",
    timeline.items.some((item) => item.id === `business-event:${jobCompletedEvent.id}`),
  );
  check(
    "Recommendation copy is not labeled AI-originated",
    descriptions.some((text) => text.includes('Recommendation state "cash-flow" was recorded.')) &&
      !descriptions.some((text) => text.toLowerCase().includes("ai")),
  );
  check(
    "Recommendation history uses recorded at+status only",
    timeline.items.some(
      (item) =>
        item.eventType === "RECOMMENDATION_STATUS_RECORDED" &&
        item.description === "Recommendation status recorded as DISMISSED.",
    ),
  );
  check(
    "Newest-first mixed order puts vault ahead of older request",
    ids.indexOf(
      timeline.items.find((item) => item.eventType === "VAULT_RECORD_RECORDED")?.id,
    ) < ids.indexOf(`request:${requestA.id}:recorded`),
  );
  check(
    "Payment is newer than invoice recorded",
    ids.indexOf(`payment:${paymentA.id}:recorded`) < ids.indexOf(`invoice:${invoiceA.id}:recorded`),
  );
  const samePaid = timeline.items.filter((item) => item.occurredAt === samePaidAt.toISOString());
  check(
    "Same paidAt invoices stay in deterministic id order",
    samePaid.length === 2 &&
      samePaid[0].id === `invoice:${sameInvoiceOne.id}:paid` &&
      samePaid[1].id === `invoice:${sameInvoiceTwo.id}:paid`,
  );
  check(
    "Owned invoice/estimate/job/change-order links resolve",
    paidItem?.relatedHref === `/invoices/${invoiceA.id}` &&
      timeline.items.find((item) => item.id === `estimate:${estimateA.id}:recorded`)?.relatedHref ===
        `/estimates/${estimateA.id}` &&
      timeline.items.find((item) => item.id === `job:${jobA.id}:recorded`)?.relatedHref ===
        `/jobs/${jobA.id}` &&
      timeline.items.find((item) => item.id === `change-order:${changeOrderA.id}:approved`)
        ?.relatedHref === `/jobs/${jobA.id}/change-orders/${changeOrderA.id}`,
  );
  check(
    "Foreign related estimate id does not get a link",
    timeline.items.find((item) => item.description.includes("Foreign estimate link"))
      ?.relatedHref === null,
  );

  console.log("\nDB — Isolation and customer filter");
  let foreignCustomerDenied = false;
  try {
    await loadBusinessTimeline(prisma, tenantA.access, {
      since: FAR_SINCE,
      customerId: customerB.id,
    });
  } catch (error) {
    foreignCustomerDenied = error instanceof ForbiddenError;
  }
  check("Foreign tenant customer fails closed", foreignCustomerDenied);

  let memberDenied = false;
  try {
    await loadBusinessTimeline(prisma, tenantA.memberAccess, { since: FAR_SINCE });
  } catch (error) {
    memberDenied = error instanceof ForbiddenError;
  }
  check("MEMBER cannot read the business timeline", memberDenied);

  const filtered = await loadBusinessTimeline(prisma, tenantA.access, {
    since: FAR_SINCE,
    customerId: customerA.id,
  });
  check(
    "Customer filter keeps Ava events",
    filtered.items.some((item) => item.id === `invoice:${invoiceA.id}:paid`) &&
      filtered.customerId === customerA.id,
  );
  check(
    "Same-business sibling customer does not leak into the filtered view",
    filtered.items.every((item) => item.id !== `invoice:${siblingInvoice.id}:paid`) &&
      filtered.items.every((item) => !item.description.includes("Sibling secret")) &&
      filtered.items.every((item) => item.customerId === customerA.id),
  );
  check(
    "Foreign tenant rows do not leak",
    timeline.items.every((item) => item.id !== `invoice:${invoiceB.id}:paid`) &&
      timeline.items.every((item) => !item.description.includes("Tenant B secret")) &&
      timeline.items.every((item) => !item.description.includes("Dirty cross-tenant")),
  );

  const tenantBTimeline = await loadBusinessTimeline(prisma, tenantB.access, { since: FAR_SINCE });
  check(
    "Tenant B stays on its own rows and timezone",
    tenantBTimeline.timeZone === "America/New_York" &&
      tenantBTimeline.items.some((item) => item.id === `invoice:${invoiceB.id}:paid`) &&
      tenantBTimeline.items.every((item) => item.id !== `invoice:${invoiceA.id}:paid`),
  );

  console.log("\nDB — Bounded read");
  const extraStart = new Date("2026-08-01T00:00:00.000Z");
  for (let index = 0; index < BUSINESS_TIMELINE_LIMIT + 5; index += 1) {
    await prisma.invoice.create({
      data: {
        businessId: tenantA.business.id,
        customerId: customerA.id,
        status: "PAID",
        paidAt: new Date(extraStart.getTime() + index * 60_000),
        createdAt: new Date(extraStart.getTime() + index * 60_000),
      },
    });
  }
  const bounded = await loadBusinessTimeline(prisma, tenantA.access, {
    since: extraStart,
    category: "money",
  });
  check("Bounded limit is enforced", bounded.items.length === BUSINESS_TIMELINE_LIMIT);
  check("Truncated flag is set when the window overflows", bounded.truncated === true);
  check(
    "Bounded window still newest-first",
    bounded.items.every((item, index) => {
      if (index === 0) return true;
      return item.occurredAt <= bounded.items[index - 1].occurredAt;
    }),
  );

  const lookbackNow = new Date("2026-09-26T12:00:00.000Z");
  await prisma.invoice.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      status: "PAID",
      paidAt: new Date("2026-04-01T12:00:00.000Z"),
      createdAt: new Date("2026-04-01T12:00:00.000Z"),
    },
  });
  const recentPaid = await prisma.invoice.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      status: "PAID",
      paidAt: new Date("2026-09-20T12:00:00.000Z"),
      createdAt: new Date("2026-09-20T12:00:00.000Z"),
    },
  });
  const lookback = await loadBusinessTimeline(prisma, tenantA.access, {
    now: lookbackNow,
    category: "money",
    customerId: customerA.id,
  });
  check(
    "Default lookback excludes older-than-window invoices",
    lookback.items.every((item) => item.occurredAt >= lookback.since) &&
      lookback.items.some((item) => item.id === `invoice:${recentPaid.id}:paid`) &&
      !lookback.items.some((item) => item.occurredAt === "2026-04-01T12:00:00.000Z"),
  );
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
