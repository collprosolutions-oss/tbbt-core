export type NativeRecoveryError = {
  error: string;
  status?: number;
};

export type NativeRecoveryDecision = "session-expired" | "clear-record" | "keep-record";

export const NATIVE_JOB_NOT_AVAILABLE_MESSAGE = "That job is not available.";
export const NATIVE_WORKSPACE_UNAVAILABLE_MESSAGE = "That workspace is not available.";
export const NATIVE_ACCOUNT_UNASSIGNED_MESSAGE =
  "This account is not assigned to a business workspace.";
export const NATIVE_SIGN_IN_AGAIN_MESSAGE = "You need to sign in again.";
export const NATIVE_SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE =
  "This business needs an active TBBT subscription before operating records can be changed. Only the business owner can start or manage billing.";
export const NATIVE_OWN_ENTRY_FORBIDDEN_MESSAGE = "You do not have permission to do that.";

const WORKSPACE_UNAVAILABLE_MESSAGES = new Set([
  NATIVE_WORKSPACE_UNAVAILABLE_MESSAGE,
  NATIVE_ACCOUNT_UNASSIGNED_MESSAGE,
]);

const LOST_ASSIGNMENT_MESSAGES = new Set([
  NATIVE_JOB_NOT_AVAILABLE_MESSAGE,
  NATIVE_WORKSPACE_UNAVAILABLE_MESSAGE,
]);

export function isSessionExpired(error: NativeRecoveryError) {
  if (error.status === 401) return true;
  return error.status === 403 && WORKSPACE_UNAVAILABLE_MESSAGES.has(error.error);
}

export function isLostAssignment(error: NativeRecoveryError) {
  if (error.status === 404) return true;
  return error.status === 403 && LOST_ASSIGNMENT_MESSAGES.has(error.error);
}

export function nativeRecoveryDecision(error: NativeRecoveryError): NativeRecoveryDecision {
  if (isSessionExpired(error)) return "session-expired";
  if (isLostAssignment(error)) return "clear-record";
  return "keep-record";
}

export function applyLostAssignment<T>(
  current: T | null,
  error: NativeRecoveryError,
): T | null {
  if (nativeRecoveryDecision(error) === "clear-record") {
    return null;
  }
  return current;
}

export function nextNativeRequestGeneration(current: number) {
  return current + 1;
}

export function shouldApplyNativeResponse(
  latestGeneration: number,
  responseGeneration: number,
) {
  return latestGeneration === responseGeneration;
}
