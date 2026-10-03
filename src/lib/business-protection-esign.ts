/**
 * Provider-neutral e-sign boundary.
 *
 * Dropbox Sign is the connected adapter when DROPBOX_SIGN_API_KEY is set.
 * The fake adapter is local/script tests only. Form completion stays
 * external signature or manual upload — TBBT will not invent a digital
 * signature from a button click.
 */

import { isEsignProviderConfigured } from "@/lib/esign/config";

export const ESIGN_PROVIDER_STATUSES = ["NOT_CONNECTED", "PROVIDER_READY"] as const;
export type EsignProviderStatus = (typeof ESIGN_PROVIDER_STATUSES)[number];

export const ESIGN_COMPLETION_MODES = [
  "NOT_CONNECTED",
  "EXTERNAL_SIGNATURE",
  "MANUAL_UPLOAD",
  "PROVIDER_READY",
] as const;
export type EsignCompletionMode = (typeof ESIGN_COMPLETION_MODES)[number];

export const ESIGN_PROVIDER_NOT_CONNECTED_MESSAGE =
  "No e-sign provider is connected. You can record an external signature or upload a signed PDF. TBBT will not invent a digital signature.";

export const ESIGN_PROVIDER_READY_MESSAGE =
  "A connected e-sign adapter is available. Only the owner can send a locked agreement version. The signed file is bound to that exact business, agreement, and version after a verified webhook. Manual upload and external completion still work. TBBT will not invent a digital signature.";

export const ESIGN_WEBHOOK_ONLY_COMPLETION_MESSAGE =
  "Provider completion arrives through a verified webhook bound to the sent version. TBBT will not invent a digital signature from this form.";

export const ESIGN_SEND_OUTCOME_UNKNOWN_MESSAGE =
  "The e-sign send outcome is unknown. Check Dropbox Sign before sending again. TBBT did not invent a signature.";

export const ESIGN_SEND_IN_PROGRESS_MESSAGE =
  "This locked version already has an e-sign send in progress. The outcome may be unknown — check Dropbox Sign. Cancel the stuck send if it is stale.";

export const ESIGN_CANCEL_STUCK_SEND_WARNING =
  "Check Dropbox Sign first. This only clears a stuck local send claim. It does not cancel a live signature request.";

export const ESIGN_STALE_SEND_NOT_READY_MESSAGE =
  "That e-sign send is still in progress. Wait before canceling, and check Dropbox Sign first.";

export const ESIGN_RECONCILE_OUTCOME_UNKNOWN_MESSAGE =
  "The provider could not be fully checked. Check Dropbox Sign directly and retry this lookup. TBBT did not invent a signature.";

export const ESIGN_RECONCILE_REQUEST_ID_NOT_FOUND_MESSAGE =
  "That request id was not found. Check Dropbox Sign directly and retry this lookup. TBBT did not invent a signature.";

export const ESIGN_RECONCILE_MISSING_MESSAGE =
  "No provider signature request was found for this send. You can cancel the stuck send when it is stale. TBBT did not invent a signature.";

export const ESIGN_RECONCILE_BOUND_MESSAGE =
  "A provider signature request was found and bound to this exact business, agreement, and version. TBBT did not invent a signature.";

export const ESIGN_RECONCILE_REUSED_MESSAGE =
  "This locked version already has an e-sign request. TBBT did not invent a signature.";

export const ESIGN_RECONCILE_REQUEST_MISMATCH_MESSAGE =
  "That signature request is not bound to this exact business, agreement, and version.";

export const ESIGN_RECONCILE_NOT_STUCK_MESSAGE =
  "That agreement does not have a stuck e-sign send claim.";

export const ESIGN_STALE_SEND_MINUTES = 15;

export class EsignBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EsignBoundaryError";
  }
}

export function isEsignProviderStatus(value: string): value is EsignProviderStatus {
  return (ESIGN_PROVIDER_STATUSES as readonly string[]).includes(value);
}

export function isEsignCompletionMode(value: string): value is EsignCompletionMode {
  return (ESIGN_COMPLETION_MODES as readonly string[]).includes(value);
}

export function resolveEsignProviderStatus(): EsignProviderStatus {
  return isEsignProviderConfigured() ? "PROVIDER_READY" : "NOT_CONNECTED";
}

export function esignProviderMessage(
  providerStatus: EsignProviderStatus = resolveEsignProviderStatus(),
) {
  return providerStatus === "PROVIDER_READY"
    ? ESIGN_PROVIDER_READY_MESSAGE
    : ESIGN_PROVIDER_NOT_CONNECTED_MESSAGE;
}

export function allowedCompletionModes(
  _providerStatus: EsignProviderStatus = resolveEsignProviderStatus(),
): readonly EsignCompletionMode[] {
  return ["EXTERNAL_SIGNATURE", "MANUAL_UPLOAD"];
}

export function canApplyDigitalSignature(
  providerStatus: EsignProviderStatus = resolveEsignProviderStatus(),
): boolean {
  return providerStatus === "PROVIDER_READY";
}

export function assertDigitalSignatureAllowed(
  providerStatus: EsignProviderStatus = resolveEsignProviderStatus(),
): void {
  if (!canApplyDigitalSignature(providerStatus)) {
    throw new EsignBoundaryError(
      "No e-sign provider is connected. TBBT will not invent a digital signature.",
    );
  }
}

export function normalizeCompletionMode(
  requested: string | null | undefined,
  providerStatus: EsignProviderStatus = resolveEsignProviderStatus(),
): Exclude<EsignCompletionMode, "NOT_CONNECTED" | "PROVIDER_READY"> | "PROVIDER_READY" {
  const mode = (requested ?? "").trim();
  if (mode === "PROVIDER_READY") {
    assertDigitalSignatureAllowed(providerStatus);
    throw new EsignBoundaryError(ESIGN_WEBHOOK_ONLY_COMPLETION_MESSAGE);
  }
  if (mode === "EXTERNAL_SIGNATURE" || mode === "MANUAL_UPLOAD") {
    return mode;
  }
  if (!mode) {
    return "EXTERNAL_SIGNATURE";
  }
  throw new EsignBoundaryError(
    "Choose external signature or a signed-file upload. Digital signing is not invented here.",
  );
}
