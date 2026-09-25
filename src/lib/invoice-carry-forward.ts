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
 * The first invoice is ORIGINAL: resolveCurrentApprovedProjectTotal()
 * computed once at create. A later approved Change Order is billed on a
 * SUPPLEMENTAL invoice. Copied LineItem rows are a commercial snapshot:
 * later catalog / settings edits must not rewrite them.
 */
import { Prisma, type LineItemType, type PrismaClient } from "@prisma/client";
import { resolveCurrentApprovedProjectTotal } from "@/lib/change-order";
import { resolveCustomerMaterialsTotal } from "@/lib/customer-materials-total";
import { resolveApprovedWorkOrderScope } from "@/lib/job-work-order";
import { attachEstimatePaymentsToInvoice } from "@/lib/project-payments";
import {
  INVOICE_KIND_ORIGINAL,
  INVOICE_KIND_SUPPLEMENTAL,
  billedChangeOrderIds,
  isOriginalInvoiceKind,
  originalInvoiceForJob,
  unbilledApprovedChangeOrders,
} from "@/lib/revenue-integrity";

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
      approvedAt: true,
      invoiceId: true,
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
  approvedAt?: Date | null;
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
 * Customer commercial total for an invoice snapshot: LABOR + OTHER + the
 * approved Final Customer Materials Total (override encoded on a copied
 * line description), not the raw MATERIAL line sum.
 *
 * Empty-invoice backfill must match Invoice.total this way. A $300
 * customer materials total with $289.18 of underlying material rows is
 * still a $1,100 invoice, not $1,089.18.
 */
export function invoiceCustomerPricingTotal(
  lines: readonly InvoiceSnapshotLineInput[],
): Prisma.Decimal {
  const labor = lines
    .filter((line) => line.type === "LABOR")
    .reduce((sum, line) => sum.add(toInvoiceDecimal(line.total)), ZERO);
  const other = lines
    .filter((line) => line.type === "OTHER")
    .reduce((sum, line) => sum.add(toInvoiceDecimal(line.total)), ZERO);
  const materials = resolveCustomerMaterialsTotal(
    lines.map((line) => ({
      type: line.type,
      total: line.total,
      description: line.description,
    })),
  );
  return labor.add(materials.amount).add(other);
}

/**
 * Choose the APPROVED Change Orders whose copied lines, plus the original
 * approved estimate (and labor-minimum snapshot), equal the invoice total.
 *
 * Prefers Change Orders whose recorded approvedAt is at or before the
 * invoice. createdAt is not approval time. If approval timing cannot be
 * proven, the Change Order is omitted from as-of reconstruction.
 *
 * If that set does not match — for example two COs approved before the
 * invoice but only one included in the frozen total — grows prefixes in
 * approvedAt order among that as-of set until the snapshot sum equals
 * the stored Invoice.total.
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
  const asOfInvoice = [...input.approvedChangeOrders]
    .filter((changeOrder) => {
      if (!changeOrder.approvedAt) return false;
      return changeOrder.approvedAt.getTime() <= input.invoiceCreatedAt.getTime();
    })
    .sort((a, b) => {
      const aTime = (a.approvedAt ?? a.createdAt).getTime();
      const bTime = (b.approvedAt ?? b.createdAt).getTime();
      return aTime !== bTime ? aTime - bTime : a.id.localeCompare(b.id);
    });

  const matches = (changeOrders: BackfillChangeOrderCandidate[]) => {
    const lines = buildInvoiceLineSnapshots({
      approvedLineItems: input.approvedLineItems,
      laborMinimumAdjustment: input.laborMinimumAdjustment,
      approvedChangeOrderLineItems: changeOrders.flatMap(
        (changeOrder) => changeOrder.lineItems,
      ),
    });
    return invoiceCustomerPricingTotal(lines).eq(invoiceTotal);
  };

  if (matches(asOfInvoice)) {
    return asOfInvoice;
  }

  for (let index = 0; index <= asOfInvoice.length; index += 1) {
    const prefix = asOfInvoice.slice(0, index);
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
      approvedAt: changeOrder.approvedAt,
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

  if (!invoiceCustomerPricingTotal(lines).eq(invoice.total)) {
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
  | { ok: true; invoiceId: string; reused: true; kind: string }
  | { ok: true; invoiceId: string; reused: false; total: Prisma.Decimal; kind: string }
  | { ok: false; error: string };

/**
 * Test-only barriers. Production never sets these.
 * - beforeCreateOriginal: concurrent first-invoice callers meet after
 *   both saw no ORIGINAL and before the unique insert.
 * - afterCreateSupplemental: concurrent balance callers meet after a
 *   SUPPLEMENTAL row is created and before Change Orders are claimed.
 */
export const persistDraftInvoiceTestHooks: {
  beforeCreateOriginal?: (input: {
    businessId: string;
    jobId: string;
  }) => Promise<void> | void;
  afterCreateSupplemental?: (input: {
    businessId: string;
    jobId: string;
    invoiceId: string;
    changeOrderIds: string[];
  }) => Promise<void> | void;
} = {};

const ORIGINAL_INVOICE_UNIQUE_INDEX = "Invoice_jobId_original_unique";

function prismaUniqueViolation(
  error: unknown,
): Prisma.PrismaClientKnownRequestError | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return error;
  }
  if (error && typeof error === "object" && "cause" in error) {
    return prismaUniqueViolation((error as { cause: unknown }).cause);
  }
  return null;
}

/**
 * True only when the unique ORIGINAL-per-job index rejected a create.
 * Unrelated Prisma unique violations (Payment, etc.) stay false.
 */
export function isOriginalInvoiceUniqueViolation(error: unknown): boolean {
  const unique = prismaUniqueViolation(error);
  if (!unique) return false;
  const model = String(unique.meta?.modelName ?? "");
  const target = unique.meta?.target;
  const parts = (Array.isArray(target) ? target : target != null ? [target] : []).map(
    (value) => String(value),
  );
  const joined = [...parts, unique.message ?? ""].join(" ").toLowerCase();
  if (joined.includes(ORIGINAL_INVOICE_UNIQUE_INDEX.toLowerCase())) {
    return true;
  }
  if (joined.includes("jobid_original")) {
    return true;
  }
  return model === "Invoice" && parts.some((part) => /^jobid$/i.test(part));
}

async function reuseOwnedOriginalInvoice(
  db: PrismaClient,
  input: { businessId: string; jobId: string },
): Promise<Extract<PersistDraftInvoiceResult, { ok: true; reused: true }> | null> {
  const winner = await db.invoice.findFirst({
    where: {
      businessId: input.businessId,
      jobId: input.jobId,
      kind: INVOICE_KIND_ORIGINAL,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, kind: true },
  });
  if (!winner || !isOriginalInvoiceKind(winner.kind)) {
    return null;
  }
  return {
    ok: true,
    invoiceId: winner.id,
    reused: true,
    kind: winner.kind,
  };
}

async function writeInvoiceLines(
  tx: InvoiceWriteClient,
  input: {
    businessId: string;
    invoiceId: string;
    lines: InvoiceSnapshotLineInput[];
  },
) {
  for (const line of input.lines) {
    await tx.lineItem.create({
      data: {
        businessId: input.businessId,
        invoiceId: input.invoiceId,
        serviceCatalogItemId: line.serviceCatalogItemId ?? null,
        description: line.description,
        quantity: toInvoiceDecimal(line.quantity),
        unitPrice: toInvoiceDecimal(line.unitPrice),
        total: toInvoiceDecimal(line.total),
        type: line.type,
      },
    });
  }
}

async function claimChangeOrdersOnInvoice(
  tx: InvoiceWriteClient,
  input: {
    businessId: string;
    invoiceId: string;
    changeOrderIds: string[];
  },
): Promise<string[]> {
  if (input.changeOrderIds.length === 0) return [];
  await tx.changeOrder.updateMany({
    where: {
      id: { in: input.changeOrderIds },
      businessId: input.businessId,
      status: "APPROVED",
      invoiceId: null,
    },
    data: { invoiceId: input.invoiceId },
  });
  const claimed = await tx.changeOrder.findMany({
    where: {
      id: { in: input.changeOrderIds },
      businessId: input.businessId,
      invoiceId: input.invoiceId,
    },
    select: { id: true },
  });
  return claimed.map((row) => row.id);
}

async function attachOriginalInvoicePayments(
  tx: InvoiceWriteClient,
  input: {
    businessId: string;
    estimateId: string | null;
    jobId: string;
    invoiceId: string;
  },
) {
  await backfillEmptyInvoiceWorkLines(tx, {
    businessId: input.businessId,
    invoiceId: input.invoiceId,
  });
  await attachEstimatePaymentsToInvoice(tx, {
    businessId: input.businessId,
    estimateId: input.estimateId,
    jobId: input.jobId,
    invoiceId: input.invoiceId,
  });
}

/**
 * Creates the ORIGINAL invoice when none exists, or a SUPPLEMENTAL invoice
 * for approved Change Orders that are not yet billed. Safe to call twice:
 * already-billed work is reused, never duplicated, and the original
 * invoice total is never rewritten.
 *
 * Concurrent first-ORIGINAL creates are serialized by
 * Invoice_jobId_original_unique. The losing transaction is not surfaced as
 * a unique-index error: it requeries the owned job ORIGINAL and returns
 * that winner with reused=true. Unrelated Prisma errors still throw.
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

  try {
    return await db.$transaction(async (tx) => {
    const existing = await tx.invoice.findMany({
      where: { businessId: input.businessId, jobId: job.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, status: true, kind: true, createdAt: true, total: true },
    });
    const changeOrders = await tx.changeOrder.findMany({
      where: { businessId: input.businessId, jobId: job.id },
      select: {
        id: true,
        status: true,
        total: true,
        createdAt: true,
        approvedAt: true,
        invoiceId: true,
        lineItems: {
          orderBy: { createdAt: "asc" },
          select: INVOICE_LINE_SELECT,
        },
      },
    });

    const laborMinimumAdjustment =
      approvedScope.source === "version"
        ? approvedScope.laborMinimumAdjustment
        : (job.estimate?.laborMinimumAdjustment ?? ZERO);

    if (existing.length === 0) {
      await persistDraftInvoiceTestHooks.beforeCreateOriginal?.({
        businessId: input.businessId,
        jobId: job.id,
      });
      const total = resolveCurrentApprovedProjectTotal(approvedScope.total, changeOrders);
      const created = await tx.invoice.create({
        data: {
          businessId: input.businessId,
          customerId: job.customerId,
          jobId: job.id,
          kind: INVOICE_KIND_ORIGINAL,
          total,
        },
      });

      const approvedChangeOrders = changeOrders.filter(
        (changeOrder) => changeOrder.status === "APPROVED",
      );
      const claimedIds = await claimChangeOrdersOnInvoice(tx, {
        businessId: input.businessId,
        invoiceId: created.id,
        changeOrderIds: approvedChangeOrders.map((changeOrder) => changeOrder.id),
      });
      const claimed = approvedChangeOrders.filter((changeOrder) =>
        claimedIds.includes(changeOrder.id),
      );
      const claimedTotal = resolveCurrentApprovedProjectTotal(approvedScope.total, claimed);
      if (!claimedTotal.eq(total)) {
        await tx.invoice.update({
          where: { id: created.id },
          data: { total: claimedTotal },
        });
      }

      const estimateLines = buildInvoiceLineSnapshots({
        approvedLineItems: approvedScope.lineItems,
        laborMinimumAdjustment,
      });
      await writeInvoiceLines(tx, {
        businessId: input.businessId,
        invoiceId: created.id,
        lines: estimateLines,
      });
      for (const changeOrder of claimed) {
        await writeInvoiceLines(tx, {
          businessId: input.businessId,
          invoiceId: created.id,
          lines: changeOrder.lineItems,
        });
      }

      await attachOriginalInvoicePayments(tx, {
        businessId: input.businessId,
        estimateId: job.estimateId,
        jobId: job.id,
        invoiceId: created.id,
      });

      return {
        ok: true as const,
        invoiceId: created.id,
        reused: false as const,
        total: claimedTotal,
        kind: INVOICE_KIND_ORIGINAL,
      };
    }

    const original = originalInvoiceForJob(existing);
    if (original && isOriginalInvoiceKind(original.kind)) {
      await attachOriginalInvoicePayments(tx, {
        businessId: input.businessId,
        estimateId: job.estimateId,
        jobId: job.id,
        invoiceId: original.id,
      });
    }

    const billed = billedChangeOrderIds({ invoices: existing, changeOrders });
    const legacyUnmarked = changeOrders.filter(
      (changeOrder) =>
        changeOrder.status === "APPROVED" &&
        !changeOrder.invoiceId &&
        billed.has(changeOrder.id) &&
        original,
    );
    if (legacyUnmarked.length > 0 && original) {
      await claimChangeOrdersOnInvoice(tx, {
        businessId: input.businessId,
        invoiceId: original.id,
        changeOrderIds: legacyUnmarked.map((changeOrder) => changeOrder.id),
      });
    }

    const freshChangeOrders = await tx.changeOrder.findMany({
      where: { businessId: input.businessId, jobId: job.id },
      select: {
        id: true,
        status: true,
        total: true,
        createdAt: true,
        approvedAt: true,
        invoiceId: true,
        lineItems: {
          orderBy: { createdAt: "asc" },
          select: INVOICE_LINE_SELECT,
        },
      },
    });
    const unbilled = unbilledApprovedChangeOrders({
      invoices: existing,
      changeOrders: freshChangeOrders,
    }).filter((changeOrder) => toInvoiceDecimal(changeOrder.total).gt(0));

    if (unbilled.length > 0) {
      const total = unbilled.reduce(
        (sum, changeOrder) => sum.add(toInvoiceDecimal(changeOrder.total)),
        ZERO,
      );
      const created = await tx.invoice.create({
        data: {
          businessId: input.businessId,
          customerId: job.customerId,
          jobId: job.id,
          kind: INVOICE_KIND_SUPPLEMENTAL,
          total,
        },
      });
      const changeOrderIds = unbilled.map((changeOrder) => changeOrder.id);
      await persistDraftInvoiceTestHooks.afterCreateSupplemental?.({
        businessId: input.businessId,
        jobId: job.id,
        invoiceId: created.id,
        changeOrderIds,
      });
      const claimedIds = await claimChangeOrdersOnInvoice(tx, {
        businessId: input.businessId,
        invoiceId: created.id,
        changeOrderIds,
      });

      if (claimedIds.length === 0) {
        await tx.invoice.delete({ where: { id: created.id } });
        const claimedNow = await tx.changeOrder.findMany({
          where: {
            id: { in: changeOrderIds },
            businessId: input.businessId,
            jobId: job.id,
          },
          select: { invoiceId: true },
        });
        const winningInvoiceIds = [
          ...new Set(
            claimedNow
              .map((row) => row.invoiceId)
              .filter((invoiceId): invoiceId is string => Boolean(invoiceId)),
          ),
        ];
        if (winningInvoiceIds.length !== 1) {
          return { ok: false, error: "That invoice could not be created." };
        }
        const winner = await tx.invoice.findFirst({
          where: {
            id: winningInvoiceIds[0],
            businessId: input.businessId,
            jobId: job.id,
          },
          select: { id: true, kind: true },
        });
        if (!winner) {
          return { ok: false, error: "That invoice could not be created." };
        }
        return {
          ok: true as const,
          invoiceId: winner.id,
          reused: true as const,
          kind: winner.kind,
        };
      }

      const claimed = unbilled.filter((changeOrder) => claimedIds.includes(changeOrder.id));
      const claimedTotal = claimed.reduce(
        (sum, changeOrder) => sum.add(toInvoiceDecimal(changeOrder.total)),
        ZERO,
      );
      if (!claimedTotal.eq(total)) {
        await tx.invoice.update({
          where: { id: created.id },
          data: { total: claimedTotal },
        });
      }
      for (const changeOrder of claimed) {
        await writeInvoiceLines(tx, {
          businessId: input.businessId,
          invoiceId: created.id,
          lines: changeOrder.lineItems,
        });
      }

      return {
        ok: true as const,
        invoiceId: created.id,
        reused: false as const,
        total: claimedTotal,
        kind: INVOICE_KIND_SUPPLEMENTAL,
      };
    }

    const draft = existing.find((invoice) => invoice.status === "DRAFT");
    if (draft) {
      return {
        ok: true as const,
        invoiceId: draft.id,
        reused: true as const,
        kind: draft.kind,
      };
    }

    const reused = original ?? existing[0];
    return {
      ok: true as const,
      invoiceId: reused.id,
      reused: true as const,
      kind: reused.kind,
    };
    });
  } catch (error) {
    if (!isOriginalInvoiceUniqueViolation(error)) {
      throw error;
    }
    const reused = await reuseOwnedOriginalInvoice(db, {
      businessId: input.businessId,
      jobId: job.id,
    });
    if (!reused) {
      throw error;
    }
    return reused;
  }
}
