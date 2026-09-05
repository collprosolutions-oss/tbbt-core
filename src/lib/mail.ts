import { Resend } from "resend";

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
  if (!host || host.includes("/") || host.includes("@") || host.includes(":")) {
    return null;
  }
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.vercel\.app$/i.test(host)) {
    return null;
  }
  return parseAppUrl(`https://${host}`);
}

/**
 * The app's own base URL, independent of whether transactional email
 * (Resend) is configured. Used to build absolute links a page hands
 * directly to the user to copy/share -- e.g. the one-time team-member
 * password-setup link in src/app/actions/team.ts -- which must keep
 * working even when RESEND_API_KEY/EMAIL_FROM are unset.
 *
 * Resolution order:
 *   1. NEXT_PUBLIC_APP_URL when explicitly set (production:
 *      https://www.collproreno.com).
 *   2. Trusted Vercel preview/dev deployment host when that env is
 *      absent, so Team setup links work on preview without writing a
 *      preview hostname into source.
 * Never uses the request Host header.
 */
export function getAppUrl(): string | null {
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return parseAppUrl(process.env.NEXT_PUBLIC_APP_URL);
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

export function isUsableEmail(value: string | null | undefined) {
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

export type TransactionalEmailKind = "estimate" | "invoice" | "team";

export function transactionalEmailFailureMessage(kind: TransactionalEmailKind) {
  if (kind === "estimate") {
    return "The estimate email could not be sent.";
  }
  if (kind === "invoice") {
    return "The invoice email could not be sent.";
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
}) {
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
