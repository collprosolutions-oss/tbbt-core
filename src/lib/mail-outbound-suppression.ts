/**
 * Outbound bounce/complaint suppression. Looked up immediately before
 * the provider call in sendTransactionalEmail. Fail closed: a lookup
 * error does not send.
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
    error === EMAIL_SUPPRESSION_UNAVAILABLE_REASON
  );
}

export async function blockedOutboundEmailReason(
  db: Db,
  businessId: string,
  email: string | null | undefined,
): Promise<string | null> {
  const tenantId = businessId.trim();
  const destination = email?.trim() ?? "";
  if (!tenantId) return EMAIL_SUPPRESSION_UNAVAILABLE_REASON;
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
    return row.reason === "COMPLAINT" ? EMAIL_COMPLAINT_BLOCK_REASON : EMAIL_BOUNCE_BLOCK_REASON;
  } catch {
    return EMAIL_SUPPRESSION_UNAVAILABLE_REASON;
  }
}
