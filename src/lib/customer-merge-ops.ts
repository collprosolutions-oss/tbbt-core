/**
 * OWNER-only same-business customer merge write path.
 *
 * Review lists email/phone matches only. Merge remaps every customer
 * relation onto the survivor, keeps the stricter SMS consent state, then
 * deletes the absorbed row inside one transaction. Browser-supplied
 * businessId is never authorization.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { requireBusinessRole } from "@/lib/authorization";
import { resolveStoredSmsConsent } from "@/lib/customer-messaging/consent";
import {
  absorbedCustomerSnapshot,
  CONFIRM_REQUIRED_MESSAGE,
  CROSS_BUSINESS_MERGE_MESSAGE,
  CUSTOMERS_NOT_AVAILABLE_MESSAGE,
  CustomerMergeError,
  encodeMatchReasons,
  findPossibleDuplicatePairs,
  MERGE_ALREADY_ABSORBED_MESSAGE,
  mergeSmsConsentStates,
  NO_SHARED_IDENTIFIER_MESSAGE,
  OWNER_ONLY_MERGE_MESSAGE,
  pairMatchReasons,
  SAME_RECORD_MESSAGE,
  survivorContactFields,
  type CustomerMergeCounts,
  type CustomerMergeIdentity,
  type PossibleDuplicatePair,
} from "@/lib/customer-merge";

type Db = PrismaClient;
type Tx = Prisma.TransactionClient;
export type CustomerMergeAccess = BusinessAccess;

const IDENTITY_SELECT = {
  id: true,
  businessId: true,
  name: true,
  email: true,
  phone: true,
  smsConsentStatus: true,
  smsConsentUpdatedAt: true,
  firstLeadSource: true,
  firstCampaignId: true,
  createdAt: true,
} as const;

export type MergeCustomersInput = {
  keepCustomerId: string;
  absorbCustomerId: string;
  confirmedSameCustomer: boolean;
};

export type MergeCustomersHooks = {
  afterLocked?: (tx: Tx) => Promise<void>;
  afterRelationsMoved?: (tx: Tx) => Promise<void>;
};

export type MergeCustomersResult = {
  survivorId: string;
  absorbedId: string;
  matchReasons: string;
  smsConsentStatus: string;
};

export type DuplicateReview = {
  pairs: Array<PossibleDuplicatePair & { leftCounts: CustomerMergeCounts; rightCounts: CustomerMergeCounts }>;
};

function requireOwner(access: CustomerMergeAccess) {
  requireBusinessRole(access, "OWNER");
}

function membershipId(access: CustomerMergeAccess): string {
  const id = access.workspace.membership?.id?.trim();
  if (!id) {
    throw new CustomerMergeError(OWNER_ONLY_MERGE_MESSAGE);
  }
  return id;
}

async function loadOwnedIdentities(db: Db, access: CustomerMergeAccess) {
  requireOwner(access);
  const rows = await db.customer.findMany({
    where: access.scope,
    select: IDENTITY_SELECT,
    orderBy: { name: "asc" },
  });
  return rows.map((row) => access.assertOwned(row));
}

async function loadCounts(
  db: Db | Tx,
  businessId: string,
  customerIds: string[],
): Promise<Map<string, CustomerMergeCounts>> {
  const empty = (): CustomerMergeCounts => ({
    jobs: 0,
    estimates: 0,
    invoices: 0,
    properties: 0,
    communications: 0,
  });
  const counts = new Map(customerIds.map((id) => [id, empty()]));
  if (customerIds.length === 0) return counts;

  const [jobs, estimates, invoices, properties, communications] = await Promise.all([
    db.job.groupBy({
      by: ["customerId"],
      where: { businessId, customerId: { in: customerIds } },
      _count: { _all: true },
    }),
    db.estimate.groupBy({
      by: ["customerId"],
      where: { businessId, customerId: { in: customerIds } },
      _count: { _all: true },
    }),
    db.invoice.groupBy({
      by: ["customerId"],
      where: { businessId, customerId: { in: customerIds } },
      _count: { _all: true },
    }),
    db.property.groupBy({
      by: ["customerId"],
      where: { businessId, customerId: { in: customerIds } },
      _count: { _all: true },
    }),
    db.customerCommunication.groupBy({
      by: ["customerId"],
      where: { businessId, customerId: { in: customerIds } },
      _count: { _all: true },
    }),
  ]);

  function apply(
    rows: Array<{ customerId: string | null; _count: { _all: number } }>,
    key: keyof CustomerMergeCounts,
  ) {
    for (const row of rows) {
      if (!row.customerId) continue;
      const current = counts.get(row.customerId);
      if (current) current[key] = row._count._all;
    }
  }

  apply(jobs, "jobs");
  apply(estimates, "estimates");
  apply(invoices, "invoices");
  apply(properties, "properties");
  apply(communications, "communications");
  return counts;
}

export async function loadDuplicateReview(
  db: Db,
  access: CustomerMergeAccess,
): Promise<DuplicateReview> {
  const customers = await loadOwnedIdentities(db, access);
  const pairs = findPossibleDuplicatePairs(customers);
  const ids = [...new Set(pairs.flatMap((pair) => [pair.left.id, pair.right.id]))];
  const counts = await loadCounts(db, access.businessId, ids);
  return {
    pairs: pairs.map((pair) => ({
      ...pair,
      leftCounts: counts.get(pair.left.id) ?? {
        jobs: 0,
        estimates: 0,
        invoices: 0,
        properties: 0,
        communications: 0,
      },
      rightCounts: counts.get(pair.right.id) ?? {
        jobs: 0,
        estimates: 0,
        invoices: 0,
        properties: 0,
        communications: 0,
      },
    })),
  };
}

export async function loadOwnedMergePair(
  db: Db,
  access: CustomerMergeAccess,
  leftId: string,
  rightId: string,
) {
  requireOwner(access);
  if (!leftId || !rightId || leftId === rightId) {
    throw new CustomerMergeError(SAME_RECORD_MESSAGE);
  }
  const [left, right] = await Promise.all([
    db.customer.findFirst({
      where: { id: leftId, ...access.scope },
      select: IDENTITY_SELECT,
    }),
    db.customer.findFirst({
      where: { id: rightId, ...access.scope },
      select: IDENTITY_SELECT,
    }),
  ]);
  if (!left || !right) {
    throw new CustomerMergeError(CUSTOMERS_NOT_AVAILABLE_MESSAGE);
  }
  access.assertOwned(left);
  access.assertOwned(right);
  const reasons = pairMatchReasons(left, right);
  const counts = await loadCounts(db, access.businessId, [left.id, right.id]);
  return {
    left,
    right,
    reasons,
    leftCounts: counts.get(left.id)!,
    rightCounts: counts.get(right.id)!,
  };
}

export async function findSurvivorForAbsorbedCustomer(
  db: Db,
  access: BusinessAccess,
  absorbedCustomerId: string,
): Promise<string | null> {
  const merge = await db.customerMerge.findFirst({
    where: { absorbedCustomerId, ...access.scope },
    select: { survivorCustomerId: true, businessId: true },
  });
  if (!merge) return null;
  access.assertOwned(merge);
  return merge.survivorCustomerId;
}

async function lockCustomer(tx: Tx, businessId: string, customerId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Customer"
    WHERE id = ${customerId} AND "businessId" = ${businessId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function reassignCustomerId(
  tx: Tx,
  businessId: string,
  absorbId: string,
  keepId: string,
) {
  await tx.property.updateMany({
    where: { businessId, customerId: absorbId },
    data: { customerId: keepId },
  });
  await tx.serviceRequest.updateMany({
    where: { businessId, customerId: absorbId },
    data: { customerId: keepId },
  });
  await tx.estimate.updateMany({
    where: { businessId, customerId: absorbId },
    data: { customerId: keepId },
  });
  await tx.job.updateMany({
    where: { businessId, customerId: absorbId },
    data: { customerId: keepId },
  });
  await tx.invoice.updateMany({
    where: { businessId, customerId: absorbId },
    data: { customerId: keepId },
  });
  await tx.payment.updateMany({
    where: { businessId, customerId: absorbId },
    data: { customerId: keepId },
  });
  await tx.expense.updateMany({
    where: { businessId, customerId: absorbId },
    data: { customerId: keepId },
  });
  await tx.reviewRequest.updateMany({
    where: { businessId, customerId: absorbId },
    data: { customerId: keepId },
  });
  await tx.review.updateMany({
    where: { businessId, customerId: absorbId },
    data: { customerId: keepId },
  });
  await tx.customerCommunication.updateMany({
    where: { businessId, customerId: absorbId },
    data: { customerId: keepId },
  });
  await tx.phoneInteraction.updateMany({
    where: { businessId, customerId: absorbId },
    data: { customerId: keepId },
  });
  await tx.receptionistEvent.updateMany({
    where: { businessId, customerId: absorbId },
    data: { customerId: keepId },
  });
  await tx.referralRequest.updateMany({
    where: { businessId, customerId: absorbId },
    data: { customerId: keepId },
  });
  await tx.customerFollowUp.updateMany({
    where: { businessId, customerId: absorbId },
    data: { customerId: keepId },
  });
  await tx.referral.updateMany({
    where: { businessId, sourceCustomerId: absorbId },
    data: { sourceCustomerId: keepId },
  });
  await tx.referral.updateMany({
    where: { businessId, referredCustomerId: absorbId },
    data: { referredCustomerId: keepId },
  });
  await tx.growthActionRequest.updateMany({
    where: { businessId, customerId: absorbId },
    data: { customerId: keepId },
  });
  await tx.storedAsset.updateMany({
    where: { businessId, customerId: absorbId },
    data: { customerId: keepId },
  });
}

async function mergeCommunicationThreads(
  tx: Tx,
  businessId: string,
  absorbId: string,
  keepId: string,
) {
  const absorbThreads = await tx.communicationThread.findMany({
    where: { businessId, customerId: absorbId },
  });

  for (const thread of absorbThreads) {
    const nextSubjectId =
      thread.subjectType === "CUSTOMER" && thread.subjectId === absorbId
        ? keepId
        : thread.subjectId;
    const existing = await tx.communicationThread.findFirst({
      where: {
        businessId,
        customerId: keepId,
        subjectType: thread.subjectType,
        subjectId: nextSubjectId,
        NOT: { id: thread.id },
      },
    });
    if (existing) {
      await tx.customerCommunication.updateMany({
        where: { businessId, threadId: thread.id },
        data: { threadId: existing.id, customerId: keepId },
      });
      await tx.phoneInteraction.updateMany({
        where: { businessId, threadId: thread.id },
        data: { threadId: existing.id, customerId: keepId },
      });
      await tx.communicationThread.delete({ where: { id: thread.id } });
      continue;
    }
    await tx.communicationThread.update({
      where: { id: thread.id },
      data: { customerId: keepId, subjectId: nextSubjectId },
    });
  }
}

export async function mergeConfirmedCustomers(
  db: Db,
  access: CustomerMergeAccess,
  input: MergeCustomersInput,
  hooks: MergeCustomersHooks = {},
): Promise<MergeCustomersResult> {
  requireOwner(access);
  const keepId = input.keepCustomerId.trim();
  const absorbId = input.absorbCustomerId.trim();
  if (!keepId || !absorbId || keepId === absorbId) {
    throw new CustomerMergeError(SAME_RECORD_MESSAGE);
  }
  if (!input.confirmedSameCustomer) {
    throw new CustomerMergeError(CONFIRM_REQUIRED_MESSAGE);
  }

  const actorId = membershipId(access);
  const [firstLock, secondLock] = [keepId, absorbId].sort();

  try {
    return await db.$transaction(
      async (tx) => {
        const lockedFirst = await lockCustomer(tx, access.businessId, firstLock);
        const lockedSecond = await lockCustomer(tx, access.businessId, secondLock);
        if (!lockedFirst || !lockedSecond) {
          throw new CustomerMergeError(CUSTOMERS_NOT_AVAILABLE_MESSAGE);
        }

        const [keep, absorb] = await Promise.all([
          tx.customer.findFirst({
            where: { id: keepId, businessId: access.businessId },
            select: IDENTITY_SELECT,
          }),
          tx.customer.findFirst({
            where: { id: absorbId, businessId: access.businessId },
            select: IDENTITY_SELECT,
          }),
        ]);
        if (!keep || !absorb) {
          throw new CustomerMergeError(CUSTOMERS_NOT_AVAILABLE_MESSAGE);
        }
        access.assertOwned(keep);
        access.assertOwned(absorb);
        if (keep.businessId !== absorb.businessId || keep.businessId !== access.businessId) {
          throw new CustomerMergeError(CROSS_BUSINESS_MERGE_MESSAGE);
        }

        const alreadyAbsorbed = await tx.customerMerge.findFirst({
          where: {
            businessId: access.businessId,
            absorbedCustomerId: { in: [keepId, absorbId] },
          },
        });
        if (alreadyAbsorbed) {
          throw new CustomerMergeError(MERGE_ALREADY_ABSORBED_MESSAGE);
        }

        const reasons = pairMatchReasons(keep, absorb);
        if (reasons.length === 0) {
          throw new CustomerMergeError(NO_SHARED_IDENTIFIER_MESSAGE);
        }

        if (hooks.afterLocked) {
          await hooks.afterLocked(tx);
        }

        await mergeCommunicationThreads(tx, access.businessId, absorbId, keepId);
        await reassignCustomerId(tx, access.businessId, absorbId, keepId);

        if (hooks.afterRelationsMoved) {
          await hooks.afterRelationsMoved(tx);
        }

        const nextConsent = mergeSmsConsentStates(keep.smsConsentStatus, absorb.smsConsentStatus);
        const consentChanged =
          resolveStoredSmsConsent(keep.smsConsentStatus) !== nextConsent;
        const contact = survivorContactFields(keep, absorb);

        await tx.customer.update({
          where: { id: keep.id },
          data: {
            email: contact.email,
            phone: contact.phone,
            firstLeadSource: contact.firstLeadSource,
            firstCampaignId: contact.firstCampaignId,
            smsConsentStatus: nextConsent,
            ...(consentChanged ? { smsConsentUpdatedAt: new Date() } : {}),
          },
        });

        await tx.customerMerge.create({
          data: {
            businessId: access.businessId,
            survivorCustomerId: keep.id,
            absorbedCustomerId: absorb.id,
            absorbedSnapshot: absorbedCustomerSnapshot(absorb) as Prisma.InputJsonValue,
            matchReasons: encodeMatchReasons(reasons),
            mergedByMembershipId: actorId,
          },
        });

        await tx.customer.delete({
          where: { id: absorb.id },
        });

        return {
          survivorId: keep.id,
          absorbedId: absorb.id,
          matchReasons: encodeMatchReasons(reasons),
          smsConsentStatus: nextConsent,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof CustomerMergeError) throw error;
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === "P2002" || error.code === "P2025" || error.code === "P2034")
    ) {
      throw new CustomerMergeError(MERGE_ALREADY_ABSORBED_MESSAGE);
    }
    throw error;
  }
}

export function isCustomerMergeError(error: unknown): error is CustomerMergeError {
  return error instanceof CustomerMergeError;
}

export type { CustomerMergeIdentity, PossibleDuplicatePair };
