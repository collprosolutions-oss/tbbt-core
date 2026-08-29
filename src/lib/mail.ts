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
 * The app's own base URL, independent of whether transactional email
 * (Resend) is configured. Used to build absolute links a page hands
 * directly to the user to copy/share -- e.g. the one-time team-member
 * password-setup link in src/app/actions/team.ts -- which must keep
 * working even when RESEND_API_KEY/EMAIL_FROM are unset.
 */
export function getAppUrl(): string | null {
  return process.env.NEXT_PUBLIC_APP_URL
    ? parseAppUrl(process.env.NEXT_PUBLIC_APP_URL)
    : null;
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

export async function sendTransactionalEmail(input: {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
}) {
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
      return { error: "The estimate email could not be sent." };
    }

    return { id: data?.id };
  } catch {
    return { error: "The estimate email could not be sent." };
  }
}
