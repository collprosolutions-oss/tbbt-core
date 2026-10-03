import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Shared at-rest encryption for provider OAuth tokens (payroll, marketing).
 * AES-256-GCM, random 96-bit IV per call, authenticated with AAD bound to the
 * purpose and the business, so a ciphertext cannot be replayed for another
 * tenant or another provider. Key: CONNECTION_TOKEN_ENCRYPTION_KEY (64 hex).
 * There is deliberately no fallback key and no plaintext mode.
 */

const VERSION = "v1";
const KEY_ENV = "CONNECTION_TOKEN_ENCRYPTION_KEY";

export class ConnectionTokenCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionTokenCryptoError";
  }
}

function loadKey(): Buffer {
  const raw = process.env[KEY_ENV];
  if (typeof raw !== "string" || !/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new ConnectionTokenCryptoError(
      `${KEY_ENV} must be set to 32 bytes encoded as 64 hex characters.`,
    );
  }
  return Buffer.from(raw, "hex");
}

export function isConnectionTokenKeyConfigured(): boolean {
  const raw = process.env[KEY_ENV];
  return typeof raw === "string" && /^[0-9a-fA-F]{64}$/.test(raw);
}

function aad(purpose: string, businessId: string): Buffer {
  if (!purpose || !businessId) {
    throw new ConnectionTokenCryptoError("Purpose and businessId are required.");
  }
  return Buffer.from(`${purpose}|${businessId}`, "utf8");
}

export function encryptConnectionToken(
  purpose: string,
  businessId: string,
  plaintext: string,
): string {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new ConnectionTokenCryptoError("Nothing to encrypt.");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", loadKey(), iv);
  cipher.setAAD(aad(purpose, businessId));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptConnectionToken(
  purpose: string,
  businessId: string,
  envelope: string,
): string {
  const parts = typeof envelope === "string" ? envelope.split(".") : [];
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new ConnectionTokenCryptoError("Unrecognized token envelope.");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", loadKey(), Buffer.from(parts[1], "base64url"));
    decipher.setAAD(aad(purpose, businessId));
    decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]).toString("utf8");
  } catch (error) {
    if (error instanceof ConnectionTokenCryptoError) throw error;
    throw new ConnectionTokenCryptoError("Token could not be decrypted.");
  }
}
