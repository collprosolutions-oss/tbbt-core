/**
 * Outbound bounce/complaint suppression. Looked up immediately before
 * the provider call in sendTransactionalEmail. Fail closed: a lookup
 * error does not send. Customer-facing purposes are checked; explicit
 * system-exempt purposes skip this lookup.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  EMAIL_BOUNCE_BLOCK_REASON,
  EMAIL_COMPLAINT_BLOCK_REASON,
  EMAIL_SUPPRESSION_UNAVAILABLE_REASON,
  emailDestinationFingerprint,
  findEmailFailedDestination,
} from "@/lib/mail-failed-destination";

type Db = PrismaClient | Prisma.TransactionClient;

export {
  EMAIL_BOUNCE_BLOCK_REASON,
  EMAIL_COMPLAINT_BLOCK_REASON,
  EMAIL_SUPPRESSION_UNAVAILABLE_REASON,
};

export const EMAIL_OUTBOUND_SUPPRESSED_COMPLAINT =
  "Not sent: this address reported a complaint.";
export const EMAIL_OUTBOUND_SUPPRESSED_BOUNCE = "Not sent: this address bounced.";
export const EMAIL_OUTBOUND_SUPPRESSED_UNAVAILABLE =
  "Not sent: destination eligibility could not be confirmed.";

export type OutboundEmailSuppressionReason = "BOUNCE" | "COMPLAINT" | "UNAVAILABLE";

export type OutboundEmailSuppression = {
  reason: OutboundEmailSuppressionReason;
  message: string;
};

/** Test-only. Production never assigns this. */
export const outboundEmailSuppressionTestHooks: {
  failLookup?: boolean;
} = {};

export function resetOutboundEmailSuppressionTestHooks() {
  outboundEmailSuppressionTestHooks.failLookup = false;
}

export function isOutboundEmailSuppressedError(error: string | null | undefined) {
  return (
    error === EMAIL_BOUNCE_BLOCK_REASON ||
    error === EMAIL_COMPLAINT_BLOCK_REASON ||
    error === EMAIL_SUPPRESSION_UNAVAILABLE_REASON ||
    error === EMAIL_OUTBOUND_SUPPRESSED_COMPLAINT ||
    error === EMAIL_OUTBOUND_SUPPRESSED_BOUNCE ||
    error === EMAIL_OUTBOUND_SUPPRESSED_UNAVAILABLE
  );
}

function suppressionForReason(reason: OutboundEmailSuppressionReason): OutboundEmailSuppression {
  if (reason === "COMPLAINT") {
    return { reason, message: EMAIL_OUTBOUND_SUPPRESSED_COMPLAINT };
  }
  if (reason === "BOUNCE") {
    return { reason, message: EMAIL_OUTBOUND_SUPPRESSED_BOUNCE };
  }
  return { reason: "UNAVAILABLE", message: EMAIL_OUTBOUND_SUPPRESSED_UNAVAILABLE };
}

export async function blockedOutboundEmailReason(
  db: Db,
  businessId: string,
  email: string | null | undefined,
): Promise<OutboundEmailSuppression | null> {
  const tenantId = businessId.trim();
  const destination = email?.trim() ?? "";
  if (!tenantId) return suppressionForReason("UNAVAILABLE");
  if (!destination || !destination.includes("@")) return null;
  try {
    if (outboundEmailSuppressionTestHooks.failLookup) {
      throw new Error("suppression lookup failed");
    }
    const row = await findEmailFailedDestination(db, {
      businessId: tenantId,
      destinationFingerprint: emailDestinationFingerprint(tenantId, destination),
    });
    if (!row) return null;
    return suppressionForReason(row.reason === "COMPLAINT" ? "COMPLAINT" : "BOUNCE");
  } catch {
    return suppressionForReason("UNAVAILABLE");
  }
}
