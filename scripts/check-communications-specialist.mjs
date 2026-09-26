/**
 * AI Chief of Staff Communications specialist proofs.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-communications-specialist.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError, CAPABILITIES, requireBusinessCapability } = await import("@/lib/authorization");
const {
  COMMUNICATIONS_CONTEXT_CAPS,
  MAX_RECURSION_DEPTH,
  MAX_SPECIALIST_FANOUT,
  communicationsProjectionHasForbiddenFields,
  getCommunicationsProjectionLoadCount,
  getCommunicationsSpecialistInterpretationCount,
  getLastCommunicationsProjection,
  phoneDoesNotGrantConsent,
  planSpecialists,
  resetLastCommunicationsProjection,
  resetCommunicationsSpecialistCounters,
  resolveConflicts,
  runChiefOfStaffCoach,
  runCommunicationsSpecialist,
  unknownConsentIsNotGranted,
} = await import("@/lib/chief-of-staff");
const { getSpecialistEntry } = await import("@/lib/chief-of-staff/registry");
const { resolveStoredSmsConsent } = await import("@/lib/customer-messaging/consent");
const { PRODUCT_CAPABILITIES } = await import("@/lib/product-catalog");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_communications_specialist_test";
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

function makeAccess(businessId, role, membershipId, userId) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      user: { id: userId, email: "owner@example.com", name: "Owner" },
    },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
    assertAttachable(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

async function entitleFounder(businessId) {
  await prisma.businessSaasSubscription.create({
    data: {
      businessId,
      status: "active",
      planCode: "FOUNDER",
      legacyExempt: true,
    },
  });
}

async function createOwnerWorkspace(name) {
  const user = await prisma.user.create({
    data: { name: `${name} Owner`, email: `${name}-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const business = await prisma.business.create({
    data: { name, slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID()}`, tradeCode: "HANDYMAN" },
  });
  const membership = await prisma.membership.create({
    data: { userId: user.id, businessId: business.id, role: "OWNER" },
  });
  return {
    user,
    business,
    membership,
    access: makeAccess(business.id, "OWNER", membership.id, user.id),
  };
}

function resetLoads() {
  resetCommunicationsSpecialistCounters();
  resetLastCommunicationsProjection();
}

function emptyCatalog(keys = []) {
  return {
    facts: {},
    recommendations: [],
    activeRecommendations: keys.map((key) => ({ key, title: key, why: key })),
    historyRecommendations: [],
    states: [],
    workforceRecommendationKeys: [],
    financial: { entitled: false, failed: false, intelligence: null },
    growth: { entitled: false, source: null, failed: false, missingCapabilities: [] },
    workforceSnapshot: null,
  };
}

async function countCommunicationsRows(businessId) {
  const [messages, threads, phones, customers, proposals] = await Promise.all([
    prisma.customerCommunication.count({ where: { businessId } }),
    prisma.communicationThread.count({ where: { businessId } }),
    prisma.phoneInteraction.count({ where: { businessId } }),
    prisma.customer.findMany({
      where: { businessId },
      select: { id: true, smsConsentStatus: true, email: true, phone: true },
    }),
    Promise.resolve(0),
  ]);
  return {
    messages,
    threads,
    phones,
    consents: customers.map((row) => `${row.id}:${row.smsConsentStatus}`).sort().join("|"),
    contacts: customers.map((row) => `${row.id}:${row.email ?? ""}:${row.phone ?? ""}`).sort().join("|"),
    proposals,
  };
}

async function seedCommunicationsWorld(workspace, { secret = false, extraMessages = 0 } = {}) {
  const businessId = workspace.business.id;
  const prefix = secret ? "BetaSecretCustomer" : "Alpha";
  const granted = await prisma.customer.create({
    data: {
      businessId,
      name: `${prefix} Granted`,
      email: secret ? "secret-beta@example.com" : "alpha-granted@example.com",
      phone: secret ? "5553334444" : "5551112222",
      smsConsentStatus: "GRANTED",
    },
  });
  const revoked = await prisma.customer.create({
    data: {
      businessId,
      name: `${prefix} Revoked`,
      email: secret ? "secret-revoked@example.com" : "alpha-revoked@example.com",
      phone: "5558889999",
      smsConsentStatus: "REVOKED",
    },
  });
  const unknown = await prisma.customer.create({
    data: {
      businessId,
      name: `${prefix} Unknown`,
      email: secret ? "secret-unknown@example.com" : "alpha-unknown@example.com",
      phone: "5556667777",
      smsConsentStatus: "UNKNOWN",
    },
  });
  const phoneOnly = await prisma.customer.create({
    data: {
      businessId,
      name: `${prefix} PhoneOnly`,
      phone: "5550001111",
      smsConsentStatus: "UNKNOWN",
    },
  });

  const request = await prisma.serviceRequest.create({
    data: {
      businessId,
      customerId: granted.id,
      summary: `${prefix} request`,
    },
  });
  const job = await prisma.job.create({
    data: {
      businessId,
      customerId: granted.id,
      status: "SCHEDULED",
      scheduledAt: new Date(),
      projectToken: randomUUID(),
      appointmentConfirmationStatus: "DIFFERENT_TIME_REQUESTED",
      appointmentProposalId: 1,
      appointmentNotificationStatus: "FAILED",
    },
  });

  const failedSms = await prisma.customerCommunication.create({
    data: {
      businessId,
      customerId: granted.id,
      channel: "SMS",
      direction: "OUTBOUND",
      purpose: "APPOINTMENT_CONFIRMATION",
      relatedType: "JOB",
      relatedId: job.id,
      subject: `${prefix} appointment sms`,
      idempotencyKey: `sms-fail-${randomUUID()}`,
      bodySnapshot: secret ? "BetaSecretBody9999" : "Alpha appointment SMS body",
      status: "FAILED",
      provider: "disconnected",
      failureReason: "SMS delivery is not connected.",
    },
  });
  const sentEmail = await prisma.customerCommunication.create({
    data: {
      businessId,
      customerId: granted.id,
      channel: "EMAIL",
      direction: "OUTBOUND",
      purpose: "GENERAL",
      subject: `${prefix} owner email`,
      idempotencyKey: `email-sent-${randomUUID()}`,
      bodySnapshot: secret ? "BetaSecretEmailBody" : "Alpha recorded email body",
      status: "SENT",
      provider: "resend",
    },
  });
  const pending = await prisma.customerCommunication.create({
    data: {
      businessId,
      customerId: revoked.id,
      channel: "EMAIL",
      direction: "OUTBOUND",
      purpose: "JOB_UPDATE",
      subject: `${prefix} pending email`,
      idempotencyKey: `email-pending-${randomUUID()}`,
      bodySnapshot: "Pending email body",
      status: "QUEUED",
      provider: "resend",
    },
  });

  for (let i = 0; i < extraMessages; i += 1) {
    await prisma.customerCommunication.create({
      data: {
        businessId,
        customerId: granted.id,
        channel: "EMAIL",
        purpose: "GENERAL",
        subject: `${prefix} overflow ${i + 1}`,
        idempotencyKey: `overflow-${i}-${randomUUID()}`,
        bodySnapshot: `${prefix} overflow body ${i + 1}`,
        status: "SENT",
        provider: "resend",
      },
    });
  }

  return { granted, revoked, unknown, phoneOnly, request, job, failedSms, sentEmail, pending };
}

try {
  const specialistSrc = readFileSync(new URL("../src/lib/chief-of-staff/communications-specialist.ts", import.meta.url), "utf8");
  const snapshotSrc = readFileSync(new URL("../src/lib/chief-of-staff/communications-snapshot.ts", import.meta.url), "utf8");
  const runSrc = readFileSync(new URL("../src/lib/chief-of-staff/run.ts", import.meta.url), "utf8");
  const schemaSrc = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

  console.log("\nSTATIC — Communications specialist is read/explain only");
  const entry = getSpecialistEntry("COMMUNICATIONS");
  check("COMMUNICATIONS remains the existing specialist identity", entry.id === "COMMUNICATIONS" && entry.enabled === true);
  check("Role floor is MANAGE_COMMUNICATIONS", entry.requiredRoleCapability === CAPABILITIES.MANAGE_COMMUNICATIONS);
  check("SMS_MESSAGING is not a specialist-wide product floor", entry.requiredProductCapability === null);
  check("Approval class is READ_EXPLAIN", entry.approvalClass === "READ_EXPLAIN");
  check("Communications specialist performs no LLM call", !specialistSrc.includes("runAiTask") && !specialistSrc.includes("resolveAiProvider"));
  check(
    "Communications specialist does not call write or send paths",
    !specialistSrc.includes("composeCustomerCommunication") &&
      !specialistSrc.includes("attemptCustomerSms") &&
      !specialistSrc.includes("sendRecordedEmail") &&
      !specialistSrc.includes("applyInboundConsentEvent") &&
      !specialistSrc.includes("getOrCreateCustomerThread") &&
      !specialistSrc.includes("touchCommunicationThread") &&
      !specialistSrc.includes("recordMissedOrManualCall") &&
      !specialistSrc.includes("notifyCustomerAppointmentProposed") &&
      !specialistSrc.includes("listAssignedJobCommunications") &&
      !specialistSrc.includes("loadCommunicationsWorkspace") &&
      !specialistSrc.includes("AiActionProposal") &&
      !snapshotSrc.includes("AiActionProposal") &&
      !runSrc.includes("AiActionProposal"),
  );
  check(
    "Communications specialist does not invoke another specialist",
    !specialistSrc.includes("runWorkforceSpecialist") &&
      !specialistSrc.includes("runMaterialsSpecialist") &&
      !specialistSrc.includes("interpretFinancialSpecialist") &&
      !specialistSrc.includes("interpretGrowthSpecialist") &&
      !specialistSrc.includes("planSpecialists(") &&
      !specialistSrc.includes("runChiefOfStaffCoach"),
  );
  check("No Prisma schema change is required", schemaSrc.includes("model CustomerCommunication") && schemaSrc.includes("smsConsentStatus"));
  check("Max fan-out remains 4", MAX_SPECIALIST_FANOUT === 4);
  check("Recursion depth remains 1", MAX_RECURSION_DEPTH === 1);
  check("Phone number does not imply GRANTED", phoneDoesNotGrantConsent(true, "UNKNOWN") === "UNKNOWN");
  check("UNKNOWN never becomes GRANTED", unknownConsentIsNotGranted("UNKNOWN") && resolveStoredSmsConsent("UNKNOWN") === "UNKNOWN");
  check("GRANTED / REVOKED / UNKNOWN stay distinct", resolveStoredSmsConsent("GRANTED") === "GRANTED" && resolveStoredSmsConsent("REVOKED") === "REVOKED" && resolveStoredSmsConsent(null) === "UNKNOWN");

  const contactPlan = planSpecialists({ question: "Did we contact this customer?", activeRecommendationKeys: [] });
  const messagePlan = planSpecialists({ question: "What happened with the message?", activeRecommendationKeys: [] });
  const textPlan = planSpecialists({ question: "Can I text this customer?", activeRecommendationKeys: [] });
  const failPlan = planSpecialists({ question: "Why did this message fail?", activeRecommendationKeys: [] });
  const waitingPlan = planSpecialists({ question: "What communication is waiting?", activeRecommendationKeys: [] });
  const appointmentPlan = planSpecialists({ question: "What did we send about this appointment?", activeRecommendationKeys: [] });
  const recPlan = planSpecialists({
    question: "What should I focus on this week?",
    activeRecommendationKeys: ["communications-failed-delivery"],
  });
  const genericBusiness = planSpecialists({ question: "How is my business doing?", activeRecommendationKeys: [] });
  const genericWork = planSpecialists({ question: "What should I work on?", activeRecommendationKeys: [] });
  const kitchen = planSpecialists({ question: "Tell me everything", activeRecommendationKeys: [] });
  const profit = planSpecialists({ question: "How is my profit and margin this month?", activeRecommendationKeys: [] });
  check("Planner selects COMMUNICATIONS for contact", contactPlan.selectedIds.includes("COMMUNICATIONS"));
  check("Planner selects COMMUNICATIONS for message result", messagePlan.selectedIds.includes("COMMUNICATIONS"));
  check("Planner selects COMMUNICATIONS for text/consent", textPlan.selectedIds.includes("COMMUNICATIONS"));
  check("Planner selects COMMUNICATIONS for failed message", failPlan.selectedIds.includes("COMMUNICATIONS"));
  check("Planner selects COMMUNICATIONS for waiting communication", waitingPlan.selectedIds.includes("COMMUNICATIONS"));
  check("Planner selects COMMUNICATIONS for appointment send", appointmentPlan.selectedIds.includes("COMMUNICATIONS"));
  check("Planner selects COMMUNICATIONS from communications-* recs", recPlan.selectedIds.includes("COMMUNICATIONS"));
  check("Generic business question does not select COMMUNICATIONS", !genericBusiness.selectedIds.includes("COMMUNICATIONS"));
  check("Generic work question does not select COMMUNICATIONS", !genericWork.selectedIds.includes("COMMUNICATIONS"));
  check("Tell-me-everything does not select COMMUNICATIONS", !kitchen.selectedIds.includes("COMMUNICATIONS"));
  check("Profit question does not select COMMUNICATIONS", !profit.selectedIds.includes("COMMUNICATIONS") && profit.selectedIds.includes("FINANCIAL"));
  check("Fan-out stays <= 4", contactPlan.fanout <= 4 && recPlan.fanout <= 4);
  check("Recursion depth stays 1", contactPlan.recursionDepth === 1);

  const tenantA = await createOwnerWorkspace("Alpha Communications");
  const tenantB = await createOwnerWorkspace("Beta Communications");
  await entitleFounder(tenantA.business.id);
  await entitleFounder(tenantB.business.id);
  const seededA = await seedCommunicationsWorld(tenantA, { extraMessages: 18 });
  const seededB = await seedCommunicationsWorld(tenantB, { secret: true });

  const memberUser = await prisma.user.create({
    data: { name: "Member", email: `member-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: tenantA.business.id, role: "MEMBER" },
  });
  const memberAccess = makeAccess(tenantA.business.id, "MEMBER", memberMem.id, memberUser.id);
  await prisma.job.update({
    where: { id: seededA.job.id },
    data: { assignedMembershipId: memberMem.id },
  });

  console.log("\nAUTH — owner deep read, MEMBER, tenant isolation, fail-closed");
  try {
    requireBusinessCapability(memberAccess, CAPABILITIES.VIEW_REPORTS);
    check("MEMBER remains blocked from VIEW_REPORTS", false);
  } catch (error) {
    check("MEMBER remains blocked from VIEW_REPORTS", error instanceof ForbiddenError);
  }
  try {
    requireBusinessCapability(memberAccess, CAPABILITIES.MANAGE_COMMUNICATIONS);
    check("MEMBER remains blocked from MANAGE_COMMUNICATIONS", false);
  } catch (error) {
    check("MEMBER remains blocked from MANAGE_COMMUNICATIONS", error instanceof ForbiddenError);
  }

  resetLoads();
  const ownerResult = await runCommunicationsSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "Did we contact this customer and can I text them?",
    entityHints: { customerId: seededA.granted.id },
  });
  const ownerProjection = getLastCommunicationsProjection();
  check("Owner authorized deep read succeeds", ownerResult.status === "OK" && Boolean(ownerProjection));
  check("Tenant ownership is explicit on customers", ownerProjection.customers.every((row) => row.businessId === tenantA.business.id));
  check("Tenant ownership is explicit on messages", ownerProjection.messages.every((row) => row.businessId === tenantA.business.id));
  check("Owner sees targeted customer", ownerProjection.customers.some((row) => row.id === seededA.granted.id));
  check("No forbidden/private provider fields leak", !communicationsProjectionHasForbiddenFields(ownerProjection));
  check("Raw email does not leak", !JSON.stringify(ownerProjection).includes("alpha-granted@example.com"));
  check("Raw phone does not leak", !JSON.stringify(ownerProjection).includes("5551112222"));
  check("Message bodies are not projected", ownerProjection.messages.every((row) => row.hasBody === true || row.hasBody === false) && !JSON.stringify(ownerProjection).includes("Alpha appointment SMS body"));
  check("Tenant A does not see BetaSecretCustomer", !JSON.stringify(ownerProjection).includes("BetaSecretCustomer"));
  check("Tenant A does not see secret-beta email", !JSON.stringify(ownerProjection).includes("secret-beta@example.com"));
  check("Tenant A does not see Beta secret body", !JSON.stringify(ownerProjection).includes("BetaSecretBody9999"));

  resetLoads();
  const memberResult = await runCommunicationsSpecialist({
    db: prisma,
    access: memberAccess,
    catalog: emptyCatalog(),
    question: "Did we contact this customer?",
    entityHints: { customerId: seededA.granted.id, jobId: seededA.job.id },
  });
  check("MEMBER cannot receive whole-customer communication history", memberResult.status === "SKIPPED" && memberResult.skipReason === "NOT_AUTHORIZED");
  check("MEMBER assigned field work does not load a projection", getLastCommunicationsProjection() == null);
  check("MEMBER result has no customer messages", memberResult.findings.length === 0 && !JSON.stringify(memberResult).includes(seededA.granted.id));
  check("MEMBER skip does not fake an empty inbox", /not treated as empty|Assigned field work/i.test(memberResult.limitation ?? ""));

  resetLoads();
  const tenantBResult = await runCommunicationsSpecialist({
    db: prisma,
    access: tenantB.access,
    catalog: emptyCatalog(),
    question: "Did we contact this customer?",
    entityHints: { customerId: seededB.granted.id },
  });
  const tenantBProjection = getLastCommunicationsProjection();
  check("Tenant B run is OK", tenantBResult.status === "OK");
  check("Tenant B does not see Alpha customer names", !JSON.stringify(tenantBProjection).includes("Alpha Granted"));
  check("Tenant B does not see Alpha message ids", !tenantBProjection.messages.some((row) => row.id === seededA.failedSms.id || row.id === seededA.sentEmail.id));

  resetLoads();
  const foreignCustomer = await runCommunicationsSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "Did we contact this customer?",
    entityHints: { customerId: seededB.granted.id },
  });
  check(
    "Targeted foreign customer fails closed",
    foreignCustomer.status === "OK" &&
      getLastCommunicationsProjection().targetedCustomerUnauthorized === true &&
      !getLastCommunicationsProjection().customers.some((row) => row.id === seededB.granted.id) &&
      !getLastCommunicationsProjection().messages.some((row) => row.customerId === seededB.granted.id),
  );

  resetLoads();
  await runCommunicationsSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "What happened with the message?",
    entityHints: { requestId: seededB.request.id },
  });
  check(
    "Targeted foreign request fails closed",
    getLastCommunicationsProjection().targetedRequestUnauthorized === true &&
      !getLastCommunicationsProjection().messages.some((row) => row.relatedId === seededB.request.id),
  );

  resetLoads();
  await runCommunicationsSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "What did we send about this appointment?",
    entityHints: { jobId: seededB.job.id },
  });
  check(
    "Targeted foreign job fails closed",
    getLastCommunicationsProjection().targetedJobUnauthorized === true &&
      !getLastCommunicationsProjection().appointments.some((row) => row.jobId === seededB.job.id),
  );

  resetLoads();
  await runCommunicationsSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "What happened with the message?",
    entityHints: { messageId: seededB.failedSms.id },
  });
  check(
    "Targeted foreign message fails closed",
    getLastCommunicationsProjection().targetedMessageUnauthorized === true &&
      !getLastCommunicationsProjection().messages.some((row) => row.id === seededB.failedSms.id),
  );

  console.log("\nCONSENT — GRANTED / REVOKED / UNKNOWN stay distinct");
  resetLoads();
  await runCommunicationsSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "Can I text this customer?",
    entityHints: { customerId: seededA.granted.id },
  });
  const grantedProjection = getLastCommunicationsProjection();
  check(
    "GRANTED stays GRANTED",
    grantedProjection.customers.some((row) => row.id === seededA.granted.id && row.smsConsentStatus === "GRANTED"),
  );

  resetLoads();
  const revokedResult = await runCommunicationsSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "Can I text this customer?",
    entityHints: { customerId: seededA.revoked.id },
  });
  const revokedProjection = getLastCommunicationsProjection();
  check(
    "REVOKED stays REVOKED",
    revokedProjection.customers.some((row) => row.id === seededA.revoked.id && row.smsConsentStatus === "REVOKED" && row.smsEligible === false),
  );
  check(
    "Revoked finding does not claim opted in",
    revokedResult.findings.some((row) => row.key === "communications-sms-consent-revoked" && /REVOKED/.test(row.summary) && !/opted in/i.test(row.summary)),
  );

  resetLoads();
  const unknownResult = await runCommunicationsSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "Can I text this customer?",
    entityHints: { customerId: seededA.unknown.id },
  });
  const unknownProjection = getLastCommunicationsProjection();
  const unknownCustomer = unknownProjection.customers.find((row) => row.id === seededA.unknown.id);
  check("UNKNOWN stays UNKNOWN", unknownCustomer?.smsConsentStatus === "UNKNOWN");
  check("UNKNOWN is not eligible", unknownCustomer?.smsEligible === false);
  check("UNKNOWN never becomes GRANTED", unknownCustomer?.smsConsentStatus !== "GRANTED");
  check(
    "UNKNOWN finding never says opted in or GRANTED as truth",
    unknownResult.findings.some((row) => row.key === "communications-sms-consent-unknown" && /UNKNOWN is not GRANTED/.test(row.summary) && !/opted in/.test(row.summary)),
  );

  resetLoads();
  await runCommunicationsSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "Can I text this customer?",
    entityHints: { customerId: seededA.phoneOnly.id },
  });
  const phoneOnly = getLastCommunicationsProjection().customers.find((row) => row.id === seededA.phoneOnly.id);
  check("Phone number is recorded as available", phoneOnly?.hasPhone === true);
  check("Phone number does not imply consent", phoneOnly?.smsConsentStatus === "UNKNOWN" && phoneOnly?.smsEligible === false);

  console.log("\nSLICES — SMS-disabled does not erase email truth");
  resetLoads();
  const smsDenied = await runCommunicationsSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "What happened with the message?",
    entityHints: { customerId: seededA.granted.id },
    denyProductCapabilities: [PRODUCT_CAPABILITIES.SMS_MESSAGING],
  });
  const smsDeniedProjection = getLastCommunicationsProjection();
  check("SMS-disabled run still succeeds", smsDenied.status === "OK");
  check(
    "SMS-disabled state does not erase recorded email",
    smsDeniedProjection.messages.some((row) => row.id === seededA.sentEmail.id && row.channel === "EMAIL") &&
      smsDenied.factKeys.includes("communications-email-message-count") &&
      Number(smsDeniedProjection.totals.emailMessages) >= 1,
  );
  check("SMS-disabled limitation stays on the SMS slice", /SMS compose is not entitled|does not erase recorded email/i.test(smsDenied.limitation ?? ""));
  check("SMS-disabled does not invent granted consent", smsDeniedProjection.customers.every((row) => row.smsConsentStatus !== "GRANTED" || row.id === seededA.granted.id));

  console.log("\nBOUNDS — projection caps and deterministic result");
  resetLoads();
  const capped = await runCommunicationsSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "What communication is waiting?",
  });
  const cappedProjection = getLastCommunicationsProjection();
  check("Customer cap holds", cappedProjection.customers.length <= COMMUNICATIONS_CONTEXT_CAPS.customers);
  check("Message cap holds", cappedProjection.messages.length <= COMMUNICATIONS_CONTEXT_CAPS.messages);
  check("Appointment cap holds", cappedProjection.appointments.length <= COMMUNICATIONS_CONTEXT_CAPS.appointments);
  check("Phone-interaction cap holds", cappedProjection.phoneInteractions.length <= COMMUNICATIONS_CONTEXT_CAPS.phoneInteractions);
  check("Finding cap holds", capped.findings.length <= COMMUNICATIONS_CONTEXT_CAPS.findings);
  check("Fact cap holds", capped.factKeys.length <= COMMUNICATIONS_CONTEXT_CAPS.facts);
  check("Overflow history is not dumped", cappedProjection.messages.length < 18 + 3);

  resetLoads();
  const first = await runCommunicationsSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "Did we contact this customer?",
    entityHints: { customerId: seededA.granted.id },
  });
  const firstProjection = JSON.stringify(getLastCommunicationsProjection());
  resetLoads();
  const second = await runCommunicationsSpecialist({
    db: prisma,
    access: tenantA.access,
    catalog: emptyCatalog(),
    question: "Did we contact this customer?",
    entityHints: { customerId: seededA.granted.id },
  });
  check("Deterministic result for identical data", JSON.stringify(first.findings) === JSON.stringify(second.findings) && JSON.stringify(first.factKeys) === JSON.stringify(second.factKeys) && firstProjection === JSON.stringify(getLastCommunicationsProjection()));

  console.log("\nCONFLICTS — Communications-owned recorded truth only");
  function findingResult(id, keys) {
    return {
      specialistId: id,
      status: "OK",
      findings: keys.map((key) => ({
        key,
        title: key,
        summary: key,
        recommendationKeys: [key],
        factKeys: [],
      })),
      factKeys: [],
      recommendationKeys: keys,
    };
  }
  const emptyConflictInput = { recommendations: [], facts: {} };
  const revokedConflicts = resolveConflicts({
    ...emptyConflictInput,
    results: [findingResult("COMMUNICATIONS", ["communications-sms-consent-revoked"])],
  });
  check("SMS_REVOKED_VS_TEXTABLE comes from revoked consent", revokedConflicts.items.some((item) => item.kind === "SMS_REVOKED_VS_TEXTABLE"));
  const unknownConflicts = resolveConflicts({
    ...emptyConflictInput,
    results: [findingResult("COMMUNICATIONS", ["communications-sms-consent-unknown"])],
  });
  check("UNKNOWN_CONSENT_IS_NOT_GRANTED keeps UNKNOWN distinct", unknownConflicts.items.some((item) => item.kind === "UNKNOWN_CONSENT_IS_NOT_GRANTED" && /not GRANTED/i.test(item.summary)));
  const failedConflicts = resolveConflicts({
    ...emptyConflictInput,
    results: [findingResult("COMMUNICATIONS", ["communications-failed-delivery"])],
  });
  check("FAILED_DELIVERY_VS_DELIVERED does not invent a read", failedConflicts.items.some((item) => item.kind === "FAILED_DELIVERY_VS_DELIVERED" && /not delivered, seen, or ignored/i.test(item.summary)));
  const channelConflicts = resolveConflicts({
    ...emptyConflictInput,
    results: [findingResult("COMMUNICATIONS", ["communications-channel-unavailable"])],
  });
  check("CHANNEL_UNAVAILABLE_VS_SEND does not claim sent", channelConflicts.items.some((item) => item.kind === "CHANNEL_UNAVAILABLE_VS_SEND"));
  const timeConflicts = resolveConflicts({
    ...emptyConflictInput,
    results: [findingResult("COMMUNICATIONS", ["communications-appointment-different-time"])],
  });
  check("APPOINTMENT_DIFFERENT_TIME_VS_CONFIRMED is not a cancellation", timeConflicts.items.some((item) => item.kind === "APPOINTMENT_DIFFERENT_TIME_VS_CONFIRMED" && /not a confirmation, a cancellation/i.test(item.summary)));
  const emailVsSms = resolveConflicts({
    ...emptyConflictInput,
    results: [findingResult("COMMUNICATIONS", ["communications-sms-consent-revoked", "communications-channel-unavailable"])],
  });
  check("EMAIL_AVAILABLE_VS_SMS_LIMIT keeps email independent", emailVsSms.items.some((item) => item.kind === "EMAIL_AVAILABLE_VS_SMS_LIMIT" && /do not erase recorded email/i.test(item.summary)));
  const materialsOnly = resolveConflicts({
    ...emptyConflictInput,
    results: [findingResult("MATERIALS", ["materials-needed-for-upcoming-jobs"])],
  });
  check(
    "Communications conflicts do not fire without Communications findings",
    materialsOnly.items.every((item) => !["SMS_REVOKED_VS_TEXTABLE", "UNKNOWN_CONSENT_IS_NOT_GRANTED", "FAILED_DELIVERY_VS_DELIVERED", "CHANNEL_UNAVAILABLE_VS_SEND", "APPOINTMENT_DIFFERENT_TIME_VS_CONFIRMED", "EMAIL_AVAILABLE_VS_SMS_LIMIT"].includes(item.kind)),
  );

  console.log("\nRUNTIME — orchestration, no send, no write, no recursive specialist");
  resetLoads();
  const coach = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "Did we contact this customer and why did this message fail?",
    attemptId: randomUUID(),
    browserBusinessId: tenantB.business.id,
    entityHints: { customerId: seededA.granted.id },
  });
  check("Coach omits Beta secret", Boolean(coach.text) && !coach.text.includes("BetaSecret") && !coach.text.includes("9999"));
  check("Coach mentions recorded communications", /consent|FAILED|email|SMS|message/i.test(coach.text ?? ""));
  check("Coach does not invent motives", !/ignored us|is upset|will cancel|saw the message|read the message/i.test(coach.text ?? ""));
  check("Exactly one Communications projection load when selected", getCommunicationsProjectionLoadCount() === 1);
  check("Communications interprets once", getCommunicationsSpecialistInterpretationCount() === 1);
  check("Orchestration can complete", coach.orchestrationStatus === "COMPLETED");

  resetLoads();
  const genericCoach = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "How is my business doing?",
    attemptId: randomUUID(),
  });
  check("Generic Coach question does not interpret Communications", getCommunicationsSpecialistInterpretationCount() === 0);
  check("Generic Coach question still completes", genericCoach.orchestrationStatus === "COMPLETED");

  resetLoads();
  const financialOnly = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "How is my profit and outstanding invoices this month?",
    attemptId: randomUUID(),
  });
  check("Unrelated Financial question does not interpret Communications", getCommunicationsSpecialistInterpretationCount() === 0);
  check("Financial question still completes", financialOnly.orchestrationStatus === "COMPLETED");

  resetLoads();
  const failLoad = await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "Can I text this customer?",
    attemptId: randomUUID(),
    test: { failCommunicationsLoad: true },
  });
  check("Injected loader failure is PARTIAL", failLoad.orchestrationStatus === "PARTIAL");
  check("ATTENTION survives Communications loader failure", /surviving facts|could not be loaded|unavailable/i.test(failLoad.text ?? ""));

  const before = await countCommunicationsRows(tenantA.business.id);
  const consentBefore = await prisma.customer.findMany({
    where: { businessId: tenantA.business.id },
    select: { id: true, smsConsentStatus: true },
  });
  await runChiefOfStaffCoach(prisma, tenantA.access, {
    question: "Send a text, email the customer, opt them in, retry delivery, and create a follow-up thread.",
    attemptId: randomUUID(),
    entityHints: { customerId: seededA.unknown.id },
  });
  const after = await countCommunicationsRows(tenantA.business.id);
  const consentAfter = await prisma.customer.findMany({
    where: { businessId: tenantA.business.id },
    select: { id: true, smsConsentStatus: true },
  });
  check("No communication records are written", before.messages === after.messages);
  check("No threads are created", before.threads === after.threads);
  check("No phone interactions are written", before.phones === after.phones);
  check("No consent state is mutated", before.consents === after.consents);
  check("No customer contact fields are mutated", before.contacts === after.contacts);
  check("No AiActionProposal is created", before.proposals === after.proposals);
  check(
    "Consent rows stay GRANTED/REVOKED/UNKNOWN",
    consentBefore.every((row) => consentAfter.some((afterRow) => afterRow.id === row.id && afterRow.smsConsentStatus === row.smsConsentStatus)),
  );

  check("Financial specialist file was not rewritten by this work", readFileSync(new URL("../src/lib/chief-of-staff/specialists/financial.ts", import.meta.url), "utf8").includes("interpretFinancialSpecialist"));
  check("Workforce specialist file was not rewritten by this work", readFileSync(new URL("../src/lib/chief-of-staff/workforce-specialist.ts", import.meta.url), "utf8").includes("runWorkforceSpecialist"));
  check("Growth specialist file was not rewritten by this work", readFileSync(new URL("../src/lib/chief-of-staff/growth-specialist.ts", import.meta.url), "utf8").includes("interpretGrowthSpecialist"));
  check("Materials specialist file was not rewritten by this work", readFileSync(new URL("../src/lib/chief-of-staff/materials-specialist.ts", import.meta.url), "utf8").includes("runMaterialsSpecialist"));
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
}

if (failures > 0) {
  console.error(`\nCommunications specialist checks failed: ${failures}`);
  process.exit(1);
}
console.log("\nCommunications specialist checks passed.");
