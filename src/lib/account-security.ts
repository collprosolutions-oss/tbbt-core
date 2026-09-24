import type { Prisma, PrismaClient } from "@prisma/client";
import { createSecureToken, hashToken } from "@/lib/auth-crypto";
import {
  generateBackupCodes,
  generateTotpSecret,
  totpOtpauthUrl,
  verifyTotpCode,
} from "@/lib/totp";

type Db = PrismaClient | Prisma.TransactionClient;

export const TOTP_CHALLENGE_PURPOSE = "TOTP_SIGN_IN";
export const TOTP_CHALLENGE_MINUTES = 10;

export class AccountSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountSecurityError";
  }
}

export function listUserSessions(
  db: Db,
  input: { userId: string; currentSessionId?: string | null },
) {
  return db.session.findMany({
    where: { userId: input.userId },
    select: {
      id: true,
      createdAt: true,
      expiresAt: true,
      userAgent: true,
      revokedAt: true,
    },
    orderBy: { createdAt: "desc" },
  }).then((rows) =>
    rows.map((row) => ({
      ...row,
      current: row.id === input.currentSessionId,
      active: !row.revokedAt && row.expiresAt > new Date(),
    })),
  );
}

export async function revokeOtherSessionsOp(
  db: Db,
  input: { userId: string; currentSessionId: string },
) {
  const result = await db.session.updateMany({
    where: {
      userId: input.userId,
      id: { not: input.currentSessionId },
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

export async function revokeSessionOp(
  db: Db,
  input: { userId: string; sessionId: string; currentSessionId: string },
) {
  if (input.sessionId === input.currentSessionId) {
    throw new AccountSecurityError("You cannot revoke the session you are using. Sign out instead.");
  }
  const session = await db.session.findFirst({
    where: { id: input.sessionId, userId: input.userId },
  });
  if (!session) {
    throw new AccountSecurityError("That session could not be found.");
  }
  if (session.revokedAt) {
    return session;
  }
  return db.session.update({
    where: { id: session.id },
    data: { revokedAt: new Date() },
  });
}

export async function startTotpEnrollmentOp(
  db: Db,
  input: { userId: string; accountName: string },
) {
  const user = await db.user.findUnique({ where: { id: input.userId } });
  if (!user) {
    throw new AccountSecurityError("You need to sign in again.");
  }
  if (user.totpEnabledAt && user.totpSecret) {
    throw new AccountSecurityError("Authenticator app sign-in is already enabled.");
  }
  const secret = generateTotpSecret();
  await db.user.update({
    where: { id: user.id },
    data: { totpPendingSecret: secret },
  });
  return {
    secret,
    otpauthUrl: totpOtpauthUrl({ secret, accountName: input.accountName }),
  };
}

export async function confirmTotpEnrollmentOp(
  db: PrismaClient,
  input: { userId: string; code: string },
) {
  const user = await db.user.findUnique({ where: { id: input.userId } });
  if (!user?.totpPendingSecret) {
    throw new AccountSecurityError("Start authenticator setup first.");
  }
  if (!verifyTotpCode(user.totpPendingSecret, input.code)) {
    throw new AccountSecurityError("That authenticator code is not valid.");
  }
  const backupCodes = generateBackupCodes();
  await db.$transaction(async (tx) => {
    await tx.totpBackupCode.deleteMany({ where: { userId: user.id } });
    await tx.totpBackupCode.createMany({
      data: backupCodes.map((code) => ({
        userId: user.id,
        codeHash: hashToken(code),
      })),
    });
    await tx.user.update({
      where: { id: user.id },
      data: {
        totpSecret: user.totpPendingSecret,
        totpPendingSecret: null,
        totpEnabledAt: new Date(),
      },
    });
  });
  return { backupCodes };
}

export async function disableTotpOp(
  db: PrismaClient,
  input: { userId: string; code: string },
) {
  const user = await db.user.findUnique({
    where: { id: input.userId },
    include: { totpBackupCodes: { where: { usedAt: null } } },
  });
  if (!user?.totpEnabledAt || !user.totpSecret) {
    throw new AccountSecurityError("Authenticator app sign-in is not enabled.");
  }
  const ok =
    verifyTotpCode(user.totpSecret, input.code) ||
    (await consumeBackupCode(db, user.id, input.code));
  if (!ok) {
    throw new AccountSecurityError("That authenticator or backup code is not valid.");
  }
  await db.$transaction(async (tx) => {
    await tx.totpBackupCode.deleteMany({ where: { userId: user.id } });
    await tx.user.update({
      where: { id: user.id },
      data: {
        totpSecret: null,
        totpPendingSecret: null,
        totpEnabledAt: null,
      },
    });
  });
}

export async function createTotpSignInChallenge(
  db: Db,
  userId: string,
): Promise<string> {
  const token = createSecureToken();
  await db.authChallenge.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      purpose: TOTP_CHALLENGE_PURPOSE,
      expiresAt: new Date(Date.now() + TOTP_CHALLENGE_MINUTES * 60 * 1000),
    },
  });
  return token;
}

export async function verifyTotpSignInChallenge(
  db: PrismaClient,
  input: { challengeToken: string; code: string },
): Promise<{ userId: string }> {
  const challenge = await db.authChallenge.findUnique({
    where: { tokenHash: hashToken(input.challengeToken) },
    include: {
      user: { include: { totpBackupCodes: { where: { usedAt: null } } } },
    },
  });
  if (!challenge || challenge.purpose !== TOTP_CHALLENGE_PURPOSE) {
    throw new AccountSecurityError("That sign-in challenge is not valid.");
  }
  if (challenge.expiresAt < new Date()) {
    await db.authChallenge.delete({ where: { id: challenge.id } }).catch(() => undefined);
    throw new AccountSecurityError("That sign-in challenge expired. Sign in again.");
  }
  const user = challenge.user;
  if (!user.totpEnabledAt || !user.totpSecret) {
    throw new AccountSecurityError("Authenticator app sign-in is not enabled.");
  }
  const totpOk = verifyTotpCode(user.totpSecret, input.code);
  const backupOk = totpOk ? false : await consumeBackupCode(db, user.id, input.code);
  if (!totpOk && !backupOk) {
    throw new AccountSecurityError("That authenticator or backup code is not valid.");
  }
  await db.authChallenge.delete({ where: { id: challenge.id } });
  return { userId: user.id };
}

async function consumeBackupCode(db: PrismaClient, userId: string, code: string) {
  const normalized = code.replace(/\s+/g, "").toUpperCase();
  if (!normalized) return false;
  const match = await db.totpBackupCode.findFirst({
    where: { userId, codeHash: hashToken(normalized), usedAt: null },
  });
  if (!match) return false;
  await db.totpBackupCode.update({
    where: { id: match.id },
    data: { usedAt: new Date() },
  });
  return true;
}
