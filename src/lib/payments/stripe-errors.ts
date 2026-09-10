/**
 * Stripe Connect onboarding errors, without leaking secrets or account ids.
 *
 * v1 Account Links use `resource_missing`. v2 `core/account_links` uses
 * HTTP 404 `not_found`. Test/live mismatches often keep `resource_missing`
 * but put "similar object exists in test mode" in the message. Matching
 * only `resource_missing` / "unknown connected account" swallows the
 * production failure into "Stripe onboarding could not be started."
 */

const SECRET_SHAPED =
  /\b(?:acct|sk_live|sk_test|pk_live|pk_test|rk_live|rk_test|whsec)_[A-Za-z0-9]+\b/g;
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

export type StripeErrorSummary = {
  type: string | null;
  code: string | null;
  statusCode: number | null;
  requestId: string | null;
  param: string | null;
};

export function redactStripeText(value: string) {
  return value.replace(SECRET_SHAPED, "[redacted]").replace(EMAIL_SHAPED, "[redacted]");
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function summarizeStripeError(error: unknown): StripeErrorSummary {
  if (!error || typeof error !== "object") {
    return { type: null, code: null, statusCode: null, requestId: null, param: null };
  }
  const record = error as {
    type?: unknown;
    name?: unknown;
    code?: unknown;
    statusCode?: unknown;
    requestId?: unknown;
    param?: unknown;
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
  };
}

export function isUnknownConnectedAccountError(error: unknown): boolean {
  const summary = summarizeStripeError(error);
  if (summary.code && STALE_ACCOUNT_CODES.has(summary.code)) {
    return true;
  }
  if (summary.statusCode === 404 && summary.param === "account") {
    return true;
  }
  const message = error instanceof Error ? error.message : "";
  const lower = message.toLowerCase();
  return (
    /unknown connected account/i.test(message) ||
    /no such account/i.test(lower) ||
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
  const code = summary.code || summary.type;
  if (!code) {
    return "Stripe onboarding could not be started.";
  }
  return `Stripe onboarding could not be started. (${redactStripeText(code)})`;
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
      ...extra,
    }),
  );
}
