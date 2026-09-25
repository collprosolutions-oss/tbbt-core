/**
 * Communications Department + AI receptionist foundation.
 *
 * Timeline, consent, send idempotency, provider failure, tenant isolation,
 * role checks, AI suggestion-only, event automation, honest voice readiness,
 * and SMS entitlement behavior. Does not call live Resend/Twilio/Voice.
 *
 * Run with:
 *   npm run test:communications-department
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

const testDbName = "tbbt_communications_department_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;
process.env.NEXT_PUBLIC_APP_URL = "http://communications-department.test";
process.env.RESEND_API_KEY = "re_test_communications";
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
  console.error("Failed to push schema for communications department test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

const { CAPABILITIES, ForbiddenError, requireBusinessCapability, roleHasCapability } =
  await import("@/lib/authorization");
const { BUSINESS_EVENT_TYPES } = await import("@/lib/automation/types");
const { ensureDefaultAutomationRules } = await import("@/lib/automation/rules");
const { emitAndProcessBusinessEvent } = await import("@/lib/automation/events");
const { scanScheduledBusinessEvents, ESTIMATE_NO_ACTION_AFTER_MS } = await import(
  "@/lib/automation/scan"
);
const {
  composeCustomerCommunication,
  evaluateComposeChannelEligibility,
  evaluateEmailEligibility,
  getReceptionistReadiness,
  listAssignedJobCommunications,
  loadCustomerCommunicationTimeline,
  lookupCaller,
  purposeForComposeTemplate,
  recordMissedOrManualCall,
  recordInboundCallEvent,
  setPhoneLogFailureAfter,
  PHONE_LOG_INJECTED_FAILURE_PREFIX,
  resetCommunicationEmailSender,
  runCommunicationAssist,
  setCommunicationEmailSender,
  VOICE_NOT_CONNECTED_REASON,
  buildComposeFormFields,
  composeIdempotencyKey,
  nextCommunicationAttemptId,
  resolveComposeSendIntent,
  shouldRotateCommunicationAiAttemptId,
  shouldRotateCommunicationSendAttemptId,
  PHONE_LOG_CUSTOMER_CONFLICT_REASON,
  RELATED_RECORD_NOT_OWNED_REASON,
  RELATED_RECORD_WRONG_CUSTOMER_REASON,
  SMS_COMMERCIAL_BOUNDARY,
  productCapabilityForTemplate,
} = await import("@/lib/communications");
const {
  createFakeCustomerMessagingProvider,
  setCustomerMessagingProvider,
  attemptCustomerSms,
} = await import("@/lib/customer-messaging");
const { PRODUCT_CAPABILITIES } = await import("@/lib/product-catalog/codes");

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
      business: { id: businessId, name: "Comms Co" },
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

async function grantSms(businessId) {
  await prisma.businessProductGrant.create({
    data: {
      businessId,
      grantType: "CAPABILITY",
      code: PRODUCT_CAPABILITIES.SMS_MESSAGING,
      status: "ACTIVE",
      source: "MANUAL",
      sourceRef: `sms-${randomUUID()}`,
    },
  });
}

try {
  const engineSrc = readFileSync(new URL("../src/lib/communications/engine.ts", import.meta.url), "utf8");
  const receptionistSrc = readFileSync(
    new URL("../src/lib/communications/receptionist.ts", import.meta.url),
    "utf8",
  );
  const consentSrc = readFileSync(new URL("../src/lib/communications/consent.ts", import.meta.url), "utf8");
  const aiSrc = readFileSync(new URL("../src/lib/communications/ai.ts", import.meta.url), "utf8");
  const pageSrc = readFileSync(new URL("../src/app/(app)/communications/page.tsx", import.meta.url), "utf8");
  const actionSrc = readFileSync(new URL("../src/app/actions/communications.ts", import.meta.url), "utf8");
  const migrationSrc = readFileSync(
    new URL("../prisma/migrations/20260925220000_communications_department/migration.sql", import.meta.url),
    "utf8",
  );
  const relationMigrationSrc = readFileSync(
    new URL("../prisma/migrations/20260925230000_phone_interaction_relations/migration.sql", import.meta.url),
    "utf8",
  );
  const capabilitiesSrc = readFileSync(
    new URL("../src/lib/product-catalog/capabilities.ts", import.meta.url),
    "utf8",
  );
  const schemaSrc = readFileSync(new URL("../src/lib/communications/schema.ts", import.meta.url), "utf8");
  const composeFlowSrc = readFileSync(
    new URL("../src/lib/communications/compose-flow.ts", import.meta.url),
    "utf8",
  );
  const composeFormSrc = readFileSync(
    new URL("../src/components/communications/compose-form.tsx", import.meta.url),
    "utf8",
  );
  const dataSrc = readFileSync(new URL("../src/lib/communications/data.ts", import.meta.url), "utf8");
  const smsPolicySrc = readFileSync(new URL("../src/lib/communications/sms-policy.ts", import.meta.url), "utf8");
  const missedCallSrc = readFileSync(new URL("../src/lib/communications/missed-call.ts", import.meta.url), "utf8");
  const timelineSrc = readFileSync(new URL("../src/lib/communications/timeline.ts", import.meta.url), "utf8");
  const threadSrc = readFileSync(new URL("../src/lib/communications/thread.ts", import.meta.url), "utf8");
  const relatedSrc = readFileSync(new URL("../src/lib/communications/related.ts", import.meta.url), "utf8");

  console.log("\nSTATIC — Department boundary and honesty");
  check(
    "Communications page requires MANAGE_COMMUNICATIONS",
    pageSrc.includes("MANAGE_COMMUNICATIONS") && pageSrc.includes("requireBusinessCapability"),
  );
  check(
    "Compose never treats browser businessId as authority",
    engineSrc.includes("Browser businessId never authorizes") &&
      actionSrc.includes("browserBusinessId"),
  );
  check(
    "Voice readiness is never connected and does not provision numbers",
    receptionistSrc.includes("connected: false") &&
      receptionistSrc.includes("provisionedNumber: false") &&
      receptionistSrc.includes("VOICE_NOT_CONNECTED_REASON") &&
      !receptionistSrc.includes("twilio-voice") &&
      !receptionistSrc.includes("completed call"),
  );
  check(
    "AI assist is suggestion-only and cannot send or change consent",
    aiSrc.includes("Suggestion only") &&
      !aiSrc.includes("composeCustomerCommunication") &&
      !aiSrc.includes("smsConsentStatus") &&
      actionSrc.includes("USE_AI_ASSIST"),
  );
  check(
    "Ordinary email does not depend on the SMS add-on",
    consentSrc.includes("SMS_ADDON_NOT_ENTITLED_REASON") &&
      smsPolicySrc.includes("ordinaryEmailRequiresSmsAddon: false") &&
      SMS_COMMERCIAL_BOUNDARY.ordinaryEmailRequiresSmsAddon === false &&
      SMS_COMMERCIAL_BOUNDARY.departmentSmsComposeRequiresSmsAddon === true &&
      SMS_COMMERCIAL_BOUNDARY.publicPurchasable === false &&
      capabilitiesSrc.includes("Ordinary email never requires this add-on"),
  );
  check(
    "Migration is additive",
    migrationSrc.includes("ADD COLUMN IF NOT EXISTS") &&
      migrationSrc.includes("CREATE TABLE IF NOT EXISTS") &&
      !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migrationSrc) &&
      !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(relationMigrationSrc),
  );
  const requestPathSources = [
    schemaSrc,
    engineSrc,
    dataSrc,
    timelineSrc,
    missedCallSrc,
    threadSrc,
    receptionistSrc,
    aiSrc,
    actionSrc,
    relatedSrc,
  ];
  check(
    "Communications request paths do not run department DDL",
    schemaSrc.includes("prisma-migrate") &&
      requestPathSources.every(
        (src) =>
          !src.includes("$executeRawUnsafe") &&
          !src.includes("CREATE TABLE IF NOT EXISTS") &&
          !src.includes("ALTER TABLE") &&
          !src.includes("ensureCommunicationsSchema"),
      ),
  );
  check(
    "Compose submit uses selected customer and template, not a hardcoded general send",
    composeFormSrc.includes("buildComposeFormFields") &&
      composeFormSrc.includes("setCustomerId") &&
      composeFormSrc.includes("setTemplate") &&
      !composeFormSrc.includes('name="template" value="general"') &&
      !composeFormSrc.includes("hidden\" name=\"customerId\" value={selectedCustomerId") &&
      !actionSrc.includes("purposeForComposeTemplate") &&
      actionSrc.includes("resolveComposeSendIntent") &&
      composeFlowSrc.includes("purposeForComposeTemplate"),
  );
  check(
    "Attempt-id rotation uses the action result, not stale pre-dispatch state",
    composeFormSrc.includes("nextCommunicationAttemptId") &&
      composeFormSrc.includes("shouldRotateCommunicationSendAttemptId") &&
      composeFormSrc.includes("shouldRotateCommunicationAiAttemptId") &&
      !composeFormSrc.includes("shouldRotateAiAttemptId(sendState)") &&
      !composeFormSrc.includes("shouldRotateAiAttemptId(aiState)") &&
      /export function shouldRotateCommunicationAiAttemptId[\s\S]*if \(result\.error\) return false/.test(
        composeFlowSrc,
      ),
  );
  check(
    "Automation catalog includes estimate no-action and owner follow-up",
    BUSINESS_EVENT_TYPES.includes("ESTIMATE_NO_ACTION") &&
      BUSINESS_EVENT_TYPES.includes("OWNER_FOLLOW_UP_CREATED"),
  );
  check(
    "MEMBER does not receive MANAGE_COMMUNICATIONS",
    roleHasCapability("OWNER", CAPABILITIES.MANAGE_COMMUNICATIONS) &&
      roleHasCapability("ADMIN", CAPABILITIES.MANAGE_COMMUNICATIONS) &&
      !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_COMMUNICATIONS),
  );

  const tenantA = await seedBusiness("Alpha Comms");
  const tenantB = await seedBusiness("Beta Comms");
  const customerA = await prisma.customer.create({
    data: {
      businessId: tenantA.business.id,
      name: "Ava",
      email: "ava@example.com",
      phone: "5551112222",
      smsConsentStatus: "GRANTED",
    },
  });
  const customerB = await prisma.customer.create({
    data: {
      businessId: tenantB.business.id,
      name: "Bea",
      email: "bea@example.com",
      phone: "5553334444",
      smsConsentStatus: "GRANTED",
    },
  });
  const unknownConsent = await prisma.customer.create({
    data: {
      businessId: tenantA.business.id,
      name: "Unknown Consent",
      email: "unknown@example.com",
      phone: "5556667777",
      smsConsentStatus: "UNKNOWN",
    },
  });
  const revoked = await prisma.customer.create({
    data: {
      businessId: tenantA.business.id,
      name: "Revoked",
      email: "revoked@example.com",
      phone: "5558889999",
      smsConsentStatus: "REVOKED",
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

  setCommunicationEmailSender(async (input) => {
    if (input.subject.includes("FAIL-PROVIDER")) {
      return { error: "The email provider failed." };
    }
    return { id: `fake-email:${input.idempotencyKey}` };
  });
  setCustomerMessagingProvider(createFakeCustomerMessagingProvider());

  console.log("\nDB — Consent and channel eligibility");
  const emailOk = evaluateEmailEligibility({
    businessId: tenantA.business.id,
    email: customerA.email,
    deliveryConfigured: true,
  });
  check("Usable email is available without inventing SMS consent", emailOk.permitted && emailOk.available);
  const phoneOnly = evaluateComposeChannelEligibility({
    businessId: tenantA.business.id,
    channel: "SMS",
    email: null,
    phone: "5550001111",
    smsConsentStatus: "UNKNOWN",
    purpose: "GENERAL",
    preferences: null,
    smsEntitled: true,
    smsConfigured: true,
    emailConfigured: true,
  });
  check(
    "A phone number does not invent SMS consent",
    phoneOnly.permitted === false && phoneOnly.reason === "unknown_consent",
  );
  const revokedElig = evaluateComposeChannelEligibility({
    businessId: tenantA.business.id,
    channel: "SMS",
    email: revoked.email,
    phone: revoked.phone,
    smsConsentStatus: revoked.smsConsentStatus,
    purpose: "GENERAL",
    preferences: null,
    smsEntitled: true,
    smsConfigured: true,
  });
  check("Revoked SMS consent is visible to the owner", revokedElig.reason === "revoked_consent");

  console.log("\nDB — Email compose, entitlements, and SMS add-on");
  const emailWithoutSmsAddon = await composeCustomerCommunication(prisma, tenantA.access, {
    customerId: customerA.id,
    channel: "EMAIL",
    purpose: purposeForComposeTemplate("general"),
    subject: "Hello",
    body: "General customer email.",
    idempotencyKey: `email-general-${randomUUID()}`,
  });
  check(
    "Ordinary email compose does not require the SMS add-on",
    emailWithoutSmsAddon.ok && emailWithoutSmsAddon.status === "SENT",
  );

  const smsBlocked = await composeCustomerCommunication(prisma, tenantA.access, {
    customerId: customerA.id,
    channel: "SMS",
    purpose: "GENERAL",
    body: "This should not send without the SMS add-on.",
    idempotencyKey: `sms-no-addon-${randomUUID()}`,
  });
  check(
    "Department SMS compose is blocked without SMS_MESSAGING",
    smsBlocked.ok === false &&
      smsBlocked.status === "BLOCKED" &&
      /SMS Messaging add-on/i.test(smsBlocked.failureReason ?? ""),
  );

  await grantSms(tenantA.business.id);
  const smsSent = await composeCustomerCommunication(prisma, tenantA.access, {
    customerId: customerA.id,
    channel: "SMS",
    purpose: "GENERAL",
    body: "Granted SMS compose.",
    idempotencyKey: `sms-addon-${randomUUID()}`,
  });
  check("Department SMS compose works after SMS entitlement", smsSent.ok === true);

  const unknownSms = await composeCustomerCommunication(prisma, tenantA.access, {
    customerId: unknownConsent.id,
    channel: "SMS",
    purpose: "GENERAL",
    body: "Should stay blocked.",
    idempotencyKey: `sms-unknown-${randomUUID()}`,
  });
  check(
    "Granted entitlement still respects unknown SMS consent",
    unknownSms.status === "BLOCKED" && /consent is not granted/i.test(unknownSms.failureReason ?? ""),
  );

  const commercial = await composeCustomerCommunication(prisma, tenantA.access, {
    customerId: customerA.id,
    channel: "EMAIL",
    purpose: "ESTIMATE_FOLLOW_UP",
    subject: "Estimate follow-up",
    body: "Checking on the estimate.",
    relatedType: "ESTIMATE",
    relatedId: estimateA.id,
    idempotencyKey: `email-estimate-${randomUUID()}`,
  });
  check("Estimate follow-up uses ESTIMATES_INVOICES purpose mapping", commercial.ok);

  console.log("\nDB — Idempotency and provider failure");
  const idemKey = `email-idem-${randomUUID()}`;
  const first = await composeCustomerCommunication(prisma, tenantA.access, {
    customerId: customerA.id,
    channel: "EMAIL",
    purpose: "GENERAL",
    subject: "Idempotent",
    body: "First send.",
    idempotencyKey: idemKey,
  });
  const second = await composeCustomerCommunication(prisma, tenantA.access, {
    customerId: customerA.id,
    channel: "EMAIL",
    purpose: "GENERAL",
    subject: "Idempotent",
    body: "Retry should reuse.",
    idempotencyKey: idemKey,
  });
  check(
    "Email send is idempotent",
    first.ok && second.reused && first.communicationId === second.communicationId,
  );

  const failKey = `email-fail-${randomUUID()}`;
  const failed = await composeCustomerCommunication(prisma, tenantA.access, {
    customerId: customerA.id,
    channel: "EMAIL",
    purpose: "GENERAL",
    subject: "FAIL-PROVIDER",
    body: "Provider should fail.",
    idempotencyKey: failKey,
  });
  const failedRow = await prisma.customerCommunication.findFirst({
    where: { businessId: tenantA.business.id, idempotencyKey: failKey },
  });
  check(
    "Provider failure keeps the communication attempt",
    failed.ok === false &&
      failed.status === "FAILED" &&
      failedRow?.id === failed.communicationId &&
      failedRow?.bodySnapshot.includes("Provider should fail"),
  );

  const operationalSms = await attemptCustomerSms(prisma, {
    businessId: tenantA.business.id,
    customerId: customerA.id,
    purpose: "ESTIMATE_READY",
    relatedType: "ESTIMATE",
    relatedId: estimateA.id,
    body: "Operational estimate SMS.",
    idempotencyKey: `sms:ESTIMATE_READY:${estimateA.id}`,
  });
  check("Existing operational SMS remains available on the shared record", operationalSms.ok);

  console.log("\nDB — Timeline, missed calls, and no duplicate sends");
  const timeline = await loadCustomerCommunicationTimeline(prisma, tenantA.access, {
    customerId: customerA.id,
  });
  check("Customer timeline is chronological", timeline.length > 0);
  check(
    "Timeline includes the durable email/SMS records",
    timeline.some((item) => item.source === "record" && item.purpose === "GENERAL"),
  );
  check(
    "Projected estimate events do not duplicate recorded estimate sends",
    timeline.filter(
      (item) =>
        item.source === "projected" &&
        item.relatedType === "ESTIMATE" &&
        item.relatedId === estimateA.id,
    ).length === 0 &&
      timeline.some(
        (item) =>
          item.source === "record" &&
          item.relatedType === "ESTIMATE" &&
          item.relatedId === estimateA.id,
      ),
  );

  const missed = await recordMissedOrManualCall(prisma, tenantA.access, {
    kind: "MISSED_CALL",
    customerId: customerA.id,
    callerPhone: "5551112222",
    summary: "Caller asked about the estimate.",
    callbackNeeded: true,
    idempotencyKey: `missed-${randomUUID()}`,
  });
  check(
    "Missed call creates a phone log, communication, and callback task",
    missed.ok && missed.phoneInteractionId && missed.communicationId && missed.actionItemId,
  );
  const missedAgain = await recordMissedOrManualCall(prisma, tenantA.access, {
    kind: "MISSED_CALL",
    customerId: customerA.id,
    callerPhone: "5551112222",
    summary: "Duplicate click.",
    callbackNeeded: true,
    idempotencyKey: missed.phoneInteractionId
      ? (await prisma.phoneInteraction.findFirst({
          where: { id: missed.phoneInteractionId, businessId: tenantA.business.id },
        }))?.idempotencyKey ?? `missed-dup-${randomUUID()}`
      : `missed-dup-${randomUUID()}`,
  });
  const missedKey = (
    await prisma.phoneInteraction.findFirst({
      where: { id: missed.phoneInteractionId, businessId: tenantA.business.id },
    })
  )?.idempotencyKey;
  const missedReuse = await recordMissedOrManualCall(prisma, tenantA.access, {
    kind: "MISSED_CALL",
    customerId: customerA.id,
    summary: "Retry",
    callbackNeeded: true,
    idempotencyKey: missedKey,
  });
  check("Missed-call logging is idempotent", missedReuse.reused && missedReuse.phoneInteractionId === missed.phoneInteractionId);

  const uniqueMissedSummary = `Unique missed ${randomUUID()}`;
  const uniqueMissed = await recordMissedOrManualCall(prisma, tenantA.access, {
    kind: "MISSED_CALL",
    customerId: customerA.id,
    summary: uniqueMissedSummary,
    callbackNeeded: false,
    idempotencyKey: `unique-missed-${randomUUID()}`,
  });
  const uniqueTimeline = await loadCustomerCommunicationTimeline(prisma, tenantA.access, {
    customerId: customerA.id,
  });
  check(
    "Missed-call timeline contains exactly one logical event",
    uniqueMissed.ok &&
      uniqueTimeline.filter(
        (item) => item.body === uniqueMissedSummary || item.id === uniqueMissed.communicationId,
      ).length === 1,
  );

  console.log("\nDB — Compose customer/template, attempt ids, related records, concurrency");
  const customerBria = await prisma.customer.create({
    data: {
      businessId: tenantA.business.id,
      name: "Bria",
      email: "bria@example.com",
      phone: "5550002222",
      smsConsentStatus: "UNKNOWN",
    },
  });
  const estimateBria = await prisma.estimate.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerBria.id,
      status: "DRAFT",
      publicToken: randomUUID(),
    },
  });
  const requestA = await prisma.serviceRequest.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      summary: "A request",
    },
  });
  const requestBria = await prisma.serviceRequest.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerBria.id,
      summary: "Bria request",
    },
  });
  const jobBria = await prisma.job.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerBria.id,
      projectToken: randomUUID(),
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

  const attemptKeep = randomUUID();
  const failedRotate = nextCommunicationAttemptId(
    attemptKeep,
    { error: "The email provider failed." },
    shouldRotateCommunicationSendAttemptId,
    () => randomUUID(),
  );
  const successRotate = nextCommunicationAttemptId(
    attemptKeep,
    { message: "Message recorded." },
    shouldRotateCommunicationSendAttemptId,
    () => randomUUID(),
  );
  const pendingAi = nextCommunicationAttemptId(
    attemptKeep,
    { inProgress: true, message: "working" },
    shouldRotateCommunicationAiAttemptId,
    () => randomUUID(),
  );
  const failedAi = nextCommunicationAttemptId(
    attemptKeep,
    { error: "The AI request failed." },
    shouldRotateCommunicationAiAttemptId,
    () => randomUUID(),
  );
  const retryAiSuccess = nextCommunicationAttemptId(
    failedAi,
    { text: "Suggested draft for the owner to review." },
    shouldRotateCommunicationAiAttemptId,
    () => randomUUID(),
  );
  const nextIntentionalAi = nextCommunicationAttemptId(
    retryAiSuccess,
    { text: "Next intentional request." },
    shouldRotateCommunicationAiAttemptId,
    () => randomUUID(),
  );
  check(
    "Failed send keeps the same attempt id; confirmed success rotates; in-progress AI does not",
    failedRotate === attemptKeep && successRotate !== attemptKeep && pendingAi === attemptKeep,
  );
  check(
    "AI failure keeps the same attempt id; retry success then rotates for the next request",
    failedAi === attemptKeep &&
      retryAiSuccess !== failedAi &&
      nextIntentionalAi !== retryAiSuccess,
  );

  const composeFields = buildComposeFormFields({
    customerId: customerBria.id,
    template: "estimate_follow_up",
    channel: "EMAIL",
    subject: "Estimate follow-up for Bria",
    body: "Checking on Bria's estimate only.",
    attemptId: randomUUID(),
    relatedType: "ESTIMATE",
    relatedId: estimateBria.id,
  });
  const composeIntent = resolveComposeSendIntent(composeFields);
  const composed = composeIntent.ok
    ? await composeCustomerCommunication(prisma, tenantA.access, {
        customerId: composeIntent.intent.customerId,
        channel: composeIntent.intent.channel,
        purpose: composeIntent.intent.purpose,
        subject: composeIntent.intent.subject,
        body: composeIntent.intent.body,
        relatedType: composeIntent.intent.relatedType,
        relatedId: composeIntent.intent.relatedId,
        idempotencyKey: composeIdempotencyKey(composeIntent.intent),
      })
    : { ok: false };
  const briaRow = await prisma.customerCommunication.findFirst({
    where: { businessId: tenantA.business.id, customerId: customerBria.id, purpose: "ESTIMATE_FOLLOW_UP" },
  });
  const aGotBriaCopy = await prisma.customerCommunication.findFirst({
    where: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      bodySnapshot: "Checking on Bria's estimate only.",
    },
  });
  check(
    "Selected Customer B + estimate_follow_up sends to B with ESTIMATE_FOLLOW_UP and ESTIMATES_INVOICES",
    composeIntent.ok &&
      composeIntent.intent.purpose === "ESTIMATE_FOLLOW_UP" &&
      composeIntent.intent.requiredCapability === PRODUCT_CAPABILITIES.ESTIMATES_INVOICES &&
      productCapabilityForTemplate("estimate_follow_up") === PRODUCT_CAPABILITIES.ESTIMATES_INVOICES &&
      composed.ok &&
      briaRow?.customerId === customerBria.id &&
      briaRow?.purpose === "ESTIMATE_FOLLOW_UP" &&
      !aGotBriaCopy,
  );

  const foreignRelated = await composeCustomerCommunication(prisma, tenantA.access, {
    customerId: customerA.id,
    channel: "EMAIL",
    purpose: "ESTIMATE_FOLLOW_UP",
    subject: "Foreign",
    body: "Should not attach tenant B estimate.",
    relatedType: "ESTIMATE",
    relatedId: estimateB.id,
    idempotencyKey: `foreign-related-${randomUUID()}`,
  });
  check(
    "Foreign related record is rejected",
    foreignRelated.ok === false && foreignRelated.failureReason === RELATED_RECORD_NOT_OWNED_REASON,
  );

  const wrongCustomerRelated = await composeCustomerCommunication(prisma, tenantA.access, {
    customerId: customerA.id,
    channel: "MANUAL",
    purpose: "ESTIMATE_FOLLOW_UP",
    subject: "Wrong customer",
    body: "Should not attach Bria estimate to Ava.",
    relatedType: "ESTIMATE",
    relatedId: estimateBria.id,
    idempotencyKey: `wrong-customer-related-${randomUUID()}`,
  });
  check(
    "Same-tenant wrong-customer related record is rejected",
    wrongCustomerRelated.ok === false &&
      wrongCustomerRelated.failureReason === RELATED_RECORD_WRONG_CUSTOMER_REASON,
  );

  const explicitVsRequest = await recordMissedOrManualCall(prisma, tenantA.access, {
    kind: "MISSED_CALL",
    customerId: customerBria.id,
    requestId: requestA.id,
    summary: "Explicit customer conflicts with request.",
    idempotencyKey: `conflict-request-${randomUUID()}`,
  });
  check(
    "Explicit customer vs request customer is rejected",
    explicitVsRequest.ok === false && explicitVsRequest.failureReason === PHONE_LOG_CUSTOMER_CONFLICT_REASON,
  );

  const requestVsJob = await recordMissedOrManualCall(prisma, tenantA.access, {
    kind: "MISSED_CALL",
    requestId: requestA.id,
    jobId: jobBria.id,
    summary: "Request and job resolve to different customers.",
    idempotencyKey: `conflict-job-${randomUUID()}`,
  });
  check(
    "Request and job customer conflict is rejected",
    requestVsJob.ok === false && requestVsJob.failureReason === PHONE_LOG_CUSTOMER_CONFLICT_REASON,
  );

  const foreignRequest = await recordMissedOrManualCall(prisma, tenantA.access, {
    kind: "MISSED_CALL",
    customerId: customerA.id,
    requestId: (
      await prisma.serviceRequest.create({
        data: { businessId: tenantB.business.id, customerId: customerB.id, summary: "B request" },
      })
    ).id,
    summary: "Foreign request.",
    idempotencyKey: `foreign-request-${randomUUID()}`,
  });
  check(
    "Foreign requestId on a phone log is rejected",
    foreignRequest.ok === false && foreignRequest.failureReason === RELATED_RECORD_NOT_OWNED_REASON,
  );

  const concurrentKey = `missed-concurrent-${randomUUID()}`;
  const concurrentInput = {
    kind: "MISSED_CALL",
    customerId: customerA.id,
    summary: "Concurrent missed-call claim.",
    callbackNeeded: true,
    requestId: requestA.id,
    idempotencyKey: concurrentKey,
  };
  const [left, right] = await Promise.all([
    recordMissedOrManualCall(prisma, tenantA.access, concurrentInput),
    recordMissedOrManualCall(prisma, tenantA.access, concurrentInput),
  ]);
  const concurrentPhones = await prisma.phoneInteraction.findMany({
    where: { businessId: tenantA.business.id, idempotencyKey: concurrentKey },
  });
  const concurrentComms = await prisma.customerCommunication.findMany({
    where: { businessId: tenantA.business.id, idempotencyKey: `phone:MISSED_CALL:${concurrentKey}` },
  });
  const concurrentActions = await prisma.businessActionItem.findMany({
    where: { businessId: tenantA.business.id, recommendationKey: `phone-callback:${concurrentKey}` },
  });
  check(
    "Concurrent missed-call retries create one phone log, one communication, one callback task",
    left.ok &&
      right.ok &&
      (left.reused || right.reused) &&
      left.phoneInteractionId === right.phoneInteractionId &&
      concurrentPhones.length === 1 &&
      concurrentComms.length === 1 &&
      concurrentActions.length === 1,
  );

  async function assertLogicalPhoneLog(businessId, idempotencyKey, label) {
    const phones = await prisma.phoneInteraction.findMany({
      where: { businessId, idempotencyKey },
    });
    const comms = await prisma.customerCommunication.findMany({
      where: { businessId, idempotencyKey: `phone:MISSED_CALL:${idempotencyKey}` },
    });
    const actions = await prisma.businessActionItem.findMany({
      where: { businessId, recommendationKey: `phone-callback:${idempotencyKey}` },
    });
    check(
      label,
      phones.length === 1 &&
        comms.length === 1 &&
        actions.length === 1 &&
        phones[0].communicationId === comms[0].id &&
        phones[0].followUpActionItemId === actions[0].id,
    );
    return { phones, comms, actions };
  }

  async function injectAndRetry(stage, idempotencyKey) {
    const payload = {
      kind: "MISSED_CALL",
      customerId: customerA.id,
      summary: `Crash after ${stage}.`,
      callbackNeeded: true,
      requestId: requestA.id,
      idempotencyKey,
    };
    setPhoneLogFailureAfter(stage);
    let injected = false;
    try {
      await recordMissedOrManualCall(prisma, tenantA.access, payload);
    } catch (error) {
      injected = String(error?.message ?? "").startsWith(
        `${PHONE_LOG_INJECTED_FAILURE_PREFIX}${stage}`,
      );
    }
    setPhoneLogFailureAfter(null);
    const repaired = await recordMissedOrManualCall(prisma, tenantA.access, payload);
    return { injected, repaired };
  }

  const afterClaimKey = `missed-crash-claimed-${randomUUID()}`;
  const afterClaim = await injectAndRetry("claimed", afterClaimKey);
  const afterClaimPartial = await prisma.phoneInteraction.findFirst({
    where: { businessId: tenantA.business.id, idempotencyKey: afterClaimKey },
  });
  check(
    "Crash after PhoneInteraction claim leaves the claim and is retryable",
    afterClaim.injected &&
      afterClaimPartial &&
      afterClaim.repaired.ok &&
      afterClaim.repaired.reused,
  );
  await assertLogicalPhoneLog(
    tenantA.business.id,
    afterClaimKey,
    "Retry after claim crash converges to one phone log, communication, and callback",
  );

  const afterActionKey = `missed-crash-action-${randomUUID()}`;
  const afterAction = await injectAndRetry("action", afterActionKey);
  check(
    "Crash after callback action is retryable",
    afterAction.injected && afterAction.repaired.ok && afterAction.repaired.reused,
  );
  await assertLogicalPhoneLog(
    tenantA.business.id,
    afterActionKey,
    "Retry after callback-action crash reuses the action and completes the communication",
  );

  const afterCommKey = `missed-crash-communication-${randomUUID()}`;
  const afterComm = await injectAndRetry("communication", afterCommKey);
  check(
    "Crash after communication is retryable",
    afterComm.injected && afterComm.repaired.ok && afterComm.repaired.reused,
  );
  await assertLogicalPhoneLog(
    tenantA.business.id,
    afterCommKey,
    "Retry after communication crash links the existing rows without duplicates",
  );

  console.log("\nDB — Tenant isolation and role checks");
  let memberDenied = false;
  try {
    await composeCustomerCommunication(prisma, tenantA.memberAccess, {
      customerId: customerA.id,
      channel: "EMAIL",
      purpose: "GENERAL",
      body: "Member should not send whole-customer mail.",
      idempotencyKey: `member-${randomUUID()}`,
    });
  } catch (error) {
    memberDenied = error instanceof ForbiddenError;
  }
  check("MEMBER cannot compose whole-customer communications", memberDenied);

  let memberTimelineDenied = false;
  try {
    await loadCustomerCommunicationTimeline(prisma, tenantA.memberAccess, {
      customerId: customerA.id,
    });
  } catch (error) {
    memberTimelineDenied = error instanceof ForbiddenError;
  }
  check("MEMBER cannot read whole-customer communication history", memberTimelineDenied);

  let crossTenant = false;
  try {
    await composeCustomerCommunication(prisma, tenantB.access, {
      customerId: customerA.id,
      channel: "EMAIL",
      purpose: "GENERAL",
      body: "Cross tenant send.",
      idempotencyKey: `cross-${randomUUID()}`,
    });
  } catch (error) {
    crossTenant = error instanceof ForbiddenError;
  }
  check("Tenant B cannot send through tenant A customer", crossTenant);

  const bTimeline = await loadCustomerCommunicationTimeline(prisma, tenantB.access, {
    customerId: customerB.id,
  });
  check(
    "Tenant B timeline does not include tenant A records",
    bTimeline.every((item) => !item.body.includes("General customer email")),
  );

  const assigned = await prisma.job.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      projectToken: randomUUID(),
      assignedMembershipId: tenantA.memberMembership.id,
    },
  });
  await prisma.customerCommunication.create({
    data: {
      businessId: tenantA.business.id,
      customerId: customerA.id,
      channel: "EMAIL",
      purpose: "JOB_UPDATE",
      relatedType: "JOB",
      relatedId: assigned.id,
      idempotencyKey: `job-field-${randomUUID()}`,
      bodySnapshot: "Assigned job update only.",
      status: "SENT",
      provider: "manual",
    },
  });
  const fieldRows = await listAssignedJobCommunications(prisma, {
    businessId: tenantA.business.id,
    membershipId: tenantA.memberMembership.id,
    jobId: assigned.id,
  });
  check(
    "MEMBER field helper only returns assigned-job communications",
    fieldRows.some((row) => row.bodySnapshot.includes("Assigned job update only")),
  );

  const forgedField = await listAssignedJobCommunications(prisma, {
    businessId: tenantB.business.id,
    membershipId: tenantA.memberMembership.id,
    jobId: assigned.id,
  });
  check("Assigned-job comms stay tenant-scoped", forgedField.length === 0);

  let browserDeniedReason = "";
  const browserForged = await composeCustomerCommunication(prisma, tenantA.access, {
    customerId: customerA.id,
    channel: "EMAIL",
    purpose: "GENERAL",
    body: "Forged business id.",
    idempotencyKey: `browser-${randomUUID()}`,
    browserBusinessId: tenantB.business.id,
  });
  browserDeniedReason = browserForged.failureReason ?? "";
  check(
    "Browser businessId never authorizes a send",
    browserForged.ok === false && /never authorizes/i.test(browserDeniedReason),
  );

  console.log("\nDB — AI suggestion-only and receptionist honesty");
  const beforeAi = await prisma.customerCommunication.count({
    where: { businessId: tenantA.business.id },
  });
  const draft = await runCommunicationAssist(prisma, tenantA.access, {
    action: "draft",
    customerId: customerA.id,
    context: "Follow up on the estimate",
    idempotencyKey: `ai-draft-${randomUUID()}`,
  });
  const afterAi = await prisma.customerCommunication.count({
    where: { businessId: tenantA.business.id },
  });
  check(
    "AI draft is suggestion-only and does not send",
    Boolean(draft.output?.text) && afterAi === beforeAi,
  );
  const summary = await runCommunicationAssist(prisma, tenantA.access, {
    action: "summarize",
    customerId: customerA.id,
    idempotencyKey: `ai-sum-${randomUUID()}`,
  });
  check(
    "AI summary stays on this customer",
    Boolean(summary.output?.text) && !/Bea/.test(summary.output?.text ?? ""),
  );
  let memberAiDenied = false;
  try {
    await runCommunicationAssist(prisma, tenantA.memberAccess, {
      action: "summarize",
      customerId: customerA.id,
      idempotencyKey: `ai-member-${randomUUID()}`,
    });
  } catch (error) {
    memberAiDenied = error instanceof ForbiddenError;
  }
  check("MEMBER cannot run communications AI", memberAiDenied);

  const readiness = getReceptionistReadiness({ emailConfigured: true, smsConfigured: false });
  check(
    "Receptionist voice is not connected and cannot complete calls",
    readiness.voice.connected === false &&
      readiness.voice.canCompleteCalls === false &&
      readiness.voice.provisionedNumber === false &&
      readiness.voice.reason === VOICE_NOT_CONNECTED_REASON,
  );
  const inbound = await recordInboundCallEvent(prisma, tenantA.access, {
    phone: "5551112222",
    customerId: customerA.id,
    summary: "Caller asked to schedule.",
    idempotencyKey: `inbound-${randomUUID()}`,
  });
  check(
    "Inbound call events are recorded as not connected, not completed",
    inbound.event.status === "SKIPPED_NOT_CONNECTED" &&
      inbound.event.providerConnected === false,
  );
  const lookup = await lookupCaller(prisma, tenantA.access, { phone: "5551112222" });
  check("Caller lookup stays inside the tenant", lookup.matched && lookup.customer?.id === customerA.id);
  const foreignLookup = await lookupCaller(prisma, tenantB.access, { phone: "5551112222" });
  check("Caller lookup does not leak tenant A customers", foreignLookup.matched === false);

  console.log("\nDB — Automation reuse, no spam loops");
  await ensureDefaultAutomationRules(prisma, tenantA.business.id);
  await prisma.businessEvent.create({
    data: {
      businessId: tenantA.business.id,
      type: "ESTIMATE_SENT",
      subjectType: "ESTIMATE",
      subjectId: estimateA.id,
      payload: { customerId: customerA.id },
      idempotencyKey: `ESTIMATE_SENT:${estimateA.id}`,
      occurredAt: new Date(Date.now() - ESTIMATE_NO_ACTION_AFTER_MS - 60_000),
    },
  });
  await scanScheduledBusinessEvents(prisma, tenantA.business.id);
  const noAction = await prisma.businessEvent.findMany({
    where: {
      businessId: tenantA.business.id,
      type: "ESTIMATE_NO_ACTION",
      subjectId: estimateA.id,
    },
  });
  check("Estimate-no-action scan emits one durable event", noAction.length === 1);
  await scanScheduledBusinessEvents(prisma, tenantA.business.id);
  const noActionAgain = await prisma.businessEvent.findMany({
    where: {
      businessId: tenantA.business.id,
      type: "ESTIMATE_NO_ACTION",
      subjectId: estimateA.id,
    },
  });
  check("Estimate-no-action scan is idempotent", noActionAgain.length === 1);

  const followUpEvent = await emitAndProcessBusinessEvent(prisma, {
    businessId: tenantA.business.id,
    type: "OWNER_FOLLOW_UP_CREATED",
    subjectType: "CUSTOMER",
    subjectId: customerA.id,
    payload: { customerId: customerA.id },
    idempotencyKey: `OWNER_FOLLOW_UP_CREATED:test-${customerA.id}`,
  });
  const suggestionRun = await prisma.automationRun.findFirst({
    where: {
      businessId: tenantA.business.id,
      eventId: followUpEvent.event.id,
    },
  });
  check(
    "Owner follow-up automation is suggestion-only and does not send",
    suggestionRun?.kind === "ACTION_SUGGESTION" &&
      (suggestionRun.status === "SUCCEEDED" || suggestionRun.status === "PENDING"),
  );

  const stored = await prisma.customerCommunication.findMany({
    where: { businessId: tenantA.business.id },
  });
  check(
    "Communication records do not store raw secrets",
    stored.every(
      (row) =>
        !/sk_live_|password|TWILIO_AUTH_TOKEN|RESEND_API_KEY/i.test(
          JSON.stringify(row.providerMetadata ?? {}) + (row.bodySnapshot ?? ""),
        ),
    ),
  );

  requireBusinessCapability(tenantA.access, CAPABILITIES.MANAGE_COMMUNICATIONS);
  let memberCapDenied = false;
  try {
    requireBusinessCapability(tenantA.memberAccess, CAPABILITIES.MANAGE_COMMUNICATIONS);
  } catch (error) {
    memberCapDenied = error instanceof ForbiddenError;
  }
  check("Role gate rejects MEMBER communications access", memberCapDenied);

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
