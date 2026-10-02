/**
 * One-job money proof.
 *
 * Independently sums recorded EstimateVersion, Payment, InvoiceCredit,
 * Invoice, and InvoiceCheckoutSession rows, then compares every displayed
 * helper the owner/customer surfaces use: estimate snapshot / deposit
 * summary, invoice payment breakdown, collected cash, profitability
 * billed/collected/outstanding, accounting export paid/remaining, and
 * Stripe stale-checkout refund-review flags.
 *
 * Remaining due and per-invoice collected use paymentBelongsToInvoice
 * (explicit invoiceId, else ORIGINAL job-only fallback). Credits never
 * count as collected cash. A Payment row is never invented from status.
 */
import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import {
  accountingInvoicePaymentTotals,
  type AccountingInvoiceCreditRecord,
  type AccountingInvoiceRecord,
  type AccountingPaymentRecord,
} from "@/lib/accounting-export";
import {
  collectedForJob,
  resolveCollectedCash,
  type CollectedCashCredit,
  type CollectedCashInvoice,
  type CollectedCashPayment,
} from "@/lib/collected-cash";
import { emptyLaborBurdenConfig } from "@/lib/financial-intelligence/labor-burden";
import { calculateJobProfitability } from "@/lib/financial-intelligence/job-profitability";
import {
  collectedRevenueForJob,
  invoiceBalanceDue,
  invoiceIsCreditClosed,
  type CollectedInvoice,
  type CollectedInvoiceCredit,
  type CollectedPayment,
} from "@/lib/financial-intelligence/collected-revenue";
import type { FinancialSource } from "@/lib/financial-intelligence/source";
import { getFinanceConnectionProvider } from "@/lib/finance-connections";
import { suggestedMaterialDeposit } from "@/lib/material-deposit";
import { paymentsBelongingToInvoice } from "@/lib/payment-attribution";
import {
  isStripeCreditMismatchReviewNote,
  paymentsNeedingStripeCreditMismatchReview,
} from "@/lib/payments/service";
import {
  PAYMENT_PURPOSE_MATERIAL_DEPOSIT,
  buildProjectPaymentSummary,
  invoicePaymentBreakdown,
} from "@/lib/project-payments";
import { asNumber, outstandingRemaining } from "@/lib/reports";
import { isOriginalInvoiceKind } from "@/lib/revenue-integrity";
import { roundMoney } from "@/lib/time-cards";

const ZERO = new Prisma.Decimal(0);

export type JobMoneyMoney = Prisma.Decimal | number | string | null | undefined;

export type JobMoneyMismatch = {
  surface: string;
  field: string;
  displayed: string;
  recorded: string;
};

export type JobMoneyEstimateLine = {
  type: string;
  total: JobMoneyMoney;
  description?: string | null;
  quantity?: JobMoneyMoney;
  unitPrice?: JobMoneyMoney;
};

export type JobMoneyInvoice = {
  id: string;
  kind?: string | null;
  status: string;
  total: JobMoneyMoney;
  jobId?: string | null;
  customerId?: string | null;
  paymentMethod?: string | null;
  paymentReference?: string | null;
  paidAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
  lineItems?: Array<{ total: JobMoneyMoney }>;
};

export type JobMoneyPayment = {
  id: string;
  amount: JobMoneyMoney;
  purpose: string;
  method: string;
  invoiceId?: string | null;
  jobId?: string | null;
  estimateId?: string | null;
  customerId?: string | null;
  note?: string | null;
  stripeCheckoutSessionId?: string | null;
  stripeCreditMismatchResolvedAt?: Date | null;
  receivedAt?: Date;
  createdAt?: Date;
};

export type JobMoneyCredit = {
  id?: string;
  invoiceId: string;
  amount: JobMoneyMoney;
};

export type JobMoneyCheckoutSession = {
  id?: string;
  invoiceId: string;
  stripeSessionId: string;
  amountCents: number;
};

export type JobMoneyRecords = {
  businessId: string;
  jobId: string;
  estimate?: {
    id: string;
    status: string;
    total: JobMoneyMoney;
    approvedVersionId?: string | null;
    approvedVersion?: {
      id: string;
      total: JobMoneyMoney;
      versionNumber?: number;
      lineItems: JobMoneyEstimateLine[];
    } | null;
    liveLines?: JobMoneyEstimateLine[];
  } | null;
  invoices: JobMoneyInvoice[];
  payments: JobMoneyPayment[];
  credits: JobMoneyCredit[];
  checkoutSessions?: JobMoneyCheckoutSession[];
  changeOrders?: Array<{ id: string; status: string; total: JobMoneyMoney; invoiceId?: string | null }>;
};

export type JobMoneyInvoiceProof = {
  invoiceId: string;
  kind: string;
  status: string;
  recordedTotal: number;
  recordedPaid: number;
  recordedCredit: number;
  recordedDue: number;
  recordedCollected: number;
  creditClosed: boolean;
  refundReviewCount: number;
  checkoutSessionCount: number;
};

export type JobMoneyProof = {
  ok: boolean;
  mismatches: JobMoneyMismatch[];
  snapshotTotal: number;
  snapshotLineSum: number;
  depositRequired: number;
  depositPaid: number;
  depositRemaining: number;
  billedRevenue: number;
  collectedCash: number;
  outstandingReceivable: number;
  refundReviewCount: number;
  invoices: JobMoneyInvoiceProof[];
};

function toDecimal(value: JobMoneyMoney) {
  if (value instanceof Prisma.Decimal) return value;
  if (value == null || value === "") return ZERO;
  return new Prisma.Decimal(value.toString());
}

export function jobMoneyText(value: JobMoneyMoney) {
  return toDecimal(value).toFixed(2);
}

function moneyNumber(value: JobMoneyMoney) {
  return roundMoney(asNumber(toDecimal(value)));
}

function demandMoney(
  mismatches: JobMoneyMismatch[],
  surface: string,
  field: string,
  displayed: JobMoneyMoney,
  recorded: JobMoneyMoney,
) {
  const left = jobMoneyText(displayed);
  const right = jobMoneyText(recorded);
  if (left !== right) {
    mismatches.push({ surface, field, displayed: left, recorded: right });
  }
}

function demandCount(
  mismatches: JobMoneyMismatch[],
  surface: string,
  field: string,
  displayed: number,
  recorded: number,
) {
  if (displayed !== recorded) {
    mismatches.push({
      surface,
      field,
      displayed: String(displayed),
      recorded: String(recorded),
    });
  }
}

export function recordedInvoiceArithmetic(
  invoice: JobMoneyInvoice,
  payments: readonly JobMoneyPayment[],
  credits: readonly JobMoneyCredit[],
) {
  const allocated = paymentsBelongingToInvoice(
    { id: invoice.id, jobId: invoice.jobId ?? null, kind: invoice.kind ?? null },
    payments,
  );
  const invoiceCredits = credits.filter((credit) => credit.invoiceId === invoice.id);
  const breakdown = invoicePaymentBreakdown({
    status: invoice.status,
    total: toDecimal(invoice.total),
    payments: allocated.map((payment) => ({
      purpose: payment.purpose,
      amount: toDecimal(payment.amount),
    })),
    credits: invoiceCredits.map((credit) => ({ amount: toDecimal(credit.amount) })),
  });
  return {
    allocated,
    credits: invoiceCredits,
    breakdown,
    total: moneyNumber(breakdown.total),
    paid: moneyNumber(breakdown.amountPaid),
    credit: moneyNumber(breakdown.recordedCredit),
    due: moneyNumber(breakdown.amountDue),
    overage: moneyNumber(breakdown.credit),
    legacyFullyPaid: breakdown.legacyFullyPaid,
  };
}

function collectedInvoice(invoice: JobMoneyInvoice): CollectedInvoice & CollectedCashInvoice {
  return {
    id: invoice.id,
    status: invoice.status,
    total: moneyNumber(invoice.total),
    jobId: invoice.jobId ?? null,
    kind: invoice.kind ?? null,
    customerId: invoice.customerId ?? null,
    paymentMethod: invoice.paymentMethod ?? null,
    paymentReference: invoice.paymentReference ?? null,
    paidAt: invoice.paidAt ?? null,
  };
}

function collectedPayment(payment: JobMoneyPayment): CollectedPayment & CollectedCashPayment {
  return {
    id: payment.id,
    amount: moneyNumber(payment.amount),
    invoiceId: payment.invoiceId ?? null,
    jobId: payment.jobId ?? null,
    customerId: payment.customerId ?? null,
    receivedAt: payment.receivedAt ?? new Date(0),
  };
}

function collectedCredit(credit: JobMoneyCredit): CollectedInvoiceCredit & CollectedCashCredit {
  return {
    id: credit.id,
    invoiceId: credit.invoiceId,
    amount: moneyNumber(credit.amount),
  };
}

function profitabilitySource(records: JobMoneyRecords): FinancialSource {
  const now = new Date();
  return {
    businessId: records.businessId,
    invoices: records.invoices.map((invoice) => ({
      id: invoice.id,
      businessId: records.businessId,
      status: invoice.status,
      total: moneyNumber(invoice.total),
      paidAt: invoice.paidAt ?? null,
      createdAt: invoice.createdAt ?? now,
      customerId: invoice.customerId ?? null,
      jobId: invoice.jobId ?? records.jobId,
      kind: invoice.kind ?? null,
      paymentMethod: invoice.paymentMethod ?? null,
      paymentReference: invoice.paymentReference ?? null,
    })),
    customers: [],
    jobs: [
      {
        id: records.jobId,
        status: "COMPLETED",
        createdAt: now,
        customerId: records.invoices[0]?.customerId ?? null,
        estimateId: records.estimate?.id ?? null,
      },
    ],
    estimates: records.estimate
      ? [
          {
            id: records.estimate.id,
            status: records.estimate.status,
            total: moneyNumber(records.estimate.approvedVersion?.total ?? records.estimate.total),
            createdAt: now,
            customerId: records.invoices[0]?.customerId ?? null,
            serviceRequestId: null,
          },
        ]
      : [],
    serviceRequests: [],
    catalogItems: [],
    estimateLineItems: [],
    approvedTimeEntries: [],
    payrollRuns: [],
    memberships: [],
    expenses: [],
    payments: records.payments.map((payment) => ({
      id: payment.id,
      businessId: records.businessId,
      customerId: payment.customerId ?? null,
      jobId: payment.jobId ?? records.jobId,
      invoiceId: payment.invoiceId ?? null,
      purpose: payment.purpose,
      amount: moneyNumber(payment.amount),
      method: payment.method,
      receivedAt: payment.receivedAt ?? now,
      note: payment.note ?? null,
      stripeCreditMismatchResolvedAt: payment.stripeCreditMismatchResolvedAt ?? null,
    })),
    invoiceCredits: records.credits.map((credit) => ({
      id: credit.id,
      invoiceId: credit.invoiceId,
      amount: moneyNumber(credit.amount),
    })),
    changeOrders: (records.changeOrders ?? []).map((order) => ({
      id: order.id,
      jobId: records.jobId,
      status: order.status,
      total: moneyNumber(order.total),
      approvedAt: order.status === "APPROVED" ? now : null,
    })),
    estimateLines: (records.estimate?.approvedVersion?.lineItems ?? []).map((line) => ({
      estimateId: records.estimate?.id ?? "",
      type: line.type,
      quantity: moneyNumber(line.quantity ?? 1),
      total: moneyNumber(line.total),
      description: line.description ?? null,
      fromApprovedVersion: true,
    })),
    laborBurden: emptyLaborBurdenConfig(),
    financeConnections: getFinanceConnectionProvider().status(),
    recurringPatterns: [],
  };
}

export function proveJobMoney(records: JobMoneyRecords): JobMoneyProof {
  const mismatches: JobMoneyMismatch[] = [];
  const snapshotLines = records.estimate?.approvedVersion?.lineItems ?? [];
  const snapshotTotal = moneyNumber(records.estimate?.approvedVersion?.total ?? 0);
  const snapshotLineSum = roundMoney(snapshotLines.reduce((sum, line) => sum + moneyNumber(line.total), 0));
  if (records.estimate?.approvedVersion) {
    demandMoney(mismatches, "estimate-snapshot", "version-total-vs-lines", snapshotTotal, snapshotLineSum);
  }

  const depositRequired = moneyNumber(
    suggestedMaterialDeposit(
      snapshotLines.map((line) => ({
        type: line.type,
        total: toDecimal(line.total),
        description: line.description ?? "",
      })),
    ),
  );
  const depositPayments = records.payments.filter(
    (payment) => payment.purpose === PAYMENT_PURPOSE_MATERIAL_DEPOSIT,
  );
  const depositPaid = roundMoney(depositPayments.reduce((sum, payment) => sum + moneyNumber(payment.amount), 0));
  const estimateTotal = moneyNumber(
    records.estimate?.approvedVersion?.total ?? records.estimate?.total ?? 0,
  );
  const depositSummary = buildProjectPaymentSummary({
    estimateTotal,
    requiredDeposit: depositRequired,
    payments: records.payments.map((payment) => ({
      id: payment.id,
      purpose: payment.purpose,
      amount: toDecimal(payment.amount),
      method: payment.method,
      receivedAt: payment.receivedAt ?? new Date(0),
      note: payment.note ?? null,
    })),
  });
  demandMoney(mismatches, "deposit", "required", depositSummary.requiredDeposit, depositRequired);
  demandMoney(mismatches, "deposit", "paid", depositSummary.depositPaid, depositPaid);
  demandMoney(
    mismatches,
    "deposit",
    "remaining",
    depositSummary.depositRemaining,
    Math.max(0, depositRequired - depositPaid),
  );

  const collectedInvoices = records.invoices.map(collectedInvoice);
  const collectedPayments = records.payments.map(collectedPayment);
  const collectedCredits = records.credits.map(collectedCredit);
  const cash = resolveCollectedCash({
    invoices: collectedInvoices,
    payments: collectedPayments,
    credits: collectedCredits,
  });
  const jobCash = collectedForJob({
    jobId: records.jobId,
    invoices: collectedInvoices,
    payments: collectedPayments,
    credits: collectedCredits,
  });
  const profitCollected = collectedRevenueForJob({
    jobId: records.jobId,
    invoices: collectedInvoices,
    payments: collectedPayments,
    credits: collectedCredits,
  });
  const recordedCollected = roundMoney(
    records.payments.reduce((sum, payment) => sum + moneyNumber(payment.amount), 0) +
      records.invoices.reduce((sum, invoice) => {
        const rows = paymentsBelongingToInvoice(
          { id: invoice.id, jobId: invoice.jobId ?? records.jobId, kind: invoice.kind ?? null },
          records.payments,
        );
        if (rows.length > 0) return sum;
        if (
          invoiceIsCreditClosed(
            collectedInvoice(invoice),
            collectedCredits,
          )
        ) {
          return sum;
        }
        if (invoice.status === "PAID") return sum + moneyNumber(invoice.total);
        return sum;
      }, 0),
  );

  demandMoney(mismatches, "collected-cash", "resolveCollectedCash", cash.totalCollected, recordedCollected);
  demandMoney(mismatches, "collected-cash", "collectedForJob", jobCash.collected, recordedCollected);
  demandMoney(mismatches, "collected-cash", "collectedRevenueForJob", profitCollected, recordedCollected);

  const billedInvoices = records.invoices.filter(
    (invoice) => invoice.status === "SENT" || invoice.status === "PAID",
  );
  const billedRevenue = roundMoney(billedInvoices.reduce((sum, invoice) => sum + moneyNumber(invoice.total), 0));
  const outstanding = outstandingRemaining(
    collectedInvoices.map((invoice) => ({
      id: invoice.id,
      businessId: records.businessId,
      status: invoice.status,
      total: invoice.total,
      paidAt: invoice.paidAt ?? null,
      createdAt: records.invoices.find((row) => row.id === invoice.id)?.createdAt ?? new Date(0),
      customerId: invoice.customerId ?? null,
      jobId: invoice.jobId ?? records.jobId,
      kind: invoice.kind ?? null,
      paymentMethod: invoice.paymentMethod ?? null,
      paymentReference: invoice.paymentReference ?? null,
    })),
    collectedPayments,
    collectedCredits,
  );
  const profitOutstanding = roundMoney(
    records.invoices
      .filter((invoice) => invoice.status === "SENT")
      .reduce(
        (sum, invoice) =>
          sum + invoiceBalanceDue(collectedInvoice(invoice), collectedPayments, collectedCredits),
        0,
      ),
  );
  demandMoney(mismatches, "receivable", "outstandingRemaining", outstanding.amount, profitOutstanding);

  const invoiceProofs: JobMoneyInvoiceProof[] = records.invoices.map((invoice) => {
    const recorded = recordedInvoiceArithmetic(invoice, records.payments, records.credits);
    const lineSum = (invoice.lineItems ?? []).reduce((sum, line) => sum + moneyNumber(line.total), 0);
    if (invoice.lineItems) {
      demandMoney(mismatches, `invoice:${invoice.id}`, "total-vs-lines", invoice.total, lineSum);
    }
    demandMoney(
      mismatches,
      `invoice:${invoice.id}`,
      "amountPaid",
      recorded.breakdown.amountPaid,
      recorded.paid,
    );
    demandMoney(
      mismatches,
      `invoice:${invoice.id}`,
      "amountDue",
      recorded.breakdown.amountDue,
      recorded.due,
    );
    demandMoney(
      mismatches,
      `invoice:${invoice.id}`,
      "recordedCredit",
      recorded.breakdown.recordedCredit,
      recorded.credit,
    );

    const profitDue = invoiceBalanceDue(
      collectedInvoice(invoice),
      collectedPayments,
      collectedCredits,
    );
    demandMoney(mismatches, `invoice:${invoice.id}`, "invoiceBalanceDue", profitDue, recorded.due);

    const accounting = accountingInvoicePaymentTotals(
      {
        id: invoice.id,
        jobId: invoice.jobId ?? records.jobId,
        kind: invoice.kind ?? null,
        status: invoice.status,
        total: toDecimal(invoice.total),
      } satisfies Pick<AccountingInvoiceRecord, "id" | "jobId" | "kind" | "status" | "total">,
      records.payments.map(
        (payment) =>
          ({
            id: payment.id,
            customerId: payment.customerId ?? null,
            invoiceId: payment.invoiceId ?? null,
            jobId: payment.jobId ?? null,
            purpose: payment.purpose,
            amount: toDecimal(payment.amount),
            method: payment.method,
            receivedAt: payment.receivedAt ?? new Date(0),
            note: payment.note ?? null,
            createdAt: payment.createdAt ?? new Date(0),
          }) satisfies AccountingPaymentRecord,
      ),
      records.credits.map(
        (credit) =>
          ({
            id: credit.id ?? "",
            invoiceId: credit.invoiceId,
            amount: toDecimal(credit.amount),
          }) satisfies AccountingInvoiceCreditRecord,
      ),
    );
    demandMoney(mismatches, `invoice:${invoice.id}`, "export-amountPaid", accounting.amountPaid, recorded.paid);
    demandMoney(mismatches, `invoice:${invoice.id}`, "export-amountRemaining", accounting.amountRemaining, recorded.due);

    const cashForInvoice = cash.byInvoiceId.get(invoice.id);
    const recordedInvoiceCollected = recorded.legacyFullyPaid
      ? recorded.total
      : recorded.paid;
    demandMoney(
      mismatches,
      `invoice:${invoice.id}`,
      "collected-cash",
      cashForInvoice?.amount ?? 0,
      recordedInvoiceCollected,
    );

    const reviews = paymentsNeedingStripeCreditMismatchReview(recorded.allocated);
    const sessions = (records.checkoutSessions ?? []).filter(
      (session) => session.invoiceId === invoice.id,
    );
    const sessionPaymentIds = new Set(
      recorded.allocated
        .map((payment) => payment.stripeCheckoutSessionId)
        .filter((id): id is string => Boolean(id)),
    );
    demandCount(
      mismatches,
      `invoice:${invoice.id}`,
      "unique-checkout-payments",
      sessionPaymentIds.size,
      recorded.allocated.filter((payment) => payment.stripeCheckoutSessionId).length,
    );

    if (isOriginalInvoiceKind(invoice.kind) && records.estimate?.approvedVersion && !records.changeOrders?.length) {
      demandMoney(mismatches, `invoice:${invoice.id}`, "matches-snapshot", invoice.total, snapshotTotal);
    }

    return {
      invoiceId: invoice.id,
      kind: invoice.kind ?? "ORIGINAL",
      status: invoice.status,
      recordedTotal: recorded.total,
      recordedPaid: recorded.paid,
      recordedCredit: recorded.credit,
      recordedDue: recorded.due,
      recordedCollected: recordedInvoiceCollected,
      creditClosed: invoiceIsCreditClosed(collectedInvoice(invoice), collectedCredits),
      refundReviewCount: reviews.length,
      checkoutSessionCount: sessions.length,
    };
  });

  const profit = calculateJobProfitability(records.jobId, profitabilitySource(records));
  if (profit) {
    demandMoney(mismatches, "profitability", "billedRevenue", profit.billedRevenue, billedRevenue);
    demandMoney(mismatches, "profitability", "collectedRevenue", profit.collectedRevenue, recordedCollected);
    demandMoney(
      mismatches,
      "profitability",
      "outstandingReceivable",
      profit.outstandingReceivable,
      profitOutstanding,
    );
  }

  const refundReviewCount = paymentsNeedingStripeCreditMismatchReview(records.payments).length;
  const flaggedFromNotes = records.payments.filter(
    (payment) =>
      isStripeCreditMismatchReviewNote(payment.note) && !payment.stripeCreditMismatchResolvedAt,
  ).length;
  demandCount(mismatches, "stripe", "refund-review-flags", refundReviewCount, flaggedFromNotes);

  return {
    ok: mismatches.length === 0,
    mismatches,
    snapshotTotal,
    snapshotLineSum,
    depositRequired,
    depositPaid,
    depositRemaining: Math.max(0, depositRequired - depositPaid),
    billedRevenue,
    collectedCash: recordedCollected,
    outstandingReceivable: profitOutstanding,
    refundReviewCount,
    invoices: invoiceProofs,
  };
}

export async function loadJobMoneyRecords(
  db: PrismaClient,
  input: { businessId: string; jobId: string },
): Promise<JobMoneyRecords> {
  const job = await db.job.findFirst({
    where: { id: input.jobId, businessId: input.businessId },
    select: {
      id: true,
      businessId: true,
      estimateId: true,
      estimate: {
        select: {
          id: true,
          status: true,
          total: true,
          approvedVersionId: true,
          approvedVersion: {
            select: {
              id: true,
              total: true,
              versionNumber: true,
              lineItems: {
                orderBy: { createdAt: "asc" },
                select: {
                  type: true,
                  total: true,
                  description: true,
                  quantity: true,
                  unitPrice: true,
                },
              },
            },
          },
          lineItems: {
            orderBy: { createdAt: "asc" },
            select: {
              type: true,
              total: true,
              description: true,
              quantity: true,
              unitPrice: true,
            },
          },
        },
      },
    },
  });
  if (!job) {
    throw new Error("Job not found for money reconciliation.");
  }

  const [invoices, payments, credits, checkoutSessions, changeOrders] = await Promise.all([
    db.invoice.findMany({
      where: { businessId: input.businessId, jobId: input.jobId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      include: {
        lineItems: { orderBy: { createdAt: "asc" }, select: { total: true } },
      },
    }),
    db.payment.findMany({
      where: {
        businessId: input.businessId,
        OR: [
          { jobId: input.jobId },
          ...(job.estimateId ? [{ estimateId: job.estimateId }] : []),
          {
            invoice: { is: { businessId: input.businessId, jobId: input.jobId } },
          },
        ],
      },
      orderBy: { receivedAt: "asc" },
    }),
    db.invoiceCredit.findMany({
      where: { businessId: input.businessId, invoice: { jobId: input.jobId } },
      orderBy: { createdAt: "asc" },
    }),
    db.invoiceCheckoutSession.findMany({
      where: { businessId: input.businessId, invoice: { jobId: input.jobId } },
    }),
    db.changeOrder.findMany({
      where: { businessId: input.businessId, jobId: input.jobId },
      select: { id: true, status: true, total: true, invoiceId: true },
    }),
  ]);

  const seen = new Set<string>();
  const uniquePayments = payments.filter((payment) => {
    if (seen.has(payment.id)) return false;
    seen.add(payment.id);
    return true;
  });

  return {
    businessId: input.businessId,
    jobId: input.jobId,
    estimate: job.estimate
      ? {
          id: job.estimate.id,
          status: job.estimate.status,
          total: job.estimate.total,
          approvedVersionId: job.estimate.approvedVersionId,
          approvedVersion: job.estimate.approvedVersion,
          liveLines: job.estimate.lineItems,
        }
      : null,
    invoices,
    payments: uniquePayments,
    credits,
    checkoutSessions,
    changeOrders,
  };
}

export function describeJobMoneyMismatches(proof: JobMoneyProof) {
  if (proof.ok) return "Job money reconciles.";
  return proof.mismatches
    .map((row) => `${row.surface} ${row.field}: displayed ${row.displayed} vs recorded ${row.recorded}`)
    .join("; ");
}
