/**
 * Verified inbound Twilio Voice webhook for the Communications missed-call
 * log. Official X-Twilio-Signature validation (HMAC-SHA1 of the exact
 * URL plus every received form parameter) follows current Twilio docs:
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 * Inbound parameters and CallStatus values:
 * https://www.twilio.com/docs/voice/twiml
 * https://www.twilio.com/docs/voice/api/call-resource
 * Reject (do not answer, do not record):
 * https://www.twilio.com/docs/voice/twiml/reject
 *
 * Recordings, transcriptions, digits, and speech stay out of scope.
 * This route does not place calls or send messages.
 */
import type { PrismaClient } from "@prisma/client";
import {
  getTwilioAccountSid,
  getTwilioAuthToken,
} from "@/lib/customer-messaging/config";
import {
  parseFormBody,
  verifyTwilioRequestSignature,
} from "@/lib/customer-messaging/twilio";
import { isUsableNormalizedPhone, normalizePhone } from "@/lib/customer-identity";
import { getAppUrl } from "@/lib/mail";
import type { CommunicationAccess } from "@/lib/communications/engine";
import { recordMissedOrManualCall } from "@/lib/communications/missed-call";

export const VOICE_WEBHOOK_PATH = "/api/communications/voice-webhook";
export const TWILIO_VOICE_PROVIDER = "twilio";

export const VOICE_WEBHOOK_REJECT_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>';

const GENERIC_NOT_FOUND = { error: "Not found." };
const GENERIC_INVALID = { error: "Invalid signature." };
const GENERIC_UNAVAILABLE = { error: "Unable to process." };

/**
 * Official inbound CallStatus values that mean the call was not answered.
 * `ringing` is the Voice URL POST before `<Reject/>`; later status
 * callbacks reuse the same CallSid.
 */
export const MISSED_INBOUND_VOICE_STATUSES = [
  "ringing",
  "no-answer",
  "busy",
  "canceled",
  "failed",
] as const;

/** Official request params that must never be stored or echoed. */
export const VOICE_WEBHOOK_IGNORED_CONTENT_PARAMS = [
  "RecordingUrl",
  "RecordingSid",
  "RecordingDuration",
  "RecordingStatus",
  "RecordingChannels",
  "RecordingSource",
  "RecordingTrack",
  "TranscriptionText",
  "TranscriptionStatus",
  "TranscriptionSid",
  "Digits",
  "SpeechResult",
  "UnstableSpeechResult",
  "Body",
  "CallToken",
] as const;

export type InboundVoiceWebhookEvent = {
  provider: typeof TWILIO_VOICE_PROVIDER;
  callSid: string;
  accountSid: string | null;
  from: string | null;
  to: string | null;
  callStatus: string;
  direction: string;
};

export type VoiceWebhookRequest = {
  url: string;
  twilioSignature: string | null;
  rawBody: string;
  contentType: string | null;
};

export type VoiceWebhookResult = {
  status: number;
  body: string;
  contentType: string;
};

export function isVoiceWebhookPath(pathname: string) {
  return pathname === VOICE_WEBHOOK_PATH;
}

export function isTwilioVoiceWebhookConfigured() {
  return Boolean(getTwilioAccountSid() && getTwilioAuthToken());
}

export function voiceMissedCallIdempotencyKey(callSid: string) {
  return `voice:${callSid}`;
}

export function voiceWebhookCommunicationsAccess(businessId: string): CommunicationAccess {
  return {
    businessId,
    workspace: { role: "OWNER", membership: null },
  };
}

export function isMissedInboundVoiceEvent(
  event: Pick<InboundVoiceWebhookEvent, "direction" | "callStatus">,
) {
  const direction = event.direction.trim().toLowerCase();
  const status = event.callStatus.trim().toLowerCase();
  return (
    direction === "inbound" &&
    (MISSED_INBOUND_VOICE_STATUSES as readonly string[]).includes(status)
  );
}

function voiceWebhookUrlsToTry(requestUrl: string) {
  const configured = getAppUrl();
  const urls = [requestUrl];
  if (configured) {
    const built = `${configured}${VOICE_WEBHOOK_PATH}`;
    if (built !== requestUrl) urls.push(built);
  }
  return urls;
}

function missedCallSummary(status: string) {
  return `Missed inbound call (${status}).`;
}

function jsonResult(status: number, body: { error?: string; ok?: true }): VoiceWebhookResult {
  return {
    status,
    body: JSON.stringify(body),
    contentType: "application/json",
  };
}

function twimlResult(status = 200): VoiceWebhookResult {
  return {
    status,
    body: VOICE_WEBHOOK_REJECT_TWIML,
    contentType: "text/xml",
  };
}

export function parseInboundVoiceWebhook(
  request: VoiceWebhookRequest,
): InboundVoiceWebhookEvent | null {
  const authToken = getTwilioAuthToken();
  const accountSid = getTwilioAccountSid();
  if (!authToken || !accountSid) return null;

  const params = parseFormBody(request.rawBody);
  const signed = voiceWebhookUrlsToTry(request.url).some((url) =>
    verifyTwilioRequestSignature(authToken, url, params, request.twilioSignature),
  );
  if (!signed) return null;

  const payloadAccountSid = (params.AccountSid || "").trim();
  if (payloadAccountSid && payloadAccountSid !== accountSid) return null;

  const callSid = (params.CallSid || "").trim();
  if (!callSid) return null;

  return {
    provider: TWILIO_VOICE_PROVIDER,
    callSid,
    accountSid: payloadAccountSid || null,
    from: params.From || null,
    to: params.To || null,
    callStatus: (params.CallStatus || "").trim().toLowerCase(),
    direction: (params.Direction || "").trim().toLowerCase(),
  };
}

async function resolveVoiceWebhookTenant(
  db: PrismaClient,
  to: string | null,
): Promise<string | null> {
  const digits = normalizePhone(to);
  if (!isUsableNormalizedPhone(digits)) return null;
  const business = await db.business.findFirst({
    where: { operationalSmsNumber: digits },
    select: { id: true },
  });
  return business?.id ?? null;
}

export async function applyInboundVoiceMissedCall(
  db: PrismaClient,
  event: InboundVoiceWebhookEvent,
) {
  if (!isMissedInboundVoiceEvent(event)) {
    return { applied: false as const, reason: "not_missed_inbound" };
  }

  const businessId = await resolveVoiceWebhookTenant(db, event.to);
  if (!businessId) {
    return { applied: false as const, reason: "unknown_tenant" };
  }

  const result = await recordMissedOrManualCall(
    db,
    voiceWebhookCommunicationsAccess(businessId),
    {
      kind: "MISSED_CALL",
      callerPhone: event.from,
      summary: missedCallSummary(event.callStatus),
      callbackNeeded: true,
      idempotencyKey: voiceMissedCallIdempotencyKey(event.callSid),
    },
  );
  if (!result.ok) {
    return { applied: false as const, reason: result.failureReason ?? "not_logged" };
  }
  return {
    applied: true as const,
    reason: result.reused ? "idempotent" : "logged",
    businessId,
    phoneInteractionId: result.phoneInteractionId,
    actionItemId: result.actionItemId,
    reused: result.reused,
  };
}

export async function handleInboundVoiceWebhookRequest(
  db: PrismaClient,
  request: VoiceWebhookRequest,
): Promise<VoiceWebhookResult> {
  if (!isTwilioVoiceWebhookConfigured()) {
    return jsonResult(404, GENERIC_NOT_FOUND);
  }

  const parsed = parseInboundVoiceWebhook(request);
  if (!parsed) {
    return jsonResult(400, GENERIC_INVALID);
  }

  try {
    await applyInboundVoiceMissedCall(db, parsed);
    return twimlResult(200);
  } catch {
    return jsonResult(500, GENERIC_UNAVAILABLE);
  }
}
