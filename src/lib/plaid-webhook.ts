/**
 * Plaid webhook verification.
 *
 * Fake / disposable tests use a dedicated header and PLAID_WEBHOOK_SECRET.
 * Production verifies the official Plaid-Verification JWT against
 * /webhook_verification_key/get and the SHA-256 of the raw body.
 */
import { createHash, createPublicKey, createVerify, timingSafeEqual } from "node:crypto";
import { plaidAdapterKind, resolvePlaidEnvironment } from "@/lib/plaid-provider";

export class PlaidWebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaidWebhookVerificationError";
  }
}

const FAKE_WEBHOOK_HEADER = "x-tbbt-plaid-webhook";

function readHeader(headers: Headers, name: string) {
  return headers.get(name)?.trim() ?? "";
}

function expectedFakeSecret(env: NodeJS.ProcessEnv = process.env) {
  return env.PLAID_WEBHOOK_SECRET?.trim() || "sandbox-test";
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

async function fetchPlaidVerificationKey(keyId: string, env: NodeJS.ProcessEnv) {
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
    key?: { kty?: string; crv?: string; x?: string; y?: string; kid?: string };
    error_message?: string;
  };
  if (!response.ok || !payload.key) {
    throw new PlaidWebhookVerificationError(payload.error_message || "Plaid verification key failed.");
  }
  return payload.key;
}

export async function verifyPlaidWebhookRequest(
  rawBody: string,
  headers: Headers,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (plaidAdapterKind(env) === "fake") {
    const provided = readHeader(headers, FAKE_WEBHOOK_HEADER);
    if (!provided || !timingEqual(provided, expectedFakeSecret(env))) {
      throw new PlaidWebhookVerificationError("Plaid webhook signature is invalid.");
    }
    return;
  }

  const jwt = readHeader(headers, "plaid-verification") || readHeader(headers, "Plaid-Verification");
  if (!jwt) {
    throw new PlaidWebhookVerificationError("Missing Plaid-Verification header.");
  }
  const [headerPart, payloadPart, signaturePart] = jwt.split(".");
  if (!headerPart || !payloadPart || !signaturePart) {
    throw new PlaidWebhookVerificationError("Plaid-Verification JWT is malformed.");
  }
  const header = JSON.parse(decodeBase64Url(headerPart).toString("utf8")) as {
    alg?: string;
    kid?: string;
  };
  if (header.alg !== "ES256" || !header.kid) {
    throw new PlaidWebhookVerificationError("Plaid-Verification JWT is unsupported.");
  }
  const key = await fetchPlaidVerificationKey(header.kid, env);
  const publicKey = createPublicKey({
    key: {
      kty: key.kty ?? "EC",
      crv: key.crv ?? "P-256",
      x: key.x ?? "",
      y: key.y ?? "",
    },
    format: "jwk",
  });
  const verifier = createVerify("SHA256");
  verifier.update(`${headerPart}.${payloadPart}`);
  verifier.end();
  const valid = verifier.verify(publicKey, decodeBase64Url(signaturePart));
  if (!valid) {
    throw new PlaidWebhookVerificationError("Plaid-Verification JWT is invalid.");
  }
  const claims = JSON.parse(decodeBase64Url(payloadPart).toString("utf8")) as {
    iat?: number;
    request_body_sha256?: string;
  };
  const issuedAt = Number(claims.iat ?? 0);
  if (!Number.isFinite(issuedAt) || Math.abs(Date.now() / 1000 - issuedAt) > 5 * 60) {
    throw new PlaidWebhookVerificationError("Plaid webhook is too old.");
  }
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  if (!claims.request_body_sha256 || !timingEqual(claims.request_body_sha256, bodyHash)) {
    throw new PlaidWebhookVerificationError("Plaid webhook body hash does not match.");
  }
}
