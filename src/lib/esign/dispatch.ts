/**
 * Verified e-sign webhook dispatch. Signature is checked before any
 * payload is trusted. Completion binds the signed file to the exact
 * business, agreement, and version stored on the provider request.
 */
import { DROPBOX_SIGN_COMPLETION_EVENTS } from "@/lib/esign/dropbox-sign";
import { requireEsignProvider } from "@/lib/esign/provider";
import { EsignProviderError } from "@/lib/esign/types";
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
      return { applied: false, reason: "ignored_event", status: 200, hello: true };
    }
    return {
      applied: false,
      reason: error instanceof EsignProviderError ? "invalid_payload" : "invalid_payload",
      status: 400,
      hello: false,
    };
  }

  if (!DROPBOX_SIGN_COMPLETION_EVENTS.has(event.eventType)) {
    return { applied: false, reason: "ignored_event", status: 200, hello: true };
  }

  let signedPdf: Buffer;
  try {
    signedPdf = await provider.downloadSignedDocument(event.requestId);
  } catch (error) {
    if (error instanceof EsignProviderError && /still preparing/.test(error.message)) {
      return { applied: false, reason: "document_not_ready", status: 409, hello: false };
    }
    return { applied: false, reason: "provider_download_failed", status: 502, hello: false };
  }

  try {
    const completed = await completeAgreementFromEsignWebhook(db, {
      event,
      signedPdf,
      storage: input.storage ?? { db: db as PrismaClient },
    });
    if (completed.reused) {
      return { applied: false, reason: "already_applied", status: 200, hello: true };
    }
    return { applied: true, reason: "applied", status: 200, hello: true };
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
          return { applied: false, reason: "already_applied", status: 200, hello: true };
        }
      }
      return { applied: false, reason: "already_complete", status: 409, hello: false };
    }
    if (/not bound to this exact business/.test(message) || /not in this business workspace/.test(message)) {
      return { applied: false, reason: "tenant_mismatch", status: 403, hello: false };
    }
    if (/was not sent through the connected e-sign adapter/.test(message)) {
      return { applied: false, reason: "request_mismatch", status: 409, hello: false };
    }
    if (/not an owner in that business/.test(message)) {
      return { applied: false, reason: "tenant_mismatch", status: 403, hello: false };
    }
    return { applied: false, reason: "completion_failed", status: 409, hello: false };
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
