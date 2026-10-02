/**
 * Canonical collected-cash resolver for TBBT.
 *
 * Payment rows are modern collected-cash truth. A PAID invoice total is a
 * legacy fallback only when that invoice has no Payment rows and was not
 * closed by OWNER credits. SENT invoice totals are never collected. Each
 * Payment is counted once.
 *
 * Growth uses this now. Financial #102 can later share or reconcile it.
 * This module does not rebuild Financial intelligence.
 */

import { invoiceIsCreditClosed } from "@/lib/financial-intelligence/collected-revenue";
import { paymentBelongsToInvoice } from "@/lib/payment-attribution";
import { asNumber } from "@/lib/reports";

export type CollectedCashMoney = { toString(): string } | number | string | null | undefined;

export type CollectedCashInvoice = {
  id: string;
  status: string;
  total: CollectedCashMoney;
  jobId?: string | null;
  kind?: string | null;
  customerId?: string | null;
  paymentMethod?: string | null;
  paymentReference?: string | null;
};

export type CollectedCashCredit = {
  id?: string;
  invoiceId: string;
  amount?: CollectedCashMoney;
};

export type CollectedCashPayment = {
  id: string;
  amount: CollectedCashMoney;
  invoiceId?: string | null;
  jobId?: string | null;
  customerId?: string | null;
};

export type CollectedCashSource = "payments" | "legacy_paid";

export const COLLECTED_CASH_MESSAGE =
  "Collected uses recorded Payment rows. A PAID invoice total is used only when that invoice has no Payment rows and was not closed by recorded credits. SENT is never collected.";

function money(value: CollectedCashMoney): number {
  return asNumber(value as { toString(): string } | number | null | undefined);
}

export function paymentsForInvoice(
  invoice: string | Pick<CollectedCashInvoice, "id" | "jobId" | "kind">,
  payments: readonly CollectedCashPayment[],
): CollectedCashPayment[] {
  const target =
    typeof invoice === "string"
      ? { id: invoice, jobId: null, kind: null }
      : { id: invoice.id, jobId: invoice.jobId ?? null, kind: invoice.kind ?? null };
  const seen = new Set<string>();
  const rows: CollectedCashPayment[] = [];
  for (const payment of payments) {
    if (seen.has(payment.id)) continue;
    if (
      !paymentBelongsToInvoice(
        { invoiceId: payment.invoiceId ?? null, jobId: payment.jobId ?? null },
        target,
      )
    ) {
      continue;
    }
    seen.add(payment.id);
    rows.push(payment);
  }
  return rows;
}

export function resolveInvoiceCollected(
  invoice: CollectedCashInvoice,
  payments: readonly CollectedCashPayment[],
  credits: readonly CollectedCashCredit[] = [],
): { amount: number; source: CollectedCashSource | null; paymentIds: string[] } {
  const rows = paymentsForInvoice(invoice, payments);
  if (rows.length > 0) {
    return {
      amount: rows.reduce((sum, payment) => sum + money(payment.amount), 0),
      source: "payments",
      paymentIds: rows.map((row) => row.id),
    };
  }
  // CREDIT_CLOSED_NOT_LEGACY_CASH
  if (
    invoice.status === "PAID" &&
    !invoiceIsCreditClosed(
      {
        id: invoice.id,
        status: invoice.status,
        total: money(invoice.total),
        paymentMethod: invoice.paymentMethod,
        paymentReference: invoice.paymentReference,
      },
      credits.map((credit) => ({
        id: credit.id,
        invoiceId: credit.invoiceId,
        amount: money(credit.amount),
      })),
    )
  ) {
    return { amount: money(invoice.total), source: "legacy_paid", paymentIds: [] };
  }
  return { amount: 0, source: null, paymentIds: [] };
}

export function resolveCollectedCash(input: {
  invoices: readonly CollectedCashInvoice[];
  payments: readonly CollectedCashPayment[];
  credits?: readonly CollectedCashCredit[];
}) {
  const countedPaymentIds = new Set<string>();
  const byInvoiceId = new Map<string, { amount: number; source: CollectedCashSource }>();
  let totalCollected = 0;
  let collectionCount = 0;

  for (const invoice of input.invoices) {
    const resolved = resolveInvoiceCollected(invoice, input.payments, input.credits);
    for (const paymentId of resolved.paymentIds) countedPaymentIds.add(paymentId);
    if (resolved.source) {
      byInvoiceId.set(invoice.id, { amount: resolved.amount, source: resolved.source });
    }
    if (resolved.amount > 0) {
      totalCollected += resolved.amount;
      collectionCount += 1;
    }
  }

  let unattachedPaymentTotal = 0;
  for (const payment of input.payments) {
    if (payment.invoiceId || countedPaymentIds.has(payment.id)) continue;
    countedPaymentIds.add(payment.id);
    const amount = money(payment.amount);
    if (amount <= 0) continue;
    unattachedPaymentTotal += amount;
    totalCollected += amount;
    collectionCount += 1;
  }

  return {
    totalCollected,
    collectionCount,
    byInvoiceId,
    countedPaymentIds,
    unattachedPaymentTotal,
  };
}

export function invoicedAmount(invoices: readonly CollectedCashInvoice[]): number {
  return invoices
    .filter((invoice) => invoice.status === "SENT" || invoice.status === "PAID")
    .reduce((sum, invoice) => sum + money(invoice.total), 0);
}

export function collectedForJob(input: {
  jobId: string;
  invoices: readonly CollectedCashInvoice[];
  payments: readonly CollectedCashPayment[];
  credits?: readonly CollectedCashCredit[];
}): { invoiced: number; collected: number } {
  const invoices = input.invoices.filter((invoice) => invoice.jobId === input.jobId);
  const invoiceIds = new Set(invoices.map((invoice) => invoice.id));
  const seen = new Set<string>();
  const jobPayments: CollectedCashPayment[] = [];
  for (const payment of input.payments) {
    if (seen.has(payment.id)) continue;
    const viaInvoice = Boolean(payment.invoiceId && invoiceIds.has(payment.invoiceId));
    const viaJobOnly = payment.jobId === input.jobId && !payment.invoiceId;
    if (!viaInvoice && !viaJobOnly) continue;
    seen.add(payment.id);
    jobPayments.push(payment);
  }
  const cash = resolveCollectedCash({
    invoices,
    payments: jobPayments,
    credits: input.credits,
  });
  return {
    invoiced: invoicedAmount(invoices),
    collected: cash.totalCollected,
  };
}
