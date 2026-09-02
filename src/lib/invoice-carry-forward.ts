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
      status: true,
      total: true,
      lineItems: {
        orderBy: { createdAt: "asc" as const },
        select: INVOICE_LINE_SELECT,
      },
    },
  },
} as const;

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
