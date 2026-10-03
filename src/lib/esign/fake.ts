/**
 * Local/script fake e-sign adapter. Never enabled in Vercel production.
 * Uses the official Dropbox Sign event_hash algorithm so webhook proofs
 * match current provider documentation without sending a real request.
 * Does not verify Content-Sha256 (that header is not the documented verifier).
 */
import { randomUUID } from "node:crypto";
import { getFakeEsignWebhookKey } from "@/lib/esign/config";
import { dropboxSignEventHash, verifyDropboxSignEventHash } from "@/lib/esign/hmac";
import { renderEsignAgreementPdf } from "@/lib/esign/signed-pdf";
import {
  ESIGN_METADATA_KEYS,
  EsignProviderError,
  type CreateEsignSignatureRequestInput,
  type EsignProvider,
  type EsignRequestMetadata,
  type EsignSignatureRequestResult,
  type VerifiedEsignCompletionEvent,
} from "@/lib/esign/types";

export const FAKE_ESIGN_SIGNED_EVENT = "signature_request_all_signed" as const;
export const FAKE_ESIGN_DOWNLOADABLE_EVENT = "signature_request_downloadable" as const;

type FakeRequest = {
  requestId: string;
  input: CreateEsignSignatureRequestInput;
  signedPdf: Buffer;
};

function metadataFromRecord(value: unknown): EsignRequestMetadata | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const businessId = typeof record.businessId === "string" ? record.businessId : "";
  const agreementId = typeof record.agreementId === "string" ? record.agreementId : "";
  const versionId = typeof record.versionId === "string" ? record.versionId : "";
  const attemptKey = typeof record.attemptKey === "string" ? record.attemptKey : "";
  const actorMembershipId =
    typeof record.actorMembershipId === "string" ? record.actorMembershipId : "";
  if (!businessId || !agreementId || !versionId || !attemptKey || !actorMembershipId) {
    return null;
  }
  return { businessId, agreementId, versionId, attemptKey, actorMembershipId };
}

export async function buildFakeSignedPdf(input: {
  title?: string;
  businessId: string;
  agreementId: string;
  versionId: string;
  draftContent: string;
}) {
  return renderEsignAgreementPdf(input);
}

export class FakeEsignProvider implements EsignProvider {
  readonly id = "fake" as const;
  private readonly requests = new Map<string, FakeRequest>();
  private failNextCreate = false;
  private throwAfterCreate: Error | null = null;
  private failNextDownload = false;
  private processedEventIds = new Set<string>();
  private createCalls = 0;

  reset() {
    this.requests.clear();
    this.failNextCreate = false;
    this.throwAfterCreate = null;
    this.failNextDownload = false;
    this.processedEventIds.clear();
    this.createCalls = 0;
  }

  failNextSignatureRequest() {
    this.failNextCreate = true;
  }

  createThenThrow(error?: Error) {
    this.throwAfterCreate =
      error ?? Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
  }

  failNextSignedDownload() {
    this.failNextDownload = true;
  }

  createdRequestCount() {
    return this.createCalls;
  }

  lastCreatedRequestId() {
    return [...this.requests.keys()].at(-1) ?? null;
  }

  rememberProcessedEvent(eventId: string) {
    this.processedEventIds.add(eventId);
  }

  hasProcessedEvent(eventId: string) {
    return this.processedEventIds.has(eventId);
  }

  getRequest(requestId: string) {
    return this.requests.get(requestId) ?? null;
  }

  async createSignatureRequest(
    input: CreateEsignSignatureRequestInput,
  ): Promise<EsignSignatureRequestResult> {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new EsignProviderError("Fake e-sign provider failed to create the signature request.", {
        outcome: "rejected",
        statusCode: 400,
      });
    }
    this.createCalls += 1;
    const requestId = `fake_sr_${randomUUID().replaceAll("-", "")}`;
    this.requests.set(requestId, {
      requestId,
      input: { ...input },
      signedPdf: await buildFakeSignedPdf(input),
    });
    if (this.throwAfterCreate) {
      const error = this.throwAfterCreate;
      this.throwAfterCreate = null;
      throw error;
    }
    return { requestId, signingUrl: `https://esign.test/sign/${requestId}` };
  }

  async downloadSignedDocument(requestId: string): Promise<Buffer> {
    if (this.failNextDownload) {
      this.failNextDownload = false;
      throw new EsignProviderError("Fake e-sign provider could not download the signed document.");
    }
    const row = this.requests.get(requestId);
    if (!row) {
      throw new EsignProviderError("Fake e-sign provider has no signed document for that request.");
    }
    return Buffer.from(row.signedPdf);
  }

  verifyCompletionEvent(input: {
    rawJson: string;
    contentSha256?: string | null;
  }): VerifiedEsignCompletionEvent {
    const apiKey = getFakeEsignWebhookKey();
    let parsed: {
      event?: {
        event_time?: unknown;
        event_type?: unknown;
        event_hash?: unknown;
        event_id?: unknown;
      };
      signature_request?: {
        signature_request_id?: unknown;
        metadata?: unknown;
      };
    };
    try {
      parsed = JSON.parse(input.rawJson) as typeof parsed;
    } catch {
      throw new EsignProviderError("Fake e-sign webhook payload is not JSON.");
    }
    const eventTime = typeof parsed.event?.event_time === "string" ? parsed.event.event_time : "";
    const eventType = typeof parsed.event?.event_type === "string" ? parsed.event.event_type : "";
    const eventHash = typeof parsed.event?.event_hash === "string" ? parsed.event.event_hash : "";
    if (!verifyDropboxSignEventHash({ apiKey, eventTime, eventType, eventHash })) {
      throw new EsignProviderError("Invalid e-sign webhook signature.");
    }
    const requestId =
      typeof parsed.signature_request?.signature_request_id === "string"
        ? parsed.signature_request.signature_request_id
        : "";
    const metadata = metadataFromRecord(parsed.signature_request?.metadata);
    if (!requestId || !metadata) {
      throw new EsignProviderError("E-sign webhook is missing the bound request metadata.");
    }
    const eventId =
      typeof parsed.event?.event_id === "string" && parsed.event.event_id
        ? parsed.event.event_id
        : `${eventTime}:${eventType}:${requestId}`;
    return {
      eventId,
      eventType,
      eventTime,
      requestId,
      metadata,
    };
  }

  buildSignedWebhookPayload(input: {
    requestId: string;
    metadata?: Partial<EsignRequestMetadata>;
    eventType?: string;
    eventTime?: string;
    eventId?: string;
    forged?: boolean;
    apiKey?: string;
  }) {
    const stored = this.requests.get(input.requestId);
    const metadata: EsignRequestMetadata = {
      businessId: input.metadata?.businessId ?? stored?.input.businessId ?? "",
      agreementId: input.metadata?.agreementId ?? stored?.input.agreementId ?? "",
      versionId: input.metadata?.versionId ?? stored?.input.versionId ?? "",
      attemptKey: input.metadata?.attemptKey ?? stored?.input.attemptKey ?? "",
      actorMembershipId:
        input.metadata?.actorMembershipId ?? stored?.input.actorMembershipId ?? "",
    };
    const eventTime = input.eventTime ?? String(Math.floor(Date.now() / 1000));
    const eventType = input.eventType ?? FAKE_ESIGN_DOWNLOADABLE_EVENT;
    const apiKey = input.apiKey ?? getFakeEsignWebhookKey();
    const eventHash = input.forged
      ? "0".repeat(64)
      : dropboxSignEventHash(apiKey, eventTime, eventType);
    const payload = {
      event: {
        event_time: eventTime,
        event_type: eventType,
        event_hash: eventHash,
        event_id: input.eventId ?? `${eventTime}:${eventType}:${input.requestId}`,
        event_metadata: {
          related_signature_id: null,
          reported_for_account_id: "fake-account",
          reported_for_app_id: null,
        },
      },
      signature_request: {
        signature_request_id: input.requestId,
        metadata: {
          [ESIGN_METADATA_KEYS.businessId]: metadata.businessId,
          [ESIGN_METADATA_KEYS.agreementId]: metadata.agreementId,
          [ESIGN_METADATA_KEYS.versionId]: metadata.versionId,
          [ESIGN_METADATA_KEYS.attemptKey]: metadata.attemptKey,
          [ESIGN_METADATA_KEYS.actorMembershipId]: metadata.actorMembershipId,
        },
      },
    };
    const rawJson = JSON.stringify(payload);
    return {
      rawJson,
      payload,
      eventId: payload.event.event_id,
    };
  }
}

let shared: FakeEsignProvider | null = null;

export function getSharedFakeEsignProvider() {
  if (!shared) shared = new FakeEsignProvider();
  return shared;
}

export function resetSharedFakeEsignProvider() {
  getSharedFakeEsignProvider().reset();
}
