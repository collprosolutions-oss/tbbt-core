/**
 * Plaid webhook verification.
 *
 * Fake / disposable tests use a dedicated header and PLAID_WEBHOOK_SECRET.
 * Production verifies the official Plaid-Verification JWT against
 * /webhook_verification_key/get and the SHA-256 of the raw body.
 * ES256 signatures are JOSE ieee-p1363 (raw r||s), never DER.
 */
import { createHash, createPublicKey, createVerify, timingSafeEqual } from "node:crypto";
import {
  isFakePlaidAdapterEnabled,
  isProductionPlaidEnv,
  resolvePlaidEnvironment,
} from "@/lib/plaid-provider";

export class PlaidWebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaidWebhookVerificationError";
  }
}

export const MAX_PLAID_WEBHOOK_BYTES = 256 * 1024;
export const PLAID_WEBHOOK_IAT_WINDOW_SECONDS = 5 * 60;
const FAKE_WEBHOOK_HEADER = "x-tbbt-plaid-webhook";
const KEY_CACHE_TTL_MS = 10 * 60 * 1000;
const KEY_CACHE_MAX = 16;

export type PlaidVerificationJwk = {
  kty?: string;
  crv?: string;
  x?: string;
  y?: string;
  kid?: string;
};

export type PlaidVerificationKeyFetcher = (
  kid: string,
  env: NodeJS.ProcessEnv,
) => Promise<PlaidVerificationJwk>;

export type VerifiedPlaidWebhook = {
  iat: number;
  jti: string | null;
  requestBodySha256: string;
};

type CachedKey = { key: PlaidVerificationJwk; expiresAt: number };

const keyCache = new Map<string, CachedKey>();
let injectedFetcher: PlaidVerificationKeyFetcher | null = null;

export function setPlaidVerificationKeyFetcher(fetcher: PlaidVerificationKeyFetcher | null) {
  injectedFetcher = fetcher;
}

export function resetPlaidVerificationKeyCache() {
  keyCache.clear();
}

function readHeader(headers: Headers, name: string) {
  return headers.get(name)?.trim() ?? "";
}

function timingEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function decodeBase64Url(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return Buffer.from(padded, "base64");
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new PlaidWebhookVerificationError(`Plaid-Verification JWT ${label} is malformed.`);
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof PlaidWebhookVerificationError) throw error;
    throw new PlaidWebhookVerificationError(`Plaid-Verification JWT ${label} is malformed.`);
  }
}

export function readFakePlaidWebhookSecret(env: NodeJS.ProcessEnv = process.env): string {
  if (isProductionPlaidEnv(env) || !isFakePlaidAdapterEnabled(env)) {
    throw new PlaidWebhookVerificationError("Fake Plaid webhook secret is not available.");
  }
  const secret = env.PLAID_WEBHOOK_SECRET?.trim() ?? "";
  if (!secret) {
    throw new PlaidWebhookVerificationError("PLAID_WEBHOOK_SECRET is required for the fake adapter.");
  }
  return secret;
}

function cacheGet(kid: string): PlaidVerificationJwk | null {
  const hit = keyCache.get(kid);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    keyCache.delete(kid);
    return null;
  }
  return hit.key;
}

function cacheSet(kid: string, key: PlaidVerificationJwk) {
  if (keyCache.size >= KEY_CACHE_MAX) {
    const oldest = keyCache.keys().next().value;
    if (oldest) keyCache.delete(oldest);
  }
  keyCache.set(kid, { key, expiresAt: Date.now() + KEY_CACHE_TTL_MS });
}

async function defaultFetchPlaidVerificationKey(
  keyId: string,
  env: NodeJS.ProcessEnv,
): Promise<PlaidVerificationJwk> {
  const clientId = env.PLAID_CLIENT_ID?.trim() ?? "";
  const secret = env.PLAID_SECRET?.trim() ?? "";
  if (!clientId || !secret) {
    throw new PlaidWebhookVerificationError("Plaid webhook verification is not configured.");
  }
  const host =
    resolvePlaidEnvironment(env.PLAID_ENV) === "production"
      ? "https://production.plaid.com"
      : resolvePlaidEnvironment(env.PLAID_ENV) === "development"
        ? "https://development.plaid.com"
        : "https://sandbox.plaid.com";
  const response = await fetch(`${host}/webhook_verification_key/get`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, secret, key_id: keyId }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    key?: PlaidVerificationJwk;
    error_message?: string;
  };
  if (!response.ok || !payload.key) {
    throw new PlaidWebhookVerificationError(payload.error_message || "Plaid verification key failed.");
  }
  return payload.key;
}

async function loadVerificationKey(kid: string, env: NodeJS.ProcessEnv): Promise<PlaidVerificationJwk> {
  const cached = cacheGet(kid);
  if (cached) return cached;
  const fetcher = injectedFetcher ?? defaultFetchPlaidVerificationKey;
  const key = await fetcher(kid, env);
  cacheSet(kid, key);
  return key;
}

function assertWebhookBodySize(rawBody: string) {
  if (Buffer.byteLength(rawBody, "utf8") > MAX_PLAID_WEBHOOK_BYTES) {
    throw new PlaidWebhookVerificationError("Plaid webhook body is too large.");
  }
}

export async function verifyPlaidWebhookRequest(
  rawBody: string,
  headers: Headers,
  env: NodeJS.ProcessEnv = process.env,
): Promise<VerifiedPlaidWebhook | void> {
  assertWebhookBodySize(rawBody);
  if (isFakePlaidAdapterEnabled(env)) {
    const provided = readHeader(headers, FAKE_WEBHOOK_HEADER);
    const expected = readFakePlaidWebhookSecret(env);
    if (!provided || !timingEqual(provided, expected)) {
      throw new PlaidWebhookVerificationError("Plaid webhook signature is invalid.");
    }
    return;
  }

  const jwt = readHeader(headers, "plaid-verification") || readHeader(headers, "Plaid-Verification");
  if (!jwt) {
    throw new PlaidWebhookVerificationError("Missing Plaid-Verification header.");
  }
  const parts = jwt.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new PlaidWebhookVerificationError("Plaid-Verification JWT is malformed.");
  }
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = parseJsonObject(decodeBase64Url(headerPart).toString("utf8"), "header");
  if (header.alg !== "ES256" || typeof header.kid !== "string" || !header.kid) {
    throw new PlaidWebhookVerificationError("Plaid-Verification JWT is unsupported.");
  }
  const key = await loadVerificationKey(header.kid, env);
  const publicKey = createPublicKey({
    key: {
      kty: key.kty ?? "EC",
      crv: key.crv ?? "P-256",
      x: key.x ?? "",
      y: key.y ?? "",
    },
    format: "jwk",
  });
  const signature = decodeBase64Url(signaturePart);
  if (signature.length !== 64) {
    throw new PlaidWebhookVerificationError("Plaid-Verification JWT is invalid.");
  }
  const verifier = createVerify("SHA256");
  verifier.update(`${headerPart}.${payloadPart}`);
  verifier.end();
  const valid = verifier.verify(
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    signature,
  );
  if (!valid) {
    throw new PlaidWebhookVerificationError("Plaid-Verification JWT is invalid.");
  }
  const claims = parseJsonObject(decodeBase64Url(payloadPart).toString("utf8"), "payload");
  const issuedAt = Number(claims.iat ?? 0);
  if (!Number.isFinite(issuedAt) || Math.abs(Date.now() / 1000 - issuedAt) > PLAID_WEBHOOK_IAT_WINDOW_SECONDS) {
    throw new PlaidWebhookVerificationError("Plaid webhook is too old.");
  }
  const requestBodySha256 =
    typeof claims.request_body_sha256 === "string" ? claims.request_body_sha256 : "";
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  if (!requestBodySha256 || !timingEqual(requestBodySha256, bodyHash)) {
    throw new PlaidWebhookVerificationError("Plaid webhook body hash does not match.");
  }
  return {
    iat: issuedAt,
    jti: typeof claims.jti === "string" && claims.jti.trim() ? claims.jti.trim() : null,
    requestBodySha256,
  };
}
