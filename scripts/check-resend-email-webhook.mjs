/**
 * Verified Resend bounce/complaint webhook → failed destination →
 * existing email consent rules.
 *
 * Signed fixtures and the fake email adapter only. Does not call Resend
 * or change the compose-flow module. Replays must not duplicate history.
 * Forged or cross-tenant events must write nothing. Later compose to a
 * failed destination is excluded; the same address in another business
 * is not.
 *
 * Uses a dedicated local disposable database.
 *
 * Run with:
 *   npm run test:resend-email-webhook
 */
import { register } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withDisposableTestDatabase } from "./disposable-test-database.mjs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function readRepo(rel) {
  return readFileSync(join(root, rel), "utf8");
}

const previous = {
  DATABASE_URL: process.env.DATABASE_URL,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  RESEND_WEBHOOK_SECRET: process.env.RESEND_WEBHOOK_SECRET,
  EMAIL_FROM: process.env.EMAIL_FROM,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  TBBT_EMAIL_ADAPTER: process.env.TBBT_EMAIL_ADAPTER,
  VERCEL_ENV: process.env.VERCEL_ENV,
};

if (!previous.DATABASE_URL) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const WEBHOOK_SECRET = `whsec_${Buffer.from("resend_webhook_test_secret").toString("base64")}`;

delete process.env.VERCEL_ENV;
process.env.TBBT_EMAIL_ADAPTER = "fake";
process.env.RESEND_API_KEY = "re_test_bounce_complaint";
process.env.EMAIL_FROM = "TBBT <bounce@example.com>";
process.env.NEXT_PUBLIC_APP_URL = "http://mail-webhook.test";
process.env.RESEND_WEBHOOK_SECRET = WEBHOOK_SECRET;

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  ok  - ${label}`);
  else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

function restoreEnv() {
  for (const [key, value] of Object.entries(previous)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

function makeAccess(businessId, role, membershipId, userId) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      user: { id: userId },
      business: { id: businessId, name: "Mail Co" },
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

async function seedBusiness(prisma, name) {
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
  return {
    business,
    membership,
    access: makeAccess(business.id, "OWNER", membership.id, ownerUser.id),
  };
}

await withDisposableTestDatabase(
  {
    databaseUrl: previous.DATABASE_URL,
    namePrefix: "tbbt_resend_email_webhook",
    setProcessEnv: true,
  },
  async ({ prisma }) => {
    const {
      composeCustomerCommunication,
      emailDestinationFingerprint,
      evaluateEmailEligibility,
    } = await import("@/lib/communications");
    const { createFakeTransactionalEmailSender, signFakeResendWebhook } = await import(
      "@/lib/mail-fake"
    );
    const { setCommunicationEmailSender, resetCommunicationEmailSender } = await import(
      "@/lib/communications"
    );
    const {
      MAIL_WEBHOOK_EVENT_BOUNCE,
      MAIL_WEBHOOK_EVENT_COMPLAINT,
      applyVerifiedMailDeliveryEvent,
      handleMailWebhookRequest,
      parseResendDeliveryEvent,
    } = await import("@/lib/mail-webhook");
    const {
      EMAIL_BOUNCE_BLOCK_REASON,
      EMAIL_COMPLAINT_BLOCK_REASON,
    } = await import("@/lib/mail-failed-destination");
    const { MAIL_WEBHOOK_PATH, isMailWebhookPath, RESEND_MAIL_PROVIDER } = await import(
      "@/lib/mail-webhook-path"
    );
    const { verifyResendWebhookSignature } = await import("@/lib/mail-webhook-signature");

    const fakeEmail = createFakeTransactionalEmailSender();
    setCommunicationEmailSender(fakeEmail.send.bind(fakeEmail));

    function signedFixture(input) {
      const payload = JSON.stringify({
        type: input.type,
        created_at: "2026-10-03T12:00:00.000Z",
        data: {
          email_id: input.emailId,
          from: "TBBT <bounce@example.com>",
          to: [input.to ?? "ava@example.com"],
          subject: "Recorded customer email",
          ...(input.claimedBusinessId
            ? { claimed_business_id: input.claimedBusinessId }
            : {}),
        },
      });
      const signed = signFakeResendWebhook({
        secret: input.secret ?? WEBHOOK_SECRET,
        payload,
        id: input.svixId,
        timestamp: input.timestamp,
      });
      return { payload, signed };
    }

    function webhookRequest(signed, overrides = {}) {
      return {
        rawBody: signed.payload,
        headers: {
          id: overrides.id ?? signed.id,
          timestamp: overrides.timestamp ?? signed.timestamp,
          signature: overrides.signature ?? signed.signature,
        },
      };
    }

    async function recordSendHistory(input) {
      const fingerprint = emailDestinationFingerprint(input.businessId, input.email);
      return prisma.customerCommunication.create({
        data: {
          businessId: input.businessId,
          customerId: input.customerId,
          direction: "OUTBOUND",
          channel: "EMAIL",
          purpose: "GENERAL",
          subject: "Recorded customer email",
          idempotencyKey: input.idempotencyKey ?? `email-sent-${randomUUID()}`,
          destinationLast4: input.email.split("@")[0].slice(-4),
          destinationFingerprint: fingerprint,
          consentContext: "sms:UNKNOWN;email:AVAILABLE;channel:EMAIL",
          bodySnapshot: "Recorded send history for webhook tests.",
          status: "SENT",
          provider: RESEND_MAIL_PROVIDER,
          providerMessageId: input.providerMessageId,
          attemptedAt: new Date(),
        },
      });
    }

    async function destCount(businessId) {
      return prisma.emailFailedDestination.count({
        where: businessId ? { businessId } : undefined,
      });
    }

    async function eventCount() {
      return prisma.customerMessagingWebhookEvent.count({
        where: { provider: RESEND_MAIL_PROVIDER },
      });
    }

    const composeFlowSrc = readRepo("src/lib/communications/compose-flow.ts");
    const webhookSrc = readRepo("src/lib/mail-webhook.ts");
    const routeSrc = readRepo("src/app/api/mail/webhook/route.ts");
    const proxySrc = readRepo("src/proxy.ts");
    const engineSrc = readRepo("src/lib/communications/engine.ts");
    const consentSrc = readRepo("src/lib/communications/consent.ts");

    console.log("\nSTATIC — Resend webhook boundary and compose-flow isolation");
    check(
      "Mail webhook path is exact and public-proxy allowed",
      MAIL_WEBHOOK_PATH === "/api/mail/webhook" &&
        isMailWebhookPath(MAIL_WEBHOOK_PATH) &&
        !isMailWebhookPath(`${MAIL_WEBHOOK_PATH}/extra`) &&
        proxySrc.includes("isMailWebhookPath") &&
        proxySrc.includes("api/mail/webhook"),
    );
    check(
      "Route verifies from the raw body and returns generic JSON",
      routeSrc.includes("request.text()") &&
        routeSrc.includes("handleMailWebhookRequest") &&
        !routeSrc.includes("businessId") &&
        !routeSrc.includes("customerId"),
    );
    check(
      "Ingest never sends email and does not import compose-flow",
      !webhookSrc.includes("sendTransactionalEmail") &&
        !webhookSrc.includes("composeCustomerCommunication") &&
        !webhookSrc.includes("resend.emails") &&
        !webhookSrc.includes("CREATE TABLE") &&
        !webhookSrc.includes("ALTER TABLE"),
    );
    check(
      "Compose-flow module is unchanged by bounce and complaint handling",
      !composeFlowSrc.includes("bounce") &&
        !composeFlowSrc.includes("complaint") &&
        !composeFlowSrc.includes("mail-webhook") &&
        !composeFlowSrc.includes("failed_destination") &&
        !composeFlowSrc.includes("EmailFailedDestination"),
    );
    check(
      "Consent rules exclude a recorded failed destination",
      consentSrc.includes("failed_destination") &&
        engineSrc.includes("findEmailFailedDestination") &&
        engineSrc.includes("failedDestinationReason"),
    );

    const tenantA = await seedBusiness(prisma, "Alpha Mail");
    const tenantB = await seedBusiness(prisma, "Beta Mail");
    const sharedEmail = "shared.dest@example.com";
    const customerA = await prisma.customer.create({
      data: {
        businessId: tenantA.business.id,
        name: "Ava",
        email: sharedEmail,
      },
    });
    const customerB = await prisma.customer.create({
      data: {
        businessId: tenantB.business.id,
        name: "Bea",
        email: sharedEmail,
      },
    });
    const complaintCustomer = await prisma.customer.create({
      data: {
        businessId: tenantA.business.id,
        name: "Cora",
        email: "cora@example.com",
      },
    });

    const bounceId = `re_bounce_${randomUUID()}`;
    const complaintId = `re_complaint_${randomUUID()}`;
    const unknownId = `re_unknown_${randomUUID()}`;
    await recordSendHistory({
      businessId: tenantA.business.id,
      customerId: customerA.id,
      email: sharedEmail,
      providerMessageId: bounceId,
    });
    await recordSendHistory({
      businessId: tenantA.business.id,
      customerId: complaintCustomer.id,
      email: "cora@example.com",
      providerMessageId: complaintId,
    });

    console.log("\nTEST — forged and unsigned events write nothing");
    const bounceFixture = signedFixture({
      type: MAIL_WEBHOOK_EVENT_BOUNCE,
      emailId: bounceId,
      to: sharedEmail,
    });
    check("Fake provider signs a Svix bounce fixture", Boolean(bounceFixture.signed?.signature));
    check(
      "Signed fixture verifies with the webhook secret",
      verifyResendWebhookSignature({
        secret: WEBHOOK_SECRET,
        payload: bounceFixture.payload,
        headers: {
          id: bounceFixture.signed.id,
          timestamp: bounceFixture.signed.timestamp,
          signature: bounceFixture.signed.signature,
        },
      }),
    );
    const forged = await handleMailWebhookRequest(
      prisma,
      webhookRequest(bounceFixture.signed, { signature: "v1,forged" }),
    );
    check("Forged signature is rejected", forged.status === 400 && forged.body.error === "Invalid signature.");
    check(
      "Forged signature writes no destination or webhook claim",
      (await destCount()) === 0 && (await eventCount()) === 0,
    );
    const previousSecret = process.env.RESEND_WEBHOOK_SECRET;
    delete process.env.RESEND_WEBHOOK_SECRET;
    const unsigned = await handleMailWebhookRequest(prisma, webhookRequest(bounceFixture.signed));
    process.env.RESEND_WEBHOOK_SECRET = previousSecret;
    check("Missing signing secret is not found", unsigned.status === 404 && unsigned.body.error === "Not found.");
    check("Missing secret writes nothing", (await destCount()) === 0 && (await eventCount()) === 0);

    console.log("\nTEST — unknown and cross-tenant events write nothing");
    const unknownFixture = signedFixture({
      type: MAIL_WEBHOOK_EVENT_BOUNCE,
      emailId: unknownId,
      to: sharedEmail,
    });
    const unknown = await handleMailWebhookRequest(prisma, webhookRequest(unknownFixture.signed));
    check("Unknown send history is acknowledged without leaking", unknown.status === 200 && unknown.body.ok === true);
    check(
      "Unknown email id writes nothing",
      (await destCount()) === 0 && (await eventCount()) === 0,
    );
    const crossFixture = signedFixture({
      type: MAIL_WEBHOOK_EVENT_BOUNCE,
      emailId: bounceId,
      to: sharedEmail,
      claimedBusinessId: tenantB.business.id,
    });
    const parsedCross = parseResendDeliveryEvent(crossFixture.payload);
    const crossApply = await applyVerifiedMailDeliveryEvent(prisma, parsedCross);
    const crossHttp = await handleMailWebhookRequest(prisma, webhookRequest(crossFixture.signed));
    check(
      "Cross-tenant claim is rejected before any write",
      crossApply.applied === false && crossApply.reason === "tenant_mismatch",
    );
    check("Cross-tenant HTTP response stays generic", crossHttp.status === 200 && crossHttp.body.ok === true);
    check(
      "Cross-tenant event writes no destination or webhook claim",
      (await destCount()) === 0 && (await eventCount()) === 0,
    );

    console.log("\nTEST — verified bounce records the owning business only");
    const bounce = await handleMailWebhookRequest(prisma, webhookRequest(bounceFixture.signed));
    check("Verified bounce is accepted", bounce.status === 200 && bounce.body.ok === true);
    const bounceDests = await prisma.emailFailedDestination.findMany({
      where: { businessId: tenantA.business.id },
    });
    const bounceComm = await prisma.customerCommunication.findFirst({
      where: { providerMessageId: bounceId, businessId: tenantA.business.id },
    });
    check(
      "Bounce destination is recorded for the sending business",
      bounceDests.length === 1 &&
        bounceDests[0].reason === "BOUNCE" &&
        bounceDests[0].providerMessageId === bounceId &&
        bounceDests[0].destinationFingerprint ===
          emailDestinationFingerprint(tenantA.business.id, sharedEmail),
    );
    check("Other businesses received no destination row", (await destCount(tenantB.business.id)) === 0);
    check(
      "Original send history is marked FAILED with the bounce reason",
      bounceComm?.status === "FAILED" && bounceComm.failureReason === EMAIL_BOUNCE_BLOCK_REASON,
    );

    console.log("\nTEST — replay does not duplicate history");
    const replaySame = await handleMailWebhookRequest(prisma, webhookRequest(bounceFixture.signed));
    const replayResigned = signedFixture({
      type: MAIL_WEBHOOK_EVENT_BOUNCE,
      emailId: bounceId,
      to: sharedEmail,
      svixId: `msg_replay_${randomUUID()}`,
    });
    const replayHttp = await handleMailWebhookRequest(prisma, webhookRequest(replayResigned.signed));
    check("Replay HTTP stays ok", replaySame.status === 200 && replayHttp.status === 200);
    check(
      "Replay does not create a second destination",
      (await destCount(tenantA.business.id)) === 1 && (await destCount()) === 1,
    );
    const replayEvents = await prisma.customerMessagingWebhookEvent.findMany({
      where: {
        provider: RESEND_MAIL_PROVIDER,
        providerEventId: `${bounceId}:${MAIL_WEBHOOK_EVENT_BOUNCE}`,
      },
    });
    check("Replay reuses the same webhook event claim", replayEvents.length === 1);

    console.log("\nTEST — later sends follow existing consent rules");
    const beforeSend = fakeEmail.sent.length;
    const blocked = await composeCustomerCommunication(prisma, tenantA.access, {
      customerId: customerA.id,
      channel: "EMAIL",
      purpose: "GENERAL",
      subject: "Should not send",
      body: "Later send after a verified bounce.",
      idempotencyKey: `email-later-${randomUUID()}`,
    });
    const eligibility = evaluateEmailEligibility({
      businessId: tenantA.business.id,
      email: sharedEmail,
      deliveryConfigured: true,
      failedDestinationReason: "BOUNCE",
    });
    check(
      "Consent rules mark the bounced destination unavailable",
      eligibility.permitted === false && eligibility.reason === "failed_destination",
    );
    check(
      "Later compose is blocked for the owning business",
      blocked.ok === false &&
        blocked.status === "BLOCKED" &&
        blocked.failureReason === EMAIL_BOUNCE_BLOCK_REASON &&
        fakeEmail.sent.length === beforeSend,
    );
    const otherBusiness = await composeCustomerCommunication(prisma, tenantB.access, {
      customerId: customerB.id,
      channel: "EMAIL",
      purpose: "GENERAL",
      subject: "Other tenant may still send",
      body: "Same address, different business.",
      idempotencyKey: `email-other-${randomUUID()}`,
    });
    check(
      "The same address in another business is not excluded",
      otherBusiness.ok === true &&
        otherBusiness.status === "SENT" &&
        fakeEmail.sent.length === beforeSend + 1 &&
        (await destCount(tenantB.business.id)) === 0,
    );

    console.log("\nTEST — verified complaint is recorded once");
    const complaintFixture = signedFixture({
      type: MAIL_WEBHOOK_EVENT_COMPLAINT,
      emailId: complaintId,
      to: "cora@example.com",
    });
    const complaint = await handleMailWebhookRequest(prisma, webhookRequest(complaintFixture.signed));
    const complaintAgain = await handleMailWebhookRequest(
      prisma,
      webhookRequest(complaintFixture.signed),
    );
    const complaintDests = await prisma.emailFailedDestination.findMany({
      where: {
        businessId: tenantA.business.id,
        destinationFingerprint: emailDestinationFingerprint(tenantA.business.id, "cora@example.com"),
      },
    });
    const complaintBlocked = await composeCustomerCommunication(prisma, tenantA.access, {
      customerId: complaintCustomer.id,
      channel: "EMAIL",
      purpose: "GENERAL",
      subject: "Should not send after complaint",
      body: "Later send after a verified complaint.",
      idempotencyKey: `email-complaint-later-${randomUUID()}`,
    });
    check("Verified complaint is accepted", complaint.status === 200 && complaintAgain.status === 200);
    check("Complaint replay does not duplicate destination history", complaintDests.length === 1);
    check(
      "Complaint destination excludes later compose",
      complaintDests[0].reason === "COMPLAINT" &&
        complaintBlocked.ok === false &&
        complaintBlocked.status === "BLOCKED" &&
        complaintBlocked.failureReason === EMAIL_COMPLAINT_BLOCK_REASON,
    );

    const deliveredFixture = signedFixture({
      type: "email.delivered",
      emailId: bounceId,
      to: sharedEmail,
    });
    const delivered = await handleMailWebhookRequest(prisma, webhookRequest(deliveredFixture.signed));
    check(
      "Signed non-bounce events are acknowledged and write no extra history",
      delivered.status === 200 &&
        delivered.body.ok === true &&
        (await destCount(tenantA.business.id)) === 2,
    );

    resetCommunicationEmailSender();
  },
).finally(restoreEnv);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nResend bounce/complaint webhook checks passed.");
