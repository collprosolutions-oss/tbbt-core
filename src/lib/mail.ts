import { Resend } from "resend";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isTrustedVercelAppHost } from "@/lib/vercel-app-host";
import {
  createFakeTransactionalEmailSender,
  isFakeEmailAdapterEnabled,
  type FakeTransactionalEmailInput,
} from "@/lib/mail-fake";
import {
  blockedOutboundEmailReason,
  type OutboundEmailSuppression,
} from "@/lib/mail-outbound-suppression";

export { isFakeEmailAdapterEnabled } from "@/lib/mail-fake";

/**
 * Call-site inventory for sendTransactionalEmail (the only provider send).
 *
 * Customer-facing — purpose "customer" or "automation", businessId required,
 * bounce/complaint suppression enforced immediately before the provider:
 * - src/lib/communications/engine.ts          compose / customer
 * - src/app/actions/estimate.ts               estimate send
 * - src/lib/complete-job-invoice.ts           invoice notify
 * - src/lib/reviews-ops.ts                    review request + review reminder
 * - src/lib/appointment-notify.ts             appointment proposed / notify
 * - src/lib/referral-ops.ts                   referral request + follow-up
 * - src/lib/automation/email.ts               every automation kind
 *
 * Non-customer system mail — explicit exempt purpose, suppression skipped
 * by design (a static test distinguishes these from customer purposes):
 * - src/app/actions/team.ts                   system-exempt-team
 * - src/lib/password-reset.ts                 system-exempt-password-reset
 * - src/lib/request-notify.ts                 system-exempt-request-notify
 */
export const CUSTOMER_EMAIL_PURPOSES = ["customer", "automation"] as const;
export const SYSTEM_EXEMPT_EMAIL_PURPOSES = [
  "system-exempt-team",
  "system-exempt-password-reset",
  "system-exempt-request-notify",
] as const;

export type CustomerEmailPurpose = (typeof CUSTOMER_EMAIL_PURPOSES)[number];
export type SystemExemptEmailPurpose = (typeof SYSTEM_EXEMPT_EMAIL_PURPOSES)[number];
export type TransactionalEmailPurpose = CustomerEmailPurpose | SystemExemptEmailPurpose;

export function isCustomerEmailPurpose(
  purpose: string | null | undefined,
): purpose is CustomerEmailPurpose {
  return (CUSTOMER_EMAIL_PURPOSES as readonly string[]).includes(purpose ?? "");
}

export function isSystemExemptEmailPurpose(
  purpose: string | null | undefined,
): purpose is SystemExemptEmailPurpose {
  return (SYSTEM_EXEMPT_EMAIL_PURPOSES as readonly string[]).includes(purpose ?? "");
}

export type TransactionalEmailSuppressedResult = {
  suppressed: true;
  reason: OutboundEmailSuppression["reason"];
  message: string;
};

export type TransactionalEmailSendResult =
  | { id?: string }
  | { error: string }
  | TransactionalEmailSuppressedResult;

export function isTransactionalEmailSuppressed(
  result: TransactionalEmailSendResult,
): result is TransactionalEmailSuppressedResult {
  return "suppressed" in result && result.suppressed === true;
}

export function transactionalEmailSendError(
  result: TransactionalEmailSendResult,
): string | undefined {
  if (isTransactionalEmailSuppressed(result)) return result.message;
  if ("error" in result) return result.error;
  return undefined;
}

export function customerEmailAttemptStatus(
  result: TransactionalEmailSendResult,
): "SENT" | "FAILED" | "SUPPRESSED" {
  if (isTransactionalEmailSuppressed(result)) return "SUPPRESSED";
  if ("error" in result && result.error) return "FAILED";
  return "SENT";
}

type TransactionalEmailSender = (
  input: FakeTransactionalEmailInput,
) => Promise<TransactionalEmailSendResult>;

const defaultFakeEmailSender = createFakeTransactionalEmailSender();
let injectedEmailSender: TransactionalEmailSender | null = null;

export function setTransactionalEmailSender(sender: TransactionalEmailSender | null) {
  injectedEmailSender = sender;
}

export function resetTransactionalEmailSender() {
  injectedEmailSender = null;
  defaultFakeEmailSender.sent.length = 0;
  defaultFakeEmailSender.failNext = false;
  defaultFakeEmailSender.throwNext = false;
}

export function getFakeTransactionalEmailSender() {
  return defaultFakeEmailSender;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type MailConfig = {
  apiKey: string;
  fromAddress: string;
  appUrl: string;
};

function parseFromAddress(value: string) {
  const trimmed = value.trim();
  const angled = trimmed.match(/<([^>]+)>/);
  const address = (angled ? angled[1] : trimmed).trim();
  if (!EMAIL_PATTERN.test(address)) {
    return null;
  }
  return address;
}

function parseAppUrl(value: string) {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

/**
 * Vercel sets VERCEL_URL / VERCEL_BRANCH_URL as hostnames (no protocol)
 * for the current deployment. These are platform-supplied, not request
 * Host headers. Only honor them on preview/dev, and only when the host
 * is a vercel.app deployment hostname -- never an arbitrary origin.
 */
function vercelPreviewOrigin(): string | null {
  const env = process.env.VERCEL_ENV;
  if (env !== "preview" && env !== "development") {
    return null;
  }
  const host = (process.env.VERCEL_BRANCH_URL || process.env.VERCEL_URL || "").trim();
  if (!isTrustedVercelAppHost(host)) {
    return null;
  }
  return parseAppUrl(`https://${host}`);
}

export const PRODUCTION_APP_ORIGIN = "https://www.collproreno.com";

/**
 * The app's own base URL, independent of whether transactional email
 * (Resend) is configured. Used to build absolute links a page hands
 * directly to the user to copy/share -- e.g. the one-time team-member
 * password-setup link in src/app/actions/team.ts -- which must keep
 * working even when RESEND_API_KEY/EMAIL_FROM are unset.
 *
 * Resolution order:
 *   1. NEXT_PUBLIC_APP_URL when explicitly set.
 *   2. Canonical production origin on Vercel production
 *      (https://www.collproreno.com) so Connect return URLs and Checkout
 *      success/cancel links work even if that env is missing.
 *   3. Trusted Vercel preview/dev deployment host when that env is
 *      absent, so Team setup links work on preview without writing a
 *      preview hostname into source.
 * Never uses the request Host header. Never adopts a Vercel production
 * deployment hostname.
 */
export function getAppUrl(): string | null {
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return parseAppUrl(process.env.NEXT_PUBLIC_APP_URL);
  }
  if (process.env.VERCEL_ENV === "production") {
    return PRODUCTION_APP_ORIGIN;
  }
  return vercelPreviewOrigin();
}

export function getMailConfig(): MailConfig | { error: string } {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const fromAddress = process.env.EMAIL_FROM
    ? parseFromAddress(process.env.EMAIL_FROM)
    : null;
  const appUrl = getAppUrl();

  if (!apiKey || !fromAddress || !appUrl) {
    return { error: "Email delivery is not configured" };
  }

  return { apiKey, fromAddress, appUrl };
}

export function senderFrom(businessName: string, fromAddress: string) {
  const display = businessName.replace(/[\r\n<>]/g, " ").trim() || "Estimate";
  return `${display} <${fromAddress}>`;
}

export function isUsableEmail(value: string | null | undefined): value is string {
  return Boolean(value && EMAIL_PATTERN.test(value.trim()));
}

const SEND_ATTEMPT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isMailSendAttemptId(value: string) {
  return SEND_ATTEMPT_ID_PATTERN.test(value);
}

/**
 * Estimate Email can be clicked again on purpose (customer lost the
 * message). Each owner click supplies a sendAttemptId; React/server-action
 * retries resubmit the same FormData, so the key stays stable for that
 * click. A later intentional click uses a new attempt id.
 */
export function estimateEmailIdempotencyKey(
  estimateId: string,
  sendAttemptId: string,
) {
  return `estimate-ready/${estimateId}/${sendAttemptId}`;
}

/**
 * Team invite email is sent once when a brand-new member is created.
 * There is no resend-invite action. Retrying the same add uses the same
 * business + email key.
 */
export function teamInviteIdempotencyKey(businessId: string, email: string) {
  return `team-invite/${businessId}/${email.trim().toLowerCase()}`;
}

/** Invoice notify is attempted once on the DRAFT → SENT flip. */
export function invoiceReadyIdempotencyKey(invoiceId: string) {
  return `invoice-ready/${invoiceId}`;
}

/**
 * Company notification for a new public service request. One send per
 * request id so public-form retries with the same submission do not
 * mail the business twice.
 */
export function newRequestCompanyEmailIdempotencyKey(requestId: string) {
  return `new-request/${requestId}`;
}

/**
 * Appointment proposal/reschedule email. Automatic send uses attempt
 * "auto" for that proposal. Owner retry supplies a new sendAttemptId.
 */
export function appointmentProposedEmailIdempotencyKey(
  jobId: string,
  proposalId: number,
  sendAttemptId: string,
) {
  return `appointment-proposed/${jobId}/${proposalId}/${sendAttemptId}`;
}

export type TransactionalEmailKind =
  | "estimate"
  | "invoice"
  | "team"
  | "appointment"
  | "request"
  | "password-reset"
  | "review"
  | "referral"
  | "follow-up"
  | "customer";

/**
 * Password-reset mail is sent once per issued token. The key is the
 * token row id (not the raw token, not the email) so a later request
 * that replaces the unused token is a new send.
 */
export function passwordResetIdempotencyKey(userId: string, tokenId: string) {
  return `password-reset/${userId}/${tokenId}`;
}

export function reviewRequestEmailIdempotencyKey(reviewRequestId: string, attemptKey = "sent") {
  return `review-request/${reviewRequestId}/${attemptKey}`;
}

export function referralRequestEmailIdempotencyKey(referralRequestId: string, attemptKey = "sent") {
  return `referral-request/${referralRequestId}/${attemptKey}`;
}

export function followUpEmailIdempotencyKey(followUpId: string, attemptKey = "sent") {
  return `customer-follow-up/${followUpId}/${attemptKey}`;
}

export function transactionalEmailFailureMessage(kind: TransactionalEmailKind) {
  if (kind === "estimate") {
    return "The estimate email could not be sent.";
  }
  if (kind === "invoice") {
    return "The invoice email could not be sent.";
  }
  if (kind === "appointment") {
    return "The appointment email could not be sent.";
  }
  if (kind === "request") {
    return "The new-request email could not be sent.";
  }
  if (kind === "password-reset") {
    return "The password reset email could not be sent.";
  }
  if (kind === "review") {
    return "The review request email could not be sent.";
  }
  if (kind === "referral") {
    return "The referral request email could not be sent.";
  }
  if (kind === "follow-up") {
    return "The follow-up email could not be sent.";
  }
  if (kind === "customer") {
    return "The customer email could not be sent.";
  }
  return "The team invitation email could not be sent.";
}

export async function sendTransactionalEmail(input: {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
  kind: TransactionalEmailKind;
  purpose: TransactionalEmailPurpose;
  businessId?: string;
  db?: PrismaClient | Prisma.TransactionClient;
}): Promise<TransactionalEmailSendResult> {
  if (isCustomerEmailPurpose(input.purpose)) {
    const db = input.db ?? prisma;
    const blocked = await blockedOutboundEmailReason(db, input.businessId ?? "", input.to);
    if (blocked) {
      return {
        suppressed: true,
        reason: blocked.reason,
        message: blocked.message,
      };
    }
  }

  const providerInput: FakeTransactionalEmailInput = {
    apiKey: input.apiKey,
    from: input.from,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
    idempotencyKey: input.idempotencyKey,
    kind: input.kind,
    purpose: input.purpose,
    businessId: input.businessId ?? "",
  };

  if (injectedEmailSender) {
    return injectedEmailSender(providerInput);
  }
  if (isFakeEmailAdapterEnabled()) {
    return defaultFakeEmailSender.send(providerInput);
  }

  const failure = transactionalEmailFailureMessage(input.kind);
  try {
    const resend = new Resend(input.apiKey);
    const { data, error } = await resend.emails.send(
      {
        from: input.from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
      },
      { idempotencyKey: input.idempotencyKey },
    );

    if (error) {
      return { error: failure };
    }

    return { id: data?.id };
  } catch {
    return { error: failure };
  }
}
