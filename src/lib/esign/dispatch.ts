/**
 * Verified e-sign webhook dispatch. Signature is checked before any
 * payload is trusted. Completion binds the signed file to the exact
 * business, agreement, version, and stored provider request id.
 *
 * Authenticated events always return HTTP 200 + Hello API Event Received,
 * including terminal outcomes (already complete, mismatch). Dropbox Sign
 * treats non-200 as a callback failure and will clear the account URL.
 * Failed event_hash stays 400.
 */
import { DROPBOX_SIGN_COMPLETION_EVENTS } from "@/lib/esign/dropbox-sign";
import { requireEsignProvider } from "@/lib/esign/provider";
import { EsignProviderError } from "@/lib/esign/types";
import { isCompletedAgreement, type AgreementLifecycleStatus } from "@/lib/business-protection-agreements";
import {
  BusinessProtectionError,
  completeAgreementFromEsignWebhook,
} from "@/lib/business-protection-ops";
import type { StorageServiceDeps } from "@/lib/business-storage/service";
import type { Prisma, PrismaClient } from "@prisma/client";

export const ESIGN_WEBHOOK_HELLO = "Hello API Event Received";

export type EsignWebhookResult = {
  applied: boolean;
  reason: string;
  status: number;
  hello: boolean;
};

type Db = PrismaClient | Prisma.TransactionClient;

function authenticated(reason: string, applied = false): EsignWebhookResult {
  return { applied, reason, status: 200, hello: true };
}

async function alreadyClaimedWithoutDownload(
  db: Db,
  event: {
    requestId: string;
    metadata: {
      businessId: string;
      agreementId: string;
      versionId: string;
      attemptKey: string;
    };
  },
): Promise<EsignWebhookResult | null> {
  const agreement = await db.businessAgreement.findFirst({
    where: { id: event.metadata.agreementId, businessId: event.metadata.businessId },
    include: {
      versions: { where: { id: event.metadata.versionId } },
      completionClaim: true,
    },
  });
  if (!agreement) return null;
  const version = agreement.versions[0];
  if (
    agreement.esignSignatureRequestId !== event.requestId ||
    version?.esignSignatureRequestId !== event.requestId
  ) {
    return authenticated("request_mismatch");
  }
  if (
    isCompletedAgreement(agreement.lifecycleStatus as AgreementLifecycleStatus) ||
    agreement.completionClaim
  ) {
    if (
      (agreement.completionClaim?.attemptKey ?? agreement.completionAttemptKey) ===
        event.metadata.attemptKey &&
      agreement.signedVersionId === event.metadata.versionId
    ) {
      return authenticated("already_applied");
    }
    return authenticated("already_complete");
  }
  return null;
}

export async function dispatchEsignWebhook(
  db: Db,
  input: {
    rawJson: string;
    contentSha256?: string | null;
    storage?: StorageServiceDeps;
  },
): Promise<EsignWebhookResult> {
  let provider;
  try {
    provider = requireEsignProvider();
  } catch {
    return { applied: false, reason: "not_configured", status: 503, hello: false };
  }

  let event;
  try {
    event = provider.verifyCompletionEvent({
      rawJson: input.rawJson,
      contentSha256: input.contentSha256,
    });
  } catch (error) {
    if (error instanceof EsignProviderError && /Invalid e-sign webhook signature/.test(error.message)) {
      return { applied: false, reason: "invalid_signature", status: 400, hello: false };
    }
    if (error instanceof EsignProviderError && /Ignoring/.test(error.message)) {
      return authenticated("ignored_event");
    }
    return authenticated("invalid_payload");
  }

  if (!DROPBOX_SIGN_COMPLETION_EVENTS.has(event.eventType)) {
    return authenticated("ignored_event");
  }

  const claimed = await alreadyClaimedWithoutDownload(db, event);
  if (claimed) return claimed;

  let signedPdf: Buffer;
  try {
    signedPdf = await provider.downloadSignedDocument(event.requestId);
  } catch (error) {
    if (error instanceof EsignProviderError && /still preparing/.test(error.message)) {
      return authenticated("document_not_ready");
    }
    return authenticated("provider_download_failed");
  }

  try {
    const completed = await completeAgreementFromEsignWebhook(db, {
      event,
      signedPdf,
      storage: input.storage ?? { db: db as PrismaClient },
    });
    if (completed.reused) {
      return authenticated("already_applied");
    }
    return authenticated("applied", true);
  } catch (error) {
    const message = error instanceof BusinessProtectionError ? error.message : "";
    if (/already complete/.test(message)) {
      if (/Later edits belong on a new agreement/.test(message) && /already complete/.test(message)) {
        const winner = await db.businessAgreement.findFirst({
          where: {
            id: event.metadata.agreementId,
            businessId: event.metadata.businessId,
          },
          select: {
            completionAttemptKey: true,
            signedVersionId: true,
            lifecycleStatus: true,
          },
        });
        if (
          winner?.completionAttemptKey === event.metadata.attemptKey &&
          winner.signedVersionId === event.metadata.versionId
        ) {
          return authenticated("already_applied");
        }
      }
      return authenticated("already_complete");
    }
    if (/not bound to this exact business/.test(message) || /not in this business workspace/.test(message)) {
      return authenticated("tenant_mismatch");
    }
    if (/was not sent through the connected e-sign adapter/.test(message)) {
      return authenticated("request_mismatch");
    }
    if (/not an owner in that business/.test(message)) {
      return authenticated("tenant_mismatch");
    }
    return authenticated("completion_failed");
  }
}

export async function parseEsignWebhookJson(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return request.text();
  }
  if (contentType.includes("multipart/form-data") || contentType.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    const json = form.get("json");
    return typeof json === "string" ? json : "";
  }
  return request.text();
}
