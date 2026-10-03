/**
 * Failed email destinations recorded from verified Resend bounce and
 * complaint webhooks. Request paths only assert the migrate-owned table.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { assertRequiredTablesExist } from "@/lib/request-path-schema";

type Db = PrismaClient | Prisma.TransactionClient;

export const EMAIL_FAILED_DESTINATION_REASONS = ["BOUNCE", "COMPLAINT"] as const;
export type EmailFailedDestinationReason = (typeof EMAIL_FAILED_DESTINATION_REASONS)[number];

export const EMAIL_BOUNCE_BLOCK_REASON =
  "This email address bounced and is excluded from later sends.";
export const EMAIL_COMPLAINT_BLOCK_REASON =
  "This email address reported a complaint and is excluded from later sends.";

export function isEmailFailedDestinationReason(
  value: string | null | undefined,
): value is EmailFailedDestinationReason {
  return (EMAIL_FAILED_DESTINATION_REASONS as readonly string[]).includes(value ?? "");
}

export function emailFailedDestinationOwnerReason(reason: EmailFailedDestinationReason) {
  return reason === "COMPLAINT" ? EMAIL_COMPLAINT_BLOCK_REASON : EMAIL_BOUNCE_BLOCK_REASON;
}

export const EMAIL_FAILED_DESTINATION_TABLE = "EmailFailedDestination";

let ensurePromise: Promise<void> | null = null;

export function resetEmailFailedDestinationSchemaEnsure() {
  ensurePromise = null;
}

export async function ensureEmailFailedDestinationSchema(db: Db) {
  if (!ensurePromise) {
    ensurePromise = assertRequiredTablesExist(db, [EMAIL_FAILED_DESTINATION_TABLE]).catch(
      (error) => {
        ensurePromise = null;
        throw error;
      },
    );
  }
  await ensurePromise;
}

export type EmailFailedDestinationRecord = {
  id: string;
  businessId: string;
  destinationFingerprint: string;
  destinationLast4: string | null;
  reason: EmailFailedDestinationReason;
  provider: string;
  providerEventId: string;
  providerMessageId: string;
  communicationId: string | null;
};

function asRecord(row: {
  id: string;
  businessId: string;
  destinationFingerprint: string;
  destinationLast4: string | null;
  reason: string;
  provider: string;
  providerEventId: string;
  providerMessageId: string;
  communicationId: string | null;
}): EmailFailedDestinationRecord | null {
  if (!isEmailFailedDestinationReason(row.reason)) return null;
  return {
    id: row.id,
    businessId: row.businessId,
    destinationFingerprint: row.destinationFingerprint,
    destinationLast4: row.destinationLast4,
    reason: row.reason,
    provider: row.provider,
    providerEventId: row.providerEventId,
    providerMessageId: row.providerMessageId,
    communicationId: row.communicationId,
  };
}

export async function findEmailFailedDestination(
  db: Db,
  input: { businessId: string; destinationFingerprint: string },
): Promise<EmailFailedDestinationRecord | null> {
  await ensureEmailFailedDestinationSchema(db);
  const row = await db.emailFailedDestination.findUnique({
    where: {
      businessId_destinationFingerprint: {
        businessId: input.businessId,
        destinationFingerprint: input.destinationFingerprint,
      },
    },
  });
  return row ? asRecord(row) : null;
}

export async function listEmailFailedDestinationsByFingerprints(
  db: Db,
  input: { businessId: string; fingerprints: string[] },
): Promise<Map<string, EmailFailedDestinationReason>> {
  const unique = [...new Set(input.fingerprints.filter(Boolean))];
  const map = new Map<string, EmailFailedDestinationReason>();
  if (unique.length === 0) return map;
  await ensureEmailFailedDestinationSchema(db);
  const rows = await db.emailFailedDestination.findMany({
    where: {
      businessId: input.businessId,
      destinationFingerprint: { in: unique },
    },
    select: { destinationFingerprint: true, reason: true },
  });
  for (const row of rows) {
    if (isEmailFailedDestinationReason(row.reason)) {
      map.set(row.destinationFingerprint, row.reason);
    }
  }
  return map;
}
