/**
 * Durable business-event / automation isolation and honesty proofs.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-automation.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { emitBusinessEvent, emitAndProcessBusinessEvent, queueAutomationRunsForEvent } = await import(
  "@/lib/automation/events"
);
const { ensureDefaultAutomationRules } = await import("@/lib/automation/rules");
const { processPendingAutomationRuns } = await import("@/lib/automation/processor");
const { scanScheduledBusinessEvents, INVOICE_DUE_AFTER_MS } = await import("@/lib/automation/scan");
const { partitionRecommendations, upsertRecommendationState } = await import("@/lib/bsos-actions");
const { CAPABILITIES, requireBusinessCapability } = await import("@/lib/authorization");
const { BUSINESS_EVENT_TYPES } = await import("@/lib/automation/types");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_automation_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) process.exit(push.status ?? 1);

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  ok  - ${label}`);
  else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: { role, membership: { id: membershipId }, user: { id: "u" } },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

try {
  const ownerA = await prisma.user.create({
    data: { name: "A Auto", email: `a-auto-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerB = await prisma.user.create({
    data: { name: "B Auto", email: `b-auto-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const businessA = await prisma.business.create({
    data: { name: "Alpha Auto", slug: `alpha-auto-${randomUUID()}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Auto", slug: `beta-auto-${randomUUID()}`, tradeCode: "HANDYMAN" },
  });
  const memA = await prisma.membership.create({
    data: { userId: ownerA.id, businessId: businessA.id, role: "OWNER" },
  });
  const memB = await prisma.membership.create({
    data: { userId: ownerB.id, businessId: businessB.id, role: "OWNER" },
  });
  const customerA = await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: "Cara",
      phone: "5551112222",
      smsConsentStatus: "REVOKED",
    },
  });
  const jobA = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      projectToken: randomUUID(),
      status: "COMPLETED",
    },
  });

  console.log("\nDB — Events, idempotency, isolation, consent, recommendations");

  const first = await emitBusinessEvent(prisma, {
    businessId: businessA.id,
    type: "JOB_COMPLETED",
    subjectType: "JOB",
    subjectId: jobA.id,
    payload: { customerId: customerA.id, businessName: "Alpha Auto" },
    idempotencyKey: `JOB_COMPLETED:${jobA.id}`,
  });
  const second = await emitBusinessEvent(prisma, {
    businessId: businessA.id,
    type: "JOB_COMPLETED",
    subjectType: "JOB",
    subjectId: jobA.id,
    payload: { customerId: customerA.id },
    idempotencyKey: `JOB_COMPLETED:${jobA.id}`,
  });
  check("Duplicate event processing is idempotent", first.created === true && second.created === false && first.event.id === second.event.id);

  const bEvents = await prisma.businessEvent.findMany({ where: { businessId: businessB.id } });
  check("Business A events do not appear on business B", bEvents.length === 0);

  const forged = await prisma.businessEvent.findMany({
    where: { businessId: businessB.id, id: first.event.id },
  });
  check("Business B cannot consume business A automation events", forged.length === 0);

  await ensureDefaultAutomationRules(prisma, businessA.id);
  const smsRule = await prisma.automationRule.findFirst({
    where: { businessId: businessA.id, purpose: "JOB_FOLLOW_UP" },
  });
  await prisma.automationRule.update({
    where: { id: smsRule.id },
    data: { enabled: true, channel: "SMS", delayMinutes: 0 },
  });
  await queueAutomationRunsForEvent(prisma, businessA.id, first.event.id, "JOB_COMPLETED", new Date());
  const followUp = await prisma.customerFollowUp.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      jobId: jobA.id,
      kind: "JOB_COMPLETE",
      status: "OPEN",
      createdByMembershipId: memA.id,
    },
  });
  const followEvent = await emitBusinessEvent(prisma, {
    businessId: businessA.id,
    type: "CUSTOMER_FOLLOW_UP_DUE",
    subjectType: "CUSTOMER_FOLLOW_UP",
    subjectId: followUp.id,
    payload: { customerId: customerA.id, businessName: "Alpha Auto", followUpId: followUp.id },
    idempotencyKey: `CUSTOMER_FOLLOW_UP_DUE:${followUp.id}`,
  });
  const followRule = await prisma.automationRule.findFirst({
    where: { businessId: businessA.id, purpose: "REPEAT_FOLLOW_UP" },
  });
  await prisma.automationRule.update({
    where: { id: followRule.id },
    data: { enabled: true, channel: "SMS", delayMinutes: 0 },
  });
  await queueAutomationRunsForEvent(
    prisma,
    businessA.id,
    followEvent.event.id,
    "CUSTOMER_FOLLOW_UP_DUE",
    new Date(),
  );

  const processed = await processPendingAutomationRuns(prisma, businessA.id);
  const comms = await prisma.customerCommunication.findMany({ where: { businessId: businessA.id } });
  check(
    "Revoked SMS consent prevents SMS action",
    comms.every((row) => row.status === "BLOCKED" || row.status === "NOT_SENT") &&
      !comms.some((row) => row.status === "SENT"),
  );
  check(
    "Communication automation does not mark SENT on provider failure or block",
    processed.every((row) => row.status !== "SUCCEEDED" || (row.resultSummary || "").includes("No message was sent") || (row.resultSummary || "").includes("accepted")) &&
      !comms.some((row) => row.status === "SENT"),
  );

  const jobStillThere = await prisma.job.findUniqueOrThrow({ where: { id: jobA.id } });
  check("Provider/consent failure does not destroy the completed job", jobStillThere.status === "COMPLETED");

  const accessA = makeAccess(businessA.id, "OWNER", memA.id);
  const accessB = makeAccess(businessB.id, "OWNER", memB.id);
  await upsertRecommendationState(prisma, accessA, {
    recommendationKey: "collect-unpaid-invoices",
    status: "DISMISSED",
  });
  const aState = await prisma.bsosRecommendationState.findMany({ where: { businessId: businessA.id } });
  const bState = await prisma.bsosRecommendationState.findMany({ where: { businessId: businessB.id } });
  check("Recommendation/action history is business-scoped", aState.length === 1 && bState.length === 0);

  const partitioned = partitionRecommendations(
    [
      { key: "collect-unpaid-invoices", title: "Follow up", kind: "recommendation", priority: 1, why: "x", facts: [], href: "/invoices" },
      { key: "request-reviews", title: "Reviews", kind: "recommendation", priority: 2, why: "y", facts: [], href: "/reviews" },
    ],
    aState,
  );
  check(
    "Dismissed recommendations leave the active list",
    partitioned.active.every((item) => item.key !== "collect-unpaid-invoices") &&
      partitioned.history.some((item) => item.key === "collect-unpaid-invoices"),
  );

  let memberBlocked = false;
  try {
    requireBusinessCapability(makeAccess(businessA.id, "MEMBER", memA.id), CAPABILITIES.VIEW_REPORTS);
  } catch {
    memberBlocked = true;
  }
  check("MEMBER cannot use VIEW_REPORTS coach/actions", memberBlocked);

  await emitAndProcessBusinessEvent(prisma, {
    businessId: businessB.id,
    type: "INVOICE_PAID",
    subjectType: "INVOICE",
    subjectId: "missing",
    idempotencyKey: `INVOICE_PAID:missing-b`,
  });
  const aRuns = await prisma.automationRun.findMany({ where: { businessId: businessA.id } });
  const bRuns = await prisma.automationRun.findMany({ where: { businessId: businessB.id } });
  check("Automation runs never cross tenants", aRuns.every((row) => row.businessId === businessA.id) && bRuns.every((row) => row.businessId === businessB.id));

  check(
    "Catalog includes request, estimate, job, invoice, review, and follow-up events",
    [
      "REQUEST_CREATED",
      "ESTIMATE_SENT",
      "ESTIMATE_APPROVED",
      "APPOINTMENT_SCHEDULED",
      "APPOINTMENT_CHANGED",
      "JOB_STARTED",
      "JOB_COMPLETED",
      "INVOICE_SENT",
      "INVOICE_DUE",
      "INVOICE_OVERDUE",
      "INVOICE_PAID",
      "REVIEW_OPPORTUNITY_CREATED",
      "REFERRAL_OPPORTUNITY_CREATED",
      "CUSTOMER_FOLLOW_UP_DUE",
    ].every((type) => BUSINESS_EVENT_TYPES.includes(type)),
  );

  const oldSentAt = new Date(Date.now() - INVOICE_DUE_AFTER_MS - 60_000);
  const invoiceA = await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "SENT",
      total: 80,
      createdAt: oldSentAt,
    },
  });
  const invoiceB = await prisma.invoice.create({
    data: {
      businessId: businessB.id,
      status: "SENT",
      total: 999,
      createdAt: oldSentAt,
    },
  });
  await scanScheduledBusinessEvents(prisma, businessA.id);
  const aDue = await prisma.businessEvent.findMany({
    where: { businessId: businessA.id, type: "INVOICE_DUE" },
  });
  const bDue = await prisma.businessEvent.findMany({
    where: { businessId: businessB.id, type: "INVOICE_DUE" },
  });
  check(
    "Sent-age scan emits INVOICE_DUE only for the scanned business",
    aDue.some((row) => row.subjectId === invoiceA.id) &&
      !aDue.some((row) => row.subjectId === invoiceB.id) &&
      bDue.length === 0,
  );
  await scanScheduledBusinessEvents(prisma, businessA.id);
  const aDueAgain = await prisma.businessEvent.findMany({
    where: { businessId: businessA.id, type: "INVOICE_DUE", subjectId: invoiceA.id },
  });
  check("Invoice due scan is idempotent", aDueAgain.length === 1);
} finally {
  await prisma.$disconnect();
  spawnSync("psql", [baseUrl, "-c", `DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE);`], {
    stdio: "ignore",
  });
}

if (failures > 0) {
  console.error(`\n${failures} automation check(s) failed.`);
  process.exit(1);
}
console.log("\nAutomation checks passed.");
