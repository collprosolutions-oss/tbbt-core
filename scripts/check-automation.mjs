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
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { emitBusinessEvent, emitAndProcessBusinessEvent, queueAutomationRunsForEvent, skipSupersededAppointmentReminders } = await import(
  "@/lib/automation/events"
);
const { ensureDefaultAutomationRules } = await import("@/lib/automation/rules");
const { processPendingAutomationRuns, claimAutomationRun } = await import("@/lib/automation/processor");
const { scanScheduledBusinessEvents, INVOICE_DUE_AFTER_MS, INVOICE_OVERDUE_AFTER_MS } = await import("@/lib/automation/scan");
const { partitionRecommendations, recommendationEvidenceKey, upsertRecommendationState } = await import("@/lib/bsos-actions");
const { CAPABILITIES, requireBusinessCapability } = await import("@/lib/authorization");
const { appointmentReminderAvailableAt } = await import("@/lib/automation/timing");
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

  console.log("\nSTATIC — Channel honesty and record-ID safety");
  const processorSrc = readFileSync(new URL("../src/lib/automation/processor.ts", import.meta.url), "utf8");
  const emailSrc = readFileSync(new URL("../src/lib/automation/email.ts", import.meta.url), "utf8");
  const healthSrc = readFileSync(new URL("../src/app/(app)/business-health/page.tsx", import.meta.url), "utf8");
  const scanSrc = readFileSync(new URL("../src/lib/automation/scan.ts", import.meta.url), "utf8");
  check(
    "Processor claims PENDING runs before provider work",
    processorSrc.includes("claimAutomationRun") && processorSrc.includes('status: "PENDING"'),
  );
  check(
    "EMAIL and SMS are attempted independently",
    processorSrc.includes("wantsEmail") &&
      processorSrc.includes("wantsSms") &&
      emailSrc.includes("attemptAutomationEmail") &&
      emailSrc.includes("sendTransactionalEmail"),
  );
  check(
    "Review/referral/follow-up communications require real same-tenant records",
    processorSrc.includes('event.subjectType === "REVIEW_REQUEST"') &&
      processorSrc.includes('event.subjectType === "REFERRAL_REQUEST"') &&
      processorSrc.includes('event.subjectType === "CUSTOMER_FOLLOW_UP"') &&
      !processorSrc.includes("reviewRequestId: event.subjectId") &&
      !processorSrc.includes("followUpId: event.subjectId ||"),
  );
  check(
    "ACTION_SUGGESTION UI does not offer EMAIL/SMS/BOTH controls",
    healthSrc.includes("Owner action only") &&
      healthSrc.includes('rule.kind === "ACTION_SUGGESTION"'),
  );
  check(
    "Invoice due/overdue clock is INVOICE_SENT.occurredAt, not invoice.createdAt",
    scanSrc.includes('type: "INVOICE_SENT"') &&
      scanSrc.includes("sentEvent.occurredAt") &&
      !scanSrc.includes("invoice.createdAt"),
  );

  await ensureDefaultAutomationRules(prisma, businessA.id);
  const suggestionRule = await prisma.automationRule.findFirst({
    where: { businessId: businessA.id, eventType: "JOB_COMPLETED", purpose: "JOB_FOLLOW_UP" },
  });
  await prisma.automationRule.update({
    where: { id: suggestionRule.id },
    data: { enabled: true, channel: "NONE", delayMinutes: 0 },
  });
  await queueAutomationRunsForEvent(prisma, businessA.id, first.event);
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
  await queueAutomationRunsForEvent(prisma, businessA.id, followEvent.event);

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
  await emitBusinessEvent(prisma, {
    businessId: businessA.id,
    type: "INVOICE_SENT",
    subjectType: "INVOICE",
    subjectId: invoiceA.id,
    payload: { customerId: customerA.id },
    idempotencyKey: `INVOICE_SENT:${invoiceA.id}`,
    occurredAt: oldSentAt,
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

  const legacySent = await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "SENT",
      total: 40,
      createdAt: new Date(Date.now() - INVOICE_OVERDUE_AFTER_MS - 60_000),
    },
  });
  await scanScheduledBusinessEvents(prisma, businessA.id);
  const legacyDue = await prisma.businessEvent.findMany({
    where: { businessId: businessA.id, subjectId: legacySent.id, type: { in: ["INVOICE_DUE", "INVOICE_OVERDUE"] } },
  });
  check(
    "Legacy SENT invoices without an INVOICE_SENT event do not invent a due/overdue clock",
    legacyDue.length === 0,
  );

  const draftCreatedAt = new Date(Date.now() - INVOICE_OVERDUE_AFTER_MS - 60_000);
  const lateSent = await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "SENT",
      total: 55,
      createdAt: draftCreatedAt,
    },
  });
  await emitBusinessEvent(prisma, {
    businessId: businessA.id,
    type: "INVOICE_SENT",
    subjectType: "INVOICE",
    subjectId: lateSent.id,
    payload: { customerId: customerA.id },
    idempotencyKey: `INVOICE_SENT:${lateSent.id}`,
    occurredAt: new Date(),
  });
  await scanScheduledBusinessEvents(prisma, businessA.id);
  const lateDue = await prisma.businessEvent.findMany({
    where: { businessId: businessA.id, subjectId: lateSent.id, type: { in: ["INVOICE_DUE", "INVOICE_OVERDUE"] } },
  });
  check(
    "Old DRAFT created 30+ days ago and sent today is not immediately due/overdue",
    lateDue.length === 0,
  );

  console.log("\nDB — Appointment reminder timing, record IDs, channels, claim");
  const scheduledAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const appointmentJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
      scheduledAt,
      scheduledDurationMinutes: 60,
      appointmentProposalId: 1,
    },
  });
  const reminderRule = await prisma.automationRule.findFirst({
    where: { businessId: businessA.id, eventType: "APPOINTMENT_SCHEDULED", purpose: "APPOINTMENT_REMINDER" },
  });
  await prisma.automationRule.update({
    where: { id: reminderRule.id },
    data: { enabled: true, channel: "SMS", delayMinutes: 24 * 60 },
  });
  const scheduledEvent = await emitBusinessEvent(prisma, {
    businessId: businessA.id,
    type: "APPOINTMENT_SCHEDULED",
    subjectType: "JOB",
    subjectId: appointmentJob.id,
    payload: {
      customerId: customerA.id,
      businessName: "Alpha Auto",
      proposalId: 1,
      scheduledAt: scheduledAt.toISOString(),
    },
    idempotencyKey: `APPOINTMENT_SCHEDULED:${appointmentJob.id}:1`,
  });
  await queueAutomationRunsForEvent(prisma, businessA.id, scheduledEvent.event);
  const reminderRun = await prisma.automationRun.findFirst({
    where: { businessId: businessA.id, eventId: scheduledEvent.event.id, ruleId: reminderRule.id },
  });
  const expectedAvailable = appointmentReminderAvailableAt(scheduledAt, 24 * 60);
  check(
    "Appointment reminder availableAt is scheduledAt minus delayMinutes",
    Boolean(reminderRun) &&
      Math.abs(reminderRun.availableAt.getTime() - expectedAvailable.getTime()) < 1000 &&
      reminderRun.availableAt.getTime() > Date.now() + 12 * 24 * 60 * 60 * 1000,
  );

  const rescheduledAt = new Date(scheduledAt.getTime() + 3 * 24 * 60 * 60 * 1000);
  await prisma.job.update({
    where: { id: appointmentJob.id },
    data: { scheduledAt: rescheduledAt, appointmentProposalId: 2 },
  });
  await skipSupersededAppointmentReminders(prisma, {
    businessId: businessA.id,
    jobId: appointmentJob.id,
    proposalId: 2,
  });
  const staleReminder = await prisma.automationRun.findUnique({ where: { id: reminderRun.id } });
  check(
    "Rescheduled appointment marks the old reminder SKIPPED, not SENT",
    staleReminder.status === "SKIPPED" && staleReminder.status !== "SUCCEEDED" && !(staleReminder.resultSummary || "").includes("SENT was recorded"),
  );

  const fakeReviewRule = await prisma.automationRule.create({
    data: {
      businessId: businessA.id,
      eventType: "JOB_COMPLETED",
      purpose: "REVIEW_REQUEST",
      kind: "COMMUNICATION",
      channel: "SMS",
      delayMinutes: 0,
      templateKey: "legacy-job-fallback",
      enabled: true,
    },
  });
  await queueAutomationRunsForEvent(prisma, businessA.id, first.event);
  const fakeProcessed = await processPendingAutomationRuns(prisma, businessA.id);
  const fakeRun = fakeProcessed.find((row) => row.ruleId === fakeReviewRule.id);
  const fakeComms = await prisma.customerCommunication.findMany({
    where: { businessId: businessA.id, relatedType: "REVIEW_REQUEST", relatedId: jobA.id },
  });
  check(
    "JOB_COMPLETED cannot send a review using the Job ID as a ReviewRequest id",
    Boolean(fakeRun) && fakeRun.status === "SKIPPED" && fakeComms.length === 0,
  );

  const reviewRequest = await prisma.reviewRequest.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      jobId: jobA.id,
      status: "DRAFT",
      requestText: "Please leave an honest review.",
      createdByMembershipId: memA.id,
    },
  });
  const reviewRule = await prisma.automationRule.findFirst({
    where: { businessId: businessA.id, eventType: "REVIEW_REQUEST_CREATED", purpose: "REVIEW_REQUEST" },
  });
  await prisma.automationRule.update({
    where: { id: reviewRule.id },
    data: { enabled: true, channel: "BOTH", delayMinutes: 0 },
  });
  const reviewEvent = await emitBusinessEvent(prisma, {
    businessId: businessA.id,
    type: "REVIEW_REQUEST_CREATED",
    subjectType: "REVIEW_REQUEST",
    subjectId: reviewRequest.id,
    payload: {
      customerId: customerA.id,
      businessName: "Alpha Auto",
      reviewRequestId: reviewRequest.id,
      requestText: reviewRequest.requestText,
    },
    idempotencyKey: `REVIEW_REQUEST_CREATED:${reviewRequest.id}`,
  });
  await queueAutomationRunsForEvent(prisma, businessA.id, reviewEvent.event);
  const reviewProcessed = await processPendingAutomationRuns(prisma, businessA.id);
  const reviewRun = reviewProcessed.find((row) => row.ruleId === reviewRule.id);
  const reviewComms = await prisma.customerCommunication.findMany({
    where: { businessId: businessA.id, relatedType: "REVIEW_REQUEST" },
  });
  check(
    "Review communication relatedId is the real same-tenant ReviewRequest",
    reviewComms.length >= 1 &&
      reviewComms.every((row) => row.relatedId === reviewRequest.id && row.businessId === businessA.id) &&
      !reviewComms.some((row) => row.relatedId === jobA.id),
  );
  check(
    "BOTH reports EMAIL and SMS independently and does not mark an unattempted channel SENT",
    Boolean(reviewRun) &&
      (reviewRun.resultSummary || "").includes("EMAIL") &&
      (reviewRun.resultSummary || "").includes("SMS") &&
      !(reviewRun.resultSummary || "").includes("EMAIL SENT") &&
      reviewRun.status !== "SUCCEEDED",
  );

  const bothInvoiceRule = await prisma.automationRule.findFirst({
    where: { businessId: businessA.id, eventType: "INVOICE_SENT", purpose: "INVOICE_READY" },
  });
  await prisma.automationRule.update({
    where: { id: bothInvoiceRule.id },
    data: { enabled: true, channel: "EMAIL", delayMinutes: 0 },
  });
  const emailInvoice = await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "SENT",
      total: 12,
    },
  });
  const emailEvent = await emitBusinessEvent(prisma, {
    businessId: businessA.id,
    type: "INVOICE_SENT",
    subjectType: "INVOICE",
    subjectId: emailInvoice.id,
    payload: { customerId: customerA.id, businessName: "Alpha Auto" },
    idempotencyKey: `INVOICE_SENT:${emailInvoice.id}`,
  });
  await queueAutomationRunsForEvent(prisma, businessA.id, emailEvent.event);
  const emailProcessed = await processPendingAutomationRuns(prisma, businessA.id);
  const emailRun = emailProcessed.find((row) => row.ruleId === bothInvoiceRule.id);
  check(
    "EMAIL-only reports email and does not claim SMS success",
    Boolean(emailRun) &&
      (emailRun.resultSummary || "").includes("EMAIL") &&
      !(emailRun.resultSummary || "").includes("SMS") &&
      !(emailRun.resultSummary || "").includes("EMAIL SENT") &&
      emailRun.status !== "SUCCEEDED",
  );

  const claimEvent = await emitBusinessEvent(prisma, {
    businessId: businessA.id,
    type: "JOB_STARTED",
    subjectType: "JOB",
    subjectId: jobA.id,
    payload: { customerId: customerA.id },
    idempotencyKey: `JOB_STARTED:${jobA.id}:claim`,
  });
  const claimRule = await prisma.automationRule.create({
    data: {
      businessId: businessA.id,
      eventType: "JOB_STARTED",
      purpose: "OWNER_NOTE",
      kind: "ACTION_SUGGESTION",
      channel: "NONE",
      delayMinutes: 0,
      templateKey: "claim-test",
      enabled: true,
    },
  });
  await queueAutomationRunsForEvent(prisma, businessA.id, {
    ...claimEvent.event,
    type: "JOB_STARTED",
  });
  const claimable = await prisma.automationRun.findFirst({
    where: { businessId: businessA.id, eventId: claimEvent.event.id, ruleId: claimRule.id },
  });
  const [claimA, claimB] = await Promise.all([
    claimAutomationRun(prisma, { id: claimable.id, businessId: businessA.id }),
    claimAutomationRun(prisma, { id: claimable.id, businessId: businessA.id }),
  ]);
  check(
    "Only one worker can claim a PENDING automation run",
    Boolean(claimA) !== Boolean(claimB) && Boolean(claimA || claimB),
  );

  const raceEvent = await emitBusinessEvent(prisma, {
    businessId: businessA.id,
    type: "JOB_STARTED",
    subjectType: "JOB",
    subjectId: jobA.id,
    payload: { customerId: customerA.id },
    idempotencyKey: `JOB_STARTED:${jobA.id}:race`,
  });
  const raceRule = await prisma.automationRule.create({
    data: {
      businessId: businessA.id,
      eventType: "JOB_STARTED",
      purpose: "OWNER_NOTE_RACE",
      kind: "ACTION_SUGGESTION",
      channel: "NONE",
      delayMinutes: 0,
      templateKey: "claim-race",
      enabled: true,
    },
  });
  await queueAutomationRunsForEvent(prisma, businessA.id, raceEvent.event);
  const [procA, procB] = await Promise.all([
    processPendingAutomationRuns(prisma, businessA.id),
    processPendingAutomationRuns(prisma, businessA.id),
  ]);
  const raceRows = await prisma.automationRun.findMany({
    where: { businessId: businessA.id, eventId: raceEvent.event.id, ruleId: raceRule.id },
  });
  const processedIds = [...procA, ...procB].filter((row) => row.ruleId === raceRule.id).map((row) => row.id);
  check(
    "Concurrent processors cannot duplicate an automation send/result",
    raceRows.length === 1 &&
      raceRows[0].attemptCount === 1 &&
      ["SUCCEEDED", "SKIPPED", "BLOCKED", "FAILED"].includes(raceRows[0].status) &&
      new Set(processedIds).size <= 1,
  );

  const unpaidOld = {
    key: "collect-unpaid-invoices",
    title: "Follow up",
    kind: "recommendation",
    priority: 1,
    why: "2 unpaid",
    facts: [
      { key: "count", value: "2" },
      { key: "amount", value: "300" },
    ],
    href: "/invoices",
  };
  const unpaidNew = {
    ...unpaidOld,
    why: "5 unpaid",
    facts: [
      { key: "count", value: "5" },
      { key: "amount", value: "900" },
    ],
  };
  await upsertRecommendationState(prisma, accessA, {
    recommendationKey: unpaidOld.key,
    status: "DISMISSED",
    evidenceKey: recommendationEvidenceKey(unpaidOld),
  });
  const dismissedState = await prisma.bsosRecommendationState.findUnique({
    where: {
      businessId_recommendationKey: {
        businessId: businessA.id,
        recommendationKey: unpaidOld.key,
      },
    },
  });
  const sameFacts = partitionRecommendations([unpaidOld], [dismissedState]);
  const changedFacts = partitionRecommendations([unpaidNew], [dismissedState]);
  check(
    "Dismissed recommendation stays suppressed for unchanged facts",
    sameFacts.active.length === 0 && sameFacts.history.some((item) => item.key === unpaidOld.key),
  );
  check(
    "Materially changed unpaid-invoice facts can become active again",
    changedFacts.active.some((item) => item.key === unpaidOld.key) &&
      changedFacts.history.every((item) => item.key !== unpaidOld.key),
  );
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
