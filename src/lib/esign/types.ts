export const ESIGN_METADATA_KEYS = {
  businessId: "businessId",
  agreementId: "agreementId",
  versionId: "versionId",
  attemptKey: "attemptKey",
  actorMembershipId: "actorMembershipId",
} as const;

export type EsignRequestMetadata = {
  businessId: string;
  agreementId: string;
  versionId: string;
  attemptKey: string;
  actorMembershipId: string;
};

export type CreateEsignSignatureRequestInput = EsignRequestMetadata & {
  title: string;
  draftContent: string;
  signerName: string;
  signerEmail: string;
  versionNumber: number;
};

export type EsignSignatureRequestResult = {
  requestId: string;
  signingUrl: string | null;
};

export type LookupEsignSignatureRequestInput = EsignRequestMetadata & {
  requestId?: string;
};

export type EsignSignatureLookupResult = {
  requestId: string;
  metadata: EsignRequestMetadata;
};

export type EsignSignatureLookupOutcome =
  | {
      status: "found";
      requestId: string;
      metadata: EsignRequestMetadata;
    }
  | { status: "not_found_complete" }
  | { status: "unknown"; reason: string };

export type VerifiedEsignCompletionEvent = {
  eventId: string;
  eventType: string;
  eventTime: string;
  requestId: string;
  metadata: EsignRequestMetadata;
};

export class EsignProviderError extends Error {
  readonly outcome: "rejected" | "unknown";
  readonly statusCode: number | null;

  constructor(
    message: string,
    options?: { outcome?: "rejected" | "unknown"; statusCode?: number | null },
  ) {
    super(message);
    this.name = "EsignProviderError";
    this.statusCode = options?.statusCode ?? null;
    this.outcome =
      options?.outcome ??
      (this.statusCode !== null && this.statusCode >= 400 && this.statusCode < 500
        ? "rejected"
        : "unknown");
  }
}

export function isDefiniteEsignProviderRejection(error: unknown): error is EsignProviderError {
  return (
    error instanceof EsignProviderError &&
    error.outcome === "rejected" &&
    error.statusCode !== null &&
    error.statusCode >= 400 &&
    error.statusCode < 500
  );
}

/**
 * Smallest provider boundary. TBBT talks to this, not Dropbox Sign APIs.
 */
export type EsignProvider = {
  id: "dropbox_sign" | "fake";
  createSignatureRequest(
    input: CreateEsignSignatureRequestInput,
  ): Promise<EsignSignatureRequestResult>;
  /**
   * Read-only recovery lookup. Must never create a signature request.
   * Incomplete scans are "unknown", never a safe "not found".
   */
  lookupSignatureRequest(
    input: LookupEsignSignatureRequestInput,
  ): Promise<EsignSignatureLookupOutcome>;
  downloadSignedDocument(requestId: string): Promise<Buffer>;
  verifyCompletionEvent(input: {
    rawJson: string;
    /** Ignored. event_hash is the documented Dropbox Sign verifier. */
    contentSha256?: string | null;
  }): VerifiedEsignCompletionEvent;
};
