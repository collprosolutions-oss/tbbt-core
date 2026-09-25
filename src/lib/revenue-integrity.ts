/**
 * Revenue / billing integrity helpers.
 *
 * Job → Invoice is one ORIGINAL invoice plus zero or more SUPPLEMENTAL
 * (balance) invoices. A Change Order is billed at most once via
 * ChangeOrder.invoiceId. Existing invoice totals are never rewritten.
 */
import { Prisma } from "@prisma/client";

export const INVOICE_KIND_ORIGINAL = "ORIGINAL";
export const INVOICE_KIND_SUPPLEMENTAL = "SUPPLEMENTAL";

export const COVERING_INVOICE_STATUSES = ["SENT", "PAID"] as const;

const ZERO = new Prisma.Decimal(0);

export function isCoveringInvoiceStatus(status: string): boolean {
  return status === "SENT" || status === "PAID";
}

export function isOriginalInvoiceKind(kind?: string | null): boolean {
  return kind !== INVOICE_KIND_SUPPLEMENTAL;
}

export function invoiceKindLabel(kind?: string | null): string {
  return kind === INVOICE_KIND_SUPPLEMENTAL ? "Balance invoice" : "Invoice";
}

export type BillingInvoiceLike = {
  id: string;
  status: string;
  kind?: string | null;
  createdAt: Date;
  total?: Prisma.Decimal | number | string;
};

export type BillingChangeOrderLike = {
  id: string;
  status: string;
  total: Prisma.Decimal | number | string;
  invoiceId?: string | null;
  createdAt: Date;
};

function toAmount(value: Prisma.Decimal | number | string | null | undefined): Prisma.Decimal {
  if (value instanceof Prisma.Decimal) return value;
  if (value == null || value === "") return ZERO;
  return new Prisma.Decimal(value);
}

export function sortInvoicesOldestFirst<T extends { createdAt: Date; id: string }>(
  invoices: readonly T[],
): T[] {
  return [...invoices].sort((a, b) => {
    const byTime = a.createdAt.getTime() - b.createdAt.getTime();
    return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
  });
}

export function originalInvoiceForJob<T extends BillingInvoiceLike>(
  invoices: readonly T[],
): T | null {
  const originals = invoices.filter((invoice) => isOriginalInvoiceKind(invoice.kind));
  const list = originals.length > 0 ? originals : invoices;
  return sortInvoicesOldestFirst(list)[0] ?? null;
}

/**
 * Customer portal / checkout: first SENT invoice (oldest), else the oldest
 * customer-visible invoice. DRAFT is never returned.
 */
export function selectPortalInvoice<T extends { id: string; status: string; createdAt: Date }>(
  invoices: readonly T[],
): T | null {
  const ordered = sortInvoicesOldestFirst(invoices);
  return (
    ordered.find((invoice) => invoice.status === "SENT") ??
    ordered.find((invoice) => invoice.status === "PAID") ??
    null
  );
}

export function billedChangeOrderIds(input: {
  invoices: readonly BillingInvoiceLike[];
  changeOrders: readonly BillingChangeOrderLike[];
}): Set<string> {
  const invoiceIds = new Set(input.invoices.map((invoice) => invoice.id));
  const original = originalInvoiceForJob(input.invoices);
  const billed = new Set<string>();

  for (const changeOrder of input.changeOrders) {
    if (changeOrder.status !== "APPROVED") continue;
    if (changeOrder.invoiceId && invoiceIds.has(changeOrder.invoiceId)) {
      billed.add(changeOrder.id);
      continue;
    }
    if (
      !changeOrder.invoiceId &&
      original &&
      changeOrder.createdAt.getTime() <= original.createdAt.getTime()
    ) {
      billed.add(changeOrder.id);
    }
  }
  return billed;
}

export function coveringBilledChangeOrderIds(input: {
  invoices: readonly BillingInvoiceLike[];
  changeOrders: readonly BillingChangeOrderLike[];
}): Set<string> {
  const covering = new Map(
    input.invoices
      .filter((invoice) => isCoveringInvoiceStatus(invoice.status))
      .map((invoice) => [invoice.id, invoice]),
  );
  const original = originalInvoiceForJob(input.invoices);
  const billed = new Set<string>();

  for (const changeOrder of input.changeOrders) {
    if (changeOrder.status !== "APPROVED") continue;
    if (changeOrder.invoiceId && covering.has(changeOrder.invoiceId)) {
      billed.add(changeOrder.id);
      continue;
    }
    if (
      !changeOrder.invoiceId &&
      original &&
      isCoveringInvoiceStatus(original.status) &&
      changeOrder.createdAt.getTime() <= original.createdAt.getTime()
    ) {
      billed.add(changeOrder.id);
    }
  }
  return billed;
}

export function unbilledApprovedChangeOrders<T extends BillingChangeOrderLike>(input: {
  invoices: readonly BillingInvoiceLike[];
  changeOrders: readonly T[];
}): T[] {
  const billed = billedChangeOrderIds(input);
  return input.changeOrders.filter(
    (changeOrder) => changeOrder.status === "APPROVED" && !billed.has(changeOrder.id),
  );
}

export function jobHasBillableApprovedWork(input: {
  originalApprovedTotal?: Prisma.Decimal | number | string | null;
  approvedChangeOrders: readonly { total: Prisma.Decimal | number | string }[];
}): boolean {
  if (toAmount(input.originalApprovedTotal).gt(0)) return true;
  return input.approvedChangeOrders.some((changeOrder) => toAmount(changeOrder.total).gt(0));
}

export type CompletedUnbilledReason =
  | "no-covering-invoice"
  | "draft-only-invoice"
  | "unbilled-change-orders";

export type CompletedJobBillingAttention =
  | { unbilled: false }
  | {
      unbilled: true;
      reason: CompletedUnbilledReason;
      detail: string;
      unbilledAmount: Prisma.Decimal;
    };

export function completedJobBillingAttention(input: {
  jobStatus: string;
  originalApprovedTotal?: Prisma.Decimal | number | string | null;
  invoices: readonly BillingInvoiceLike[];
  changeOrders: readonly BillingChangeOrderLike[];
}): CompletedJobBillingAttention {
  if (input.jobStatus !== "COMPLETED") {
    return { unbilled: false };
  }

  const approvedChangeOrders = input.changeOrders.filter(
    (changeOrder) => changeOrder.status === "APPROVED",
  );
  if (
    !jobHasBillableApprovedWork({
      originalApprovedTotal: input.originalApprovedTotal,
      approvedChangeOrders,
    })
  ) {
    return { unbilled: false };
  }

  const original = originalInvoiceForJob(input.invoices);
  const coveringBilled = coveringBilledChangeOrderIds(input);
  const coveringUnbilledCos = approvedChangeOrders.filter(
    (changeOrder) => !coveringBilled.has(changeOrder.id),
  );
  const originalCovered = Boolean(original && isCoveringInvoiceStatus(original.status));
  const originalAmount = originalCovered ? ZERO : toAmount(input.originalApprovedTotal);
  const unbilledAmount = coveringUnbilledCos.reduce(
    (sum, changeOrder) => sum.add(toAmount(changeOrder.total)),
    originalAmount,
  );

  if (originalCovered && coveringUnbilledCos.length === 0) {
    return { unbilled: false };
  }

  if (!original) {
    return {
      unbilled: true,
      reason: "no-covering-invoice",
      detail: "Completed job has unbilled approved work",
      unbilledAmount,
    };
  }

  if (!originalCovered) {
    return {
      unbilled: true,
      reason: "draft-only-invoice",
      detail: "Completed job invoice has not been sent",
      unbilledAmount,
    };
  }

  return {
    unbilled: true,
    reason: "unbilled-change-orders",
    detail: "Completed job has approved work not yet billed",
    unbilledAmount,
  };
}

export function listCompletedUnbilledJobs<
  TJob extends {
    id: string;
    status: string;
    customerId?: string | null;
    estimateId?: string | null;
  },
>(input: {
  jobs: readonly TJob[];
  invoices: readonly (BillingInvoiceLike & { jobId?: string | null })[];
  changeOrders: readonly (BillingChangeOrderLike & { jobId: string })[];
  estimates?: readonly { id: string; total: Prisma.Decimal | number | string }[];
}): Array<{ job: TJob; attention: Extract<CompletedJobBillingAttention, { unbilled: true }> }> {
  const estimateTotal = new Map(
    (input.estimates ?? []).map((estimate) => [estimate.id, estimate.total]),
  );
  const invoicesByJob = new Map<string, BillingInvoiceLike[]>();
  for (const invoice of input.invoices) {
    if (!invoice.jobId) continue;
    const list = invoicesByJob.get(invoice.jobId) ?? [];
    list.push(invoice);
    invoicesByJob.set(invoice.jobId, list);
  }
  const changeOrdersByJob = new Map<string, BillingChangeOrderLike[]>();
  for (const changeOrder of input.changeOrders) {
    const list = changeOrdersByJob.get(changeOrder.jobId) ?? [];
    list.push(changeOrder);
    changeOrdersByJob.set(changeOrder.jobId, list);
  }

  const rows: Array<{
    job: TJob;
    attention: Extract<CompletedJobBillingAttention, { unbilled: true }>;
  }> = [];
  for (const job of input.jobs) {
    const attention = completedJobBillingAttention({
      jobStatus: job.status,
      originalApprovedTotal: job.estimateId ? estimateTotal.get(job.estimateId) : null,
      invoices: invoicesByJob.get(job.id) ?? [],
      changeOrders: changeOrdersByJob.get(job.id) ?? [],
    });
    if (attention.unbilled) {
      rows.push({ job, attention });
    }
  }
  return rows;
}
