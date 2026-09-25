import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { MaterialsError } from "@/lib/materials/errors";
import { isPrismaUniqueViolation } from "@/lib/materials/unique";

type Db = PrismaClient | Prisma.TransactionClient;

export const MATERIAL_ATTEMPT_KINDS = [
  "CONVERT_TAKEOFF",
  "CREATE_DRAFT_PO",
  "RECORD_PURCHASE",
] as const;
export type MaterialAttemptKind = (typeof MATERIAL_ATTEMPT_KINDS)[number];

export function normalizeMaterialAttemptKey(value: string | null | undefined) {
  const key = value?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) {
    throw new MaterialsError("Retry that request from the form.");
  }
  return key;
}

export async function findMaterialAttempt(
  db: Db,
  access: BusinessAccess,
  attemptKey: string,
) {
  return db.materialOperationAttempt.findUnique({
    where: {
      businessId_attemptKey: {
        businessId: access.businessId,
        attemptKey,
      },
    },
  });
}

export async function finishMaterialAttempt(
  db: Db,
  access: BusinessAccess,
  input: {
    attemptKey: string;
    purchaseListId?: string | null;
    purchaseOrderId?: string | null;
    purchaseListItemId?: string | null;
    expenseId?: string | null;
    createdCount?: number | null;
  },
) {
  return db.materialOperationAttempt.update({
    where: {
      businessId_attemptKey: {
        businessId: access.businessId,
        attemptKey: input.attemptKey,
      },
    },
    data: {
      purchaseListId: input.purchaseListId ?? undefined,
      purchaseOrderId: input.purchaseOrderId ?? undefined,
      purchaseListItemId: input.purchaseListItemId ?? undefined,
      expenseId: input.expenseId ?? undefined,
      createdCount: input.createdCount ?? undefined,
    },
  });
}

/**
 * Run one logical browser attempt. Unique (businessId, attemptKey) is the
 * lock. A unique violation is not queried inside the aborted transaction;
 * the loser re-reads the winner after the transaction ends.
 */
export async function withMaterialAttempt<T>(
  db: PrismaClient,
  access: BusinessAccess,
  input: { attemptKey: string; kind: MaterialAttemptKind },
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<{ status: "claimed"; result: T } | { status: "replay"; attempt: NonNullable<
  Awaited<ReturnType<typeof findMaterialAttempt>>
> }> {
  const existing = await findMaterialAttempt(db, access, input.attemptKey);
  if (existing) {
    if (existing.kind !== input.kind) {
      throw new MaterialsError("That retry token was already used for a different action.");
    }
    return { status: "replay", attempt: existing };
  }
  try {
    const result = await db.$transaction(async (tx) => {
      await tx.materialOperationAttempt.create({
        data: {
          businessId: access.businessId,
          attemptKey: input.attemptKey,
          kind: input.kind,
        },
      });
      return work(tx);
    });
    return { status: "claimed", result };
  } catch (error) {
    if (!isPrismaUniqueViolation(error)) throw error;
    const winner = await findMaterialAttempt(db, access, input.attemptKey);
    if (!winner) throw error;
    if (winner.kind !== input.kind) {
      throw new MaterialsError("That retry token was already used for a different action.");
    }
    return { status: "replay", attempt: winner };
  }
}
