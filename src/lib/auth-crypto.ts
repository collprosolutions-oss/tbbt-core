import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";

const SALT_ROUNDS = 10;

/**
 * Exported so any other single-use, expiring, unguessable-token flow can
 * reuse this exact hashing scheme instead of inventing a new one -- see
 * PasswordSetupToken / PasswordResetToken in prisma/schema.prisma.
 */
export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, passwordHash: string) {
  return bcrypt.compare(password, passwordHash);
}

/**
 * A cryptographically random, URL-safe raw token. Callers store only
 * `hashToken(token)` and hand the raw value to the user exactly once.
 */
export function createSecureToken() {
  return randomBytes(32).toString("hex");
}
