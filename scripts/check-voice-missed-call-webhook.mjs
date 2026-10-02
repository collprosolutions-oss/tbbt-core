/**
 * Verified inbound Twilio Voice webhook → existing missed-call log →
 * #288 receptionist / OWNER disposition (joined path).
 *
 * Fake signed Voice POSTs and fake outbound SMS/email providers only.
 * Retries and later provider events must stay one PhoneInteraction and
 * one callback action item, must not reopen CLOSED, and must not call
 * or message the customer. Also proves number-to-business mapping,
 * wrong signatures, tenant isolation, and a disposition racing webhook
 * replay. Does not add a second phone log or answering product.
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
  TBBT_EMAIL_ADAPTER: process.env.TBBT_EMAIL_ADAPTER,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  EMAIL_FROM: process.env.EMAIL_FROM,
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
delete process.env.VERCEL_ENV;
process.env.TBBT_CUSTOMER_MESSAGING_ADAPTER = "fake";
process.env.TBBT_EMAIL_ADAPTER = "fake";
process.env.RESEND_API_KEY = "re_test_voice_joined";
process.env.EMAIL_FROM = "TBBT <voice-joined@example.com>";
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

async function restoreProviders() {
  try {
    const { resetCommunicationEmailSender } = await import("@/lib/communications");
    const { resetCustomerMessagingProvider } = await import("@/lib/customer-messaging");
    resetCommunicationEmailSender();
    resetCustomerMessagingProvider();
  } catch {
    // Suites that fail before module import still restore env below.
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
  const adminUser = await prisma.user.create({
    data: {
      name: `${name} Admin`,
      email: `${name.toLowerCase().replace(/\s+/g, ".")}.admin.${randomUUID().slice(0, 8)}@example.com`,
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
      operationalSmsNumber,
    },
  });
  const membership = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: business.id, role: "OWNER" },
  });
  const adminMembership = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: business.id, role: "ADMIN" },
  });
  const memberMembership = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: business.id, role: "MEMBER" },
  });
  return {
    business,
    membership,
    access: makeAccess(business.id, "OWNER", membership.id, ownerUser.id),
    adminAccess: makeAccess(business.id, "ADMIN", adminMembership.id, adminUser.id),
    memberAccess: makeAccess(business.id, "MEMBER", memberMembership.id, memberUser.id),
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
      COMMUNICATIONS_PERMISSION_ERROR,
      PHONE_INTERACTION_CLOSED_STATUS,
      RECEPTIONIST_DISPOSITION_FOREIGN_BUSINESS_REASON,
      RECEPTIONIST_DISPOSITION_NOT_FOUND_REASON,
      RECEPTIONIST_MANUAL_DISPOSITION_KIND,
      RECEPTIONIST_MANUAL_DISPOSITION_STATUS,
      VOICE_WEBHOOK_PATH,
      VOICE_WEBHOOK_REJECT_TWIML,
      VOICE_WEBHOOK_IGNORED_CONTENT_PARAMS,
      executeReceptionistDispositionAction,
      handleInboundVoiceWebhookRequest,
      isVoiceWebhookPath,
      isTwilioVoiceWebhookConfigured,
      loadReceptionistRecoveryCenter,
      parseInboundVoiceWebhook,
      recordReceptionistCallbackDisposition,
      setCommunicationEmailSender,
      voiceMissedCallIdempotencyKey,
    } = await import("@/lib/communications");
    const {
      createFakeCustomerMessagingProvider,
      setCustomerMessagingProvider,
      twilioRequestSignature,
    } = await import("@/lib/customer-messaging");
    const { createFakeTransactionalEmailSender } = await import("@/lib/mail");

    const fakeSms = createFakeCustomerMessagingProvider();
    const fakeEmail = createFakeTransactionalEmailSender();
    setCustomerMessagingProvider(fakeSms);
    setCommunicationEmailSender(fakeEmail.send.bind(fakeEmail));

    async function outboundTraffic(businessId) {
      const rows = await prisma.customerCommunication.findMany({
        where: {
          businessId,
          OR: [
            { channel: { in: ["SMS", "EMAIL"] } },
            { direction: "OUTBOUND" },
          ],
        },
      });
      return {
        rows,
        smsSent: fakeSms.sent.length,
        emailSent: fakeEmail.sent.length,
      };
    }

    function noAutomaticCustomerContact(traffic) {
      return traffic.smsSent === 0 && traffic.emailSent === 0 && traffic.rows.length === 0;
    }

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
    check(
      "Joined path reuses the existing phone log and OWNER disposition; it is not a second answering product",
      webhookSrc.includes("recordMissedOrManualCall") &&
        webhookSrc.includes("voiceMissedCallIdempotencyKey") &&
        !webhookSrc.includes("createPhoneLog") &&
        !webhookSrc.includes("answering") &&
        routeSrc.includes("handleInboundVoiceWebhookRequest") &&
        missedCallSrc.includes("PHONE_LOG_PRESERVE_CLOSED"),
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
    const racedCenter = await loadReceptionistRecoveryCenter(prisma, tenantA.access);
    check(
      "Disposition racing webhook replay leaves the recovery queue without that callback item",
      !racedCenter.queue.some((item) => item.id === racedPhone.id),
    );

    console.log("\nJOINED PATH — signed Voice webhook → missed-call log → receptionist/OWNER");
    const hmacParams = voiceParams({
      To: "+15550001000",
      From: "+15551112222",
      CallSid: `CA${"b".repeat(32)}`,
    });
    const wrongUrlSigned = await handleInboundVoiceWebhookRequest(
      prisma,
      signedRequest(hmacParams, {
        signature: twilioRequestSignature(
          TEST_AUTH_TOKEN,
          "http://evil.test/api/communications/voice-webhook",
          hmacParams,
        ),
      }),
    );
    const wrongTokenSigned = await handleInboundVoiceWebhookRequest(
      prisma,
      signedRequest(hmacParams, {
        signature: twilioRequestSignature("other-voice-token", WEBHOOK_URL, hmacParams),
      }),
    );
    check(
      "HMAC of the wrong URL or auth token is rejected without a log",
      wrongUrlSigned.status === 400 &&
        wrongTokenSigned.status === 400 &&
        (await prisma.phoneInteraction.count({
          where: { idempotencyKey: voiceMissedCallIdempotencyKey(hmacParams.CallSid) },
        })) === 0,
    );

    const joinedSid = `CA${"e".repeat(32)}`;
    const formattedTo = await handleInboundVoiceWebhookRequest(
      prisma,
      signedRequest(
        voiceParams({
          CallSid: joinedSid,
          To: "+1 (555) 000-1000",
          From: "+1 (555) 111-2222",
          CallStatus: "ringing",
        }),
      ),
    );
    const joinedPhone = await prisma.phoneInteraction.findFirst({
      where: {
        businessId: tenantA.business.id,
        idempotencyKey: voiceMissedCallIdempotencyKey(joinedSid),
      },
    });
    const joinedAction = joinedPhone?.followUpActionItemId
      ? await prisma.businessActionItem.findFirst({
          where: { id: joinedPhone.followUpActionItemId, businessId: tenantA.business.id },
        })
      : null;
    const ownerCenter = await loadReceptionistRecoveryCenter(prisma, tenantA.access);
    const queuedJoined = ownerCenter.queue.find((item) => item.id === joinedPhone?.id);
    const tenantBCenterBefore = await loadReceptionistRecoveryCenter(prisma, tenantB.access);
    check(
      "Formatted To/From still map onto the owning tenant and existing customer",
      formattedTo.status === 200 &&
        joinedPhone?.customerId === customerA.id &&
        joinedPhone?.status === "CALLBACK_NEEDED" &&
        joinedPhone?.callbackNeeded === true &&
        joinedPhone?.kind === "MISSED_CALL" &&
        Boolean(joinedAction) &&
        joinedAction.status === "OPEN",
    );
    check(
      "Receptionist recovery queue shows the voice-logged callback for OWNER",
      Boolean(queuedJoined) &&
        queuedJoined.source === "PHONE_INTERACTION" &&
        queuedJoined.canRecordDisposition === true &&
        queuedJoined.customerKnown === true &&
        queuedJoined.customer?.id === customerA.id &&
        ownerCenter.recordedCallbackNeededCount >= 1,
    );
    check(
      "Tenant B recovery queue does not include tenant A's voice-logged callback",
      !tenantBCenterBefore.queue.some((item) => item.id === joinedPhone?.id),
    );

    let memberCenterDenied = false;
    try {
      await loadReceptionistRecoveryCenter(prisma, tenantA.memberAccess);
    } catch (error) {
      memberCenterDenied = error?.name === "ForbiddenError";
    }
    const memberDisposition = await executeReceptionistDispositionAction(
      prisma,
      tenantA.memberAccess,
      { phoneInteractionId: joinedPhone.id },
    );
    const foreignDisposition = await recordReceptionistCallbackDisposition(prisma, tenantB.access, {
      phoneInteractionId: joinedPhone.id,
    });
    const spoofedBrowser = await recordReceptionistCallbackDisposition(prisma, tenantA.access, {
      phoneInteractionId: joinedPhone.id,
      browserBusinessId: tenantB.business.id,
    });
    check("MEMBER cannot load the office recovery queue for a voice-logged callback", memberCenterDenied);
    check(
      "MEMBER cannot dispose a voice-logged callback",
      memberDisposition.error === COMMUNICATIONS_PERMISSION_ERROR,
    );
    check(
      "Foreign tenant cannot dispose another tenant's voice-logged callback",
      foreignDisposition.ok === false &&
        foreignDisposition.failureReason === RECEPTIONIST_DISPOSITION_NOT_FOUND_REASON,
    );
    check(
      "Browser businessId never authorizes disposition of a voice-logged callback",
      spoofedBrowser.ok === false &&
        spoofedBrowser.failureReason === RECEPTIONIST_DISPOSITION_FOREIGN_BUSINESS_REASON,
    );
    check(
      "Rejected disposition attempts left the callback OPEN",
      (await prisma.phoneInteraction.findFirst({ where: { id: joinedPhone.id } }))?.status ===
        "CALLBACK_NEEDED" &&
        (await prisma.businessActionItem.findFirst({ where: { id: joinedAction.id } }))?.status ===
          "OPEN",
    );

    const retryJoined = await handleInboundVoiceWebhookRequest(
      prisma,
      signedRequest(
        voiceParams({
          CallSid: joinedSid,
          To: "+15550001000",
          From: "+15551112222",
          CallStatus: "no-answer",
        }),
      ),
    );
    const laterBusy = await handleInboundVoiceWebhookRequest(
      prisma,
      signedRequest(
        voiceParams({
          CallSid: joinedSid,
          To: "+15550001000",
          From: "+15551112222",
          CallStatus: "busy",
        }),
      ),
    );
    const [joinedLeft, joinedRight] = await Promise.all([
      handleInboundVoiceWebhookRequest(
        prisma,
        signedRequest(
          voiceParams({
            CallSid: joinedSid,
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
            CallSid: joinedSid,
            To: "+15550001000",
            From: "+15551112222",
            CallStatus: "canceled",
          }),
        ),
      ),
    ]);
    const joinedPhonesAfterRetry = await prisma.phoneInteraction.findMany({
      where: {
        businessId: tenantA.business.id,
        idempotencyKey: voiceMissedCallIdempotencyKey(joinedSid),
      },
    });
    const joinedActionsAfterRetry = await prisma.businessActionItem.findMany({
      where: {
        businessId: tenantA.business.id,
        recommendationKey: `phone-callback:${voiceMissedCallIdempotencyKey(joinedSid)}`,
      },
    });
    const retryCenter = await loadReceptionistRecoveryCenter(prisma, tenantA.access);
    check(
      "Retries and later provider events keep one log, one callback item, and one recovery row",
      retryJoined.status === 200 &&
        laterBusy.status === 200 &&
        joinedLeft.status === 200 &&
        joinedRight.status === 200 &&
        joinedPhonesAfterRetry.length === 1 &&
        joinedActionsAfterRetry.length === 1 &&
        joinedPhonesAfterRetry[0].status === "CALLBACK_NEEDED" &&
        retryCenter.queue.filter((item) => item.id === joinedPhone.id).length === 1,
    );

    const ownerDisposition = await executeReceptionistDispositionAction(prisma, tenantA.access, {
      phoneInteractionId: joinedPhone.id,
    });
    const afterOwner = await prisma.phoneInteraction.findFirst({
      where: { id: joinedPhone.id, businessId: tenantA.business.id },
    });
    const afterOwnerAction = await prisma.businessActionItem.findFirst({
      where: { id: joinedAction.id, businessId: tenantA.business.id },
    });
    const afterOwnerEvent = await prisma.receptionistEvent.findFirst({
      where: {
        businessId: tenantA.business.id,
        phoneInteractionId: joinedPhone.id,
        kind: RECEPTIONIST_MANUAL_DISPOSITION_KIND,
      },
    });
    const afterOwnerCenter = await loadReceptionistRecoveryCenter(prisma, tenantA.access);
    check(
      "OWNER disposition closes the voice-logged callback without sending a message",
      !ownerDisposition.error &&
        ownerDisposition.message?.includes("No call or message was sent") &&
        afterOwner?.status === PHONE_INTERACTION_CLOSED_STATUS &&
        afterOwner?.callbackNeeded === false &&
        afterOwnerAction?.status === "DONE" &&
        afterOwnerEvent?.status === RECEPTIONIST_MANUAL_DISPOSITION_STATUS &&
        !afterOwnerCenter.queue.some((item) => item.id === joinedPhone.id),
    );

    const afterClosedReplay = await handleInboundVoiceWebhookRequest(
      prisma,
      signedRequest(
        voiceParams({
          CallSid: joinedSid,
          To: "+1 (555) 000-1000",
          From: "+15551112222",
          CallStatus: "no-answer",
        }),
      ),
    );
    const closedReplayPhone = await prisma.phoneInteraction.findFirst({
      where: { id: joinedPhone.id, businessId: tenantA.business.id },
    });
    const closedReplayActions = await prisma.businessActionItem.findMany({
      where: {
        businessId: tenantA.business.id,
        recommendationKey: `phone-callback:${voiceMissedCallIdempotencyKey(joinedSid)}`,
      },
    });
    const closedReplayCenter = await loadReceptionistRecoveryCenter(prisma, tenantA.access);
    const closedReplayTraffic = await outboundTraffic(tenantA.business.id);
    const tenantBTraffic = await outboundTraffic(tenantB.business.id);
    check(
      "A later signed provider event does not reopen CLOSED or return the item to the queue",
      afterClosedReplay.status === 200 &&
        closedReplayPhone?.status === "CLOSED" &&
        closedReplayPhone?.callbackNeeded === false &&
        closedReplayActions.length === 1 &&
        closedReplayActions[0].status === "DONE" &&
        !closedReplayCenter.queue.some((item) => item.id === joinedPhone.id),
    );
    check(
      "Joined path never calls or messages the customer through fake outbound providers",
      noAutomaticCustomerContact(closedReplayTraffic) &&
        noAutomaticCustomerContact(tenantBTraffic) &&
        (await prisma.customerCommunication.count({
          where: { businessId: tenantA.business.id, channel: "PHONE", direction: "INBOUND" },
        })) >= 1,
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
).finally(async () => {
  await restoreProviders();
  restoreEnv();
});

if (failures) {
  console.error(`\n${failures} voice missed-call webhook check(s) failed.`);
  process.exit(1);
}
console.log("\nVoice missed-call webhook checks passed.");
