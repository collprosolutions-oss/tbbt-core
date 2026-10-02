/**
 * Official Dropbox Sign callback verification.
 *
 * Event hash (required, documented verifier):
 *   HMAC-SHA256(api_key, event_time + event_type) compared to event.event_hash
 *   https://developers.hellosign.com/docs/guides/events-and-callbacks/walkthrough/
 *
 * Content-Sha256 is not used. Dropbox Sign sends base64 of the HEX HMAC
 * digest (88 chars). Hashing the raw body and base64-encoding that digest
 * is a different value (44 chars) and would reject every genuine callback.
 * event_hash is the documented verifier; request binding is stored and
 * matched separately because event_hash does not cover the body.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export function dropboxSignEventHash(apiKey: string, eventTime: string, eventType: string) {
  return createHmac("sha256", apiKey).update(`${eventTime}${eventType}`).digest("hex");
}

function safeEqualHex(expected: string, actual: string) {
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
  return safeEqualHex(
    dropboxSignEventHash(input.apiKey, input.eventTime, input.eventType),
    input.eventHash,
  );
}
