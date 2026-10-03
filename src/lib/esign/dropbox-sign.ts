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
  ESIGN_LIST_PAGE_SIZE,
  readEsignLookupRow,
  scanEsignSignatureRequestPages,
  type EsignListPageFetch,
} from "@/lib/esign/lookup-scan";
import {
  EsignProviderError,
  type EsignProvider,
  type EsignRequestMetadata,
  type EsignSignatureLookupOutcome,
  type VerifiedEsignCompletionEvent,
} from "@/lib/esign/types";

export const DROPBOX_SIGN_API_ORIGIN = "https://api.hellosign.com";
export const DROPBOX_SIGN_SEND_PATH = "/v3/signature_request/send";
export const DROPBOX_SIGN_GET_PATH = "/v3/signature_request";
export const DROPBOX_SIGN_LIST_PATH = "/v3/signature_request/list";
export const DROPBOX_SIGN_FILES_PATH = "/v3/signature_request/files";
export { ESIGN_LIST_PAGE_LIMIT, ESIGN_LIST_PAGE_SIZE, ESIGN_LIST_SCAN_BUDGET_MS } from "@/lib/esign/lookup-scan";
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

async function dropboxSignGet(path: string, apiKey: string) {
  let response: Response;
  try {
    response = await fetch(`${DROPBOX_SIGN_API_ORIGIN}${path}`, {
      method: "GET",
      headers: { Authorization: basicAuthHeader(apiKey) },
    });
  } catch {
    throw new EsignProviderError(
      "Dropbox Sign lookup outcome is unknown. Check Dropbox Sign before canceling.",
      { outcome: "unknown" },
    );
  }
  return response;
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

      let response: Response;
      try {
        response = await fetch(`${DROPBOX_SIGN_API_ORIGIN}${DROPBOX_SIGN_SEND_PATH}`, {
          method: "POST",
          headers: { Authorization: basicAuthHeader(apiKey) },
          body: form,
        });
      } catch {
        throw new EsignProviderError(
          "Dropbox Sign send outcome is unknown. Check Dropbox Sign before sending again.",
          { outcome: "unknown" },
        );
      }
      const body = (await response.json().catch(() => null)) as {
        signature_request?: { signature_request_id?: unknown; signing_url?: unknown };
        error?: { error_msg?: unknown };
      } | null;
      if (!response.ok) {
        const detail =
          typeof body?.error?.error_msg === "string" ? body.error.error_msg : "send failed";
        const outcome = response.status >= 400 && response.status < 500 ? "rejected" : "unknown";
        throw new EsignProviderError(
          `Dropbox Sign could not create the signature request (${detail}).`,
          { outcome, statusCode: response.status },
        );
      }
      const requestId =
        typeof body?.signature_request?.signature_request_id === "string"
          ? body.signature_request.signature_request_id
          : "";
      if (!requestId) {
        throw new EsignProviderError(
          "Dropbox Sign send outcome is unknown. Check Dropbox Sign before sending again.",
          { outcome: "unknown", statusCode: response.status },
        );
      }
      return {
        requestId,
        signingUrl:
          typeof body?.signature_request?.signing_url === "string"
            ? body.signature_request.signing_url
            : null,
      };
    },

    async lookupSignatureRequest(input): Promise<EsignSignatureLookupOutcome> {
      const apiKey = getDropboxSignApiKey();
      if (!apiKey) {
        throw new EsignProviderError("Dropbox Sign is not configured.");
      }
      if (input.requestId) {
        const response = await dropboxSignGet(
          `${DROPBOX_SIGN_GET_PATH}/${encodeURIComponent(input.requestId)}`,
          apiKey,
        );
        if (response.status === 404) return { status: "not_found_complete" };
        const body = (await response.json().catch(() => null)) as {
          signature_request?: unknown;
          error?: { error_msg?: unknown };
        } | null;
        if (!response.ok) {
          return { status: "unknown", reason: response.status === 429 ? "timeout" : "error" };
        }
        const lookedUp = readEsignLookupRow(body?.signature_request);
        if (!lookedUp) {
          return { status: "unknown", reason: "malformed" };
        }
        return {
          status: "found",
          requestId: lookedUp.requestId,
          metadata: lookedUp.metadata,
        };
      }

      return scanEsignSignatureRequestPages({
        query: input,
        fetchPage: async (page): Promise<EsignListPageFetch> => {
          const response = await dropboxSignGet(
            `${DROPBOX_SIGN_LIST_PATH}?page=${page}&page_size=${ESIGN_LIST_PAGE_SIZE}`,
            apiKey,
          );
          if (!response.ok) {
            return { ok: false, reason: response.status === 429 ? "timeout" : "error" };
          }
          const body = (await response.json().catch(() => null)) as {
            signature_requests?: unknown;
            list_info?: { num_pages?: unknown };
          } | null;
          if (!body || !Array.isArray(body.signature_requests)) {
            return { ok: false, reason: "malformed" };
          }
          const numPages = body.list_info?.num_pages;
          if (typeof numPages !== "number" || !Number.isInteger(numPages) || numPages < 1) {
            return { ok: false, reason: "unknown_total" };
          }
          return {
            ok: true,
            signatureRequests: body.signature_requests,
            numPages,
          };
        },
      });
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
