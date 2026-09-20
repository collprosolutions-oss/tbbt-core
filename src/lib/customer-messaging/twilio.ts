import { createHmac, timingSafeEqual } from "node:crypto";
import {
  CUSTOMER_MESSAGING_WEBHOOK_PATH,
  TWILIO_CUSTOMER_MESSAGING_PROVIDER,
  type TwilioMessagingConfig,
} from "@/lib/customer-messaging/config";
import { SMS_TRANSACTIONAL_OPT_OUT_FOOTER } from "@/lib/customer-messaging/compliance";
import type {
  CustomerMessageSendInput,
  CustomerMessageSendResult,
  CustomerMessagingProvider,
  CustomerMessagingWebhookParseInput,
  InboundSmsOptOutType,
  ParsedCustomerMessagingWebhook,
} from "@/lib/customer-messaging/types";
import { getAppUrl } from "@/lib/mail";

export type TwilioFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type TwilioCustomerMessagingProvider = CustomerMessagingProvider & {
  config: TwilioMessagingConfig;
};

const STOP_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const START_KEYWORDS = new Set(["START", "YES", "UNSTOP"]);
const HELP_KEYWORDS = new Set(["HELP", "INFO"]);

export function twilioStatusToCustomerMessageStatus(
  status: string | null | undefined,
): "QUEUED" | "ACCEPTED" | "SENT" | "DELIVERED" | "FAILED" | null {
  const value = (status ?? "").trim().toLowerCase();
  if (value === "queued" || value === "accepted") return "ACCEPTED";
  if (value === "sending" || value === "sent") return "SENT";
  if (value === "delivered") return "DELIVERED";
  if (value === "undelivered" || value === "failed") return "FAILED";
  return null;
}

export function toTwilioE164(normalizedDigits: string) {
  if (normalizedDigits.length === 10) return `+1${normalizedDigits}`;
  if (normalizedDigits.length === 11 && normalizedDigits.startsWith("1")) {
    return `+${normalizedDigits}`;
  }
  if (normalizedDigits.startsWith("+")) return normalizedDigits;
  return `+${normalizedDigits}`;
}

export function withTransactionalOptOutFooter(body: string) {
  if (/reply stop/i.test(body)) return body;
  return `${body} ${SMS_TRANSACTIONAL_OPT_OUT_FOOTER}`;
}

export function parseTwilioOptOutType(
  optOutType: string | null | undefined,
  body: string | null | undefined,
): InboundSmsOptOutType | null {
  const flagged = (optOutType ?? "").trim().toUpperCase();
  if (flagged === "STOP" || flagged === "START" || flagged === "HELP") return flagged;
  const keyword = (body ?? "").trim().split(/\s+/)[0]?.toUpperCase() ?? "";
  if (STOP_KEYWORDS.has(keyword)) return "STOP";
  if (START_KEYWORDS.has(keyword)) return "START";
  if (HELP_KEYWORDS.has(keyword)) return "HELP";
  return null;
}

export function parseFormBody(rawBody: string) {
  const params = new URLSearchParams(rawBody);
  const record: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    if (!(key in record)) record[key] = value;
  }
  return record;
}

/**
 * Twilio X-Twilio-Signature: HMAC-SHA1 of the full URL plus sorted
 * POST params as name+value, then Base64.
 */
export function twilioRequestSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
) {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    data += key + params[key];
  }
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

export function verifyTwilioRequestSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | null,
) {
  if (!signature) return false;
  const expected = twilioRequestSignature(authToken, url, params);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function basicAuth(accountSid: string, authToken: string) {
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
}

function statusCallbackUrl() {
  const appUrl = getAppUrl();
  return appUrl ? `${appUrl}${CUSTOMER_MESSAGING_WEBHOOK_PATH}` : null;
}

function webhookUrlsToTry(requestUrl: string) {
  const configured = statusCallbackUrl();
  const urls = [requestUrl];
  if (configured && configured !== requestUrl) urls.push(configured);
  return urls;
}

export function createTwilioCustomerMessagingProvider(
  config: TwilioMessagingConfig,
  fetchImpl: TwilioFetch = fetch as TwilioFetch,
): TwilioCustomerMessagingProvider {
  const provider: TwilioCustomerMessagingProvider = {
    id: TWILIO_CUSTOMER_MESSAGING_PROVIDER,
    connected: true,
    config,
    async send(input: CustomerMessageSendInput): Promise<CustomerMessageSendResult> {
      const to = toTwilioE164(input.to);
      const body = new URLSearchParams();
      body.set("To", to);
      body.set("Body", withTransactionalOptOutFooter(input.body));
      if (config.messagingServiceSid) {
        body.set("MessagingServiceSid", config.messagingServiceSid);
      } else if (config.fromNumber) {
        body.set("From", config.fromNumber);
      }
      const callback = statusCallbackUrl();
      if (callback) body.set("StatusCallback", callback);

      const url = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`;
      let response: { ok: boolean; status: number; json(): Promise<unknown> };
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: basicAuth(config.accountSid, config.authToken),
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
        });
      } catch {
        return { ok: false, status: "FAILED", error: "The messaging provider failed." };
      }

      let payload: Record<string, unknown> = {};
      try {
        const json = await response.json();
        if (json && typeof json === "object") payload = json as Record<string, unknown>;
      } catch {
        payload = {};
      }

      const sid = typeof payload.sid === "string" ? payload.sid : "";
      const mapped = twilioStatusToCustomerMessageStatus(
        typeof payload.status === "string" ? payload.status : null,
      );
      if (!response.ok || !sid || mapped === "FAILED") {
        const message =
          typeof payload.message === "string"
            ? payload.message
            : "The messaging provider rejected the message.";
        return { ok: false, status: "FAILED", error: message };
      }

      return {
        ok: true,
        status: mapped === "SENT" ? "SENT" : "ACCEPTED",
        providerMessageId: sid,
        providerMetadata: {
          adapter: TWILIO_CUSTOMER_MESSAGING_PROVIDER,
          twilioStatus: typeof payload.status === "string" ? payload.status : null,
        },
      };
    },
    parseWebhook(input: CustomerMessagingWebhookParseInput): ParsedCustomerMessagingWebhook | null {
      const params = parseFormBody(input.rawBody);
      const signed = webhookUrlsToTry(input.url).some((url) =>
        verifyTwilioRequestSignature(config.authToken, url, params, input.signature),
      );
      if (!signed) return null;

      const messageSid =
        (typeof params.MessageSid === "string" && params.MessageSid) ||
        (typeof params.SmsSid === "string" && params.SmsSid) ||
        "";
      if (!messageSid) return null;

      const messageStatus = (params.MessageStatus || params.SmsStatus || "").toLowerCase();
      const mapped = twilioStatusToCustomerMessageStatus(messageStatus);
      const isInbound =
        messageStatus === "received" ||
        Boolean(params.OptOutType) ||
        (Boolean(params.From && params.To && params.Body !== undefined) && !mapped);

      if (isInbound) {
        return {
          kind: "inbound",
          inbound: {
            provider: TWILIO_CUSTOMER_MESSAGING_PROVIDER,
            providerEventId: messageSid,
            from: params.From,
            to: params.To,
            body: params.Body ?? "",
            optOutType: parseTwilioOptOutType(params.OptOutType, params.Body),
          },
        };
      }

      if (!mapped) return null;
      return {
        kind: "delivery",
        update: {
          provider: TWILIO_CUSTOMER_MESSAGING_PROVIDER,
          providerMessageId: messageSid,
          status: mapped,
          providerEventId: `${messageSid}:${mapped}`,
          routingNumber: params.From || null,
          failureReason:
            mapped === "FAILED"
              ? params.ErrorMessage || params.ErrorCode || "Twilio reported delivery failure."
              : undefined,
        },
        providerEventId: `${messageSid}:${mapped}`,
      };
    },
  };
  return provider;
}
