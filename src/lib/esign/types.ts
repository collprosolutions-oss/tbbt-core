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

export type VerifiedEsignCompletionEvent = {
  eventId: string;
  eventType: string;
  eventTime: string;
  requestId: string;
  metadata: EsignRequestMetadata;
};

export class EsignProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EsignProviderError";
  }
}

/**
 * Smallest provider boundary. TBBT talks to this, not Dropbox Sign APIs.
 */
export type EsignProvider = {
  id: "dropbox_sign" | "fake";
  createSignatureRequest(
    input: CreateEsignSignatureRequestInput,
  ): Promise<EsignSignatureRequestResult>;
  downloadSignedDocument(requestId: string): Promise<Buffer>;
  verifyCompletionEvent(input: {
    rawJson: string;
    /** Ignored. event_hash is the documented Dropbox Sign verifier. */
    contentSha256?: string | null;
  }): VerifiedEsignCompletionEvent;
};
