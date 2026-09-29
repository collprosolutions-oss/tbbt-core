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
  isUsableNormalizedEmail,
  isUsableNormalizedPhone,
  normalizeEmail,
  normalizePhone,
} from "@/lib/customer-identity";
import {
  absorbedCustomerSnapshot,
  CONFIRM_REQUIRED_MESSAGE,
  CROSS_BUSINESS_MERGE_MESSAGE,
  CUSTOMER_DETAIL_DUPLICATE_TAKE,
  CUSTOMERS_NOT_AVAILABLE_MESSAGE,
  CustomerMergeError,
  DUPLICATE_REVIEW_GROUP_TAKE,
  DUPLICATE_REVIEW_MAX_CUSTOMERS_PER_GROUP,
  encodeMatchReasons,
  findPossibleDuplicatePairs,
  MERGE_ALREADY_ABSORBED_MESSAGE,
  MERGE_LEFTOVER_REFERENCES_MESSAGE,
  MERGE_TRY_AGAIN_MESSAGE,
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

const MERGE_SERIALIZATION_ATTEMPTS = 3;
const MERGE_TRANSACTION_MAX_WAIT_MS = 10_000;
const MERGE_TRANSACTION_TIMEOUT_MS = 20_000;

/**
 * Test-only pause points. Production never assigns these. Concurrent
 * checks use a count-2 barrier plus separate PrismaClients.
 */
export const customerMergeTestHooks: {
  beforeLock?: () => Promise<void> | void;
  afterLocked?: (tx: Tx) => Promise<void> | void;
  afterRelationsMoved?: (tx: Tx) => Promise<void> | void;
} = {};

export type MergeCustomersInput = {
  keepCustomerId: string;
  absorbCustomerId: string;
  confirmedSameCustomer: boolean;
};

export type MergeCustomersHooks = {
  beforeLock?: () => Promise<void> | void;
  afterLocked?: (tx: Tx) => Promise<void> | void;
  afterRelationsMoved?: (tx: Tx) => Promise<void> | void;
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

/**
 * Customer list relations that reassignCustomerId / mergeCommunicationThreads
 * must remap. firstCampaign is a belongs-to on Customer itself (copied onto
 * the survivor). StoredAsset.customerId is not a Prisma Customer relation.
 */
export const REASSIGNED_CUSTOMER_RELATION_FIELDS = [
  "properties",
  "serviceRequests",
  "estimates",
  "jobs",
  "invoices",
  "payments",
  "expenses",
  "reviewRequests",
  "reviews",
  "communications",
  "communicationThreads",
  "phoneInteractions",
  "receptionistEvents",
  "referralRequests",
  "customerFollowUps",
  "referralsGiven",
  "referralsReceived",
  "growthActionRequests",
] as const;

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

function emptyCounts(): CustomerMergeCounts {
  return {
    jobs: 0,
    estimates: 0,
    invoices: 0,
    properties: 0,
    communications: 0,
  };
}

async function loadIdentitiesByIds(
  db: Db,
  access: CustomerMergeAccess,
  ids: string[],
): Promise<CustomerMergeIdentity[]> {
  if (ids.length === 0) return [];
  const rows = await db.customer.findMany({
    where: { id: { in: ids }, ...access.scope },
    select: IDENTITY_SELECT,
  });
  return rows.map((row) => access.assertOwned(row));
}

type IdentityGroupRow = { sharedKey: string; ids: string[] };

async function loadDuplicateIdentityGroups(
  db: Db,
  businessId: string,
): Promise<IdentityGroupRow[]> {
  const [emailGroups, phoneGroups] = await Promise.all([
    db.$queryRaw<IdentityGroupRow[]>`
      SELECT lower(trim(email)) AS "sharedKey",
             array_agg(id ORDER BY name ASC, id ASC) AS ids
      FROM "Customer"
      WHERE "businessId" = ${businessId}
        AND email IS NOT NULL
        AND length(trim(email)) > 0
        AND position('@' in lower(trim(email))) > 0
      GROUP BY lower(trim(email))
      HAVING count(*) >= 2
      ORDER BY min(name) ASC, lower(trim(email)) ASC
      LIMIT ${DUPLICATE_REVIEW_GROUP_TAKE}
    `,
    db.$queryRaw<IdentityGroupRow[]>`
      SELECT (
               CASE
                 WHEN length(regexp_replace(phone, '[^0-9]', '', 'g')) = 11
                  AND regexp_replace(phone, '[^0-9]', '', 'g') LIKE '1%'
                 THEN substring(regexp_replace(phone, '[^0-9]', '', 'g') FROM 2)
                 ELSE regexp_replace(phone, '[^0-9]', '', 'g')
               END
             ) AS "sharedKey",
             array_agg(id ORDER BY name ASC, id ASC) AS ids
      FROM "Customer"
      WHERE "businessId" = ${businessId}
        AND phone IS NOT NULL
        AND length(regexp_replace(phone, '[^0-9]', '', 'g')) >= 7
      GROUP BY 1
      HAVING count(*) >= 2
      ORDER BY min(name) ASC, 1
      LIMIT ${DUPLICATE_REVIEW_GROUP_TAKE}
    `,
  ]);
  return [...emailGroups, ...phoneGroups].map((group) => ({
    sharedKey: group.sharedKey,
    ids: group.ids.slice(0, DUPLICATE_REVIEW_MAX_CUSTOMERS_PER_GROUP),
  }));
}

async function loadCounts(
  db: Db | Tx,
  businessId: string,
  customerIds: string[],
): Promise<Map<string, CustomerMergeCounts>> {
  const counts = new Map(customerIds.map((id) => [id, emptyCounts()]));
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

function withCounts(
  pairs: PossibleDuplicatePair[],
  counts: Map<string, CustomerMergeCounts>,
) {
  return pairs.map((pair) => ({
    ...pair,
    leftCounts: counts.get(pair.left.id) ?? emptyCounts(),
    rightCounts: counts.get(pair.right.id) ?? emptyCounts(),
  }));
}

export async function loadDuplicateReview(
  db: Db,
  access: CustomerMergeAccess,
): Promise<DuplicateReview> {
  requireOwner(access);
  const groups = await loadDuplicateIdentityGroups(db, access.businessId);
  const ids = [...new Set(groups.flatMap((group) => group.ids))];
  const customers = await loadIdentitiesByIds(db, access, ids);
  const pairs = findPossibleDuplicatePairs(customers, {
    maxCustomersPerGroup: DUPLICATE_REVIEW_MAX_CUSTOMERS_PER_GROUP,
  });
  const pairIds = [...new Set(pairs.flatMap((pair) => [pair.left.id, pair.right.id]))];
  const counts = await loadCounts(db, access.businessId, pairIds);
  return { pairs: withCounts(pairs, counts) };
}

export async function loadPossibleDuplicatesForCustomer(
  db: Db,
  access: CustomerMergeAccess,
  customerId: string,
): Promise<DuplicateReview> {
  requireOwner(access);
  const customer = await db.customer.findFirst({
    where: { id: customerId, ...access.scope },
    select: IDENTITY_SELECT,
  });
  if (!customer) {
    return { pairs: [] };
  }
  access.assertOwned(customer);
  const email = normalizeEmail(customer.email);
  const phone = normalizePhone(customer.phone);
  const emailUsable = isUsableNormalizedEmail(email);
  const phoneUsable = isUsableNormalizedPhone(phone);
  if (!emailUsable && !phoneUsable) {
    return { pairs: [] };
  }

  const matchClauses: Prisma.Sql[] = [];
  if (emailUsable) {
    matchClauses.push(Prisma.sql`(email IS NOT NULL AND lower(trim(email)) = ${email})`);
  }
  if (phoneUsable) {
    matchClauses.push(Prisma.sql`(
      phone IS NOT NULL
      AND (
        CASE
          WHEN length(regexp_replace(phone, '[^0-9]', '', 'g')) = 11
           AND regexp_replace(phone, '[^0-9]', '', 'g') LIKE '1%'
          THEN substring(regexp_replace(phone, '[^0-9]', '', 'g') FROM 2)
          ELSE regexp_replace(phone, '[^0-9]', '', 'g')
        END
      ) = ${phone}
    )`);
  }
  const matches = await db.$queryRaw<{ id: string }[]>`
    SELECT id
    FROM "Customer"
    WHERE "businessId" = ${access.businessId}
      AND id <> ${customer.id}
      AND (${Prisma.join(matchClauses, " OR ")})
    ORDER BY name ASC, id ASC
    LIMIT ${CUSTOMER_DETAIL_DUPLICATE_TAKE}
  `;
  const customers = await loadIdentitiesByIds(db, access, [customer.id, ...matches.map((row) => row.id)]);
  const pairs = findPossibleDuplicatePairs(customers, {
    maxCustomersPerGroup: CUSTOMER_DETAIL_DUPLICATE_TAKE + 1,
  }).filter((pair) => pair.left.id === customer.id || pair.right.id === customer.id);
  const ids = [...new Set(pairs.flatMap((pair) => [pair.left.id, pair.right.id]))];
  const counts = await loadCounts(db, access.businessId, ids);
  return { pairs: withCounts(pairs, counts) };
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

function clientDelegateName(modelName: string) {
  return modelName.slice(0, 1).toLowerCase() + modelName.slice(1);
}

type RowDelegate = {
  findMany: (args: { where: Record<string, unknown>; select: { id: true } }) => Promise<Array<{ id: string }>>;
};

function pendingBusinessEventWhere(businessId: string, absorbId: string): Prisma.BusinessEventWhereInput {
  return {
    businessId,
    AND: [
      {
        OR: [
          { payload: { path: ["customerId"], equals: absorbId } },
          { subjectType: "CUSTOMER", subjectId: absorbId },
        ],
      },
      {
        OR: [
          { runs: { none: {} } },
          { runs: { some: { status: { in: ["PENDING", "PROCESSING"] } } } },
        ],
      },
    ],
  };
}

type SoftLeftover = {
  delegate: keyof Tx;
  field: string;
  extraWhere?: Record<string, unknown>;
};

export function customerFkFieldsFromDmmf(dmmf: typeof Prisma.dmmf = Prisma.dmmf) {
  const fields: Array<{ model: string; field: string; delegate: string }> = [];
  for (const model of dmmf.datamodel.models) {
    if (model.name === "Customer") continue;
    for (const field of model.fields) {
      if (field.kind !== "object" || field.type !== "Customer") continue;
      const from = field.relationFromFields ?? [];
      for (const fk of from) {
        fields.push({
          model: model.name,
          field: fk,
          delegate: clientDelegateName(model.name),
        });
      }
    }
  }
  return fields;
}

export function customerListRelationsFromDmmf(dmmf: typeof Prisma.dmmf = Prisma.dmmf) {
  const customer = dmmf.datamodel.models.find((model) => model.name === "Customer");
  if (!customer) return [];
  return customer.fields
    .filter(
      (field) =>
        field.kind === "object" &&
        field.name !== "business" &&
        field.name !== "firstCampaign",
    )
    .map((field) => field.name);
}

async function reassignCustomerId(
  tx: Tx,
  businessId: string,
  absorbId: string,
  keepId: string,
) {
  await mergeCommunicationThreads(tx, businessId, absorbId, keepId);
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
  await tx.externalLeadImportRow.updateMany({
    where: { businessId, possibleDuplicateCustomerId: absorbId },
    data: { possibleDuplicateCustomerId: keepId },
  });
  await tx.leadAttributionCorrection.updateMany({
    where: { businessId, recordType: "CUSTOMER", recordId: absorbId },
    data: { recordId: keepId },
  });
  const pendingEvents = await tx.businessEvent.findMany({
    where: pendingBusinessEventWhere(businessId, absorbId),
    select: { id: true, payload: true, subjectType: true, subjectId: true },
  });
  for (const event of pendingEvents) {
    const payload =
      event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? { ...(event.payload as Record<string, unknown>) }
        : {};
    if (payload.customerId === absorbId) {
      payload.customerId = keepId;
    }
    await tx.businessEvent.update({
      where: { id: event.id },
      data: {
        payload: payload as Prisma.InputJsonValue,
        ...(event.subjectType === "CUSTOMER" && event.subjectId === absorbId
          ? { subjectId: keepId }
          : {}),
      },
    });
  }
}

const SOFT_CUSTOMER_REFS: SoftLeftover[] = [
  { delegate: "storedAsset", field: "customerId" },
  { delegate: "externalLeadImportRow", field: "possibleDuplicateCustomerId" },
  { delegate: "leadAttributionCorrection", field: "recordId", extraWhere: { recordType: "CUSTOMER" } },
];

async function leftoverRows(reader: Tx | Db, absorbId: string, businessId: string) {
  const rows: Array<{ delegate: string; field: string; id: string }> = [];
  const delegates = reader as unknown as Record<string, RowDelegate | undefined>;
  for (const ref of customerFkFieldsFromDmmf()) {
    const delegate = delegates[ref.delegate];
    if (!delegate?.findMany) continue;
    const found = await delegate.findMany({
      where: { [ref.field]: absorbId },
      select: { id: true },
    });
    for (const row of found) rows.push({ delegate: ref.delegate, field: ref.field, id: row.id });
  }
  for (const ref of SOFT_CUSTOMER_REFS) {
    const delegate = delegates[String(ref.delegate)];
    if (!delegate?.findMany) continue;
    const found = await delegate.findMany({
      where: { ...(ref.extraWhere ?? {}), [ref.field]: absorbId },
      select: { id: true },
    });
    for (const row of found) rows.push({ delegate: String(ref.delegate), field: ref.field, id: row.id });
  }
  const events = await reader.businessEvent.findMany({
    where: pendingBusinessEventWhere(businessId, absorbId),
    select: { id: true },
  });
  for (const event of events) {
    rows.push({ delegate: "businessEvent", field: "payload.customerId", id: event.id });
  }
  return rows;
}

async function assertNoLeftoverCustomerReferences(tx: Tx, absorbId: string, businessId: string) {
  const leftovers = await leftoverRows(tx, absorbId, businessId);
  if (leftovers.length > 0) {
    throw new CustomerMergeError(MERGE_LEFTOVER_REFERENCES_MESSAGE);
  }
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

function isSerializationFailure(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2034") return true;
    if (error.message.includes("40001")) return true;
  }
  return error instanceof Error && /could not serialize|40001/i.test(error.message);
}

function isTransactionTimeout(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2028";
}

function isForeignKeyConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003";
}

function isAlreadyMergedPrisma(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2002" || error.code === "P2025")
  );
}

function resolveHook<T extends (...args: never[]) => unknown>(
  perCall: T | undefined,
  shared: T | undefined,
): T | undefined {
  return perCall ?? shared;
}

async function mergeConfirmedCustomersOnce(
  db: Db,
  access: CustomerMergeAccess,
  input: MergeCustomersInput,
  hooks: MergeCustomersHooks,
): Promise<MergeCustomersResult> {
  const keepId = input.keepCustomerId.trim();
  const absorbId = input.absorbCustomerId.trim();
  const actorId = membershipId(access);
  const [firstLock, secondLock] = [keepId, absorbId].sort();
  const beforeLock = resolveHook(hooks.beforeLock, customerMergeTestHooks.beforeLock);
  const afterLocked = resolveHook(hooks.afterLocked, customerMergeTestHooks.afterLocked);
  const afterRelationsMoved = resolveHook(
    hooks.afterRelationsMoved,
    customerMergeTestHooks.afterRelationsMoved,
  );

  return db.$transaction(
    async (tx) => {
      if (beforeLock) {
        await beforeLock();
      }

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

      if (afterLocked) {
        await afterLocked(tx);
      }

      await reassignCustomerId(tx, access.businessId, absorbId, keepId);

      if (afterRelationsMoved) {
        await afterRelationsMoved(tx);
      }

      await assertNoLeftoverCustomerReferences(tx, absorb.id, access.businessId);

      const nextConsent = mergeSmsConsentStates(keep.smsConsentStatus, absorb.smsConsentStatus);
      const keepConsent = resolveStoredSmsConsent(keep.smsConsentStatus);
      const absorbConsent = resolveStoredSmsConsent(absorb.smsConsentStatus);
      const adoptingAbsorbedStricter = nextConsent !== keepConsent && nextConsent === absorbConsent;
      const contact = survivorContactFields(keep, absorb);

      await tx.customer.update({
        where: { id: keep.id },
        data: {
          email: contact.email,
          phone: contact.phone,
          firstLeadSource: contact.firstLeadSource,
          firstCampaignId: contact.firstCampaignId,
          smsConsentStatus: nextConsent,
          ...(adoptingAbsorbedStricter
            ? { smsConsentUpdatedAt: absorb.smsConsentUpdatedAt ?? new Date() }
            : {}),
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
    {
      // Mutual exclusion comes from the Customer FOR UPDATE locks.
      // ReadCommitted is required so remap and leftover checks see
      // StoredAsset rows committed by an upload that held FOR KEY SHARE
      // while this transaction waited. A Serializable snapshot is taken
      // when the first lock statement starts and would miss that insert.
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: MERGE_TRANSACTION_MAX_WAIT_MS,
      timeout: MERGE_TRANSACTION_TIMEOUT_MS,
    },
  );
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

  let lastSerializationError: unknown;
  for (let attempt = 0; attempt < MERGE_SERIALIZATION_ATTEMPTS; attempt += 1) {
    try {
      return await mergeConfirmedCustomersOnce(db, access, input, hooks);
    } catch (error) {
      if (error instanceof CustomerMergeError) throw error;
      if (isTransactionTimeout(error)) {
        throw new CustomerMergeError(MERGE_TRY_AGAIN_MESSAGE);
      }
      if (isForeignKeyConflict(error)) {
        throw new CustomerMergeError(MERGE_TRY_AGAIN_MESSAGE);
      }
      if (isSerializationFailure(error)) {
        lastSerializationError = error;
        continue;
      }
      if (isAlreadyMergedPrisma(error)) {
        throw new CustomerMergeError(MERGE_ALREADY_ABSORBED_MESSAGE);
      }
      throw error;
    }
  }
  void lastSerializationError;
  throw new CustomerMergeError(MERGE_TRY_AGAIN_MESSAGE);
}

export function isCustomerMergeError(error: unknown): error is CustomerMergeError {
  return error instanceof CustomerMergeError;
}

export type { CustomerMergeIdentity, PossibleDuplicatePair };
