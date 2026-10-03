/**
 * Verified Resend delivery webhook. Resend POSTs have no TBBT session
 * cookie; the auth proxy must not redirect them to sign-in. The route
 * verifies Svix signatures before any write.
 */
export const MAIL_WEBHOOK_PATH = "/api/mail/webhook";
export const RESEND_MAIL_PROVIDER = "resend";

export function isMailWebhookPath(pathname: string) {
  return pathname === MAIL_WEBHOOK_PATH;
}

export function getResendWebhookSecret(): string | null {
  const value = process.env.RESEND_WEBHOOK_SECRET?.trim();
  return value || null;
}
