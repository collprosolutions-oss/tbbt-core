/**
 * Forgot-password + signed-in change-password operations.
 *
 * Reuses Session / PasswordSetupToken hashing exactly (createSecureToken +
 * hashToken SHA-256; bcrypt password hashes). The reset URL carries only
 * the raw token -- never a business, tenant, or user id.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  createSecureToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from "@/lib/auth-crypto";
import {
  getAppUrl,
  getMailConfig,
  passwordResetIdempotencyKey,
  sendTransactionalEmail,
  type MailConfig,
} from "@/lib/mail";
import { buildPasswordResetEmail } from "@/lib/password-reset-mail";

type Db = PrismaClient | Prisma.TransactionClient;

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_RESET_EXPIRY_MS = 60 * 60 * 1000;
export const PASSWORD_RESET_COOLDOWN_MS = 60 * 1000;

export const PASSWORD_RESET_REQUEST_MESSAGE =
  "If an account exists for that email, we sent a password reset link.";

export const PASSWORD_RESET_TOKEN_ERROR =
  "This reset link is invalid or has expired. Request a new one from the sign-in page.";

export type PasswordResetRequestOutcome =
  | "invalid-email"
  | "unknown-email"
  | "mail-unconfigured"
  | "app-url-unconfigured"
  | "cooldown"
  | "sent"
  | "send-failed";

export type PasswordResetRequestResult = {
  message: string;
  outcome: PasswordResetRequestOutcome;
};

export type PasswordMutationResult =
  | { ok: true; userId: string }
  | { ok: false; error: string };

export type PasswordResetMailer = {
  getMailConfig: typeof getMailConfig;
  getAppUrl: typeof getAppUrl;
  sendTransactionalEmail: typeof sendTransactionalEmail;
  logError?: (message: string) => void;
};

const defaultMailer: PasswordResetMailer = {
  getMailConfig,
  getAppUrl,
  sendTransactionalEmail,
  logError: (message) => {
    console.error(message);
  },
};

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function isUsableEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function resetUrlForToken(appUrl: string, rawToken: string) {
  return `${appUrl.replace(/\/$/, "")}/reset-password/${rawToken}`;
}

function mailFromAddress(fromAddress: string) {
  return `TBBT <${fromAddress}>`;
}

export function isValidResetTokenShape(token: string) {
  return /^[0-9a-f]{64}$/i.test(token.trim());
}

async function invalidateUnusedResetTokens(
  db: Db,
  userId: string,
  usedAt: Date,
) {
  await db.passwordResetToken.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt },
  });
}

/**
 * Public request. Always returns the same message for unknown emails,
 * missing mail config, cooldown, and successful send so the UI cannot
 * enumerate accounts. When mail is not configured, no token is stored
 * and an operational error is logged.
 */
export async function requestPasswordResetOp(
  db: PrismaClient,
  emailInput: string,
  mailer: PasswordResetMailer = defaultMailer,
  now = new Date(),
): Promise<PasswordResetRequestResult> {
  const email = normalizeEmail(emailInput);
  if (!email || !isUsableEmail(email)) {
    return { message: "Enter a valid email address.", outcome: "invalid-email" };
  }

  const user = await db.user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (!user) {
    return { message: PASSWORD_RESET_REQUEST_MESSAGE, outcome: "unknown-email" };
  }

  const mailConfig = mailer.getMailConfig();
  const appUrl =
    "error" in mailConfig ? mailer.getAppUrl() : mailConfig.appUrl;

  if ("error" in mailConfig || !appUrl) {
    const reason = "error" in mailConfig
      ? mailConfig.error
      : "The app URL is not configured";
    mailer.logError?.(
      `Password reset email skipped: ${reason}`,
    );
    return {
      message: PASSWORD_RESET_REQUEST_MESSAGE,
      outcome: "error" in mailConfig ? "mail-unconfigured" : "app-url-unconfigured",
    };
  }

  const latest = await db.passwordResetToken.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, usedAt: true },
  });

  if (
    latest &&
    !latest.usedAt &&
    now.getTime() - latest.createdAt.getTime() < PASSWORD_RESET_COOLDOWN_MS
  ) {
    return { message: PASSWORD_RESET_REQUEST_MESSAGE, outcome: "cooldown" };
  }

  const rawToken = createSecureToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(now.getTime() + PASSWORD_RESET_EXPIRY_MS);

  const token = await db.$transaction(async (tx) => {
    await invalidateUnusedResetTokens(tx, user.id, now);
    return tx.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
      },
    });
  });

  const emailContent = buildPasswordResetEmail({
    resetUrl: resetUrlForToken(appUrl, rawToken),
  });
  const sent = await mailer.sendTransactionalEmail({
    apiKey: (mailConfig as MailConfig).apiKey,
    from: mailFromAddress((mailConfig as MailConfig).fromAddress),
    to: email,
    subject: emailContent.subject,
    html: emailContent.html,
    text: emailContent.text,
    kind: "password-reset",
    idempotencyKey: passwordResetIdempotencyKey(user.id, token.id),
  });

  if (sent.error) {
    mailer.logError?.(sent.error);
    return { message: PASSWORD_RESET_REQUEST_MESSAGE, outcome: "send-failed" };
  }

  return { message: PASSWORD_RESET_REQUEST_MESSAGE, outcome: "sent" };
}

export async function lookupUsablePasswordResetToken(
  db: Db,
  rawToken: string,
  now = new Date(),
) {
  if (!isValidResetTokenShape(rawToken)) {
    return null;
  }

  const token = await db.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(rawToken.trim()) },
    select: {
      id: true,
      userId: true,
      usedAt: true,
      expiresAt: true,
    },
  });

  if (!token || token.usedAt || token.expiresAt <= now) {
    return null;
  }

  return token;
}

class PasswordResetTokenClaimError extends Error {
  constructor() {
    super(PASSWORD_RESET_TOKEN_ERROR);
    this.name = "PasswordResetTokenClaimError";
  }
}

export async function completePasswordResetOp(
  db: PrismaClient,
  input: { token: string; password: string; confirmPassword: string },
  now = new Date(),
): Promise<PasswordMutationResult> {
  const token = input.token.trim();
  const password = input.password;
  const confirmPassword = input.confirmPassword;

  if (!token || !isValidResetTokenShape(token)) {
    return { ok: false, error: PASSWORD_RESET_TOKEN_ERROR };
  }
  if (!password || password.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, error: "Password must be at least 8 characters." };
  }
  if (password !== confirmPassword) {
    return { ok: false, error: "Passwords do not match." };
  }

  const tokenHash = hashToken(token);
  const passwordHash = await hashPassword(password);

  try {
    const userId = await db.$transaction(async (tx) => {
      // Atomic claim: only one concurrent reset can flip this row.
      // usedAt IS NULL + expiresAt still in the future must both hold
      // at UPDATE time, not from a pre-transaction read.
      const claimed = await tx.passwordResetToken.updateMany({
        where: {
          tokenHash,
          usedAt: null,
          expiresAt: { gt: now },
        },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) {
        throw new PasswordResetTokenClaimError();
      }

      const resetToken = await tx.passwordResetToken.findUnique({
        where: { tokenHash },
        select: { userId: true },
      });
      if (!resetToken) {
        throw new PasswordResetTokenClaimError();
      }

      await tx.user.update({
        where: { id: resetToken.userId },
        data: { passwordHash },
      });
      await invalidateUnusedResetTokens(tx, resetToken.userId, now);
      // Forgot-password reset is an account-recovery event: any existing
      // session (including a stolen cookie) must die in the same
      // transaction. The server action may create one fresh session after
      // this returns. A failed claim never reaches this delete.
      await tx.session.deleteMany({
        where: { userId: resetToken.userId },
      });
      return resetToken.userId;
    });

    return { ok: true, userId };
  } catch (error) {
    if (error instanceof PasswordResetTokenClaimError) {
      return { ok: false, error: PASSWORD_RESET_TOKEN_ERROR };
    }
    throw error;
  }
}

export async function changeSignedInPasswordOp(
  db: PrismaClient,
  input: {
    userId: string;
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
  },
  now = new Date(),
): Promise<PasswordMutationResult> {
  const currentPassword = input.currentPassword;
  const newPassword = input.newPassword;
  const confirmPassword = input.confirmPassword;

  if (!currentPassword || !newPassword) {
    return { ok: false, error: "Current password and new password are required." };
  }
  if (newPassword.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, error: "Password must be at least 8 characters." };
  }
  if (newPassword !== confirmPassword) {
    return { ok: false, error: "Passwords do not match." };
  }

  const user = await db.user.findUnique({
    where: { id: input.userId },
    select: { id: true, passwordHash: true },
  });
  if (!user) {
    return { ok: false, error: "You need to sign in again." };
  }

  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    return { ok: false, error: "Current password is incorrect." };
  }

  const passwordHash = await hashPassword(newPassword);
  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });
    await invalidateUnusedResetTokens(tx, user.id, now);
  });

  return { ok: true, userId: user.id };
}
