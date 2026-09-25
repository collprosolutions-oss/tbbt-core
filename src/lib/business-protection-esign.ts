/**
 * Provider-neutral e-sign boundary.
 *
 * This PR does not connect a live e-sign provider and must not invent a
 * digital signature. Completion is recorded as external signing or a
 * manual signed-file upload.
 */

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

/**
 * Live provider credentials are out of scope. Always report NOT_CONNECTED
 * until a later PR wires a real provider.
 */
export function resolveEsignProviderStatus(): EsignProviderStatus {
  return "NOT_CONNECTED";
}

export function allowedCompletionModes(
  providerStatus: EsignProviderStatus = resolveEsignProviderStatus(),
): readonly EsignCompletionMode[] {
  if (providerStatus === "PROVIDER_READY") {
    return ["PROVIDER_READY", "EXTERNAL_SIGNATURE", "MANUAL_UPLOAD"];
  }
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
    return "PROVIDER_READY";
  }
  if (mode === "EXTERNAL_SIGNATURE" || mode === "MANUAL_UPLOAD") {
    return mode;
  }
  if (!mode) {
    return "EXTERNAL_SIGNATURE";
  }
  throw new EsignBoundaryError(
    "Choose external signature or a signed-file upload. Digital signing is not connected.",
  );
}
