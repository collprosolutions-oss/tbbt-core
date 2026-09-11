/**
 * Stripe Connect onboarding errors, without leaking secrets or account ids.
 *
 * v1 Account Links use `resource_missing`. v2 `core/account_links` uses
 * HTTP 404 `not_found`. Live Workbench also returns HTTP 400 with no
 * machine code: "You requested an account link for an account that is not
 * connected to your platform or does not exist." That is a stale stored
 * connected-account id, not a platform permission failure.
 */

const SECRET_SHAPED =
  /\b(?:acct|sk_live|sk_test|pk_live|pk_test|rk_live|rk_test|whsec)_[A-Za-z0-9_]+\b/g;
const EMAIL_SHAPED = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g;

const STALE_ACCOUNT_CODES = new Set([
  "resource_missing",
  "not_found",
  "account_invalid",
]);

const V1_ACCOUNT_LINK_FALLBACK_CODES = new Set([
  "forbidden",
  "accounts_v2_access_blocked",
]);

const REDACTED_MESSAGE_MAX_LENGTH = 240;

export type StripeErrorSummary = {
  type: string | null;
  code: string | null;
  statusCode: number | null;
  requestId: string | null;
  param: string | null;
  rawType: string | null;
};

export function redactStripeText(value: string) {
  return value.replace(SECRET_SHAPED, "[redacted]").replace(EMAIL_SHAPED, "[redacted]");
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function redactedStripeErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const record = error as { message?: unknown; raw?: { message?: unknown } };
  const message = readString(record.message) ?? readString(record.raw?.message);
  if (!message) {
    return null;
  }
  const redacted = redactStripeText(message);
  if (redacted.length <= REDACTED_MESSAGE_MAX_LENGTH) {
    return redacted;
  }
  return `${redacted.slice(0, REDACTED_MESSAGE_MAX_LENGTH)}…`;
}

export function summarizeStripeError(error: unknown): StripeErrorSummary {
  if (!error || typeof error !== "object") {
    return {
      type: null,
      code: null,
      statusCode: null,
      requestId: null,
      param: null,
      rawType: null,
    };
  }
  const record = error as {
    type?: unknown;
    name?: unknown;
    code?: unknown;
    statusCode?: unknown;
    requestId?: unknown;
    param?: unknown;
    rawType?: unknown;
    raw?: { type?: unknown; code?: unknown; param?: unknown };
  };
  const statusCode =
    typeof record.statusCode === "number" && Number.isFinite(record.statusCode)
      ? record.statusCode
      : null;
  return {
    type: readString(record.type) ?? readString(record.name),
    code: readString(record.code) ?? readString(record.raw?.code),
    statusCode,
    requestId: readString(record.requestId),
    param: readString(record.param) ?? readString(record.raw?.param),
    rawType: readString(record.rawType) ?? readString(record.raw?.type),
  };
}

/**
 * Owner-safe Stripe identifier. When Stripe omits `code`, include type,
 * param, and HTTP status so the UI is not only the SDK class name.
 */
export function stripeConnectOnboardingFailureIdentifier(error: unknown): string | null {
  const summary = summarizeStripeError(error);
  if (summary.code) {
    return redactStripeText(summary.code);
  }
  const parts: string[] = [];
  if (summary.type) {
    parts.push(redactStripeText(summary.type));
  }
  if (summary.param) {
    parts.push(`param=${redactStripeText(summary.param)}`);
  }
  if (summary.statusCode != null) {
    parts.push(`status=${summary.statusCode}`);
  }
  return parts.length > 0 ? parts.join(" / ") : null;
}

function stripeErrorMessageText(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (error && typeof error === "object") {
    const record = error as { raw?: { message?: unknown } };
    return readString(record.raw?.message) ?? "";
  }
  return "";
}

export function isUnknownConnectedAccountError(error: unknown): boolean {
  const summary = summarizeStripeError(error);
  if (summary.code && STALE_ACCOUNT_CODES.has(summary.code)) {
    return true;
  }
  if (summary.statusCode === 404 && summary.param === "account") {
    return true;
  }
  const message = stripeErrorMessageText(error);
  const lower = message.toLowerCase();
  return (
    /unknown connected account/i.test(message) ||
    /no such account/i.test(lower) ||
    /not connected to your platform or does not exist/i.test(lower) ||
    /similar object exists in (?:test|live) mode/i.test(lower) ||
    /live mode key was used/i.test(lower) ||
    /test mode key was used/i.test(lower)
  );
}

/**
 * v2 POST /v2/core/account_links requires Accounts v2 enrollment on the
 * platform. A live Connect platform that is not in that preview returns
 * 403 `forbidden` (StripePermissionError) or 400 `accounts_v2_access_blocked`.
 * That is a platform-key/config failure, not a stale connected-account id.
 * GA Connect onboarding is POST /v1/account_links.
 */
export function shouldFallBackToV1AccountLink(error: unknown): boolean {
  const summary = summarizeStripeError(error);
  if (summary.code && V1_ACCOUNT_LINK_FALLBACK_CODES.has(summary.code)) {
    return true;
  }
  if (summary.statusCode === 403) {
    return true;
  }
  return summary.type === "StripePermissionError";
}

export function stripeConnectOnboardingFailureMessage(error: unknown): string {
  const summary = summarizeStripeError(error);
  if (summary.code === "accounts_v2_access_blocked") {
    return "Stripe Connect Accounts v2 is not enabled on this platform. Enable Accounts v2 in the Stripe Dashboard, then try Continue Stripe Setup again.";
  }
  if (summary.code === "forbidden" || summary.type === "StripePermissionError") {
    return "The live Stripe platform key is not allowed to create Connect onboarding links. In the CrewClock Stripe Dashboard (live mode), enable Connect and use the full platform secret key — not a restricted key or a connected-account key.";
  }
  if (summary.code === "configs_must_match_to_use_account_links") {
    return "Stripe could not create an Account Link for this connected account. The stored account's configuration does not match Connect onboarding.";
  }
  const identifier = stripeConnectOnboardingFailureIdentifier(error);
  if (!identifier) {
    return "Stripe onboarding could not be started.";
  }
  return `Stripe onboarding could not be started. (${identifier})`;
}

export function logStripeConnectOnboardingError(
  error: unknown,
  extra: Record<string, string | number | boolean | null> = {},
) {
  const summary = summarizeStripeError(error);
  console.info(
    "[payments] connect onboarding",
    JSON.stringify({
      type: summary.type,
      code: summary.code,
      statusCode: summary.statusCode,
      requestId: summary.requestId,
      param: summary.param,
      rawType: summary.rawType,
      message: redactedStripeErrorMessage(error),
      ...extra,
    }),
  );
}
