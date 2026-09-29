/**
 * Bounded OWNER collections worklist loader.
 *
 * Reuses recorded Invoice, Payment, and CustomerCommunication rows.
 * Page load is read-only: no sends, no payment writes, no bank inference.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import { assertCanReadCollectionsWorklist } from "@/lib/collections/access";
import {
  COLLECTIONS_COMMUNICATION_SCAN_LIMIT,
  COLLECTIONS_NEXT_STEP_LABELS,
  COLLECTIONS_QUEUE_LIMIT,
  COLLECTIONS_SCAN_LIMIT,
  type CollectionsNextStep,
  type CollectionsWorkItemStatus,
} from "@/lib/collections/constants";
import { missingCollectionWorkItemSchema } from "@/lib/collections/schema";
import type {
  CollectionsRecordedContact,
  CollectionsRecordedWorkItem,
  CollectionsWorklist,
  CollectionsWorklistItem,
} from "@/lib/collections/types";
import { ageInWholeDays, agingBucketForDays } from "@/lib/financial-intelligence/receivables";
import { formatMoney } from "@/lib/format";
import { invoiceNumberFromId } from "@/lib/invoice-document";
import {
  invoicePaymentBreakdown,
  listPaymentsGroupedByInvoiceId,
} from "@/lib/project-payments";

type CollectionsDb = PrismaClient | Prisma.TransactionClient;

export type LoadCollectionsWorklistInput = {
  now?: Date;
};

const INVOICE_SELECT = {
  id: true,
  businessId: true,
  customerId: true,
  jobId: true,
  kind: true,
  status: true,
  total: true,
  createdAt: true,
  customer: { select: { id: true, name: true } },
} as const;

const COMMUNICATION_SELECT = {
  id: true,
  customerId: true,
  createdAt: true,
  attemptedAt: true,
  channel: true,
  direction: true,
  status: true,
  purpose: true,
  relatedType: true,
  relatedId: true,
} as const;

const WORK_ITEM_SELECT = {
  id: true,
  invoiceId: true,
  status: true,
  nextStep: true,
  note: true,
  resolvedAt: true,
} as const;

type CommunicationRow = {
  id: string;
  customerId: string;
  createdAt: Date;
  attemptedAt: Date | null;
  channel: string;
  direction: string;
  status: string;
  purpose: string;
  relatedType: string | null;
  relatedId: string | null;
};

function moneyText(value: { toString(): string }) {
  return value.toString();
}

function communicationOccurredAt(row: { attemptedAt: Date | null; createdAt: Date }) {
  return row.attemptedAt ?? row.createdAt;
}

function preferLaterCommunication(left: CommunicationRow, right: CommunicationRow) {
  const leftAt = communicationOccurredAt(left).getTime();
  const rightAt = communicationOccurredAt(right).getTime();
  if (rightAt !== leftAt) return rightAt > leftAt ? right : left;
  return right.id > left.id ? right : left;
}

function toContact(row: CommunicationRow, invoiceId: string): CollectionsRecordedContact {
  return {
    occurredAt: communicationOccurredAt(row).toISOString(),
    channel: row.channel,
    purpose: row.purpose,
    status: row.status,
    direction: row.direction,
    relatedToThisInvoice: row.relatedType === "INVOICE" && row.relatedId === invoiceId,
  };
}

function isNextStep(value: string | null | undefined): value is CollectionsNextStep {
  return value === "CALL" || value === "EMAIL" || value === "WAIT" || value === "OTHER";
}

function isWorkItemStatus(value: string): value is CollectionsWorkItemStatus {
  return value === "OPEN" || value === "RESOLVED";
}

function toWorkItem(row: {
  id: string;
  status: string;
  nextStep: string | null;
  note: string;
  resolvedAt: Date | null;
}): CollectionsRecordedWorkItem | null {
  if (!isWorkItemStatus(row.status)) return null;
  const nextStep = isNextStep(row.nextStep) ? row.nextStep : null;
  return {
    id: row.id,
    status: row.status,
    nextStep,
    nextStepLabel: nextStep ? COLLECTIONS_NEXT_STEP_LABELS[nextStep] : null,
    note: row.note,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  };
}

function emptyWorklist(
  businessId: string,
  timeZone: string,
  unavailable: boolean,
): CollectionsWorklist {
  return {
    businessId,
    timeZone,
    queueLimit: COLLECTIONS_QUEUE_LIMIT,
    scanLimit: COLLECTIONS_SCAN_LIMIT,
    overflow: false,
    scannedInvoiceCount: 0,
    unpaidCount: 0,
    items: [],
    readOnly: true,
    mutationsOnLoad: false,
    unavailable,
  };
}

export async function loadCollectionsWorklist(
  db: CollectionsDb,
  access: BusinessAccess,
  input: LoadCollectionsWorklistInput = {},
): Promise<CollectionsWorklist> {
  assertCanReadCollectionsWorklist(access);
  const now = input.now ?? new Date();
  const businessId = access.businessId;

  const business = await db.business.findFirst({
    where: { id: businessId },
    select: { timezone: true },
  });
  const timeZone = resolveBusinessTimeZone(business);

  const invoices = await db.invoice.findMany({
    where: { businessId, status: "SENT" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: COLLECTIONS_SCAN_LIMIT,
    select: INVOICE_SELECT,
  });

  const paymentsByInvoiceId = await listPaymentsGroupedByInvoiceId(
    db,
    businessId,
    invoices.map((invoice) => ({ id: invoice.id, jobId: invoice.jobId, kind: invoice.kind })),
  );

  const unpaid = invoices
    .map((invoice) => {
      const breakdown = invoicePaymentBreakdown({
        status: invoice.status,
        total: invoice.total,
        payments: paymentsByInvoiceId.get(invoice.id) ?? [],
      });
      return { invoice, breakdown };
    })
    .filter((row) => row.invoice.status === "SENT" && row.breakdown.amountDue.gt(0))
    .sort((left, right) => {
      const created = left.invoice.createdAt.getTime() - right.invoice.createdAt.getTime();
      if (created !== 0) return created;
      if (right.breakdown.amountDue.gt(left.breakdown.amountDue)) return 1;
      if (left.breakdown.amountDue.gt(right.breakdown.amountDue)) return -1;
      return left.invoice.id.localeCompare(right.invoice.id);
    });

  const overflow =
    invoices.length >= COLLECTIONS_SCAN_LIMIT || unpaid.length > COLLECTIONS_QUEUE_LIMIT;
  const queued = unpaid.slice(0, COLLECTIONS_QUEUE_LIMIT);
  const customerIds = [
    ...new Set(queued.map((row) => row.invoice.customerId).filter((id): id is string => Boolean(id))),
  ];
  const invoiceIds = queued.map((row) => row.invoice.id);

  let workItemsUnavailable = false;
  let workItems: Array<{
    id: string;
    invoiceId: string;
    status: string;
    nextStep: string | null;
    note: string;
    resolvedAt: Date | null;
  }> = [];
  try {
    if (invoiceIds.length > 0) {
      workItems = await db.invoiceCollectionWorkItem.findMany({
        where: { businessId, invoiceId: { in: invoiceIds } },
        select: WORK_ITEM_SELECT,
      });
    }
  } catch (error) {
    if (!missingCollectionWorkItemSchema(error)) throw error;
    workItemsUnavailable = true;
  }

  const workItemByInvoiceId = new Map(workItems.map((row) => [row.invoiceId, row]));

  const communications: CommunicationRow[] =
    customerIds.length === 0
      ? []
      : await db.customerCommunication.findMany({
          where: { businessId, customerId: { in: customerIds } },
          orderBy: [{ attemptedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
          take: COLLECTIONS_COMMUNICATION_SCAN_LIMIT,
          select: COMMUNICATION_SELECT,
        });

  const latestByInvoiceId = new Map<string, CommunicationRow>();
  const latestByCustomerId = new Map<string, CommunicationRow>();
  for (const row of communications) {
    const currentCustomer = latestByCustomerId.get(row.customerId);
    latestByCustomerId.set(
      row.customerId,
      currentCustomer ? preferLaterCommunication(currentCustomer, row) : row,
    );
    if (row.relatedType === "INVOICE" && row.relatedId) {
      const currentInvoice = latestByInvoiceId.get(row.relatedId);
      latestByInvoiceId.set(
        row.relatedId,
        currentInvoice ? preferLaterCommunication(currentInvoice, row) : row,
      );
    }
  }

  const items: CollectionsWorklistItem[] = queued.map(({ invoice, breakdown }) => {
    const invoiceContact = latestByInvoiceId.get(invoice.id);
    const customerContact = invoice.customerId
      ? latestByCustomerId.get(invoice.customerId)
      : undefined;
    const contactRow = invoiceContact ?? customerContact ?? null;
    return {
      invoiceId: invoice.id,
      invoiceNumber: invoiceNumberFromId(invoice.id),
      invoiceHref: `/invoices/${invoice.id}`,
      customerId: invoice.customerId,
      customerName: invoice.customer?.name ?? "Customer",
      customerHref: invoice.customerId ? `/customers/${invoice.customerId}` : null,
      communicationsHref: invoice.customerId
        ? `/communications?customerId=${encodeURIComponent(invoice.customerId)}`
        : null,
      status: "SENT",
      invoiceTotal: moneyText(breakdown.total),
      amountPaid: moneyText(breakdown.amountPaid),
      amountDue: moneyText(breakdown.amountDue),
      invoiceTotalLabel: formatMoney(breakdown.total),
      amountPaidLabel: formatMoney(breakdown.amountPaid),
      amountDueLabel: formatMoney(breakdown.amountDue),
      issuedAt: invoice.createdAt.toISOString(),
      ageDays: ageInWholeDays(invoice.createdAt, now),
      agingBucket: agingBucketForDays(ageInWholeDays(invoice.createdAt, now)),
      dueDate: null,
      contact: contactRow ? toContact(contactRow, invoice.id) : null,
      workItem: workItemByInvoiceId.get(invoice.id)
        ? toWorkItem(workItemByInvoiceId.get(invoice.id)!)
        : null,
    };
  });

  return {
    businessId,
    timeZone,
    queueLimit: COLLECTIONS_QUEUE_LIMIT,
    scanLimit: COLLECTIONS_SCAN_LIMIT,
    overflow,
    scannedInvoiceCount: invoices.length,
    unpaidCount: unpaid.length,
    items,
    readOnly: true,
    mutationsOnLoad: false,
    unavailable: workItemsUnavailable,
  };
}

export function emptyCollectionsWorklist(businessId: string, timeZone = "America/New_York") {
  return emptyWorklist(businessId, timeZone, false);
}
