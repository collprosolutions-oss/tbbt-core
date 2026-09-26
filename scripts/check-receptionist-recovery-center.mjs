/**
 * Receptionist & missed-call recovery center proofs.
 *
 * Recorded PhoneInteraction / ReceptionistEvent workspace only.
 * No schema, no carrier, no auto follow-up, no fake resolved state.
 *
 * Run with:
 *   npm run test:receptionist-recovery-center
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

const testDbName = "tbbt_receptionist_recovery_center_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for receptionist recovery test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

const { CAPABILITIES, ForbiddenError, requireBusinessCapability, roleHasCapability } =
  await import("@/lib/authorization");
const {
  OWNER_LOG_LEAD_HREF,
  RECEPTIONIST_RECOVERY_FACT_KEYS,
  RECEPTIONIST_RECOVERY_QUEUE_LIMIT,
  appendReceptionistRecoveryFacts,
  loadReceptionistRecoveryCenter,
  recordMissedOrManualCall,
  recordInboundCallEvent,
  VOICE_NOT_CONNECTED_REASON,
} = await import("@/lib/communications");
const { planSpecialists } = await import("@/lib/chief-of-staff");

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  ok  - ${label}`);
  else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

function readRepo(relPath) {
  return readFileSync(new URL(`../${relPath}`, import.meta.url), "utf8");
}

function makeAccess(businessId, role, membershipId, userId) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      user: { id: userId },
      business: { id: businessId, name: "Recovery Co" },
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

async function seedBusiness(name) {
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

try {
  const recoverySrc = readRepo("src/lib/communications/receptionist-recovery.ts");
  const pageSrc = readRepo("src/app/(app)/communications/receptionist/page.tsx");
  const uiSrc = readRepo("src/components/communications/receptionist-recovery-center.tsx");
  const workspaceSrc = readRepo("src/components/communications/communications-workspace.tsx");
  const logLeadPageSrc = readRepo("src/app/(app)/requests/log-lead/page.tsx");
  const logLeadFormSrc = readRepo("src/components/requests/log-lead-form.tsx");
  const navSrc = readRepo("src/lib/nav.ts");
  const schemaSrc = readRepo("prisma/schema.prisma");
  const timelineSrc = readRepo("src/lib/communications/timeline.ts");
  const timelineUiSrc = readRepo("src/components/communications/customer-communication-timeline.tsx");
  const specialistSrc = readRepo("src/lib/chief-of-staff/communications-specialist.ts");
  const plannerSrc = readRepo("src/lib/chief-of-staff/planner.ts");

  console.log("\nSTATIC — Recovery center stays recorded-truth and receptionist-scoped");
  check(
    "Dedicated office route exists at /communications/receptionist",
    pageSrc.includes("loadReceptionistRecoveryCenter") &&
      pageSrc.includes("MANAGE_COMMUNICATIONS") &&
      pageSrc.includes("requireManagementPageAccess") &&
      pageSrc.includes("requireBusinessCapability"),
  );
  check(
    "Global nav is unchanged",
    navSrc.includes('{ href: "/communications", label: "Communications"') &&
      !navSrc.includes("/communications/receptionist"),
  );
  check(
    "Log Lead remains the canonical capture path and still has no prefill architecture",
    pageSrc.includes("/requests/log-lead") &&
      uiSrc.includes("source.logLeadHref") &&
      recoverySrc.includes('logLeadPrefillSupported: false') &&
      !logLeadPageSrc.includes("searchParams") &&
      !logLeadFormSrc.includes("defaultPhone") &&
      !recoverySrc.includes("createOwnerLoggedLead") &&
      !pageSrc.includes("createOwnerLoggedLead") &&
      !uiSrc.includes("createOwnerLoggedLead"),
  );
  check(
    "Recovery loader does not send SMS, email, or place calls",
    !recoverySrc.includes("composeCustomerCommunication") &&
      !recoverySrc.includes("attemptCustomerSms") &&
      !recoverySrc.includes("sendTransactionalEmail") &&
      !recoverySrc.includes("recordMissedOrManualCall") &&
      !pageSrc.includes("composeCustomerCommunication") &&
      !pageSrc.includes("attemptCustomerSms"),
  );
  check(
    "No fake resolved persistence is invented",
    !recoverySrc.includes('status: "CLOSED"') &&
      !recoverySrc.includes("updateMany") &&
      !recoverySrc.includes("phoneInteraction.update") &&
      !uiSrc.includes("Mark resolved") &&
      !pageSrc.includes("Mark resolved"),
  );
  check(
    "Voice remains disconnected and no Twilio voice/number provisioning is added",
    recoverySrc.includes("voiceConnected: false") &&
      recoverySrc.includes("getReceptionistReadiness") &&
      !recoverySrc.includes("twilio") &&
      !pageSrc.includes("twilio") &&
      !uiSrc.includes("provision"),
  );
  check(
    "Unknown caller copy stays Unknown and never guesses identity",
    uiSrc.includes("Unknown caller") &&
      uiSrc.includes("Caller identity is unknown") &&
      recoverySrc.includes("resolveCustomer") &&
      !recoverySrc.includes("decideCustomerMatch"),
  );
  check(
    "Queue is bounded",
    recoverySrc.includes("RECEPTIONIST_RECOVERY_QUEUE_LIMIT = 40") &&
      RECEPTIONIST_RECOVERY_QUEUE_LIMIT === 40,
  );
  check(
    "Communications specialist can cite recorded missed-call facts without writing",
    specialistSrc.includes("appendReceptionistRecoveryFacts") &&
      plannerSrc.includes("missed calls?") &&
      !specialistSrc.includes("composeCustomerCommunication"),
  );
  check(
    "Existing receptionist tab can open the recovery route",
    workspaceSrc.includes('href="/communications/receptionist"'),
  );
  check(
    "Prisma schema still contains the existing phone/receptionist models and this check does not add fields",
    schemaSrc.includes("model PhoneInteraction") &&
      schemaSrc.includes("model ReceptionistEvent") &&
      schemaSrc.includes("model CustomerCommunication") &&
      !recoverySrc.includes("prisma.schema") &&
      !pageSrc.includes("prisma.schema"),
  );
  check(
    "Timeline files are not rewritten by this recovery module",
    !recoverySrc.includes("loadCustomerCommunicationHistory") &&
      !recoverySrc.includes("loadCustomerCommunicationTimeline") &&
      !pageSrc.includes("CustomerCommunicationTimeline") &&
      timelineSrc.includes("export async function loadCustomerCommunicationHistory") &&
      timelineUiSrc.includes("export function CustomerCommunicationTimeline"),
  );
  check(
    "MEMBER still does not receive MANAGE_COMMUNICATIONS",
    roleHasCapability("OWNER", CAPABILITIES.MANAGE_COMMUNICATIONS) &&
      roleHasCapability("ADMIN", CAPABILITIES.MANAGE_COMMUNICATIONS) &&
      !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_COMMUNICATIONS),
  );

  const missedPlan = planSpecialists({
    question: "How many missed calls are recorded?",
    activeRecommendationKeys: [],
  });
  const callerPlan = planSpecialists({
    question: "Which recorded caller has not had a later communication?",
    activeRecommendationKeys: [],
  });
  const lastPlan = planSpecialists({
    question: "What was the last recorded interaction with this customer?",
    activeRecommendationKeys: [],
  });
  check("Planner selects COMMUNICATIONS for missed-call count", missedPlan.selectedIds.includes("COMMUNICATIONS"));
  check(
    "Planner selects COMMUNICATIONS for recorded caller without later communication",
    callerPlan.selectedIds.includes("COMMUNICATIONS"),
  );
  check(
    "Planner selects COMMUNICATIONS for last recorded interaction",
    lastPlan.selectedIds.includes("COMMUNICATIONS"),
  );

  const tenantA = await seedBusiness("Alpha Recovery");
  const tenantB = await seedBusiness("Beta Recovery");
  const sharedPhone = "5551112222";

  const customerA = await prisma.customer.create({
    data: {
      businessId: tenantA.business.id,
      name: "Alpha Known Caller",
      phone: sharedPhone,
      email: "alpha-known@example.com",
      smsConsentStatus: "UNKNOWN",
    },
  });
  const customerB = await prisma.customer.create({
    data: {
      businessId: tenantB.business.id,
      name: "Beta Same Phone",
      phone: sharedPhone,
      email: "beta-secret@example.com",
      smsConsentStatus: "GRANTED",
    },
  });
  const requestA = await prisma.serviceRequest.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      summary: "Alpha recorded request",
    },
  });
  const jobA = await prisma.job.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      status: "UNSCHEDULED",
      projectToken: randomUUID(),
    },
  });

  console.log("\nDB — Known caller stays tenant-local; unknown stays unknown");
  const knownMissed = await recordMissedOrManualCall(prisma, tenantA.access, {
    kind: "MISSED_CALL",
    callerPhone: sharedPhone,
    summary: "Alpha missed the known caller.",
    callbackNeeded: true,
    requestId: requestA.id,
    jobId: jobA.id,
    idempotencyKey: `known-missed-${randomUUID()}`,
  });
  const unknownMissed = await recordMissedOrManualCall(prisma, tenantA.access, {
    kind: "MISSED_CALL",
    callerPhone: "5550009999",
    summary: "Unknown inbound missed call.",
    callbackNeeded: false,
    idempotencyKey: `unknown-missed-${randomUUID()}`,
  });
  const manualAnswered = await recordMissedOrManualCall(prisma, tenantA.access, {
    kind: "MANUAL_PHONE",
    customerId: customerA.id,
    callerPhone: sharedPhone,
    summary: "Owner logged a manual answered-style call.",
    callbackNeeded: false,
    idempotencyKey: `manual-${randomUUID()}`,
  });
  const inboundUnknown = await recordInboundCallEvent(prisma, tenantA.access, {
    phone: "5554443333",
    summary: "Inbound event with no live voice.",
    idempotencyKey: `inbound-${randomUUID()}`,
  });
  check("Canonical writers stored the phone and receptionist facts", knownMissed.ok && unknownMissed.ok && manualAnswered.ok && inboundUnknown.ok);

  await prisma.phoneInteraction.update({
    where: { id: knownMissed.phoneInteractionId },
    data: { occurredAt: new Date(Date.now() - 120_000) },
  });

  const laterEmail = await prisma.customerCommunication.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      channel: "EMAIL",
      direction: "OUTBOUND",
      purpose: "GENERAL",
      subject: "Later recorded follow-up",
      idempotencyKey: `later-email-${randomUUID()}`,
      bodySnapshot: "Later owner email.",
      status: "SENT",
      provider: "resend",
      createdAt: new Date(Date.now() + 60_000),
    },
  });

  const forgedForeign = await prisma.phoneInteraction.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerB.id,
      kind: "MISSED_CALL",
      status: "LOGGED",
      direction: "INBOUND",
      callerLast4: "2222",
      summary: "Forged foreign customer id must not leak.",
      idempotencyKey: `forged-${randomUUID()}`,
    },
  });

  const beforeComms = await prisma.customerCommunication.count({
    where: { businessId: tenantA.business.id },
  });
  const beforePhones = await prisma.phoneInteraction.findMany({
    where: { businessId: tenantA.business.id },
    select: { id: true, status: true, kind: true },
  });

  const centerA = await loadReceptionistRecoveryCenter(prisma, tenantA.access);
  const centerB = await loadReceptionistRecoveryCenter(prisma, tenantB.access);

  const afterComms = await prisma.customerCommunication.count({
    where: { businessId: tenantA.business.id },
  });
  const afterPhones = await prisma.phoneInteraction.findMany({
    where: { businessId: tenantA.business.id },
    select: { id: true, status: true, kind: true },
  });

  const knownItem = centerA.queue.find((row) => row.id === knownMissed.phoneInteractionId);
  const unknownItem = centerA.queue.find((row) => row.id === unknownMissed.phoneInteractionId);
  const manualItem = centerA.queue.find((row) => row.id === manualAnswered.phoneInteractionId);
  const inboundItem = centerA.queue.find((row) => row.id === inboundUnknown.event.id);
  const forgedItem = centerA.queue.find((row) => row.id === forgedForeign.id);

  check(
    "Known caller maps only to the same-business customer",
    knownItem?.customerKnown === true &&
      knownItem.customer?.id === customerA.id &&
      knownItem.customer?.name === "Alpha Known Caller" &&
      knownItem.customer?.href === `/customers/${customerA.id}` &&
      !centerA.queue.some((row) => row.customer?.id === customerB.id || row.customer?.name === "Beta Same Phone"),
  );
  check(
    "Unknown caller remains Unknown and offers Log Lead without prefill",
    unknownItem?.customerKnown === false &&
      unknownItem.customer === null &&
      unknownItem.logLeadHref === OWNER_LOG_LEAD_HREF &&
      centerA.logLeadPrefillSupported === false,
  );
  check(
    "Foreign tenant same phone number does not leak into either workspace",
    !centerA.queue.some((row) => (row.customer?.name ?? "").includes("Beta")) &&
      !centerB.queue.some((row) => row.id === knownMissed.phoneInteractionId) &&
      !centerB.queue.some((row) => row.id === unknownMissed.phoneInteractionId) &&
      centerB.recordedMissedCallCount === 0 &&
      !JSON.stringify(centerA).includes("beta-secret@example.com") &&
      !JSON.stringify(centerA).includes("Beta Same Phone"),
  );
  check(
    "Forged foreign customerId on a same-tenant phone row stays unknown",
    forgedItem?.customerKnown === false && forgedItem.customer === null,
  );
  check(
    "Missed vs manual recorded kinds are preserved and manual-without-callback is not invented as missed",
    knownItem?.kind === "MISSED_CALL" &&
      unknownItem?.kind === "MISSED_CALL" &&
      manualAnswered.ok &&
      !manualItem &&
      centerA.queue.every((row) => row.kind !== "ANSWERED"),
  );
  check(
    "Related request/job appear only when they belong to the same business and customer",
    knownItem?.request?.id === requestA.id &&
      knownItem.job?.id === jobA.id &&
      knownItem.request?.href === `/requests/${requestA.id}`,
  );
  check(
    "Standalone inbound receptionist event stays in the recorded queue as unknown when unmatched",
    inboundItem?.source === "RECEPTIONIST_EVENT" &&
      inboundItem.customerKnown === false &&
      inboundItem.status === "SKIPPED_NOT_CONNECTED" &&
      inboundItem.logLeadHref === OWNER_LOG_LEAD_HREF,
  );
  check(
    "Later recorded communication is reported from timestamps, not invented resolution",
    knownItem?.laterCommunicationRecorded === true &&
      knownItem.lastCustomerCommunication?.channel === "EMAIL" &&
      knownItem.lastCustomerCommunication?.isThisCallRecord === false &&
      laterEmail.id &&
      centerA.voiceConnected === false &&
      centerA.voiceReason === VOICE_NOT_CONNECTED_REASON,
  );
  check(
    "Loading the workspace does not send or mutate communications or phone status",
    afterComms === beforeComms &&
      afterPhones.length === beforePhones.length &&
      afterPhones.every((row) => {
        const before = beforePhones.find((item) => item.id === row.id);
        return before && before.status === row.status && before.kind === row.kind;
      }) &&
      afterPhones.every((row) => row.status !== "CLOSED"),
  );

  console.log("\nDB — MEMBER access stays office-narrow");
  let memberDenied = false;
  try {
    await loadReceptionistRecoveryCenter(prisma, tenantA.memberAccess);
  } catch (error) {
    memberDenied = error instanceof ForbiddenError;
  }
  let memberCapabilityDenied = false;
  try {
    requireBusinessCapability(tenantA.memberAccess, CAPABILITIES.MANAGE_COMMUNICATIONS);
  } catch (error) {
    memberCapabilityDenied = error instanceof ForbiddenError;
  }
  check("MEMBER cannot load the office-wide recovery queue", memberDenied);
  check("MEMBER still lacks MANAGE_COMMUNICATIONS", memberCapabilityDenied);

  console.log("\nDB — Bounded queue and specialist recorded facts");
  const overflowKeys = [];
  for (let i = 0; i < RECEPTIONIST_RECOVERY_QUEUE_LIMIT + 5; i += 1) {
    overflowKeys.push(`overflow-${i}-${randomUUID()}`);
  }
  await prisma.phoneInteraction.createMany({
    data: overflowKeys.map((key, index) => ({
      businessId: tenantA.business.id,
      kind: "MISSED_CALL",
      status: "LOGGED",
      direction: "INBOUND",
      summary: `Overflow missed call ${index + 1}`,
      idempotencyKey: key,
    })),
  });
  const overflowCenter = await loadReceptionistRecoveryCenter(prisma, tenantA.access);
  check(
    "Queue stays bounded even when more recorded attention items exist",
    overflowCenter.queue.length === RECEPTIONIST_RECOVERY_QUEUE_LIMIT &&
      overflowCenter.queueLimit === RECEPTIONIST_RECOVERY_QUEUE_LIMIT &&
      overflowCenter.recordedMissedCallCount >= RECEPTIONIST_RECOVERY_QUEUE_LIMIT + 5,
  );

  const facts = {};
  const factKeys = [];
  appendReceptionistRecoveryFacts(facts, factKeys, {
    phoneInteractions: [
      {
        kind: "MISSED_CALL",
        customerId: customerA.id,
        occurredAt: "2026-09-01T12:00:00.000Z",
      },
      {
        kind: "MISSED_CALL",
        customerId: customerA.id,
        occurredAt: "2026-09-01T14:00:00.000Z",
      },
      {
        kind: "MISSED_CALL",
        customerId: null,
        occurredAt: "2026-09-01T13:00:00.000Z",
      },
    ],
    messages: [
      {
        customerId: customerA.id,
        occurredAt: "2026-09-01T12:30:00.000Z",
      },
    ],
    factsCap: 24,
  });
  check(
    "Specialist facts count missed calls from the bounded recorded set",
    facts[RECEPTIONIST_RECOVERY_FACT_KEYS.missedCallCount] === "2",
  );
  check(
    "Specialist facts count known recorded callers without a later communication using timestamps",
    facts[RECEPTIONIST_RECOVERY_FACT_KEYS.callerWithoutLaterCommunicationCount] === "1" &&
      factKeys.includes(RECEPTIONIST_RECOVERY_FACT_KEYS.missedCallCount),
  );

  const tenantBAfter = await loadReceptionistRecoveryCenter(prisma, tenantB.access);
  check(
    "Overflow writes on tenant A never appear on tenant B",
    tenantBAfter.queue.length === 0 && tenantBAfter.recordedMissedCallCount === 0,
  );
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
}

if (failures > 0) {
  console.error(`\n${failures} receptionist recovery check(s) failed.`);
  process.exit(1);
}
console.log("\nReceptionist recovery center checks passed.");
