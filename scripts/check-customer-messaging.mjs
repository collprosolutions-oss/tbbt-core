/**
 * Customer messaging foundation (Task 79).
 *
 * Provider-neutral SMS adapter, consent, tenant isolation, audit trail,
 * and operational workflow wiring. Does not call a live SMS vendor.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-customer-messaging.mjs
 */
import { createHmac } from "node:crypto";
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const ALLOWED_TEST_HOSTS = new Set(["localhost", "127.0.0.1"]);
function assertLocalDatabaseUrl(urlString, label) {
  let parsedUrl;
  try {
    parsedUrl = new URL(urlString);
  } catch {
    console.error(`${label} is not a valid URL.`);
    process.exit(1);
  }
  const host = (parsedUrl.hostname || "").toLowerCase();
  if (!ALLOWED_TEST_HOSTS.has(host)) {
    console.error(
      `Refusing customer-messaging test DB: ${label} host must be localhost or 127.0.0.1, got ${host || "(empty)"}.`,
    );
    process.exit(1);
  }
  return parsedUrl;
}

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "DATABASE_URL");

const testDbName = "tbbt_customer_messaging_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
assertLocalDatabaseUrl(testUrl, "customer-messaging test DATABASE_URL");
process.env.DATABASE_URL = testUrl;
process.env.NEXT_PUBLIC_APP_URL = "http://customer-messaging.test";
delete process.env.TBBT_CUSTOMER_MESSAGING_ADAPTER;
delete process.env.VERCEL_ENV;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_MESSAGING_SERVICE_SID;
delete process.env.TWILIO_FROM_NUMBER;

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for customer messaging test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });
delete process.env.TBBT_CUSTOMER_MESSAGING_ADAPTER;
delete process.env.VERCEL_ENV;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_MESSAGING_SERVICE_SID;
delete process.env.TWILIO_FROM_NUMBER;

const { REQUEST_SEND_DISCLAIMER } = await import("@/lib/reviews");
const {
  advanceReviewRequestStatus,
  createReviewRequest,
  markReviewRequestSentManually,
  sendReviewRequest,
} = await import("@/lib/reviews-ops");
const { sendDraftInvoiceIfNeeded } = await import("@/lib/complete-job-invoice");
const { createPublicServiceRequest } = await import("@/lib/public-intake");
const {
  applyCustomerMessageDeliveryUpdate,
  applyInboundConsentEvent,
  claimedAtFromCuid,
  inboundConsentTestHooks,
  attemptAppointmentReminderSms,
  attemptCustomerSms,
  attemptPaymentReminderSms,
  communicationPreferenceEnabled,
  createDisconnectedCustomerMessagingProvider,
  createFakeCustomerMessagingProvider,
  createTwilioCustomerMessagingProvider,
  CUSTOMER_MESSAGING_ENSURE_SQL,
  customerSmsIdempotencyKey,
  evaluateSmsEligibility,
  getCustomerCommunication,
  getCustomerMessagingProvider,
  getTwilioMessagingConfig,
  handleCustomerMessagingWebhookRequest,
  isAffirmativeSmsOptIn,
  isCustomerMessagingConfigured,
  isCustomerMessagingWebhookPath,
  isFakeCustomerMessagingAdapterEnabled,
  isSmsConsentGranted,
  isTwilioCustomerMessagingConfigured,
  listCustomerCommunications,
  parseTwilioOptOutType,
  resetCustomerMessagingProvider,
  resolveStoredSmsConsent,
  setCustomerMessagingProvider,
  smsConsentAfterOwnerPhoneEdit,
  smsConsentFromPublicOptIn,
  twilioRequestSignature,
  twilioStatusToCustomerMessageStatus,
  withTransactionalOptOutFooter,
} = await import("@/lib/customer-messaging");

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
  const business = await prisma.business.create({
    data: {
      name,
      slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID().slice(0, 8)}`,
    },
  });
  const membership = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: business.id, role: "OWNER" },
  });
  return { business, membership, access: makeAccess(business.id, "OWNER", membership.id) };
}

function smsInput(overrides) {
  return {
    purpose: "ESTIMATE_READY",
    idempotencyKey: `sms:test:${randomUUID()}`,
    body: "Your estimate is ready.",
    ...overrides,
  };
}

function uniqueSmsDigits(lead) {
  const rest = randomUUID().replace(/[^0-9]/g, "8").slice(0, 7);
  return `${lead}${rest}`.slice(0, 10);
}

const BARRIER_WAIT_MS = 10_000;
const LOCK_POLL_MS = 10_000;

function createCount2Barrier() {
  let count = 0;
  const waiters = [];
  let firstArrived;
  const first = new Promise((resolve) => {
    firstArrived = resolve;
  });
  return {
    arrive: async () => {
      count += 1;
      if (count === 1) firstArrived();
      if (count >= 2) {
        for (const release of waiters) release();
        waiters.length = 0;
        return;
      }
      await withTimeout(
        new Promise((resolve) => {
          waiters.push(resolve);
        }),
        BARRIER_WAIT_MS,
        "barrier wait",
      );
    },
    firstArrived: first,
  };
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForTestDbLock(admin, label) {
  const started = Date.now();
  while (Date.now() - started < LOCK_POLL_MS) {
    const rows = await admin.$queryRaw`
      SELECT pid, wait_event_type, wait_event, state, left(query, 120) AS query
      FROM pg_stat_activity
      WHERE datname = ${testDbName}
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
    `;
    if (rows.length > 0) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const snapshot = await admin.$queryRaw`
    SELECT pid, wait_event_type, wait_event, state, left(query, 160) AS query
    FROM pg_stat_activity
    WHERE datname = ${testDbName}
      AND pid <> pg_backend_pid()
  `;
  throw new Error(
    `${label}: timed out waiting for wait_event_type=Lock on ${testDbName}. activity=${JSON.stringify(snapshot)}`,
  );
}

const opsSrc = readFileSync(new URL("../src/lib/customer-messaging/ops.ts", import.meta.url), "utf8");
const configSrc = readFileSync(new URL("../src/lib/customer-messaging/config.ts", import.meta.url), "utf8");
const twilioSrc = readFileSync(new URL("../src/lib/customer-messaging/twilio.ts", import.meta.url), "utf8");
const proxySrc = readFileSync(new URL("../src/proxy.ts", import.meta.url), "utf8");
const estimateActionSrc = readFileSync(new URL("../src/app/actions/estimate.ts", import.meta.url), "utf8");
const sendEstimateSrc = estimateActionSrc.slice(
  estimateActionSrc.indexOf("export async function sendEstimate"),
  estimateActionSrc.indexOf("export async function returnEstimateToDraft"),
);
const reviewsOpsSrc = readFileSync(new URL("../src/lib/reviews-ops.ts", import.meta.url), "utf8");
const invoiceSrc = readFileSync(new URL("../src/lib/complete-job-invoice.ts", import.meta.url), "utf8");
const appointmentSrc = readFileSync(new URL("../src/lib/appointment-notify.ts", import.meta.url), "utf8");
const saasOpsSrc = readFileSync(new URL("../src/lib/saas-billing/ops.ts", import.meta.url), "utf8");
const paymentsServiceSrc = readFileSync(new URL("../src/lib/payments/service.ts", import.meta.url), "utf8");
const webhookRouteSrc = readFileSync(
  new URL("../src/app/api/customer-messaging/webhook/route.ts", import.meta.url),
  "utf8",
);
const webhookHandlerSrc = readFileSync(
  new URL("../src/lib/customer-messaging/webhook.ts", import.meta.url),
  "utf8",
);
const inboundSrc = readFileSync(
  new URL("../src/lib/customer-messaging/inbound.ts", import.meta.url),
  "utf8",
);
const requestFlowSrc = readFileSync(
  new URL("../src/components/public/request-flow.tsx", import.meta.url),
  "utf8",
);
const customerActionSrc = readFileSync(
  new URL("../src/app/actions/customer.ts", import.meta.url),
  "utf8",
);
const settingsWorkspaceSrc = readFileSync(
  new URL("../src/components/settings/settings-workspace.tsx", import.meta.url),
  "utf8",
);

try {
  console.log("\nSTATIC — Provider architecture and isolation");
  check(
    "Default environment is not a connected SMS provider",
    isCustomerMessagingConfigured() === false && isFakeCustomerMessagingAdapterEnabled() === false,
  );
  const previousVercel = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = "production";
  process.env.TBBT_CUSTOMER_MESSAGING_ADAPTER = "fake";
  check("Production never enables the fake SMS adapter", isFakeCustomerMessagingAdapterEnabled() === false);
  delete process.env.TBBT_CUSTOMER_MESSAGING_ADAPTER;
  if (previousVercel === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = previousVercel;

  check(
    "Disconnected send does not mint a provider message id",
    (await createDisconnectedCustomerMessagingProvider().send({
      businessId: "biz",
      communicationId: "comm",
      channel: "SMS",
      to: "2395550100",
      body: "hi",
      purpose: "ESTIMATE_READY",
    })).providerMessageId === undefined,
  );
  check(
    "Unknown consent is not granted",
    resolveStoredSmsConsent("UNKNOWN") === "UNKNOWN" && isSmsConsentGranted("UNKNOWN") === false,
  );
  check(
    "Phone presence is not treated as consent",
    evaluateSmsEligibility({
      businessId: "biz",
      phone: "2395550100",
      smsConsentStatus: "UNKNOWN",
      purpose: "ESTIMATE_READY",
      preferences: { estimateCommunicationEnabled: true },
    }).ok === false &&
      evaluateSmsEligibility({
        businessId: "biz",
        phone: "2395550100",
        smsConsentStatus: "UNKNOWN",
        purpose: "ESTIMATE_READY",
        preferences: { estimateCommunicationEnabled: true },
      }).reason === "unknown_consent",
  );
  check(
    "Review request preference defaults off",
    communicationPreferenceEnabled("REVIEW_REQUEST", null) === false,
  );
  check(
    "Webhook path is exact and not a public website substitute",
    isCustomerMessagingWebhookPath("/api/customer-messaging/webhook") &&
      !isCustomerMessagingWebhookPath("/api/customer-messaging/webhook/extra"),
  );
  check(
    "Auth proxy allows the messaging webhook without a session",
    proxySrc.includes("isCustomerMessagingWebhookPath") &&
      proxySrc.includes("api/customer-messaging/webhook") &&
      proxySrc.includes("isStripeWebhookPath(pathname)") &&
      proxySrc.includes("isCustomerMessagingWebhookPath(pathname)"),
  );
  check(
    "Webhook 404s when no connected provider is configured",
    webhookHandlerSrc.includes("status: 404") &&
      webhookHandlerSrc.includes("parseWebhook") &&
      webhookHandlerSrc.includes("Invalid signature") &&
      webhookRouteSrc.includes("handleCustomerMessagingWebhookRequest") &&
      webhookRouteSrc.includes("NextResponse.json") &&
      !webhookHandlerSrc.includes("businessId"),
  );
  check(
    "Failed inbound apply returns a non-2xx so the provider retries",
    webhookHandlerSrc.includes("status: 500") &&
      webhookHandlerSrc.includes("Unable to process.") &&
      webhookHandlerSrc.includes("GENERIC_UNAVAILABLE"),
  );
  check(
    "Inbound STOP claim is not treated as consent completion",
    inboundSrc.includes("Claim is identity-only until processedAt leaves the pending sentinel") &&
      inboundSrc.includes("inboundConsentTestHooks") &&
      inboundSrc.includes("INBOUND_WEBHOOK_PENDING_AT") &&
      inboundSrc.includes("Look up first so a duplicate insert cannot abort this transaction") &&
      inboundSrc.includes("isPendingWebhookProcessedAt") &&
      inboundSrc.includes("claimedAtFromCuid") &&
      inboundSrc.includes("pg_advisory_xact_lock") &&
      inboundSrc.includes("stale_event"),
  );
  check(
    "Public request opt-in checkbox starts unchecked",
    requestFlowSrc.includes("const [smsOptIn, setSmsOptIn] = useState(false)") &&
      requestFlowSrc.includes("SMS_OPT_IN_LABEL") &&
      !requestFlowSrc.includes("useState(true)"),
  );
  check(
    "Owner customer edit cannot grant SMS consent",
    customerActionSrc.includes("smsConsentAfterOwnerPhoneEdit") &&
      !customerActionSrc.includes('smsConsentStatus: "GRANTED"'),
  );
  check(
    "Send Estimate still does not send email",
    !sendEstimateSrc.includes("sendTransactionalEmail") &&
      sendEstimateSrc.includes("attemptEstimateReadySms"),
  );
  check(
    "Email Estimate still uses Resend after the owner action",
    estimateActionSrc.includes("sendTransactionalEmail") &&
      estimateActionSrc.includes("attemptEstimateReadySms"),
  );
  check(
    "Appointment and invoice email paths still use sendTransactionalEmail",
    appointmentSrc.includes("sendTransactionalEmail") &&
      invoiceSrc.includes("sendTransactionalEmail") &&
      appointmentSrc.includes("attemptAppointmentSms") &&
      invoiceSrc.includes("attemptInvoiceReadySms"),
  );
  check(
    "Review send attempts adapters without claiming SENT on disconnect",
    reviewsOpsSrc.includes("attemptReviewRequestSms") &&
      reviewsOpsSrc.includes('status: delivered ? "SENT" : "FAILED"') &&
      /connected email and SMS adapters/i.test(REQUEST_SEND_DISCLAIMER),
  );
  check(
    "Settings workspace does not send messages",
    !settingsWorkspaceSrc.includes("attemptCustomerSms") &&
      !settingsWorkspaceSrc.includes("sendTransactionalEmail"),
  );
  check(
    "Customer messaging does not implement SaaS Checkout or Connect charges",
    !opsSrc.includes("createSubscriptionCheckout") &&
      !opsSrc.includes("STRIPE_SECRET_KEY") &&
      !configSrc.includes("STRIPE_SAAS_PRICE_ID") &&
      saasOpsSrc.includes("createSubscriptionCheckout") &&
      paymentsServiceSrc.includes("connectedAccountId"),
  );
  check(
    "Twilio send does not use a shared env FROM for every tenant",
    !twilioSrc.includes("config.fromNumber") &&
      twilioSrc.includes("This business has no assigned SMS number.") &&
      opsSrc.includes("operationalSmsNumber"),
  );
  check(
    "Preview ensure SQL is additive",
    CUSTOMER_MESSAGING_ENSURE_SQL.every((sql) => !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(sql)),
  );

  const alpha = await seedBusiness("Alpha Messaging");
  const beta = await seedBusiness("Beta Messaging");

  const customerA = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Ada Homeowner",
      phone: "2395550100",
      email: "ada@example.com",
      smsConsentStatus: "GRANTED",
    },
  });
  const customerB = await prisma.customer.create({
    data: {
      businessId: beta.business.id,
      name: "Bea Secret",
      phone: "2395550199",
      smsConsentStatus: "GRANTED",
    },
  });
  const noPhone = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "No Phone",
      smsConsentStatus: "GRANTED",
    },
  });
  const unknownConsent = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Unknown Consent",
      phone: "2395550101",
    },
  });
  const revoked = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Revoked Consent",
      phone: "2395550102",
      smsConsentStatus: "REVOKED",
    },
  });

  const estimateA = await prisma.estimate.create({
    data: {
      businessId: alpha.business.id,
      customerId: customerA.id,
      status: "SENT",
      publicToken: randomUUID(),
      total: 100,
    },
  });
  const estimateB = await prisma.estimate.create({
    data: {
      businessId: beta.business.id,
      customerId: customerB.id,
      status: "SENT",
      publicToken: randomUUID(),
      total: 200,
    },
  });
  const jobA = await prisma.job.create({
    data: {
      businessId: alpha.business.id,
      customerId: customerA.id,
      status: "SCHEDULED",
      projectToken: randomUUID(),
    },
  });
  const invoiceA = await prisma.invoice.create({
    data: {
      businessId: alpha.business.id,
      customerId: customerA.id,
      jobId: jobA.id,
      status: "DRAFT",
      total: 150,
    },
  });

  console.log("\nTEST — Tenant isolation");
  setCustomerMessagingProvider(createFakeCustomerMessagingProvider("whsec_msg_test"));
  const cross = await attemptCustomerSms(prisma, smsInput({
    businessId: alpha.business.id,
    customerId: customerB.id,
    relatedType: "ESTIMATE",
    relatedId: estimateB.id,
  }));
  check("Business A cannot send using Business B's customer", cross.communicationId === null && cross.status === "BLOCKED");

  const relatedCross = await attemptCustomerSms(prisma, smsInput({
    businessId: alpha.business.id,
    customerId: customerA.id,
    relatedType: "ESTIMATE",
    relatedId: estimateB.id,
  }));
  check("Business A cannot attach Business B's estimate", relatedCross.communicationId === null);

  const sentA = await attemptCustomerSms(prisma, smsInput({
    businessId: alpha.business.id,
    customerId: customerA.id,
    relatedType: "ESTIMATE",
    relatedId: estimateA.id,
    idempotencyKey: customerSmsIdempotencyKey("ESTIMATE_READY", estimateA.id),
  }));
  check("Eligible send is accepted with a provider message id", sentA.ok && sentA.status === "ACCEPTED" && Boolean(sentA.providerMessageId));

  const readB = await getCustomerCommunication(prisma, {
    businessId: beta.business.id,
    communicationId: sentA.communicationId,
  });
  check("Business B cannot read Business A's communication", readB === null);
  const listB = await listCustomerCommunications(prisma, { businessId: beta.business.id });
  check("Business B list does not include Business A rows", listB.length === 0);

  console.log("\nTEST — Consent, phone, and preferences");
  const missingPhone = await attemptCustomerSms(prisma, smsInput({
    businessId: alpha.business.id,
    customerId: noPhone.id,
  }));
  check("Missing phone blocks SMS", missingPhone.status === "BLOCKED" && /phone/i.test(missingPhone.failureReason ?? ""));

  const unknown = await attemptCustomerSms(prisma, smsInput({
    businessId: alpha.business.id,
    customerId: unknownConsent.id,
  }));
  check("Unknown consent does not become consent", unknown.status === "BLOCKED" && /not granted/i.test(unknown.failureReason ?? ""));
  check("Unknown consent customer remains UNKNOWN", (await prisma.customer.findFirst({ where: { id: unknownConsent.id } })).smsConsentStatus === "UNKNOWN");

  const revokedResult = await attemptCustomerSms(prisma, smsInput({
    businessId: alpha.business.id,
    customerId: revoked.id,
  }));
  check("Revoked consent blocks SMS", revokedResult.status === "BLOCKED" && /revoked/i.test(revokedResult.failureReason ?? ""));

  await prisma.businessSettings.create({
    data: {
      businessId: alpha.business.id,
      estimateCommunicationEnabled: false,
      scheduleNotificationEnabled: true,
      invoiceCommunicationEnabled: true,
      reviewRequestPreferenceEnabled: false,
    },
  });
  const preferenceOff = await attemptCustomerSms(prisma, smsInput({
    businessId: alpha.business.id,
    customerId: customerA.id,
    purpose: "ESTIMATE_READY",
    idempotencyKey: `sms:pref:${randomUUID()}`,
  }));
  check("Disabled customer communication preference blocks SMS", preferenceOff.status === "BLOCKED" && /preference/i.test(preferenceOff.failureReason ?? ""));
  await prisma.businessSettings.update({
    where: { businessId: alpha.business.id },
    data: { estimateCommunicationEnabled: true },
  });

  console.log("\nTEST — Disconnected provider honesty");
  setCustomerMessagingProvider(createDisconnectedCustomerMessagingProvider());
  const disconnected = await attemptCustomerSms(prisma, smsInput({
    businessId: alpha.business.id,
    customerId: customerA.id,
    relatedType: "ESTIMATE",
    relatedId: estimateA.id,
    idempotencyKey: `sms:disconnected:${randomUUID()}`,
  }));
  check(
    "Disconnected provider records NOT_SENT without a provider message id",
    disconnected.status === "NOT_SENT" && disconnected.providerMessageId === null && disconnected.ok === false,
  );

  console.log("\nTEST — Provider failure does not corrupt operational records");
  const failing = createFakeCustomerMessagingProvider("whsec_msg_test");
  failing.setFailNext(true);
  setCustomerMessagingProvider(failing);
  const beforeInvoice = await prisma.invoice.findFirst({ where: { id: invoiceA.id } });
  const failedSms = await attemptCustomerSms(prisma, smsInput({
    businessId: alpha.business.id,
    customerId: customerA.id,
    purpose: "INVOICE_READY",
    relatedType: "INVOICE",
    relatedId: invoiceA.id,
    idempotencyKey: `sms:fail:${invoiceA.id}`,
  }));
  const afterInvoice = await prisma.invoice.findFirst({ where: { id: invoiceA.id } });
  check("Provider failure records FAILED", failedSms.status === "FAILED" && failedSms.providerMessageId === null);
  check("Invoice status is unchanged after SMS failure", beforeInvoice.status === afterInvoice.status);

  const throwing = createFakeCustomerMessagingProvider("whsec_msg_test");
  throwing.setThrowNext(true);
  setCustomerMessagingProvider(throwing);
  const thrown = await attemptCustomerSms(prisma, smsInput({
    businessId: alpha.business.id,
    customerId: customerA.id,
    idempotencyKey: `sms:throw:${randomUUID()}`,
  }));
  check("Provider throw records FAILED and keeps an audit row", thrown.status === "FAILED" && Boolean(thrown.communicationId));

  console.log("\nTEST — Idempotency of accepted sends");
  const fake = createFakeCustomerMessagingProvider("whsec_msg_test");
  setCustomerMessagingProvider(fake);
  const firstKey = `sms:idem:${randomUUID()}`;
  const first = await attemptCustomerSms(prisma, smsInput({
    businessId: alpha.business.id,
    customerId: customerA.id,
    relatedType: "ESTIMATE",
    relatedId: estimateA.id,
    idempotencyKey: firstKey,
  }));
  const second = await attemptCustomerSms(prisma, smsInput({
    businessId: alpha.business.id,
    customerId: customerA.id,
    relatedType: "ESTIMATE",
    relatedId: estimateA.id,
    idempotencyKey: firstKey,
    body: "Different body must not resend.",
  }));
  check("Accepted send records provider message id", first.ok && Boolean(first.providerMessageId));
  check("Repeat of an accepted message reuses the row", second.reused && second.communicationId === first.communicationId);
  check("Repeat does not call the provider again", fake.sent.length === 1);

  console.log("\nTEST — Delivery callback foundation");
  const delivered = await applyCustomerMessageDeliveryUpdate(prisma, {
    provider: "fake",
    providerMessageId: first.providerMessageId,
    status: "DELIVERED",
  });
  check("Callback locates the communication by provider message id", delivered.applied && delivered.reason === "updated");
  const afterDelivered = await getCustomerCommunication(prisma, {
    businessId: alpha.business.id,
    communicationId: first.communicationId,
  });
  check("Delivered status is stored", afterDelivered.status === "DELIVERED");
  const again = await applyCustomerMessageDeliveryUpdate(prisma, {
    provider: "fake",
    providerMessageId: first.providerMessageId,
    status: "DELIVERED",
  });
  check("Repeated callback is idempotent", again.applied && again.reason === "idempotent");
  const mismatch = await applyCustomerMessageDeliveryUpdate(prisma, {
    provider: "fake",
    providerMessageId: first.providerMessageId,
    status: "FAILED",
    claimedBusinessId: beta.business.id,
  });
  check("Callback with another business id is rejected", mismatch.applied === false && mismatch.reason === "tenant_mismatch");
  const stillDelivered = await getCustomerCommunication(prisma, {
    businessId: alpha.business.id,
    communicationId: first.communicationId,
  });
  check("Rejected callback does not change tenant data", stillDelivered.status === "DELIVERED");
  const signed = JSON.stringify({
    providerMessageId: first.providerMessageId,
    status: "SENT",
    businessId: alpha.business.id,
  });
  const signature = createHmac("sha256", "whsec_msg_test").update(signed).digest("hex");
  const verified = fake.verifyDeliveryCallback(signed, signature);
  check("Fake adapter verifies a signed delivery payload", verified?.providerMessageId === first.providerMessageId);
  check("Invalid signature is rejected", fake.verifyDeliveryCallback(signed, "deadbeef") === null);

  console.log("\nTEST — Review request remains truthful");
  await prisma.businessSettings.update({
    where: { businessId: alpha.business.id },
    data: { reviewRequestPreferenceEnabled: true },
  });
  setCustomerMessagingProvider(createDisconnectedCustomerMessagingProvider());
  const reviewDraft = await createReviewRequest(prisma, alpha.access, {
    customerId: customerA.id,
    requestText: "Would you share an honest review of our work?",
  });
  await advanceReviewRequestStatus(prisma, alpha.access, { requestId: reviewDraft.id });
  const reviewFailed = await sendReviewRequest(prisma, alpha.access, { requestId: reviewDraft.id });
  const reviewComms = await listCustomerCommunications(prisma, {
    businessId: alpha.business.id,
    customerId: customerA.id,
  });
  const reviewSms = reviewComms.filter((row) => row.purpose === "REVIEW_REQUEST");
  check("Disconnected send leaves the review request FAILED", reviewFailed.status === "FAILED");
  check(
    "Unavailable messaging leaves review SMS NOT_SENT or BLOCKED",
    reviewSms.length === 1 && (reviewSms[0].status === "NOT_SENT" || reviewSms[0].status === "BLOCKED"),
  );
  const reviewSent = await markReviewRequestSentManually(prisma, alpha.access, {
    requestId: reviewDraft.id,
  });
  check("Owner can mark a review request sent manually", reviewSent.status === "SENT");
  check(
    "Review disclaimer is honest about connected adapters",
    /connected email and SMS adapters/i.test(REQUEST_SEND_DISCLAIMER),
  );

  console.log("\nTEST — Invoice email path stays independent of SMS");
  const invoiceSend = await sendDraftInvoiceIfNeeded(prisma, {
    businessId: alpha.business.id,
    invoiceId: invoiceA.id,
    businessName: alpha.business.name,
  });
  check("Draft invoice still becomes SENT without email credentials", invoiceSend.ok && invoiceSend.status === "SENT");
  check("Invoice customerNotified remains email-based", invoiceSend.newlySent === true && invoiceSend.customerNotified === false);

  console.log("\nTEST — Reminder purposes share the controlled service");
  setCustomerMessagingProvider(createFakeCustomerMessagingProvider("whsec_msg_test"));
  const reminder = await attemptAppointmentReminderSms(prisma, {
    businessId: alpha.business.id,
    jobId: jobA.id,
    customerId: customerA.id,
    businessName: alpha.business.name,
    reminderKey: "2026-09-21",
    projectToken: jobA.projectToken,
    initiatedByMembershipId: alpha.membership.id,
  });
  const payReminder = await attemptPaymentReminderSms(prisma, {
    businessId: alpha.business.id,
    invoiceId: invoiceA.id,
    customerId: customerA.id,
    businessName: alpha.business.name,
    reminderKey: "2026-09-21",
    projectToken: jobA.projectToken,
    initiatedByMembershipId: alpha.membership.id,
  });
  check("Appointment reminder uses the shared SMS service", reminder?.status === "ACCEPTED");
  check("Payment reminder uses the shared SMS service", payReminder?.status === "ACCEPTED");

  console.log("\nTEST — Twilio adapter configuration and outbound mapping");
  resetCustomerMessagingProvider();
  check(
    "Twilio does not activate with only an account SID",
    (() => {
      process.env.TWILIO_ACCOUNT_SID = "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
      process.env.TWILIO_AUTH_TOKEN = "token";
      delete process.env.TWILIO_MESSAGING_SERVICE_SID;
      delete process.env.TWILIO_FROM_NUMBER;
      const configured = getTwilioMessagingConfig();
      delete process.env.TWILIO_ACCOUNT_SID;
      delete process.env.TWILIO_AUTH_TOKEN;
      return configured === null && isTwilioCustomerMessagingConfigured() === false;
    })(),
  );
  process.env.TWILIO_ACCOUNT_SID = "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  process.env.TWILIO_AUTH_TOKEN = "token";
  process.env.TWILIO_FROM_NUMBER = "+18555550100";
  check("Twilio activates when SID, token, and from-number are set", getTwilioMessagingConfig() !== null);
  process.env.VERCEL_ENV = "production";
  process.env.TBBT_CUSTOMER_MESSAGING_ADAPTER = "fake";
  resetCustomerMessagingProvider();
  check("Fake adapter cannot activate in Vercel production", isFakeCustomerMessagingAdapterEnabled() === false);
  check(
    "Production without complete Twilio config stays disconnected",
    (() => {
      delete process.env.TWILIO_ACCOUNT_SID;
      delete process.env.TWILIO_AUTH_TOKEN;
      delete process.env.TWILIO_FROM_NUMBER;
      resetCustomerMessagingProvider();
      return getCustomerMessagingProvider().connected === false && getCustomerMessagingProvider().id === "disconnected";
    })(),
  );
  delete process.env.VERCEL_ENV;
  delete process.env.TBBT_CUSTOMER_MESSAGING_ADAPTER;
  resetCustomerMessagingProvider();

  const alphaSms = uniqueSmsDigits("855");
  const betaSms = uniqueSmsDigits("856");
  const alphaE164 = `+1${alphaSms}`;
  const sharedEnvFrom = "+19998887777";

  const twilioSid = `SM${randomUUID().replace(/-/g, "")}`;
  let lastTwilioBody = "";
  let twilioFetches = 0;
  const twilio = createTwilioCustomerMessagingProvider(
    {
      accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      authToken: "twilio_test_token",
      messagingServiceSid: "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      fromNumber: sharedEnvFrom,
    },
    async (_url, init) => {
      twilioFetches += 1;
      lastTwilioBody = init.body;
      return {
        ok: true,
        status: 201,
        async json() {
          return { sid: twilioSid, status: "queued" };
        },
      };
    },
  );
  const missingFrom = await twilio.send({
    businessId: alpha.business.id,
    communicationId: "pending",
    channel: "SMS",
    to: "2395550100",
    body: "Your estimate is ready.",
    purpose: "ESTIMATE_READY",
  });
  check(
    "Twilio send without a tenant number does not hit the provider",
    missingFrom.ok === false &&
      missingFrom.status === "NOT_SENT" &&
      twilioFetches === 0 &&
      /no assigned SMS number/i.test(missingFrom.error),
  );

  setCustomerMessagingProvider(twilio);
  const sharedFromBlocked = await attemptCustomerSms(prisma, smsInput({
    businessId: alpha.business.id,
    customerId: customerA.id,
    relatedType: "ESTIMATE",
    relatedId: estimateA.id,
    idempotencyKey: `sms:twilio-no-number:${randomUUID()}`,
  }));
  check(
    "Shared TWILIO_FROM_NUMBER cannot send for a business without operationalSmsNumber",
    sharedFromBlocked.status === "NOT_SENT" &&
      sharedFromBlocked.providerMessageId === null &&
      twilioFetches === 0,
  );

  await prisma.business.update({
    where: { id: alpha.business.id },
    data: { operationalSmsNumber: alphaSms },
  });
  await prisma.business.update({
    where: { id: beta.business.id },
    data: { operationalSmsNumber: betaSms },
  });

  const queued = await twilio.send({
    businessId: alpha.business.id,
    communicationId: "pending",
    channel: "SMS",
    to: "2395550100",
    from: alphaSms,
    body: "Your estimate is ready.",
    purpose: "ESTIMATE_READY",
  });
  const queuedParams = new URLSearchParams(lastTwilioBody);
  check("Provider queued/accepted is not recorded as delivered", queued.ok && queued.status === "ACCEPTED");
  check("Accepted Twilio send persists the real provider message id", queued.providerMessageId === twilioSid);
  check(
    "Outbound From is the tenant dedicated number, not a shared env FROM",
    queuedParams.get("From") === alphaE164 &&
      queuedParams.get("From") !== sharedEnvFrom &&
      queuedParams.get("MessagingServiceSid") === "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  );
  check(
    "Transactional STOP footer is appended once",
    /Reply STOP to opt out/i.test(withTransactionalOptOutFooter("Your estimate is ready.")),
  );
  check("queued maps to ACCEPTED not DELIVERED", twilioStatusToCustomerMessageStatus("queued") === "ACCEPTED");
  check("delivered maps to DELIVERED", twilioStatusToCustomerMessageStatus("delivered") === "DELIVERED");
  check("undelivered maps to FAILED", twilioStatusToCustomerMessageStatus("undelivered") === "FAILED");

  const failingTwilio = createTwilioCustomerMessagingProvider(
    {
      accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      authToken: "twilio_test_token",
      messagingServiceSid: "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      fromNumber: sharedEnvFrom,
    },
    async () => ({
      ok: false,
      status: 400,
      async json() {
        return { message: "The messaging provider rejected the message." };
      },
    }),
  );
  setCustomerMessagingProvider(failingTwilio);
  const beforeFailInvoice = await prisma.invoice.findFirst({ where: { id: invoiceA.id } });
  const twilioFailed = await attemptCustomerSms(prisma, smsInput({
    businessId: alpha.business.id,
    customerId: customerA.id,
    purpose: "INVOICE_READY",
    relatedType: "INVOICE",
    relatedId: invoiceA.id,
    idempotencyKey: `sms:twilio-fail:${randomUUID()}`,
  }));
  const afterFailInvoice = await prisma.invoice.findFirst({ where: { id: invoiceA.id } });
  check("Twilio provider failure records FAILED without a message id", twilioFailed.status === "FAILED" && twilioFailed.providerMessageId === null);
  check("Invoice is unchanged after Twilio send failure", beforeFailInvoice.status === afterFailInvoice.status);

  setCustomerMessagingProvider(twilio);
  const twilioSent = await attemptCustomerSms(prisma, smsInput({
    businessId: alpha.business.id,
    customerId: customerA.id,
    relatedType: "ESTIMATE",
    relatedId: estimateA.id,
    idempotencyKey: `sms:twilio-ok:${randomUUID()}`,
  }));
  const sentParams = new URLSearchParams(lastTwilioBody);
  check("Twilio accepted send stores provider message id on the communication", twilioSent.ok && twilioSent.providerMessageId === twilioSid);
  check(
    "Ops send uses the tenant operationalSmsNumber as From",
    sentParams.get("From") === alphaE164,
  );

  console.log("\nTEST — Delivery callback signature, tenant, and idempotency");
  const webhookUrl = "http://customer-messaging.test/api/customer-messaging/webhook";
  const deliveryParams = {
    MessageSid: twilioSid,
    MessageStatus: "delivered",
    From: alphaE164,
    To: "+12395550100",
    AccountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  };
  const deliveryBody = new URLSearchParams(deliveryParams).toString();
  const unsignedDelivery = twilio.parseWebhook({
    url: webhookUrl,
    signature: "invalid",
    rawBody: deliveryBody,
    contentType: "application/x-www-form-urlencoded",
  });
  check("Delivery callback requires a valid Twilio signature", unsignedDelivery === null);
  const validDeliverySig = twilioRequestSignature("twilio_test_token", webhookUrl, deliveryParams);
  const signedDelivery = twilio.parseWebhook({
    url: webhookUrl,
    signature: validDeliverySig,
    rawBody: deliveryBody,
    contentType: "application/x-www-form-urlencoded",
  });
  check("Signed delivery callback maps to DELIVERED", signedDelivery?.kind === "delivery" && signedDelivery.update.status === "DELIVERED");

  setCustomerMessagingProvider(twilio);
  const unsignedHttp = await handleCustomerMessagingWebhookRequest(prisma, {
    url: webhookUrl,
    twilioSignature: "nope",
    tbbtSignature: null,
    rawBody: deliveryBody,
    contentType: "application/x-www-form-urlencoded",
  });
  check("HTTP webhook rejects invalid signature without tenant details", unsignedHttp.status === 400 && unsignedHttp.body.error === "Invalid signature." && !("businessId" in unsignedHttp.body));

  const firstCallback = await handleCustomerMessagingWebhookRequest(prisma, {
    url: webhookUrl,
    twilioSignature: validDeliverySig,
    tbbtSignature: null,
    rawBody: deliveryBody,
    contentType: "application/x-www-form-urlencoded",
  });
  const afterCallback = await getCustomerCommunication(prisma, {
    businessId: alpha.business.id,
    communicationId: twilioSent.communicationId,
  });
  check("Valid delivery callback returns a generic ok", firstCallback.status === 200 && firstCallback.body.ok === true);
  check("Callback updates the matching communication only", afterCallback.status === "DELIVERED");
  const duplicateCallback = await handleCustomerMessagingWebhookRequest(prisma, {
    url: webhookUrl,
    twilioSignature: validDeliverySig,
    tbbtSignature: null,
    rawBody: deliveryBody,
    contentType: "application/x-www-form-urlencoded",
  });
  check("Duplicate delivery callback is idempotent", duplicateCallback.status === 200 && duplicateCallback.body.ok === true);
  const stillDeliveredTwilio = await getCustomerCommunication(prisma, {
    businessId: alpha.business.id,
    communicationId: twilioSent.communicationId,
  });
  check("Duplicate callback leaves DELIVERED in place", stillDeliveredTwilio.status === "DELIVERED");

  const betaClaim = await applyCustomerMessageDeliveryUpdate(prisma, {
    provider: "twilio",
    providerMessageId: twilioSid,
    status: "FAILED",
    claimedBusinessId: beta.business.id,
    providerEventId: `${twilioSid}:FAILED:${randomUUID()}`,
  });
  check("Cross-tenant callback cannot mutate another tenant", betaClaim.applied === false && betaClaim.reason === "tenant_mismatch");
  check(
    "Rejected cross-tenant callback did not change status",
    (await getCustomerCommunication(prisma, {
      businessId: alpha.business.id,
      communicationId: twilioSent.communicationId,
    })).status === "DELIVERED",
  );

  console.log("\nTEST — Inbound STOP/START/HELP tenant routing");
  const samePhoneBeta = await prisma.customer.create({
    data: {
      businessId: beta.business.id,
      name: "Same Phone Beta",
      phone: "2395550100",
      smsConsentStatus: "GRANTED",
    },
  });
  const inboundStop = await applyInboundConsentEvent(prisma, {
    provider: "twilio",
    providerEventId: `SM_stop_${randomUUID()}`,
    from: "+12395550100",
    to: alphaE164,
    body: "STOP",
    optOutType: "STOP",
  });
  const afterStopA = await prisma.customer.findFirst({ where: { id: customerA.id } });
  const afterStopBeta = await prisma.customer.findFirst({ where: { id: samePhoneBeta.id } });
  check("STOP revokes the customer in the receiving tenant", inboundStop.applied && inboundStop.consentStatus === "REVOKED" && afterStopA.smsConsentStatus === "REVOKED");
  check("STOP cannot revoke the same phone in another tenant", afterStopBeta.smsConsentStatus === "GRANTED");
  const stopAgain = await applyInboundConsentEvent(prisma, {
    provider: "twilio",
    providerEventId: `SM_stop_again_${randomUUID()}`,
    from: "+12395550100",
    to: alphaE164,
    body: "STOP",
    optOutType: "STOP",
  });
  check("Repeated STOP is idempotent", stopAgain.applied && stopAgain.consentStatus === "REVOKED");

  const unknownTenantStop = await applyInboundConsentEvent(prisma, {
    provider: "twilio",
    providerEventId: `SM_stop_unknown_${randomUUID()}`,
    from: "+12395550100",
    to: "+18555550000",
    body: "STOP",
    optOutType: "STOP",
  });
  check("Unknown receiving number does not scan other tenants", unknownTenantStop.reason === "unknown_tenant");
  check(
    "Unknown tenant STOP left the other-tenant customer GRANTED",
    (await prisma.customer.findFirst({ where: { id: samePhoneBeta.id } })).smsConsentStatus === "GRANTED",
  );

  const startUnknown = await applyInboundConsentEvent(prisma, {
    provider: "twilio",
    providerEventId: `SM_start_unknown_${randomUUID()}`,
    from: "+12395550101",
    to: alphaE164,
    body: "START",
    optOutType: "START",
  });
  check(
    "START does not grant an UNKNOWN customer",
    startUnknown.applied === false &&
      (await prisma.customer.findFirst({ where: { id: unknownConsent.id } })).smsConsentStatus === "UNKNOWN",
  );
  const arbitrary = await applyInboundConsentEvent(prisma, {
    provider: "twilio",
    providerEventId: `SM_hello_${randomUUID()}`,
    from: "+12395550100",
    to: alphaE164,
    body: "Can you come tomorrow?",
    optOutType: null,
  });
  check("Arbitrary inbound does not grant consent", arbitrary.applied === false && arbitrary.reason === "ignored_inbound");
  check("parseTwilioOptOutType ignores arbitrary bodies", parseTwilioOptOutType(null, "Can you come tomorrow?") === null);
  const helpEvent = await applyInboundConsentEvent(prisma, {
    provider: "twilio",
    providerEventId: `SM_help_${randomUUID()}`,
    from: "+12395550100",
    to: alphaE164,
    body: "HELP",
    optOutType: "HELP",
  });
  check("HELP does not change consent", helpEvent.applied === false && helpEvent.reason === "help_no_consent_change");
  const startRevoked = await applyInboundConsentEvent(prisma, {
    provider: "twilio",
    providerEventId: `SM_start_ok_${randomUUID()}`,
    from: "+12395550100",
    to: alphaE164,
    body: "START",
    optOutType: "START",
  });
  check(
    "START restores consent only from REVOKED under Twilio Advanced Opt-Out",
    startRevoked.applied && startRevoked.consentStatus === "GRANTED" &&
      (await prisma.customer.findFirst({ where: { id: customerA.id } })).smsConsentStatus === "GRANTED",
  );

  const inboundHttpParams = {
    MessageSid: `SM_http_stop_${randomUUID()}`,
    SmsStatus: "received",
    From: "+12395550102",
    To: alphaE164,
    Body: "STOP",
    OptOutType: "STOP",
    AccountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  };
  const inboundHttpBody = new URLSearchParams(inboundHttpParams).toString();
  const inboundHttp = await handleCustomerMessagingWebhookRequest(prisma, {
    url: webhookUrl,
    twilioSignature: twilioRequestSignature("twilio_test_token", webhookUrl, inboundHttpParams),
    tbbtSignature: null,
    rawBody: inboundHttpBody,
    contentType: "application/x-www-form-urlencoded",
  });
  check(
    "Signed inbound STOP webhook revokes the matching tenant customer",
    inboundHttp.status === 200 &&
      inboundHttp.body.ok === true &&
      (await prisma.customer.findFirst({ where: { id: revoked.id } })).smsConsentStatus === "REVOKED",
  );

  console.log("\nTEST — Leftover inbound STOP claim stays retryable");
  const leftoverPhone = uniqueSmsDigits("239");
  const leftoverCustomer = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Leftover Signed Stop",
      phone: leftoverPhone,
      smsConsentStatus: "GRANTED",
    },
  });
  const leftoverParams = {
    MessageSid: `SM_http_leftover_${randomUUID()}`,
    SmsStatus: "received",
    From: `+1${leftoverPhone}`,
    To: alphaE164,
    Body: "STOP",
    OptOutType: "STOP",
    AccountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  };
  const leftoverBody = new URLSearchParams(leftoverParams).toString();
  const leftoverSig = twilioRequestSignature("twilio_test_token", webhookUrl, leftoverParams);
  const leftoverWriteError = new Error("forced leftover consent write failure");
  inboundConsentTestHooks.beforeConsentWrite = async () => {
    throw leftoverWriteError;
  };
  inboundConsentTestHooks.beforeCleanup = async () => {
    throw new Error("forced leftover cleanup failure");
  };
  const leftoverFirst = await Promise.allSettled([
    handleCustomerMessagingWebhookRequest(prisma, {
      url: webhookUrl,
      twilioSignature: leftoverSig,
      tbbtSignature: null,
      rawBody: leftoverBody,
      contentType: "application/x-www-form-urlencoded",
    }),
  ]);
  inboundConsentTestHooks.beforeConsentWrite = undefined;
  inboundConsentTestHooks.beforeCleanup = undefined;
  check(
    "Signed leftover STOP returns non-2xx after consent and cleanup failure",
    leftoverFirst[0].status === "fulfilled" &&
      leftoverFirst[0].value.status === 500 &&
      leftoverFirst[0].value.body.error === "Unable to process.",
  );
  check(
    "Unsigned leftover retry is still rejected",
    (await handleCustomerMessagingWebhookRequest(prisma, {
      url: webhookUrl,
      twilioSignature: "nope",
      tbbtSignature: null,
      rawBody: leftoverBody,
      contentType: "application/x-www-form-urlencoded",
    })).status === 400,
  );
  check(
    "Leftover signed STOP left consent GRANTED",
    (await prisma.customer.findFirst({ where: { id: leftoverCustomer.id } })).smsConsentStatus === "GRANTED",
  );
  check(
    "Leftover webhook claim remains after cleanup failure",
    (await prisma.customerMessagingWebhookEvent.count({
      where: { provider: "twilio", providerEventId: leftoverParams.MessageSid },
    })) === 1,
  );
  const leftoverRetry = await handleCustomerMessagingWebhookRequest(prisma, {
    url: webhookUrl,
    twilioSignature: leftoverSig,
    tbbtSignature: null,
    rawBody: leftoverBody,
    contentType: "application/x-www-form-urlencoded",
  });
  check(
    "Same signed leftover STOP retries and applies REVOKED",
    leftoverRetry.status === 200 &&
      leftoverRetry.body.ok === true &&
      (await prisma.customer.findFirst({ where: { id: leftoverCustomer.id } })).smsConsentStatus === "REVOKED",
  );
  const leftoverThird = await handleCustomerMessagingWebhookRequest(prisma, {
    url: webhookUrl,
    twilioSignature: leftoverSig,
    tbbtSignature: null,
    rawBody: leftoverBody,
    contentType: "application/x-www-form-urlencoded",
  });
  check(
    "Third same signed leftover STOP stays REVOKED exactly once",
    leftoverThird.status === 200 &&
      leftoverThird.body.ok === true &&
      (await prisma.customer.findFirst({ where: { id: leftoverCustomer.id } })).smsConsentStatus === "REVOKED" &&
      (await prisma.customerMessagingWebhookEvent.count({
        where: { provider: "twilio", providerEventId: leftoverParams.MessageSid },
      })) === 1,
  );
  check(
    "Leftover STOP did not revoke the other-tenant same-phone customer",
    (await prisma.customer.findFirst({ where: { id: samePhoneBeta.id } })).smsConsentStatus === "GRANTED",
  );

  console.log("\nTEST — Concurrent identical STOP and STOP-then-START replay");
  const replayPhone = uniqueSmsDigits("239");
  const replayCustomer = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Replay Consent",
      phone: replayPhone,
      smsConsentStatus: "GRANTED",
    },
  });
  const concurrentPhone = uniqueSmsDigits("239");
  const concurrentCustomer = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Concurrent Consent",
      phone: concurrentPhone,
      smsConsentStatus: "GRANTED",
    },
  });
  const concurrentParams = {
    MessageSid: `SM_http_concurrent_${randomUUID()}`,
    SmsStatus: "received",
    From: `+1${concurrentPhone}`,
    To: alphaE164,
    Body: "STOP",
    OptOutType: "STOP",
    AccountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  };
  const concurrentBody = new URLSearchParams(concurrentParams).toString();
  const concurrentSig = twilioRequestSignature("twilio_test_token", webhookUrl, concurrentParams);
  const concurrentClientA = new PrismaClient({ datasourceUrl: testUrl });
  const concurrentClientB = new PrismaClient({ datasourceUrl: testUrl });
  const [concurrentA, concurrentB] = await Promise.all([
    handleCustomerMessagingWebhookRequest(concurrentClientA, {
      url: webhookUrl,
      twilioSignature: concurrentSig,
      tbbtSignature: null,
      rawBody: concurrentBody,
      contentType: "application/x-www-form-urlencoded",
    }),
    handleCustomerMessagingWebhookRequest(concurrentClientB, {
      url: webhookUrl,
      twilioSignature: concurrentSig,
      tbbtSignature: null,
      rawBody: concurrentBody,
      contentType: "application/x-www-form-urlencoded",
    }),
  ]);
  await Promise.all([concurrentClientA.$disconnect(), concurrentClientB.$disconnect()]);
  check(
    "Two concurrent identical signed STOPs both acknowledge without error",
    concurrentA.status === 200 &&
      concurrentA.body.ok === true &&
      concurrentB.status === 200 &&
      concurrentB.body.ok === true,
  );
  check(
    "Two concurrent identical STOPs apply REVOKED exactly once",
    (await prisma.customer.findFirst({ where: { id: concurrentCustomer.id } })).smsConsentStatus ===
      "REVOKED" &&
      (await prisma.customerMessagingWebhookEvent.count({
        where: { provider: "twilio", providerEventId: concurrentParams.MessageSid },
      })) === 1,
  );

  const stopThenStartParams = {
    MessageSid: `SM_http_stop_then_start_${randomUUID()}`,
    SmsStatus: "received",
    From: `+1${replayPhone}`,
    To: alphaE164,
    Body: "STOP",
    OptOutType: "STOP",
    AccountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  };
  const startAfterStopParams = {
    MessageSid: `SM_http_start_after_stop_${randomUUID()}`,
    SmsStatus: "received",
    From: `+1${replayPhone}`,
    To: alphaE164,
    Body: "START",
    OptOutType: "START",
    AccountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  };
  const stopThenStartBody = new URLSearchParams(stopThenStartParams).toString();
  const startAfterStopBody = new URLSearchParams(startAfterStopParams).toString();
  const stopThenStart = await handleCustomerMessagingWebhookRequest(prisma, {
    url: webhookUrl,
    twilioSignature: twilioRequestSignature("twilio_test_token", webhookUrl, stopThenStartParams),
    tbbtSignature: null,
    rawBody: stopThenStartBody,
    contentType: "application/x-www-form-urlencoded",
  });
  check(
    "STOP then START first applies REVOKED",
    stopThenStart.status === 200 &&
      (await prisma.customer.findFirst({ where: { id: replayCustomer.id } })).smsConsentStatus ===
        "REVOKED",
  );
  const startAfterStop = await handleCustomerMessagingWebhookRequest(prisma, {
    url: webhookUrl,
    twilioSignature: twilioRequestSignature("twilio_test_token", webhookUrl, startAfterStopParams),
    tbbtSignature: null,
    rawBody: startAfterStopBody,
    contentType: "application/x-www-form-urlencoded",
  });
  check(
    "START after STOP restores GRANTED on the same live phone",
    startAfterStop.status === 200 &&
      (await prisma.customer.findFirst({ where: { id: replayCustomer.id } })).smsConsentStatus ===
        "GRANTED",
  );
  const stopReplay = await handleCustomerMessagingWebhookRequest(prisma, {
    url: webhookUrl,
    twilioSignature: twilioRequestSignature("twilio_test_token", webhookUrl, stopThenStartParams),
    tbbtSignature: null,
    rawBody: stopThenStartBody,
    contentType: "application/x-www-form-urlencoded",
  });
  check(
    "Replayed STOP after START does not resurrect REVOKED",
    stopReplay.status === 200 &&
      stopReplay.body.ok === true &&
      (await prisma.customer.findFirst({ where: { id: replayCustomer.id } })).smsConsentStatus ===
        "GRANTED",
  );
  const startReplay = await handleCustomerMessagingWebhookRequest(prisma, {
    url: webhookUrl,
    twilioSignature: twilioRequestSignature("twilio_test_token", webhookUrl, startAfterStopParams),
    tbbtSignature: null,
    rawBody: startAfterStopBody,
    contentType: "application/x-www-form-urlencoded",
  });
  check(
    "Replayed START after STOP stays GRANTED exactly once",
    startReplay.status === 200 &&
      (await prisma.customer.findFirst({ where: { id: replayCustomer.id } })).smsConsentStatus ===
        "GRANTED",
  );
  check(
    "Replay claims stay tenant-scoped to the receiving business",
    (await prisma.customerMessagingWebhookEvent.findFirst({
      where: { provider: "twilio", providerEventId: stopThenStartParams.MessageSid },
    }))?.businessId === alpha.business.id &&
      (await prisma.customer.findFirst({ where: { id: samePhoneBeta.id } })).smsConsentStatus ===
        "GRANTED",
  );

  console.log("\nTEST — Late START retry after newer STOP stays REVOKED");
  const stalePhone = uniqueSmsDigits("239");
  const staleCustomer = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Stale Start",
      phone: stalePhone,
      smsConsentStatus: "REVOKED",
      smsConsentUpdatedAt: new Date(Date.now() - 60 * 60 * 1000),
    },
  });
  const staleStartParams = {
    MessageSid: `SM_http_stale_start_${randomUUID()}`,
    SmsStatus: "received",
    From: `+1${stalePhone}`,
    To: alphaE164,
    Body: "START",
    OptOutType: "START",
    AccountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  };
  const staleStartBody = new URLSearchParams(staleStartParams).toString();
  const staleStartSig = twilioRequestSignature("twilio_test_token", webhookUrl, staleStartParams);
  const staleStartError = new Error("forced stale START write failure");
  inboundConsentTestHooks.beforeConsentWrite = async () => {
    throw staleStartError;
  };
  const staleStartFirst = await handleCustomerMessagingWebhookRequest(prisma, {
    url: webhookUrl,
    twilioSignature: staleStartSig,
    tbbtSignature: null,
    rawBody: staleStartBody,
    contentType: "application/x-www-form-urlencoded",
  });
  inboundConsentTestHooks.beforeConsentWrite = undefined;
  const staleClaim = await prisma.customerMessagingWebhookEvent.findFirst({
    where: { provider: "twilio", providerEventId: staleStartParams.MessageSid },
  });
  check(
    "Stuck START returns non-2xx and leaves a pending claim",
    staleStartFirst.status === 500 &&
      staleClaim != null &&
      claimedAtFromCuid(staleClaim.id) instanceof Date &&
      (await prisma.customer.findFirst({ where: { id: staleCustomer.id } })).smsConsentStatus ===
        "REVOKED",
  );
  const newerStopParams = {
    MessageSid: `SM_http_newer_stop_${randomUUID()}`,
    SmsStatus: "received",
    From: `+1${stalePhone}`,
    To: alphaE164,
    Body: "STOP",
    OptOutType: "STOP",
    AccountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  };
  const newerStop = await handleCustomerMessagingWebhookRequest(prisma, {
    url: webhookUrl,
    twilioSignature: twilioRequestSignature("twilio_test_token", webhookUrl, newerStopParams),
    tbbtSignature: null,
    rawBody: new URLSearchParams(newerStopParams).toString(),
    contentType: "application/x-www-form-urlencoded",
  });
  check(
    "Newer STOP after stuck START stays REVOKED",
    newerStop.status === 200 &&
      (await prisma.customer.findFirst({ where: { id: staleCustomer.id } })).smsConsentStatus ===
        "REVOKED",
  );
  const staleStartRetry = await handleCustomerMessagingWebhookRequest(prisma, {
    url: webhookUrl,
    twilioSignature: staleStartSig,
    tbbtSignature: null,
    rawBody: staleStartBody,
    contentType: "application/x-www-form-urlencoded",
  });
  check(
    "Older START retry after newer STOP does not restore GRANTED",
    staleStartRetry.status === 200 &&
      staleStartRetry.body.ok === true &&
      (await prisma.customer.findFirst({ where: { id: staleCustomer.id } })).smsConsentStatus ===
        "REVOKED",
  );
  const liveStartPhone = uniqueSmsDigits("239");
  const liveStartCustomer = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Live Start Retry",
      phone: liveStartPhone,
      smsConsentStatus: "REVOKED",
      smsConsentUpdatedAt: new Date(Date.now() - 60 * 60 * 1000),
    },
  });
  const liveStartParams = {
    MessageSid: `SM_http_live_start_${randomUUID()}`,
    SmsStatus: "received",
    From: `+1${liveStartPhone}`,
    To: alphaE164,
    Body: "START",
    OptOutType: "START",
    AccountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  };
  const liveStartBody = new URLSearchParams(liveStartParams).toString();
  const liveStartSig = twilioRequestSignature("twilio_test_token", webhookUrl, liveStartParams);
  inboundConsentTestHooks.beforeConsentWrite = async () => {
    throw new Error("forced live START write failure");
  };
  await handleCustomerMessagingWebhookRequest(prisma, {
    url: webhookUrl,
    twilioSignature: liveStartSig,
    tbbtSignature: null,
    rawBody: liveStartBody,
    contentType: "application/x-www-form-urlencoded",
  });
  inboundConsentTestHooks.beforeConsentWrite = undefined;
  const liveStartRetry = await handleCustomerMessagingWebhookRequest(prisma, {
    url: webhookUrl,
    twilioSignature: liveStartSig,
    tbbtSignature: null,
    rawBody: liveStartBody,
    contentType: "application/x-www-form-urlencoded",
  });
  check(
    "Failed START without a newer STOP remains retryable and grants once",
    liveStartRetry.status === 200 &&
      (await prisma.customer.findFirst({ where: { id: liveStartCustomer.id } })).smsConsentStatus ===
        "GRANTED",
  );

  console.log("\nTEST — Concurrent duplicate START deliveries use an advisory lock");
  const lockStartPhone = uniqueSmsDigits("239");
  const lockStartCustomer = await prisma.customer.create({
    data: {
      businessId: alpha.business.id,
      name: "Lock Start",
      phone: lockStartPhone,
      smsConsentStatus: "REVOKED",
      smsConsentUpdatedAt: new Date(Date.now() - 60 * 60 * 1000),
    },
  });
  const lockStartParams = {
    MessageSid: `SM_http_lock_start_${randomUUID()}`,
    SmsStatus: "received",
    From: `+1${lockStartPhone}`,
    To: alphaE164,
    Body: "START",
    OptOutType: "START",
    AccountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  };
  const lockStartBody = new URLSearchParams(lockStartParams).toString();
  const lockStartSig = twilioRequestSignature("twilio_test_token", webhookUrl, lockStartParams);
  const lockStartRequest = {
    url: webhookUrl,
    twilioSignature: lockStartSig,
    tbbtSignature: null,
    rawBody: lockStartBody,
    contentType: "application/x-www-form-urlencoded",
  };
  const startBarrier = createCount2Barrier();
  let startWrites = 0;
  inboundConsentTestHooks.afterClaim = () => startBarrier.arrive();
  inboundConsentTestHooks.beforeConsentWrite = () => {
    startWrites += 1;
  };
  const lockStartClientA = new PrismaClient({ datasourceUrl: testUrl });
  const lockStartClientB = new PrismaClient({ datasourceUrl: testUrl });
  const lockAdmin = new PrismaClient({ datasourceUrl: testUrl });
  const startASettled = Promise.allSettled([
    handleCustomerMessagingWebhookRequest(lockStartClientA, lockStartRequest),
  ]);
  await withTimeout(startBarrier.firstArrived, BARRIER_WAIT_MS, "concurrent START first claim");
  const startBSettled = Promise.allSettled([
    handleCustomerMessagingWebhookRequest(lockStartClientB, lockStartRequest),
  ]);
  await waitForTestDbLock(lockAdmin, "concurrent duplicate START");
  await startBarrier.arrive();
  const [startAResult] = await withTimeout(startASettled, 25000, "concurrent START A");
  const [startBResult] = await withTimeout(startBSettled, 25000, "concurrent START B");
  inboundConsentTestHooks.afterClaim = undefined;
  inboundConsentTestHooks.beforeConsentWrite = undefined;
  await Promise.all([
    lockStartClientA.$disconnect(),
    lockStartClientB.$disconnect(),
    lockAdmin.$disconnect(),
  ]);
  const lockStartAfter = await prisma.customer.findFirst({ where: { id: lockStartCustomer.id } });
  const lockStartClaims = await prisma.customerMessagingWebhookEvent.count({
    where: { provider: "twilio", providerEventId: lockStartParams.MessageSid },
  });
  check(
    "Concurrent START deliveries both acknowledge after the lock",
    startAResult.status === "fulfilled" &&
      startAResult.value.status === 200 &&
      startBResult.status === "fulfilled" &&
      startBResult.value.status === 200,
  );
  check(
    "Concurrent START writes GRANTED exactly once",
    startWrites === 1 &&
      lockStartAfter.smsConsentStatus === "GRANTED" &&
      lockStartClaims === 1,
  );

  console.log("\nTEST — Public opt-in capture and existing customer behavior");
  check("Unchecked opt-in is not affirmative", isAffirmativeSmsOptIn(false) === false && isAffirmativeSmsOptIn(undefined) === false);
  check("Explicit opt-in is affirmative", isAffirmativeSmsOptIn("true") === true && isAffirmativeSmsOptIn("on") === true);
  check(
    "Public opt-in without a phone does not store GRANTED",
    smsConsentFromPublicOptIn({ smsOptIn: true, phone: "" }) === null,
  );
  check(
    "Explicit public opt-in with a phone stores GRANTED",
    smsConsentFromPublicOptIn({ smsOptIn: true, phone: "2395550110" })?.smsConsentStatus === "GRANTED",
  );
  check(
    "Owner phone edit clears consent instead of granting it",
    smsConsentAfterOwnerPhoneEdit("2395550100", "2395550111")?.smsConsentStatus === "UNKNOWN",
  );
  check(
    "Unchanged owner phone does not rewrite consent",
    smsConsentAfterOwnerPhoneEdit("2395550100", "(239) 555-0100") === null,
  );

  const catalogItem = await prisma.serviceCatalogItem.create({
    data: {
      businessId: alpha.business.id,
      name: "Messaging Opt-In Fan",
      category: "Fans & Fixtures",
      pricingMode: "FIXED",
      price: 180,
      active: true,
    },
  });
  const opted = await createPublicServiceRequest(prisma, {
    slug: alpha.business.slug,
    name: "Opted In Homeowner",
    email: `opt-in.${randomUUID().slice(0, 8)}@example.com`,
    phone: "239-555-0188",
    address: "",
    streetAddress: "10 Pine St",
    city: "Fort Myers",
    region: "FL",
    postalCode: "33901",
    notes: "Please text me.",
    catalogItemIds: [catalogItem.id],
    includeOther: false,
    otherDescription: "",
    smsOptIn: true,
  });
  const optedRequest = opted.ok
    ? await prisma.serviceRequest.findFirst({ where: { id: opted.requestId }, include: { customer: true } })
    : null;
  check("Explicit public opt-in stores GRANTED", opted.ok && optedRequest?.customer.smsConsentStatus === "GRANTED");

  const skipped = await createPublicServiceRequest(prisma, {
    slug: alpha.business.slug,
    name: "No Opt In Homeowner",
    email: `no-opt.${randomUUID().slice(0, 8)}@example.com`,
    phone: "239-555-0189",
    address: "",
    streetAddress: "11 Pine St",
    city: "Fort Myers",
    region: "FL",
    postalCode: "33901",
    notes: "Call is fine.",
    catalogItemIds: [catalogItem.id],
    includeOther: false,
    otherDescription: "",
  });
  const skippedRequest = skipped.ok
    ? await prisma.serviceRequest.findFirst({ where: { id: skipped.requestId }, include: { customer: true } })
    : null;
  check("No public opt-in does not store GRANTED", skipped.ok && skippedRequest?.customer.smsConsentStatus === "UNKNOWN");
  check(
    "Existing customer remains UNKNOWN until explicit opt-in",
    (await prisma.customer.findFirst({ where: { id: unknownConsent.id } })).smsConsentStatus === "UNKNOWN",
  );

  const stillBlocked = await attemptCustomerSms(prisma, smsInput({
    businessId: alpha.business.id,
    customerId: unknownConsent.id,
    idempotencyKey: `sms:still-unknown:${randomUUID()}`,
  }));
  check("Existing #79 unknown-consent blocking remains intact", stillBlocked.status === "BLOCKED");
  check("Existing email invoice path is still independent of SMS", invoiceSend.customerNotified === false);

  const destinationLeak = await prisma.customerCommunication.findMany({
    where: { businessId: alpha.business.id },
  });
  check(
    "Audit rows do not store the raw destination phone",
    destinationLeak.every((row) => {
      const serialized = JSON.stringify(row);
      const last4Ok = row.destinationLast4 === null || row.destinationLast4.length === 4;
      return !serialized.includes("2395550100") && last4Ok;
    }),
  );
} finally {
  inboundConsentTestHooks.afterClaim = undefined;
  inboundConsentTestHooks.beforeConsentWrite = undefined;
  inboundConsentTestHooks.beforeCleanup = undefined;
  resetCustomerMessagingProvider();
  await prisma.$disconnect();
}

console.log(`\n${failures === 0 ? "All customer messaging checks passed." : `${failures} customer messaging checks failed.`}`);
process.exit(failures === 0 ? 0 : 1);
