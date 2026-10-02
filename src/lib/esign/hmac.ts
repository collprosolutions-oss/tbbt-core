/**
 * Official Dropbox Sign callback verification.
 *
 * Event hash (required):
 *   HMAC-SHA256(api_key, event_time + event_type) compared to event.event_hash
 *   https://developers.hellosign.com/docs/guides/events-and-callbacks/walkthrough/
 *
 * Content-Sha256 header (optional extra check):
 *   Base64(HMAC-SHA256(api_key, raw JSON payload))
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export function dropboxSignEventHash(apiKey: string, eventTime: string, eventType: string) {
  return createHmac("sha256", apiKey).update(`${eventTime}${eventType}`).digest("hex");
}

export function dropboxSignContentSha256(apiKey: string, rawJson: string) {
  return createHmac("sha256", apiKey).update(rawJson).digest("base64");
}

function safeEqualHexOrB64(expected: string, actual: string) {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function verifyDropboxSignEventHash(input: {
  apiKey: string;
  eventTime: string;
  eventType: string;
  eventHash: string;
}) {
  if (!input.apiKey || !input.eventTime || !input.eventType || !input.eventHash) {
    return false;
  }
  return safeEqualHexOrB64(
    dropboxSignEventHash(input.apiKey, input.eventTime, input.eventType),
    input.eventHash,
  );
}

export function verifyDropboxSignContentSha256(input: {
  apiKey: string;
  rawJson: string;
  header: string | null | undefined;
}) {
  const header = input.header?.trim() ?? "";
  if (!header) return true;
  return safeEqualHexOrB64(dropboxSignContentSha256(input.apiKey, input.rawJson), header);
}
