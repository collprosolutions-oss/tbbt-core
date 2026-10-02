/**
 * Verified inbound Twilio Voice webhook → Communications missed-call log.
 *
 * Fake provider POSTs only. Proves signature verification, tenant/number
 * mapping, forged requests, retries, and OWNER disposition races. Does
 * not place calls, send messages, or store recordings / call content.
 *
 * Uses a dedicated local disposable database.
 *
 * Run with:
 *   npm run test:voice-missed-call-webhook
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
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  TWILIO_MESSAGING_SERVICE_SID: process.env.TWILIO_MESSAGING_SERVICE_SID,
  TWILIO_FROM_NUMBER: process.env.TWILIO_FROM_NUMBER,
  TBBT_CUSTOMER_MESSAGING_ADAPTER: process.env.TBBT_CUSTOMER_MESSAGING_ADAPTER,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  VERCEL_ENV: process.env.VERCEL_ENV,
};

if (!previous.DATABASE_URL) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const TEST_ACCOUNT_SID = "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const TEST_AUTH_TOKEN = "twilio_voice_test_token";
const WEBHOOK_URL = "http://voice-webhook.test/api/communications/voice-webhook";

process.env.TWILIO_ACCOUNT_SID = TEST_ACCOUNT_SID;
process.env.TWILIO_AUTH_TOKEN = TEST_AUTH_TOKEN;
delete process.env.TWILIO_MESSAGING_SERVICE_SID;
delete process.env.TWILIO_FROM_NUMBER;
delete process.env.TBBT_CUSTOMER_MESSAGING_ADAPTER;
delete process.env.VERCEL_ENV;
process.env.NEXT_PUBLIC_APP_URL = "http://voice-webhook.test";

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
      business: { id: businessId, name: "Voice Co" },
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

async function seedBusiness(prisma, name, operationalSmsNumber) {
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
      operationalSmsNumber,
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

function voiceParams(overrides = {}) {
  return {
    AccountSid: TEST_ACCOUNT_SID,
    CallSid: overrides.CallSid ?? `CA${randomUUID().replace(/-/g, "").slice(0, 32)}`,
    From: overrides.From ?? "+15551112222",
    To: overrides.To ?? "+15550001000",
    CallStatus: overrides.CallStatus ?? "no-answer",
    Direction: overrides.Direction ?? "inbound",
    ApiVersion: "2010-04-01",
    ...overrides,
  };
}

function formBody(params) {
  return new URLSearchParams(params).toString();
}

await withDisposableTestDatabase(
  {
    databaseUrl: previous.DATABASE_URL,
    namePrefix: "tbbt_voice_missed_call",
    setProcessEnv: true,
  },
  async ({ prisma }) => {
    const {
      VOICE_WEBHOOK_PATH,
      VOICE_WEBHOOK_REJECT_TWIML,
      VOICE_WEBHOOK_IGNORED_CONTENT_PARAMS,
      handleInboundVoiceWebhookRequest,
      isVoiceWebhookPath,
      isTwilioVoiceWebhookConfigured,
      parseInboundVoiceWebhook,
      voiceMissedCallIdempotencyKey,
      recordReceptionistCallbackDisposition,
    } = await import("@/lib/communications");
    const { twilioRequestSignature } = await import("@/lib/customer-messaging");

    function signedRequest(params, { signature, url } = {}) {
      const body = formBody(params);
      const requestUrl = url ?? WEBHOOK_URL;
      return {
        url: requestUrl,
        twilioSignature:
          signature ?? twilioRequestSignature(TEST_AUTH_TOKEN, requestUrl, params),
        rawBody: body,
        contentType: "application/x-www-form-urlencoded",
      };
    }

    const webhookSrc = readRepo("src/lib/communications/voice-webhook.ts");
    const routeSrc = readRepo("src/app/api/communications/voice-webhook/route.ts");
    const proxySrc = readRepo("src/proxy.ts");
    const missedCallSrc = readRepo("src/lib/communications/missed-call.ts");

    console.log("\nSTATIC — official Voice webhook boundary");
    check(
      "Voice webhook path is exact and public-proxy allowed",
      VOICE_WEBHOOK_PATH === "/api/communications/voice-webhook" &&
        isVoiceWebhookPath(VOICE_WEBHOOK_PATH) &&
        !isVoiceWebhookPath(`${VOICE_WEBHOOK_PATH}/extra`) &&
        proxySrc.includes("isVoiceWebhookPath") &&
        proxySrc.includes("api/communications/voice-webhook"),
    );
    check(
      "Route verifies the Twilio signature before trusting the payload",
      routeSrc.includes("handleInboundVoiceWebhookRequest") &&
        routeSrc.includes("x-twilio-signature") &&
        webhookSrc.includes("verifyTwilioRequestSignature") &&
        webhookSrc.includes("X-Twilio-Signature") &&
        webhookSrc.includes("https://www.twilio.com/docs/usage/webhooks/webhooks-security"),
    );
    check(
      "Inbound Voice response is official TwiML Reject and does not answer or record",
      VOICE_WEBHOOK_REJECT_TWIML.includes("<Reject/>") &&
        webhookSrc.includes("https://www.twilio.com/docs/voice/twiml/reject") &&
        !webhookSrc.includes("<Record") &&
        !webhookSrc.includes("<Dial") &&
        !webhookSrc.includes("<Gather") &&
        !webhookSrc.includes("<Say") &&
        !webhookSrc.includes("attemptCustomerSms") &&
        !webhookSrc.includes("sendTransactionalEmail") &&
        !webhookSrc.includes("calls.create"),
    );
    check(
      "Recordings and call content are never persisted",
      VOICE_WEBHOOK_IGNORED_CONTENT_PARAMS.includes("RecordingUrl") &&
        VOICE_WEBHOOK_IGNORED_CONTENT_PARAMS.includes("TranscriptionText") &&
        VOICE_WEBHOOK_IGNORED_CONTENT_PARAMS.includes("SpeechResult") &&
        webhookSrc.includes("VOICE_WEBHOOK_IGNORED_CONTENT_PARAMS") &&
        !webhookSrc.includes("RecordingUrl:") &&
        !webhookSrc.includes("bodySnapshot: params") &&
        missedCallSrc.includes("PHONE_LOG_PRESERVE_CLOSED"),
    );
    check(
      "Voice webhook is configured from the official Auth Token pair",
      isTwilioVoiceWebhookConfigured() === true,
    );

    const tenantA = await seedBusiness(prisma, "Voice Alpha", "5550001000");
    const tenantB = await seedBusiness(prisma, "Voice Beta", "5550002000");
    const customerA = await prisma.customer.create({
      data: {
        businessId: tenantA.business.id,
        name: "Ava Caller",
        phone: "5551112222",
        email: `ava.${randomUUID().slice(0, 8)}@example.com`,
      },
    });
    await prisma.customer.create({
      data: {
        businessId: tenantB.business.id,
        name: "Bea Other",
        phone: "5551112222",
        email: `bea.${randomUUID().slice(0, 8)}@example.com`,
      },
    });

    console.log("\nDB — forged requests never write a missed-call log");
    const forgedParams = voiceParams({
      To: "+15550001000",
      From: "+15551112222",
      CallSid: `CA${"f".repeat(32)}`,
    });
    const forged = await handleInboundVoiceWebhookRequest(
      prisma,
      signedRequest(forgedParams, { signature: "not-a-real-signature" }),
    );
    const forgedParsed = parseInboundVoiceWebhook(
      signedRequest(forgedParams, { signature: "not-a-real-signature" }),
    );
    const afterForged = await prisma.phoneInteraction.findMany({
      where: { businessId: tenantA.business.id },
    });
    check(
      "Invalid X-Twilio-Signature is rejected without tenant details",
      forged.status === 400 &&
        forged.body.includes("Invalid signature.") &&
        !forged.body.includes(tenantA.business.id) &&
        !forged.body.includes("5550001000") &&
        forgedParsed === null,
    );
    check("Forged request created no phone log", afterForged.length === 0);

    const wrongAccount = await handleInboundVoiceWebhookRequest(
      prisma,
      signedRequest(
        voiceParams({
          AccountSid: "ACyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy",
          To: "+15550001000",
        }),
      ),
    );
    check(
      "Signed payload for a different AccountSid is rejected",
      wrongAccount.status === 400 &&
        (await prisma.phoneInteraction.count({ where: { businessId: tenantA.business.id } })) ===
          0,
    );

    console.log("\nDB — tenant / number mapping");
    const callSidA = `CA${"a".repeat(32)}`;
    const firstA = await handleInboundVoiceWebhookRequest(
      prisma,
      signedRequest(
        voiceParams({
          CallSid: callSidA,
          To: "+15550001000",
          From: "+15551112222",
          CallStatus: "no-answer",
          RecordingUrl: "https://api.twilio.com/recordings/RE_should_not_store",
          TranscriptionText: "please do not persist this speech",
          Digits: "1234",
          SpeechResult: "leave a message",
        }),
      ),
    );
    const unknown = await handleInboundVoiceWebhookRequest(
      prisma,
      signedRequest(
        voiceParams({
          To: "+15559999999",
          From: "+15551112222",
          CallStatus: "no-answer",
        }),
      ),
    );
    const outbound = await handleInboundVoiceWebhookRequest(
      prisma,
      signedRequest(
        voiceParams({
          To: "+15550001000",
          From: "+15551112222",
          Direction: "outbound-api",
          CallStatus: "no-answer",
        }),
      ),
    );
    const answered = await handleInboundVoiceWebhookRequest(
      prisma,
      signedRequest(
        voiceParams({
          To: "+15550001000",
          From: "+15551112222",
          CallStatus: "completed",
          CallDuration: "42",
        }),
      ),
    );
    const phonesA = await prisma.phoneInteraction.findMany({
      where: { businessId: tenantA.business.id },
    });
    const phonesB = await prisma.phoneInteraction.findMany({
      where: { businessId: tenantB.business.id },
    });
    const loggedA = phonesA[0];
    const actionA = loggedA?.followUpActionItemId
      ? await prisma.businessActionItem.findFirst({
          where: { id: loggedA.followUpActionItemId, businessId: tenantA.business.id },
        })
      : null;
    check(
      "Signed inbound missed call returns official TwiML Reject",
      firstA.status === 200 &&
        firstA.contentType === "text/xml" &&
        firstA.body === VOICE_WEBHOOK_REJECT_TWIML,
    );
    check(
      "To number maps to the owning tenant only",
      phonesA.length === 1 &&
        phonesB.length === 0 &&
        loggedA?.idempotencyKey === voiceMissedCallIdempotencyKey(callSidA) &&
        loggedA?.customerId === customerA.id &&
        loggedA?.kind === "MISSED_CALL" &&
        loggedA?.status === "CALLBACK_NEEDED" &&
        loggedA?.callbackNeeded === true,
    );
    check(
      "Unknown To number and outbound / answered events create no log",
      unknown.status === 200 &&
        outbound.status === 200 &&
        answered.status === 200 &&
        phonesA.length === 1 &&
        phonesB.length === 0,
    );
    check(
      "Recording and speech fields never enter the missed-call summary",
      loggedA?.summary === "Missed inbound call (no-answer)." &&
        !JSON.stringify(loggedA).includes("api.twilio.com/recordings") &&
        !JSON.stringify(loggedA).includes("please do not persist") &&
        !JSON.stringify(loggedA).includes("leave a message"),
    );
    check(
      "One owner callback action item is created for the first event",
      Boolean(actionA) &&
        actionA.status === "OPEN" &&
        actionA.recommendationKey === `phone-callback:${voiceMissedCallIdempotencyKey(callSidA)}`,
    );

    const mappedB = await handleInboundVoiceWebhookRequest(
      prisma,
      signedRequest(
        voiceParams({
          To: "+15550002000",
          From: "+15551112222",
          CallStatus: "busy",
        }),
      ),
    );
    const phonesBAfter = await prisma.phoneInteraction.findMany({
      where: { businessId: tenantB.business.id },
    });
    check(
      "The same caller To-mapped onto tenant B stays on tenant B",
      mappedB.status === 200 &&
        phonesBAfter.length === 1 &&
        phonesBAfter[0].customerId !== customerA.id &&
        phonesBAfter[0].businessId === tenantB.business.id,
    );

    console.log("\nDB — retries create one log and one action item");
    const retry = await handleInboundVoiceWebhookRequest(
      prisma,
      signedRequest(
        voiceParams({
          CallSid: callSidA,
          To: "+15550001000",
          From: "+15551112222",
          CallStatus: "no-answer",
          "I-Twilio-Idempotency-Token": randomUUID(),
        }),
      ),
    );
    const ringingReplay = await handleInboundVoiceWebhookRequest(
      prisma,
      signedRequest(
        voiceParams({
          CallSid: callSidA,
          To: "+15550001000",
          From: "+15551112222",
          CallStatus: "ringing",
        }),
      ),
    );
    const [left, right] = await Promise.all([
      handleInboundVoiceWebhookRequest(
        prisma,
        signedRequest(
          voiceParams({
            CallSid: callSidA,
            To: "+15550001000",
            From: "+15551112222",
            CallStatus: "canceled",
          }),
        ),
      ),
      handleInboundVoiceWebhookRequest(
        prisma,
        signedRequest(
          voiceParams({
            CallSid: callSidA,
            To: "+15550001000",
            From: "+15551112222",
            CallStatus: "canceled",
          }),
        ),
      ),
    ]);
    const retryPhones = await prisma.phoneInteraction.findMany({
      where: {
        businessId: tenantA.business.id,
        idempotencyKey: voiceMissedCallIdempotencyKey(callSidA),
      },
    });
    const retryActions = await prisma.businessActionItem.findMany({
      where: {
        businessId: tenantA.business.id,
        recommendationKey: `phone-callback:${voiceMissedCallIdempotencyKey(callSidA)}`,
      },
    });
    check(
      "Repeated provider events stay 200 and do not duplicate the log",
      retry.status === 200 &&
        ringingReplay.status === 200 &&
        left.status === 200 &&
        right.status === 200 &&
        retryPhones.length === 1 &&
        retryActions.length === 1 &&
        retryPhones[0].status === "CALLBACK_NEEDED",
    );

    console.log("\nDB — OWNER disposition is not reopened by a later event");
    const disposed = await recordReceptionistCallbackDisposition(prisma, tenantA.access, {
      phoneInteractionId: retryPhones[0].id,
    });
    const afterDisposition = await handleInboundVoiceWebhookRequest(
      prisma,
      signedRequest(
        voiceParams({
          CallSid: callSidA,
          To: "+15550001000",
          From: "+15551112222",
          CallStatus: "no-answer",
        }),
      ),
    );
    const closedRow = await prisma.phoneInteraction.findFirst({
      where: { id: retryPhones[0].id, businessId: tenantA.business.id },
    });
    const closedAction = await prisma.businessActionItem.findFirst({
      where: { id: retryActions[0].id, businessId: tenantA.business.id },
    });
    check(
      "OWNER disposition closes the callback item",
      disposed.ok &&
        disposed.status === "CLOSED" &&
        disposed.callbackNeeded === false,
    );
    check(
      "A later provider event does not reopen the CLOSED log or DONE action",
      afterDisposition.status === 200 &&
        closedRow?.status === "CLOSED" &&
        closedRow?.callbackNeeded === false &&
        closedAction?.status === "DONE" &&
        (await prisma.phoneInteraction.count({
          where: { businessId: tenantA.business.id, idempotencyKey: voiceMissedCallIdempotencyKey(callSidA) },
        })) === 1 &&
        (await prisma.businessActionItem.count({
          where: {
            businessId: tenantA.business.id,
            recommendationKey: `phone-callback:${voiceMissedCallIdempotencyKey(callSidA)}`,
          },
        })) === 1,
    );

    const raceSid = `CA${"d".repeat(32)}`;
    const racedFirst = await handleInboundVoiceWebhookRequest(
      prisma,
      signedRequest(
        voiceParams({
          CallSid: raceSid,
          To: "+15550001000",
          From: "+15553334444",
          CallStatus: "failed",
        }),
      ),
    );
    const racedPhone = await prisma.phoneInteraction.findFirst({
      where: {
        businessId: tenantA.business.id,
        idempotencyKey: voiceMissedCallIdempotencyKey(raceSid),
      },
    });
    const [raceWebhook, raceDisposition] = await Promise.all([
      handleInboundVoiceWebhookRequest(
        prisma,
        signedRequest(
          voiceParams({
            CallSid: raceSid,
            To: "+15550001000",
            From: "+15553334444",
            CallStatus: "failed",
          }),
        ),
      ),
      recordReceptionistCallbackDisposition(prisma, tenantA.access, {
        phoneInteractionId: racedPhone.id,
      }),
    ]);
    const racedAfter = await prisma.phoneInteraction.findFirst({
      where: { id: racedPhone.id, businessId: tenantA.business.id },
    });
    const racedActions = await prisma.businessActionItem.findMany({
      where: {
        businessId: tenantA.business.id,
        recommendationKey: `phone-callback:${voiceMissedCallIdempotencyKey(raceSid)}`,
      },
    });
    check("Race setup logged the inbound missed call", racedFirst.status === 200 && Boolean(racedPhone));
    check(
      "Webhook retry overlapping OWNER disposition ends CLOSED with one DONE action",
      raceWebhook.status === 200 &&
        raceDisposition.ok &&
        racedAfter?.status === "CLOSED" &&
        racedAfter?.callbackNeeded === false &&
        racedActions.length === 1 &&
        racedActions[0].status === "DONE",
    );

    const token = process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_AUTH_TOKEN;
    const disconnected = await handleInboundVoiceWebhookRequest(
      prisma,
      signedRequest(voiceParams({ To: "+15550001000" })),
    );
    process.env.TWILIO_AUTH_TOKEN = token;
    check(
      "Disconnected Voice webhook stays 404 and generic",
      disconnected.status === 404 && disconnected.body.includes("Not found."),
    );
  },
).finally(restoreEnv);

if (failures) {
  console.error(`\n${failures} voice missed-call webhook check(s) failed.`);
  process.exit(1);
}
console.log("\nVoice missed-call webhook checks passed.");
