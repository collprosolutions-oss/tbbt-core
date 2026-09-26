import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessTimelineDraft, BusinessTimelineItem } from "@/lib/business-timeline/types";

type Db = PrismaClient | Prisma.TransactionClient;

const RECORD_HREFS: Record<string, (id: string) => string> = {
  CUSTOMER: (id) => `/customers/${id}`,
  SERVICE_REQUEST: (id) => `/requests/${id}`,
  ESTIMATE: (id) => `/estimates/${id}`,
  JOB: (id) => `/jobs/${id}`,
  INVOICE: (id) => `/invoices/${id}`,
  ACTION_ITEM: (id) => `/actions/${id}`,
  VAULT_RECORD: (id) => `/business-protection?area=vault&selected=${id}`,
  AGREEMENT: (id) => `/business-protection?area=agreements&selected=${id}`,
};

export function businessTimelineRecordHref(
  relatedType: string,
  relatedId: string,
  relatedJobId?: string | null,
): string | null {
  if (relatedType === "CHANGE_ORDER") {
    return relatedJobId ? `/jobs/${relatedJobId}/change-orders/${relatedId}` : null;
  }
  const builder = RECORD_HREFS[relatedType];
  return builder ? builder(relatedId) : null;
}

function addId(bucket: Map<string, Set<string>>, type: string, id: string | null) {
  if (!id) return;
  const set = bucket.get(type) ?? new Set<string>();
  set.add(id);
  bucket.set(type, set);
}

async function ownedIds(
  rows: Promise<Array<{ id: string }>>,
): Promise<Set<string>> {
  return new Set((await rows).map((row) => row.id));
}

/**
 * Href only after the related record is proven to belong to this business.
 * Foreign IDs, missing rows, and dirty cross-tenant FKs stay unlinkable.
 */
export async function attachVerifiedTimelineLinks(
  db: Db,
  input: {
    businessId: string;
    customerId?: string | null;
    drafts: BusinessTimelineDraft[];
    customers: Map<string, string>;
  },
): Promise<BusinessTimelineItem[]> {
  const ids = new Map<string, Set<string>>();
  for (const draft of input.drafts) {
    addId(ids, draft.relatedType, draft.relatedId);
    addId(ids, "JOB", draft.relatedJobId);
    addId(ids, "CUSTOMER", draft.customerId);
  }

  const customerWhere = input.customerId ? { customerId: input.customerId } : {};
  const verified = new Map<string, Set<string>>();
  const mark = (type: string, found: Set<string>) => {
    verified.set(type, found);
  };

  const lookups: Array<Promise<void>> = [];
  const requestIds = [...(ids.get("SERVICE_REQUEST") ?? [])];
  if (requestIds.length) {
    lookups.push(
      ownedIds(
        db.serviceRequest.findMany({
          where: { businessId: input.businessId, id: { in: requestIds }, ...customerWhere },
          select: { id: true },
        }),
      ).then((found) => mark("SERVICE_REQUEST", found)),
    );
  }
  const estimateIds = [...(ids.get("ESTIMATE") ?? [])];
  if (estimateIds.length) {
    lookups.push(
      ownedIds(
        db.estimate.findMany({
          where: { businessId: input.businessId, id: { in: estimateIds }, ...customerWhere },
          select: { id: true },
        }),
      ).then((found) => mark("ESTIMATE", found)),
    );
  }
  const jobIds = [...(ids.get("JOB") ?? [])];
  if (jobIds.length) {
    lookups.push(
      ownedIds(
        db.job.findMany({
          where: { businessId: input.businessId, id: { in: jobIds }, ...customerWhere },
          select: { id: true },
        }),
      ).then((found) => mark("JOB", found)),
    );
  }
  const invoiceIds = [...(ids.get("INVOICE") ?? [])];
  if (invoiceIds.length) {
    lookups.push(
      ownedIds(
        db.invoice.findMany({
          where: { businessId: input.businessId, id: { in: invoiceIds }, ...customerWhere },
          select: { id: true },
        }),
      ).then((found) => mark("INVOICE", found)),
    );
  }
  const changeOrderIds = [...(ids.get("CHANGE_ORDER") ?? [])];
  if (changeOrderIds.length) {
    lookups.push(
      ownedIds(
        db.changeOrder.findMany({
          where: {
            businessId: input.businessId,
            id: { in: changeOrderIds },
            job: { businessId: input.businessId, ...customerWhere },
          },
          select: { id: true },
        }),
      ).then((found) => mark("CHANGE_ORDER", found)),
    );
  }
  const actionIds = [...(ids.get("ACTION_ITEM") ?? [])];
  if (actionIds.length) {
    lookups.push(
      ownedIds(
        db.businessActionItem.findMany({
          where: { businessId: input.businessId, id: { in: actionIds } },
          select: { id: true },
        }),
      ).then((found) => mark("ACTION_ITEM", found)),
    );
  }
  const vaultIds = [...(ids.get("VAULT_RECORD") ?? [])];
  if (vaultIds.length) {
    lookups.push(
      ownedIds(
        db.businessVaultRecord.findMany({
          where: { businessId: input.businessId, id: { in: vaultIds } },
          select: { id: true },
        }),
      ).then((found) => mark("VAULT_RECORD", found)),
    );
  }
  const agreementIds = [...(ids.get("AGREEMENT") ?? [])];
  if (agreementIds.length) {
    lookups.push(
      ownedIds(
        db.businessAgreement.findMany({
          where: { businessId: input.businessId, id: { in: agreementIds } },
          select: { id: true },
        }),
      ).then((found) => mark("AGREEMENT", found)),
    );
  }
  if (lookups.length) await Promise.all(lookups);
  mark("CUSTOMER", new Set(input.customers.keys()));

  return input.drafts.map((draft) => {
    const ownedCustomer =
      draft.customerId && input.customers.has(draft.customerId) ? draft.customerId : null;
    const relatedOwned = verified.get(draft.relatedType)?.has(draft.relatedId) ?? false;
    const jobOwned = draft.relatedJobId
      ? (verified.get("JOB")?.has(draft.relatedJobId) ?? false)
      : true;
    const href =
      relatedOwned && jobOwned
        ? businessTimelineRecordHref(draft.relatedType, draft.relatedId, draft.relatedJobId)
        : null;

    return {
      id: draft.id,
      occurredAt: draft.occurredAt.toISOString(),
      eventType: draft.eventType,
      category: draft.category,
      description: draft.description,
      customerId: ownedCustomer,
      customerName: ownedCustomer ? (input.customers.get(ownedCustomer) ?? null) : null,
      relatedType: draft.relatedType,
      relatedId: draft.relatedId,
      relatedLabel: draft.relatedLabel,
      relatedHref: href,
      sourceStatus: draft.sourceStatus,
    };
  });
}
