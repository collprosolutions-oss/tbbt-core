import { ForbiddenError } from "@/lib/authorization";
import { isRequestPathSchemaUnavailableError } from "@/lib/request-path-schema";
import {
  GUSTO_COMPANY_IN_USE_MESSAGE,
  GUSTO_NEEDS_RECONNECT_MESSAGE,
  GUSTO_NOT_AVAILABLE_MESSAGE,
  GUSTO_NOT_CONNECTED_MESSAGE,
  GUSTO_PROVIDER_MESSAGE,
  GUSTO_STATE_INVALID_MESSAGE,
} from "@/lib/payroll-connect/copy";

export const PAYROLL_CONNECT_ERROR_CODES = [
  "NOT_AVAILABLE",
  "STATE_INVALID",
  "NEEDS_RECONNECT",
  "NOT_CONNECTED",
  "COMPANY_IN_USE",
  "INVALID_GRANT",
  "PROVIDER",
] as const;

export type PayrollConnectErrorCode = (typeof PAYROLL_CONNECT_ERROR_CODES)[number];

const MESSAGES: Record<PayrollConnectErrorCode, string> = {
  NOT_AVAILABLE: GUSTO_NOT_AVAILABLE_MESSAGE,
  STATE_INVALID: GUSTO_STATE_INVALID_MESSAGE,
  NEEDS_RECONNECT: GUSTO_NEEDS_RECONNECT_MESSAGE,
  NOT_CONNECTED: GUSTO_NOT_CONNECTED_MESSAGE,
  COMPANY_IN_USE: GUSTO_COMPANY_IN_USE_MESSAGE,
  INVALID_GRANT: GUSTO_NEEDS_RECONNECT_MESSAGE,
  PROVIDER: GUSTO_PROVIDER_MESSAGE,
};

export class PayrollConnectError extends Error {
  readonly code: PayrollConnectErrorCode;

  constructor(code: PayrollConnectErrorCode) {
    super(MESSAGES[code]);
    this.name = "PayrollConnectError";
    this.code = code;
  }
}

export function isInvalidGrantError(error: unknown) {
  return error instanceof PayrollConnectError && error.code === "INVALID_GRANT";
}

/**
 * A lost refresh race keeps the connection when the stored ciphertext
 * changed while this attempt was in flight. The same ciphertext means
 * the saved refresh token itself was rejected.
 */
export function shouldKeepConnectionAfterInvalidGrant(beforeCiphertext: string, afterCiphertext: string | null) {
  return Boolean(afterCiphertext) && afterCiphertext !== beforeCiphertext;
}

export function payrollConnectPublicMessage(error: unknown) {
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  if (error instanceof PayrollConnectError) return error.message;
  if (isRequestPathSchemaUnavailableError(error)) {
    return "Payroll provider tables are not applied. Request paths do not create them.";
  }
  return "Could not update the payroll connection.";
}

export function payrollConnectRedirectCode(error: unknown) {
  if (error instanceof ForbiddenError) return "forbidden";
  if (error instanceof PayrollConnectError) {
    if (error.code === "NOT_AVAILABLE") return "unavailable";
    if (error.code === "STATE_INVALID") return "state";
    if (error.code === "COMPANY_IN_USE") return "company";
    if (error.code === "NEEDS_RECONNECT" || error.code === "INVALID_GRANT") return "reconnect";
  }
  return "failed";
}
