/**
 * Owner-facing copy for the Gusto payroll-fact connection.
 * Strings stay here so the page and the verifier share one wording.
 * They never include a token, a client secret, or a derived net pay.
 */

export const GUSTO_PROVIDER = "gusto" as const;

export const GUSTO_NOT_AVAILABLE_HEADLINE =
  "Not available: awaiting Gusto partner approval/credentials";

export const GUSTO_CONNECTED_HEADLINE = "Connected";

export const GUSTO_NEEDS_RECONNECT_HEADLINE = "Needs reconnect";

export const GUSTO_NOT_CONNECTED_HEADLINE = "Not connected";

export const GUSTO_DISCONNECTED_HEADLINE = "Disconnected";

export const GUSTO_REQUIRED_ENV_NAMES = [
  "GUSTO_CLIENT_ID",
  "GUSTO_CLIENT_SECRET",
  "GUSTO_ENV",
  "GUSTO_REDIRECT_URI",
  "CONNECTION_TOKEN_ENCRYPTION_KEY",
] as const;

export const GUSTO_PARTNER_NOTE =
  "Gusto production access is limited to approved App Integration or Embedded Payroll partners: production pre-approval, a security review, and QA. Scopes are assigned at review. An individual customer connecting their own company directly is not supported. Demo credentials can be used for a demo company. Connected appears only after token exchange and token info succeed.";

export const GUSTO_FACTS_NOTE =
  "These rows are payroll facts Gusto reported. They are not verified bank movement, not a TBBT payroll run, and not net pay. TBBT does not run payroll or move funds.";

export const GUSTO_DISCONNECT_NOTE =
  "Disconnect removes the encrypted tokens stored in TBBT and keeps imported facts. Gusto does not document a revoke endpoint, so this does not revoke access at Gusto.";

export const GUSTO_COMPANY_EXCLUSIVITY_NOTE =
  "One Gusto company can be actively connected to only one TBBT business. Refresh tokens are single-use, so sharing a company would invalidate the other business.";

export const GUSTO_RUN_OVERLAP_NOTE =
  "Recorded TBBT payroll run overlaps these dates. This is not a match and not a bank withdrawal.";

export const GUSTO_FACT_CHANGED_NOTE =
  "Gusto changed the reported amounts after review. This fact is unreviewed again.";

/**
 * Every Gusto HTTP call aborts at this deadline. It stays under the 20s
 * refresh transaction so a slow response cannot rotate a single-use refresh
 * token and then lose the new pair when the transaction times out.
 */
export const GUSTO_HTTP_TIMEOUT_MS = 8_000;

export const GUSTO_NEEDS_RECONNECT_MESSAGE =
  "Gusto rejected the saved token. Reconnect is required.";

export const GUSTO_NOT_AVAILABLE_MESSAGE = GUSTO_NOT_AVAILABLE_HEADLINE;

export const GUSTO_COMPANY_IN_USE_MESSAGE =
  "That Gusto company is already connected to another business.";

export const GUSTO_STATE_INVALID_MESSAGE =
  "That connection attempt is expired, already used, or not for this owner.";

export const GUSTO_PROVIDER_MESSAGE = "Payroll provider could not be reached.";

export const GUSTO_NOT_CONNECTED_MESSAGE = "No connected payroll provider.";

export const GUSTO_SCOPES = "payrolls:read employees:read";

/**
 * Documented App Integrations API version on the current payroll reference.
 * https://docs.gusto.com/app-integrations/reference/get-v1-companies-company_id-payrolls
 */
export const GUSTO_API_VERSION = "2026-06-15";

export const GUSTO_DEMO_HOST = "https://api.gusto-demo.com";
export const GUSTO_PRODUCTION_HOST = "https://api.gusto.com";

export const GUSTO_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** Gusto recommends refreshing 60 seconds before the access token expiry. */
export const GUSTO_ACCESS_TOKEN_SKEW_SECONDS = 60;
