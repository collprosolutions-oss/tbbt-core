/**
 * Connected Dropbox Sign adapter.
 *
 * Official send: POST https://api.hellosign.com/v3/signature_request/send
 * Official files: GET https://api.hellosign.com/v3/signature_request/files/{id}
 * Official webhook: HMAC-SHA256(api_key, event_time + event_type) === event_hash
 *
 * This module never runs in the fake-adapter proofs. Tests must not set
 * DROPBOX_SIGN_API_KEY or call createSignatureRequest here.
 */
import { getDropboxSignApiKey, getDropboxSignClientId } from "@/lib/esign/config";
import { verifyDropboxSignEventHash } from "@/lib/esign/hmac";
import { renderEsignAgreementPdf } from "@/lib/esign/signed-pdf";
import {
  EsignProviderError,
  type EsignProvider,
  type EsignRequestMetadata,
  type VerifiedEsignCompletionEvent,
} from "@/lib/esign/types";

export const DROPBOX_SIGN_API_ORIGIN = "https://api.hellosign.com";
export const DROPBOX_SIGN_SEND_PATH = "/v3/signature_request/send";
export const DROPBOX_SIGN_FILES_PATH = "/v3/signature_request/files";
export const DROPBOX_SIGN_COMPLETION_EVENTS = new Set([
  "signature_request_all_signed",
  "signature_request_downloadable",
]);

function basicAuthHeader(apiKey: string) {
  return `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
}

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

export function createDropboxSignEsignProvider(): EsignProvider {
  return {
    id: "dropbox_sign",
    async createSignatureRequest(input) {
      const apiKey = getDropboxSignApiKey();
      if (!apiKey) {
        throw new EsignProviderError("Dropbox Sign is not configured.");
      }
      const pdf = await renderEsignAgreementPdf(input);
      const form = new FormData();
      form.set("title", input.title);
      form.set("subject", input.title);
      form.set(
        "message",
        "Please review and sign this agreement. TBBT did not invent this signature request.",
      );
      form.set("signers[0][email_address]", input.signerEmail);
      form.set("signers[0][name]", input.signerName);
      form.set("metadata[businessId]", input.businessId);
      form.set("metadata[agreementId]", input.agreementId);
      form.set("metadata[versionId]", input.versionId);
      form.set("metadata[attemptKey]", input.attemptKey);
      form.set("metadata[actorMembershipId]", input.actorMembershipId);
      form.set(
        "files[0]",
        new Blob([new Uint8Array(pdf)], { type: "application/pdf" }),
        `${input.agreementId}-v${input.versionNumber}.pdf`,
      );
      if (process.env.VERCEL_ENV !== "production") {
        form.set("test_mode", "1");
      }
      const clientId = getDropboxSignClientId();
      if (clientId) form.set("client_id", clientId);

      const response = await fetch(`${DROPBOX_SIGN_API_ORIGIN}${DROPBOX_SIGN_SEND_PATH}`, {
        method: "POST",
        headers: { Authorization: basicAuthHeader(apiKey) },
        body: form,
      });
      const body = (await response.json().catch(() => null)) as {
        signature_request?: { signature_request_id?: unknown; signing_url?: unknown };
        error?: { error_msg?: unknown };
      } | null;
      if (!response.ok) {
        const detail =
          typeof body?.error?.error_msg === "string" ? body.error.error_msg : "send failed";
        throw new EsignProviderError(`Dropbox Sign could not create the signature request (${detail}).`);
      }
      const requestId =
        typeof body?.signature_request?.signature_request_id === "string"
          ? body.signature_request.signature_request_id
          : "";
      if (!requestId) {
        throw new EsignProviderError("Dropbox Sign did not return a signature_request_id.");
      }
      return {
        requestId,
        signingUrl:
          typeof body?.signature_request?.signing_url === "string"
            ? body.signature_request.signing_url
            : null,
      };
    },

    async downloadSignedDocument(requestId) {
      const apiKey = getDropboxSignApiKey();
      if (!apiKey) {
        throw new EsignProviderError("Dropbox Sign is not configured.");
      }
      const response = await fetch(
        `${DROPBOX_SIGN_API_ORIGIN}${DROPBOX_SIGN_FILES_PATH}/${encodeURIComponent(requestId)}?file_type=pdf`,
        { headers: { Authorization: basicAuthHeader(apiKey) } },
      );
      if (response.status === 409) {
        throw new EsignProviderError("Dropbox Sign is still preparing the signed file.");
      }
      if (!response.ok) {
        throw new EsignProviderError("Dropbox Sign could not download the signed document.");
      }
      return Buffer.from(await response.arrayBuffer());
    },

    verifyCompletionEvent(input) {
      const apiKey = getDropboxSignApiKey();
      if (!apiKey) {
        throw new EsignProviderError("Dropbox Sign is not configured.");
      }
      let parsed: {
        event?: {
          event_time?: unknown;
          event_type?: unknown;
          event_hash?: unknown;
        };
        signature_request?: {
          signature_request_id?: unknown;
          metadata?: unknown;
        };
      };
      try {
        parsed = JSON.parse(input.rawJson) as typeof parsed;
      } catch {
        throw new EsignProviderError("Dropbox Sign webhook payload is not JSON.");
      }
      const eventTime = typeof parsed.event?.event_time === "string" ? parsed.event.event_time : "";
      const eventType = typeof parsed.event?.event_type === "string" ? parsed.event.event_type : "";
      const eventHash = typeof parsed.event?.event_hash === "string" ? parsed.event.event_hash : "";
      if (!verifyDropboxSignEventHash({ apiKey, eventTime, eventType, eventHash })) {
        throw new EsignProviderError("Invalid e-sign webhook signature.");
      }
      if (!DROPBOX_SIGN_COMPLETION_EVENTS.has(eventType)) {
        throw new EsignProviderError(`Ignoring Dropbox Sign event ${eventType}.`);
      }
      const requestId =
        typeof parsed.signature_request?.signature_request_id === "string"
          ? parsed.signature_request.signature_request_id
          : "";
      const metadata = metadataFromRecord(parsed.signature_request?.metadata);
      if (!requestId || !metadata) {
        throw new EsignProviderError("Dropbox Sign webhook is missing bound request metadata.");
      }
      return {
        eventId: `${eventTime}:${eventType}:${requestId}`,
        eventType,
        eventTime,
        requestId,
        metadata,
      };
    },
  };
}
