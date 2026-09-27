/**
 * Server-side limits for POST /api/native/v1/session.
 *
 * Web sign-in already persists TOTP failures on AuthChallenge.failedAttemptCount
 * (five tries, then the challenge is deleted). Native password attempts need
 * the same kind of durable counter — not a per-process Map — because the
 * Bearer route is easier to automate than the cookie form.
 *
 * Oversized JSON is rejected before parse. Body bytes are counted from the
 * request stream so a missing Content-Length cannot skip the cap.
 *
 * Password failures increment with a single INSERT … ON CONFLICT so five
 * simultaneous wrong-password requests for a fresh email become five rows
 * of count, not one.
 */
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  TOTP_CHALLENGE_LOCKED_MESSAGE,
  TOTP_CHALLENGE_MAX_ATTEMPTS,
  TOTP_CHALLENGE_MINUTES,
} from "@/lib/account-security";
import { hashToken } from "@/lib/auth-crypto";

type Db = PrismaClient | Prisma.TransactionClient;

export const NATIVE_SESSION_MAX_BODY_BYTES = 4096;
export const NATIVE_SESSION_MAX_FIELD_CHARS = {
  email: 320,
  password: 256,
  challengeToken: 128,
  totpCode: 32,
} as const;
export const NATIVE_PASSWORD_PURPOSE = "NATIVE_PASSWORD";
export const NATIVE_PASSWORD_MAX_ATTEMPTS = TOTP_CHALLENGE_MAX_ATTEMPTS;
export const NATIVE_PASSWORD_WINDOW_MINUTES = TOTP_CHALLENGE_MINUTES;
export const NATIVE_SESSION_TOO_LARGE = "That request is too large.";
export const NATIVE_PASSWORD_LOCKED_MESSAGE = TOTP_CHALLENGE_LOCKED_MESSAGE;

export function nativePasswordSubjectHash(email: string) {
  return hashToken(`${NATIVE_PASSWORD_PURPOSE}:${email.trim().toLowerCase()}`);
}

export async function readCappedRequestText(
  request: Request,
  maxBytes = NATIVE_SESSION_MAX_BODY_BYTES,
): Promise<{ ok: true; text: string } | { ok: false; status: 413; error: string }> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) {
    return { ok: false, status: 413, error: NATIVE_SESSION_TOO_LARGE };
  }

  const reader = request.body?.getReader();
  if (!reader) {
    return { ok: true, text: "" };
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, status: 413, error: NATIVE_SESSION_TOO_LARGE };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
}

export function parseNativeSessionJson(text: string):
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; status: 400 | 413; error: string } {
  if (!text.trim()) {
    return { ok: false, status: 400, error: "Email and password are required." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, error: "Email and password are required." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, status: 400, error: "Email and password are required." };
  }
  const payload = parsed as Record<string, unknown>;
  const fields = {
    email: payload.email,
    password: payload.password,
    challengeToken: payload.challengeToken,
    totpCode: payload.totpCode,
  };
  for (const [key, max] of Object.entries(NATIVE_SESSION_MAX_FIELD_CHARS)) {
    const value = fields[key as keyof typeof fields];
    if (typeof value === "string" && value.length > max) {
      return { ok: false, status: 413, error: NATIVE_SESSION_TOO_LARGE };
    }
  }
  return { ok: true, payload };
}

export async function nativePasswordThrottleIsLocked(db: Db, email: string) {
  const subjectHash = nativePasswordSubjectHash(email);
  const row = await db.nativeSignInThrottle.findUnique({
    where: {
      subjectHash_purpose: { subjectHash, purpose: NATIVE_PASSWORD_PURPOSE },
    },
  });
  if (!row || row.expiresAt <= new Date()) {
    return false;
  }
  return row.failedAttemptCount >= NATIVE_PASSWORD_MAX_ATTEMPTS;
}

export async function recordNativePasswordFailure(db: Db, email: string) {
  const subjectHash = nativePasswordSubjectHash(email);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + NATIVE_PASSWORD_WINDOW_MINUTES * 60 * 1000);

  const rows = await db.$queryRaw<Array<{ failedAttemptCount: number }>>`
    INSERT INTO "NativeSignInThrottle" (
      "id",
      "subjectHash",
      "purpose",
      "failedAttemptCount",
      "windowStartedAt",
      "expiresAt",
      "createdAt",
      "updatedAt"
    )
    VALUES (
      ${randomUUID()},
      ${subjectHash},
      ${NATIVE_PASSWORD_PURPOSE},
      1,
      ${now},
      ${expiresAt},
      ${now},
      ${now}
    )
    ON CONFLICT ("subjectHash", "purpose") DO UPDATE SET
      "failedAttemptCount" = CASE
        WHEN "NativeSignInThrottle"."expiresAt" <= EXCLUDED."windowStartedAt" THEN 1
        ELSE "NativeSignInThrottle"."failedAttemptCount" + 1
      END,
      "windowStartedAt" = CASE
        WHEN "NativeSignInThrottle"."expiresAt" <= EXCLUDED."windowStartedAt" THEN EXCLUDED."windowStartedAt"
        ELSE "NativeSignInThrottle"."windowStartedAt"
      END,
      "expiresAt" = CASE
        WHEN "NativeSignInThrottle"."expiresAt" <= EXCLUDED."windowStartedAt" THEN EXCLUDED."expiresAt"
        ELSE "NativeSignInThrottle"."expiresAt"
      END,
      "updatedAt" = EXCLUDED."updatedAt"
    RETURNING "failedAttemptCount"
  `;

  const failedAttemptCount = Number(rows[0]?.failedAttemptCount ?? 1);
  return {
    locked: failedAttemptCount >= NATIVE_PASSWORD_MAX_ATTEMPTS,
    failedAttemptCount,
  };
}

export async function clearNativePasswordThrottle(db: Db, email: string) {
  await db.nativeSignInThrottle.deleteMany({
    where: {
      subjectHash: nativePasswordSubjectHash(email),
      purpose: NATIVE_PASSWORD_PURPOSE,
    },
  });
}
