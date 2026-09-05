/**
 * Invoice carry-forward from a completed Job's approved commercial record.
 *
 * createInvoiceFromJob() copies these snapshots onto a new DRAFT Invoice.
 * It does not send, mark paid, or refresh prices from the live catalog.
 *
 * Source of truth for WHAT to bill:
 *   1. resolveApprovedWorkOrderScope() — the approved EstimateVersion
 *      (or the legacy live-estimate fallback)
 *   2. labor-minimum adjustment stored on that approved record
 *   3. Line items on currently APPROVED Change Orders only
 *
 * The Invoice.total is still resolveCurrentApprovedProjectTotal() computed
 * once at create (see src/app/actions/invoice.ts). Copied LineItem rows
 * are a commercial snapshot: later catalog / settings edits must not
 * rewrite them.
 */
import { Prisma, type LineItemType, type PrismaClient } from "@prisma/client";
import { resolveCurrentApprovedProjectTotal } from "@/lib/change-order";
import { resolveApprovedWorkOrderScope } from "@/lib/job-work-order";

const ZERO = new Prisma.Decimal(0);

export const LABOR_MINIMUM_INVOICE_DESCRIPTION =
  "Labor Minimum Service Fee Adjustment";

export type InvoiceSnapshotLineInput = {
  description: string;
  quantity: Prisma.Decimal | number | string;
  unitPrice: Prisma.Decimal | number | string;
  total: Prisma.Decimal | number | string;
  type: LineItemType;
  serviceCatalogItemId?: string | null;
};

export function toInvoiceDecimal(
  value: Prisma.Decimal | number | string | null | undefined,
): Prisma.Decimal {
  if (value instanceof Prisma.Decimal) {
    return value;
  }
  if (value == null || value === "") {
    return ZERO;
  }
  return new Prisma.Decimal(value);
}

export function buildInvoiceLineSnapshots(input: {
  approvedLineItems: readonly InvoiceSnapshotLineInput[];
  laborMinimumAdjustment?: Prisma.Decimal | number | string | null;
  approvedChangeOrderLineItems?: readonly InvoiceSnapshotLineInput[];
}): InvoiceSnapshotLineInput[] {
  const lines: InvoiceSnapshotLineInput[] = input.approvedLineItems.map(
    (line) => ({
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      total: line.total,
      type: line.type,
      serviceCatalogItemId: line.serviceCatalogItemId ?? null,
    }),
  );

  const laborMinimum = toInvoiceDecimal(input.laborMinimumAdjustment);
  if (laborMinimum.gt(0)) {
    lines.push({
      description: LABOR_MINIMUM_INVOICE_DESCRIPTION,
      quantity: 1,
      unitPrice: laborMinimum,
      total: laborMinimum,
      type: "OTHER",
      serviceCatalogItemId: null,
    });
  }

  for (const line of input.approvedChangeOrderLineItems ?? []) {
    lines.push({
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      total: line.total,
      type: line.type,
      serviceCatalogItemId: line.serviceCatalogItemId ?? null,
    });
  }

  return lines;
}

const INVOICE_LINE_SELECT = {
  description: true,
  quantity: true,
  unitPrice: true,
  total: true,
  type: true,
  serviceCatalogItemId: true,
} as const;

const VERSION_LINE_SELECT = {
  description: true,
  quantity: true,
  unitPrice: true,
  total: true,
  type: true,
} as const;

export const JOB_INVOICE_SCOPE_INCLUDE = {
  estimate: {
    select: {
      total: true,
      laborMinimumAdjustment: true,
      lineItems: {
        orderBy: { createdAt: "asc" as const },
        select: INVOICE_LINE_SELECT,
      },
    },
  },
  approvedEstimateVersion: {
    select: {
      versionNumber: true,
      total: true,
      laborMinimumAdjustment: true,
      approvedAt: true,
      lineItems: {
        orderBy: { createdAt: "asc" as const },
        select: VERSION_LINE_SELECT,
      },
    },
  },
  changeOrders: {
    select: {
      id: true,
      status: true,
      total: true,
      createdAt: true,
      lineItems: {
        orderBy: { createdAt: "asc" as const },
        select: INVOICE_LINE_SELECT,
      },
    },
  },
} as const;

export type InvoiceBackfillResult =
  | {
      ok: true;
      backfilled: false;
      reason:
        | "already-has-lines"
        | "no-invoice"
        | "no-job"
        | "no-scope"
        | "no-match";
    }
  | { ok: true; backfilled: true; lineCount: number };

export type BackfillChangeOrderCandidate = {
  id: string;
  createdAt: Date;
  lineItems: InvoiceSnapshotLineInput[];
};

export function snapshotLinesTotal(
  lines: readonly InvoiceSnapshotLineInput[],
): Prisma.Decimal {
  return lines.reduce(
    (sum, line) => sum.add(toInvoiceDecimal(line.total)),
    ZERO,
  );
}

/**
 * Choose the APPROVED Change Orders whose copied lines, plus the original
 * approved estimate (and labor-minimum snapshot), equal the invoice total.
 *
 * Prefers Change Orders that already existed when the invoice was created.
 * If that set does not match — for example a Change Order approved in the
 * same second as invoice create — grows prefixes in createdAt order until
 * the snapshot sum equals the stored Invoice.total.
 *
 * Returns null when no safe reconstruction exists. Never invents lines and
 * never includes DRAFT / SENT / DECLINED / CANCELLED Change Orders
 * (callers must pass only APPROVED candidates).
 */
export function selectApprovedChangeOrdersForInvoiceBackfill(input: {
  approvedLineItems: readonly InvoiceSnapshotLineInput[];
  laborMinimumAdjustment?: Prisma.Decimal | number | string | null;
  approvedChangeOrders: readonly BackfillChangeOrderCandidate[];
  invoiceCreatedAt: Date;
  invoiceTotal: Prisma.Decimal | number | string;
}): BackfillChangeOrderCandidate[] | null {
  const invoiceTotal = toInvoiceDecimal(input.invoiceTotal);
  const ordered = [...input.approvedChangeOrders].sort((a, b) => {
    const byTime = a.createdAt.getTime() - b.createdAt.getTime();
    return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
  });

  const matches = (changeOrders: BackfillChangeOrderCandidate[]) => {
    const lines = buildInvoiceLineSnapshots({
      approvedLineItems: input.approvedLineItems,
      laborMinimumAdjustment: input.laborMinimumAdjustment,
      approvedChangeOrderLineItems: changeOrders.flatMap(
        (changeOrder) => changeOrder.lineItems,
      ),
    });
    return snapshotLinesTotal(lines).eq(invoiceTotal);
  };

  const asOfInvoice = ordered.filter(
    (changeOrder) =>
      changeOrder.createdAt.getTime() <= input.invoiceCreatedAt.getTime(),
  );
  if (matches(asOfInvoice)) {
    return asOfInvoice;
  }

  for (let index = 0; index <= ordered.length; index += 1) {
    const prefix = ordered.slice(0, index);
    if (matches(prefix)) {
      return prefix;
    }
  }

  return null;
}

type InvoiceWriteClient = PrismaClient | Prisma.TransactionClient;

function canStartTransaction(
  db: InvoiceWriteClient,
): db is PrismaClient {
  return typeof (db as PrismaClient).$transaction === "function";
}

/**
 * Persist approved-scope snapshots onto an invoice that has zero LineItem
 * rows. Does not change Invoice.total, paidAt, payment method, or
 * payment reference. No-ops when lines already exist or reconstruction
 * would not equal the stored total.
 */
export async function backfillEmptyInvoiceWorkLines(
  db: InvoiceWriteClient,
  input: { businessId: string; invoiceId: string },
): Promise<InvoiceBackfillResult> {
  if (!input.businessId || !input.invoiceId) {
    return { ok: true, backfilled: false, reason: "no-invoice" };
  }

  if (canStartTransaction(db)) {
    return db.$transaction((tx) => persistEmptyInvoiceWorkLines(tx, input));
  }

  return persistEmptyInvoiceWorkLines(db, input);
}

/**
 * Token-scoped wrapper for the Customer Project Portal. Looks up the job
 * by projectToken only, then backfills that job's invoice if empty.
 */
export async function backfillEmptyInvoiceWorkLinesForProjectToken(
  db: PrismaClient,
  token: string,
): Promise<InvoiceBackfillResult> {
  if (!token) {
    return { ok: true, backfilled: false, reason: "no-invoice" };
  }

  const job = await db.job.findUnique({
    where: { projectToken: token },
    select: {
      invoices: {
        take: 1,
        orderBy: { createdAt: "asc" },
        select: { id: true, businessId: true },
      },
    },
  });

  const invoice = job?.invoices[0];
  if (!invoice) {
    return { ok: true, backfilled: false, reason: "no-invoice" };
  }

  return backfillEmptyInvoiceWorkLines(db, {
    businessId: invoice.businessId,
    invoiceId: invoice.id,
  });
}

async function persistEmptyInvoiceWorkLines(
  tx: InvoiceWriteClient,
  input: { businessId: string; invoiceId: string },
): Promise<InvoiceBackfillResult> {
  const invoice = await tx.invoice.findFirst({
    where: { id: input.invoiceId, businessId: input.businessId },
    select: {
      id: true,
      businessId: true,
      jobId: true,
      total: true,
      createdAt: true,
      _count: { select: { lineItems: true } },
    },
  });

  if (!invoice) {
    return { ok: true, backfilled: false, reason: "no-invoice" };
  }
  if (invoice._count.lineItems > 0) {
    return { ok: true, backfilled: false, reason: "already-has-lines" };
  }
  if (!invoice.jobId) {
    return { ok: true, backfilled: false, reason: "no-job" };
  }

  const job = await tx.job.findFirst({
    where: { id: invoice.jobId, businessId: input.businessId },
    include: JOB_INVOICE_SCOPE_INCLUDE,
  });

  if (!job) {
    return { ok: true, backfilled: false, reason: "no-job" };
  }

  const approvedScope = resolveApprovedWorkOrderScope(job);
  if (approvedScope.source === "none") {
    return { ok: true, backfilled: false, reason: "no-scope" };
  }

  const laborMinimumAdjustment =
    approvedScope.source === "version"
      ? approvedScope.laborMinimumAdjustment
      : (job.estimate?.laborMinimumAdjustment ?? ZERO);

  const approvedChangeOrders = job.changeOrders
    .filter((changeOrder) => changeOrder.status === "APPROVED")
    .map((changeOrder) => ({
      id: changeOrder.id,
      createdAt: changeOrder.createdAt,
      lineItems: changeOrder.lineItems,
    }));

  const selected = selectApprovedChangeOrdersForInvoiceBackfill({
    approvedLineItems: approvedScope.lineItems,
    laborMinimumAdjustment,
    approvedChangeOrders,
    invoiceCreatedAt: invoice.createdAt,
    invoiceTotal: invoice.total,
  });

  if (!selected) {
    return { ok: true, backfilled: false, reason: "no-match" };
  }

  const lines = buildInvoiceLineSnapshots({
    approvedLineItems: approvedScope.lineItems,
    laborMinimumAdjustment,
    approvedChangeOrderLineItems: selected.flatMap(
      (changeOrder) => changeOrder.lineItems,
    ),
  });

  if (!snapshotLinesTotal(lines).eq(invoice.total)) {
    return { ok: true, backfilled: false, reason: "no-match" };
  }

  const stillEmpty = await tx.lineItem.count({
    where: { invoiceId: invoice.id, businessId: invoice.businessId },
  });
  if (stillEmpty > 0) {
    return { ok: true, backfilled: false, reason: "already-has-lines" };
  }

  for (const line of lines) {
    await tx.lineItem.create({
      data: {
        businessId: invoice.businessId,
        invoiceId: invoice.id,
        serviceCatalogItemId: line.serviceCatalogItemId ?? null,
        description: line.description,
        quantity: toInvoiceDecimal(line.quantity),
        unitPrice: toInvoiceDecimal(line.unitPrice),
        total: toInvoiceDecimal(line.total),
        type: line.type,
      },
    });
  }

  return { ok: true, backfilled: true, lineCount: lines.length };
}

export type PersistDraftInvoiceResult =
  | { ok: true; invoiceId: string; reused: true }
  | { ok: true; invoiceId: string; reused: false; total: Prisma.Decimal }
  | { ok: false; error: string };

/**
 * Creates exactly one DRAFT invoice for a completed job, copying approved
 * commercial lines. Safe to call twice: the second call returns the
 * existing invoice (no second row, no extra line copies).
 */
export async function persistDraftInvoiceFromCompletedJob(
  db: PrismaClient,
  input: { businessId: string; jobId: string },
): Promise<PersistDraftInvoiceResult> {
  const job = await db.job.findFirst({
    where: { id: input.jobId, businessId: input.businessId },
    include: JOB_INVOICE_SCOPE_INCLUDE,
  });

  if (!job) {
    return { ok: false, error: "That job could not be found." };
  }

  if (job.status !== "COMPLETED") {
    return { ok: false, error: "Only a completed job can become an invoice." };
  }

  const approvedScope = resolveApprovedWorkOrderScope(job);
  if (approvedScope.source === "none") {
    return { ok: false, error: "This job has no linked estimate." };
  }

  return db.$transaction(async (tx) => {
    const existing = await tx.invoice.findFirst({
      where: { businessId: input.businessId, jobId: job.id },
      select: { id: true },
    });
    if (existing) {
      await backfillEmptyInvoiceWorkLines(tx, {
        businessId: input.businessId,
        invoiceId: existing.id,
      });
      return { ok: true as const, invoiceId: existing.id, reused: true as const };
    }

    const total = resolveCurrentApprovedProjectTotal(
      approvedScope.total,
      job.changeOrders,
    );

    const created = await tx.invoice.create({
      data: {
        businessId: input.businessId,
        customerId: job.customerId,
        jobId: job.id,
        total,
      },
    });

    const laborMinimumAdjustment =
      approvedScope.source === "version"
        ? approvedScope.laborMinimumAdjustment
        : (job.estimate?.laborMinimumAdjustment ?? ZERO);

    const approvedChangeOrderLineItems = job.changeOrders
      .filter((changeOrder) => changeOrder.status === "APPROVED")
      .flatMap((changeOrder) => changeOrder.lineItems);

    const lines = buildInvoiceLineSnapshots({
      approvedLineItems: approvedScope.lineItems,
      laborMinimumAdjustment,
      approvedChangeOrderLineItems,
    });

    for (const line of lines) {
      await tx.lineItem.create({
        data: {
          businessId: input.businessId,
          invoiceId: created.id,
          serviceCatalogItemId: line.serviceCatalogItemId ?? null,
          description: line.description,
          quantity: toInvoiceDecimal(line.quantity),
          unitPrice: toInvoiceDecimal(line.unitPrice),
          total: toInvoiceDecimal(line.total),
          type: line.type,
        },
      });
    }

    return {
      ok: true as const,
      invoiceId: created.id,
      reused: false as const,
      total,
    };
  });
}
