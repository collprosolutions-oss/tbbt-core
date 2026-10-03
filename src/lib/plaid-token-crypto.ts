/**
 * AES-256-GCM encryption for Plaid access tokens.
 * The key never ships in git. Bank logins are never stored.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "v1";

export class PlaidTokenCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaidTokenCryptoError";
  }
}

export function readPlaidTokenEncryptionKey(
  env: NodeJS.ProcessEnv = process.env,
): Buffer {
  const raw = env.PLAID_TOKEN_ENCRYPTION_KEY?.trim() ?? "";
  if (!raw) {
    throw new PlaidTokenCryptoError("PLAID_TOKEN_ENCRYPTION_KEY is not set.");
  }
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new PlaidTokenCryptoError("PLAID_TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex chars).");
  }
  return key;
}

export function encryptPlaidAccessToken(
  plaintext: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = plaintext.trim();
  if (!value) {
    throw new PlaidTokenCryptoError("Refusing to encrypt an empty access token.");
  }
  const key = readPlaidTokenEncryptionKey(env);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}.${iv.toString("hex")}.${tag.toString("hex")}.${encrypted.toString("hex")}`;
}

export function decryptPlaidAccessToken(
  ciphertext: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const parts = ciphertext.split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new PlaidTokenCryptoError("Access token ciphertext is not a v1 payload.");
  }
  const key = readPlaidTokenEncryptionKey(env);
  const iv = Buffer.from(parts[1], "hex");
  const tag = Buffer.from(parts[2], "hex");
  const encrypted = Buffer.from(parts[3], "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
