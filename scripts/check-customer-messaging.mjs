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

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_customer_messaging_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;
process.env.NEXT_PUBLIC_APP_URL = "http://customer-messaging.test";
delete process.env.TBBT_CUSTOMER_MESSAGING_ADAPTER;
delete process.env.VERCEL_ENV;

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

const { REQUEST_SEND_DISCLAIMER } = await import("@/lib/reviews");
const {
  advanceReviewRequestStatus,
  createReviewRequest,
} = await import("@/lib/reviews-ops");
const { sendDraftInvoiceIfNeeded } = await import("@/lib/complete-job-invoice");
const {
  applyCustomerMessageDeliveryUpdate,
  attemptAppointmentReminderSms,
  attemptCustomerSms,
  attemptPaymentReminderSms,
  communicationPreferenceEnabled,
  createDisconnectedCustomerMessagingProvider,
  createFakeCustomerMessagingProvider,
  CUSTOMER_MESSAGING_ENSURE_SQL,
  customerSmsIdempotencyKey,
  evaluateSmsEligibility,
  getCustomerCommunication,
  isCustomerMessagingConfigured,
  isCustomerMessagingWebhookPath,
  isFakeCustomerMessagingAdapterEnabled,
  isSmsConsentGranted,
  listCustomerCommunications,
  resetCustomerMessagingProvider,
  resolveStoredSmsConsent,
  setCustomerMessagingProvider,
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

const opsSrc = readFileSync(new URL("../src/lib/customer-messaging/ops.ts", import.meta.url), "utf8");
const configSrc = readFileSync(new URL("../src/lib/customer-messaging/config.ts", import.meta.url), "utf8");
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
    "Webhook 404s when no connected provider/secret is configured",
    webhookRouteSrc.includes("status: 404") &&
      webhookRouteSrc.includes("verifyDeliveryCallback"),
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
    "Review SENT still records internally and attempts SMS separately",
    reviewsOpsSrc.includes("attemptReviewRequestSms") &&
      /did not send/i.test(REQUEST_SEND_DISCLAIMER),
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
  const reviewSent = await advanceReviewRequestStatus(prisma, alpha.access, { requestId: reviewDraft.id });
  const reviewComms = await listCustomerCommunications(prisma, {
    businessId: alpha.business.id,
    customerId: customerA.id,
  });
  const reviewSms = reviewComms.filter((row) => row.purpose === "REVIEW_REQUEST");
  check("Review request SENT is still owner-recorded", reviewSent.status === "SENT");
  check(
    "Unavailable messaging leaves review SMS NOT_SENT or BLOCKED",
    reviewSms.length === 1 && (reviewSms[0].status === "NOT_SENT" || reviewSms[0].status === "BLOCKED"),
  );
  check(
    "Review disclaimer still says TBBT did not send SMS or email",
    /did not send sms or email/i.test(REQUEST_SEND_DISCLAIMER),
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
  resetCustomerMessagingProvider();
  await prisma.$disconnect();
}

console.log(`\n${failures === 0 ? "All customer messaging checks passed." : `${failures} customer messaging checks failed.`}`);
process.exit(failures === 0 ? 0 : 1);
