import type { Prisma, PrismaClient } from "@prisma/client";
import {
  COMMUNICATION_RELATED_TYPES,
  type CommunicationRelatedType,
} from "@/lib/communications/types";

type Db = PrismaClient | Prisma.TransactionClient;

export const RELATED_RECORD_NOT_OWNED_REASON =
  "Related record is not in the authorized business.";
export const RELATED_RECORD_WRONG_CUSTOMER_REASON =
  "Related record does not belong to this customer.";
export const PHONE_LOG_CUSTOMER_CONFLICT_REASON =
  "Linked request, job, and customer do not resolve to the same customer.";

export type ResolvedRelatedRecord = {
  relatedType: CommunicationRelatedType;
  relatedId: string;
  businessId: string;
  customerId: string | null;
};

const SELECT = { id: true, customerId: true } as const;

export function isCommunicationRelatedType(
  value: string | null | undefined,
): value is CommunicationRelatedType {
  return Boolean(value && (COMMUNICATION_RELATED_TYPES as readonly string[]).includes(value));
}

export async function resolveRelatedCommunicationRecord(
  db: Db,
  input: {
    businessId: string;
    relatedType: string | null | undefined;
    relatedId: string | null | undefined;
  },
): Promise<ResolvedRelatedRecord | null> {
  const relatedId = input.relatedId?.trim() ?? "";
  if (!input.relatedType || !relatedId) return null;
  if (!isCommunicationRelatedType(input.relatedType)) return null;

  const where = { id: relatedId, businessId: input.businessId };
  let row: { id: string; customerId: string | null } | null = null;

  if (input.relatedType === "ESTIMATE") {
    row = await db.estimate.findFirst({ where, select: SELECT });
  } else if (input.relatedType === "JOB") {
    row = await db.job.findFirst({ where, select: SELECT });
  } else if (input.relatedType === "INVOICE") {
    row = await db.invoice.findFirst({ where, select: SELECT });
  } else if (input.relatedType === "REVIEW_REQUEST") {
    row = await db.reviewRequest.findFirst({ where, select: SELECT });
  } else if (input.relatedType === "REFERRAL_REQUEST") {
    row = await db.referralRequest.findFirst({ where, select: SELECT });
  } else if (input.relatedType === "CUSTOMER_FOLLOW_UP") {
    row = await db.customerFollowUp.findFirst({ where, select: SELECT });
  } else if (input.relatedType === "SERVICE_REQUEST") {
    row = await db.serviceRequest.findFirst({ where, select: SELECT });
  } else if (input.relatedType === "PROPERTY") {
    row = await db.property.findFirst({ where, select: SELECT });
  } else if (input.relatedType === "PHONE_INTERACTION") {
    row = await db.phoneInteraction.findFirst({ where, select: SELECT });
  }

  if (!row) return null;
  return {
    relatedType: input.relatedType,
    relatedId: row.id,
    businessId: input.businessId,
    customerId: row.customerId ?? null,
  };
}

export async function assertRelatedRecordForCustomer(
  db: Db,
  input: {
    businessId: string;
    customerId: string;
    relatedType?: string | null;
    relatedId?: string | null;
  },
): Promise<{ ok: true; record: ResolvedRelatedRecord | null } | { ok: false; reason: string }> {
  const relatedType = input.relatedType?.trim() || null;
  const relatedId = input.relatedId?.trim() || null;
  if (!relatedType && !relatedId) return { ok: true, record: null };
  if (!relatedType || !relatedId || !isCommunicationRelatedType(relatedType)) {
    return { ok: false, reason: RELATED_RECORD_NOT_OWNED_REASON };
  }

  const record = await resolveRelatedCommunicationRecord(db, {
    businessId: input.businessId,
    relatedType,
    relatedId,
  });
  if (!record) return { ok: false, reason: RELATED_RECORD_NOT_OWNED_REASON };
  if (record.customerId && record.customerId !== input.customerId) {
    return { ok: false, reason: RELATED_RECORD_WRONG_CUSTOMER_REASON };
  }
  return { ok: true, record };
}

export function conflictingCustomerIds(ids: Array<string | null | undefined>) {
  const known = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  return known.length > 1;
}
