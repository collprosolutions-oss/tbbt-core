import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const SVIX_TOLERANCE_SECONDS = 5 * 60;
const WHSEC_PREFIX = "whsec_";

export type ResendWebhookHeaders = {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
};

export type SignedResendWebhook = {
  id: string;
  timestamp: string;
  signature: string;
  payload: string;
};

function decodeWebhookSecret(secret: string): Buffer | null {
  const trimmed = secret.trim();
  if (!trimmed.startsWith(WHSEC_PREFIX)) return null;
  const encoded = trimmed.slice(WHSEC_PREFIX.length);
  if (!encoded) return null;
  try {
    const key = Buffer.from(encoded, "base64");
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

function signedContent(id: string, timestamp: string, payload: string) {
  return `${id}.${timestamp}.${payload}`;
}

function hmacBase64(secret: Buffer, content: string) {
  return createHmac("sha256", secret).update(content).digest("base64");
}

function equalSignature(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseSignatureHeader(header: string) {
  const values: string[] = [];
  for (const part of header.trim().split(/\s+/)) {
    const [version, value] = part.split(",", 2);
    if (version === "v1" && value) values.push(value);
  }
  return values;
}

export function signResendWebhook(input: {
  secret: string;
  payload: string;
  id?: string;
  timestamp?: string | number;
}): SignedResendWebhook | null {
  const secret = decodeWebhookSecret(input.secret);
  if (!secret) return null;
  const id = input.id?.trim() || `msg_${randomUUID()}`;
  const timestamp =
    typeof input.timestamp === "number"
      ? String(Math.floor(input.timestamp))
      : input.timestamp?.trim() || String(Math.floor(Date.now() / 1000));
  if (!id || !timestamp) return null;
  const signature = `v1,${hmacBase64(secret, signedContent(id, timestamp, input.payload))}`;
  return { id, timestamp, signature, payload: input.payload };
}

export function verifyResendWebhookSignature(input: {
  secret: string;
  payload: string;
  headers: ResendWebhookHeaders;
  nowSeconds?: number;
}): boolean {
  const secret = decodeWebhookSecret(input.secret);
  const id = input.headers.id?.trim() || "";
  const timestamp = input.headers.timestamp?.trim() || "";
  const header = input.headers.signature?.trim() || "";
  if (!secret || !id || !timestamp || !header) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > SVIX_TOLERANCE_SECONDS) return false;

  const expected = hmacBase64(secret, signedContent(id, timestamp, input.payload));
  return parseSignatureHeader(header).some((value) => equalSignature(value, expected));
}

export function resendWebhookHeadersFromRequest(headers: {
  get(name: string): string | null;
}): ResendWebhookHeaders {
  return {
    id: headers.get("svix-id"),
    timestamp: headers.get("svix-timestamp"),
    signature: headers.get("svix-signature"),
  };
}
