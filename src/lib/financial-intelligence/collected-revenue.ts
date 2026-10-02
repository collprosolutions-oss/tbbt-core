/**
 * Canonical collected-revenue reconciliation.
 *
 * Payment rows are the modern source of collected cash.
 * A PAID invoice with no Payment rows for that invoice may count its
 * full total as legacy collected revenue, except when OWNER credits
 * closed it: method OTHER plus exactly "Recorded credit <id>" matching
 * an InvoiceCredit row on that invoice, with credits covering the total.
 * A lookalike reference or a cash-type method is still legacy cash.
 *
 * One Payment is counted once, even if it is linked through both job
 * and invoice paths. A payment on invoice A never suppresses the legacy
 * fallback for a different invoice.
 *
 * SENT / unpaid invoice value is never collected cash.
 */
import { paymentBelongsToInvoice } from "@/lib/payment-attribution";
import { roundMoney } from "@/lib/time-cards";
import type { FinancialPayment, FinancialSource } from "@/lib/financial-intelligence/source";

export type CollectedInvoice = {
  id: string;
  status: string;
  total: number;
  jobId: string | null;
  kind: string | null;
  customerId?: string | null;
  paidAt?: Date | null;
  paymentMethod?: string | null;
  paymentReference?: string | null;
};

export type CollectedPayment = Pick<
  FinancialPayment,
  "id" | "amount" | "invoiceId" | "jobId" | "customerId" | "receivedAt"
>;

function uniquePayments(payments: readonly CollectedPayment[]): CollectedPayment[] {
  const seen = new Set<string>();
  const unique: CollectedPayment[] = [];
  for (const payment of payments) {
    if (seen.has(payment.id)) continue;
    seen.add(payment.id);
    unique.push(payment);
  }
  return unique;
}

export function paymentsAppliedToInvoice(
  payments: readonly CollectedPayment[],
  invoice: string | Pick<CollectedInvoice, "id" | "jobId" | "kind">,
): number {
  const target =
    typeof invoice === "string"
      ? { id: invoice, jobId: null, kind: null }
      : { id: invoice.id, jobId: invoice.jobId ?? null, kind: invoice.kind ?? null };
  return roundMoney(
    payments
      .filter((payment) =>
        paymentBelongsToInvoice(
          { invoiceId: payment.invoiceId ?? null, jobId: payment.jobId ?? null },
          target,
        ),
      )
      .reduce((sum, payment) => sum + payment.amount, 0),
  );
}

export type CollectedInvoiceCredit = {
  id?: string;
  invoiceId: string;
  amount: number;
};

const LEGACY_CASH_PAYMENT_METHODS = new Set([
  "CASH",
  "CHECK",
  "ZELLE_BANK_TRANSFER",
  "CARD_EXTERNAL",
  "STRIPE",
]);

function creditsAppliedToInvoice(
  credits: readonly CollectedInvoiceCredit[] | undefined,
  invoiceId: string,
) {
  if (!credits?.length) return 0;
  return roundMoney(
    credits.filter((credit) => credit.invoiceId === invoiceId).reduce((sum, credit) => sum + credit.amount, 0),
  );
}

/** Remaining SENT/PAID balance after recorded payments and OWNER credits. Never negative. */
export function invoiceBalanceDue(
  invoice: { id: string; total: number; jobId: string | null; kind: string | null },
  payments: readonly CollectedPayment[],
  credits: readonly CollectedInvoiceCredit[],
): number {
  return roundMoney(
    Math.max(
      0,
      invoice.total -
        paymentsAppliedToInvoice(payments, invoice) -
        creditsAppliedToInvoice(credits, invoice.id),
    ),
  );
}

export function invoiceHasPaymentRows(
  invoice: string | Pick<CollectedInvoice, "id" | "jobId" | "kind">,
  payments: readonly CollectedPayment[],
): boolean {
  const target =
    typeof invoice === "string"
      ? { id: invoice, jobId: null, kind: null }
      : { id: invoice.id, jobId: invoice.jobId ?? null, kind: invoice.kind ?? null };
  return payments.some((payment) =>
    paymentBelongsToInvoice(
      { invoiceId: payment.invoiceId ?? null, jobId: payment.jobId ?? null },
      target,
    ),
  );
}

export const RECORDED_CREDIT_REFERENCE_PREFIX = "Recorded credit ";

export function recordedCreditReferenceFor(creditId: string) {
  return `${RECORDED_CREDIT_REFERENCE_PREFIX}${creditId}`;
}

function creditsOnInvoice<T extends { invoiceId: string }>(
  credits: readonly T[] | undefined,
  invoiceId: string,
): T[] {
  return (credits ?? []).filter((credit) => credit.invoiceId === invoiceId);
}

/** Exact OTHER + "Recorded credit <id>" matching an InvoiceCredit row on this invoice. */
export function invoiceHasExactRecordedCreditReference(
  invoice: Pick<CollectedInvoice, "id" | "paymentMethod" | "paymentReference">,
  credits: readonly { id?: string; invoiceId: string }[] | undefined,
): boolean {
  // CREDIT_CLOSED_EXACT_REFERENCE
  if (invoice.paymentMethod !== "OTHER") return false;
  const reference = invoice.paymentReference ?? "";
  return creditsOnInvoice(credits, invoice.id).some(
    // CREDIT_CLOSED_EXACT_ID_EQUALITY
    (credit) => credit.id && reference === recordedCreditReferenceFor(credit.id),
  );
}

/**
 * Credit-closed invoices are not legacy cash. Closing fields must come
 * from the credit-close path (OTHER + exact Recorded credit <id>) and
 * credits must cover the invoice total. A cash-type method or a
 * lookalike reference keeps counting legacy cash.
 */
export function invoiceIsCreditClosed(
  invoice: Pick<CollectedInvoice, "id" | "status" | "total" | "paymentMethod" | "paymentReference">,
  credits: readonly CollectedInvoiceCredit[] | undefined,
): boolean {
  if (invoice.status !== "PAID") return false;
  if (invoice.paymentMethod && LEGACY_CASH_PAYMENT_METHODS.has(invoice.paymentMethod)) {
    return false;
  }
  const rows = creditsOnInvoice(credits, invoice.id);
  if (!invoiceHasExactRecordedCreditReference(invoice, rows)) return false;
  const covered = roundMoney(rows.reduce((sum, credit) => sum + credit.amount, 0));
  // CREDIT_CLOSED_COVERS_TOTAL
  return covered + 1e-9 >= invoice.total;
}

/** @deprecated Use invoiceIsCreditClosed. Kept for existing callers. */
export function invoiceHasRecordedCredits(
  invoice: Pick<CollectedInvoice, "id" | "status" | "total" | "paymentMethod" | "paymentReference">,
  credits: readonly CollectedInvoiceCredit[] | undefined,
): boolean {
  return invoiceIsCreditClosed(invoice, credits);
}

export function legacyCollectedForInvoice(
  invoice: CollectedInvoice,
  payments: readonly CollectedPayment[],
  credits: readonly CollectedInvoiceCredit[] = [],
): number {
  if (invoice.status !== "PAID") return 0;
  if (invoiceHasPaymentRows(invoice, payments)) return 0;
  // CREDIT_CLOSED_NOT_LEGACY_CASH
  if (invoiceIsCreditClosed(invoice, credits)) return 0;
  return roundMoney(invoice.total);
}

export function collectedAmountForInvoice(
  invoice: CollectedInvoice,
  payments: readonly CollectedPayment[],
  credits: readonly CollectedInvoiceCredit[] = [],
): number {
  const applied = paymentsAppliedToInvoice(payments, invoice);
  return roundMoney(applied + legacyCollectedForInvoice(invoice, payments, credits));
}

function paymentsForJob(
  jobId: string,
  invoices: readonly CollectedInvoice[],
  payments: readonly CollectedPayment[],
): CollectedPayment[] {
  const invoiceIds = new Set(
    invoices.filter((invoice) => invoice.jobId === jobId).map((invoice) => invoice.id),
  );
  return uniquePayments(
    payments.filter(
      (payment) => payment.jobId === jobId || (payment.invoiceId != null && invoiceIds.has(payment.invoiceId)),
    ),
  );
}

function paymentsForCustomer(
  customerId: string,
  invoices: readonly CollectedInvoice[],
  payments: readonly CollectedPayment[],
): CollectedPayment[] {
  const invoiceIds = new Set(
    invoices.filter((invoice) => invoice.customerId === customerId).map((invoice) => invoice.id),
  );
  return uniquePayments(
    payments.filter(
      (payment) =>
        payment.customerId === customerId ||
        (payment.invoiceId != null && invoiceIds.has(payment.invoiceId)),
    ),
  );
}

export function collectedRevenueForJob(input: {
  jobId: string;
  invoices: readonly CollectedInvoice[];
  payments: readonly CollectedPayment[];
  credits?: readonly CollectedInvoiceCredit[];
}): number {
  const jobInvoices = input.invoices.filter((invoice) => invoice.jobId === input.jobId);
  const attributed = paymentsForJob(input.jobId, input.invoices, input.payments);
  const fromPayments = attributed.reduce((sum, payment) => sum + payment.amount, 0);
  let legacyPaid = 0;
  for (const invoice of jobInvoices) {
    legacyPaid += legacyCollectedForInvoice(invoice, input.payments, input.credits);
  }
  return roundMoney(fromPayments + legacyPaid);
}

export function collectedRevenueForCustomer(input: {
  customerId: string;
  invoices: readonly CollectedInvoice[];
  payments: readonly CollectedPayment[];
  credits?: readonly CollectedInvoiceCredit[];
}): number {
  const customerInvoices = input.invoices.filter((invoice) => invoice.customerId === input.customerId);
  const attributed = paymentsForCustomer(input.customerId, input.invoices, input.payments);
  const fromPayments = attributed.reduce((sum, payment) => sum + payment.amount, 0);
  let legacyPaid = 0;
  for (const invoice of customerInvoices) {
    legacyPaid += legacyCollectedForInvoice(invoice, input.payments, input.credits);
  }
  return roundMoney(fromPayments + legacyPaid);
}

export function collectedRevenueForInvoices(
  invoices: readonly CollectedInvoice[],
  payments: readonly CollectedPayment[],
  credits: readonly CollectedInvoiceCredit[] = [],
): number {
  const countedPaymentIds = new Set<string>();
  let total = 0;
  for (const payment of payments) {
    if (countedPaymentIds.has(payment.id)) continue;
    countedPaymentIds.add(payment.id);
    total += payment.amount;
  }
  for (const invoice of invoices) {
    total += legacyCollectedForInvoice(invoice, payments, credits);
  }
  return roundMoney(total);
}

export function outstandingReceivableAmount(
  invoices: readonly CollectedInvoice[],
  payments: readonly CollectedPayment[],
  credits: readonly CollectedInvoiceCredit[],
): { amount: number; count: number } {
  const sent = invoices.filter((invoice) => invoice.status === "SENT");
  const withBalance = sent
    .map((invoice) => ({ invoice, balance: invoiceBalanceDue(invoice, payments, credits) }))
    .filter((row) => row.balance > 0);
  return {
    amount: roundMoney(withBalance.reduce((sum, row) => sum + row.balance, 0)),
    count: withBalance.length,
  };
}

export type CollectedRevenueReconciliation = {
  totalCollected: number;
  attributedToJobs: number;
  attributedToCustomers: number;
  unattributedCollected: number;
  reconciles: boolean;
  paymentCount: number;
  legacyInvoiceCount: number;
};

/**
 * Global collected cash = job-attributed cash + genuinely unattributed
 * collected payments/legacy invoices. Customer totals are an overlapping
 * view (a job payment also belongs to its customer) and are not added
 * into the partition.
 */
export function reconcileCollectedRevenue(
  source: Pick<FinancialSource, "invoices" | "payments" | "jobs" | "invoiceCredits">,
): CollectedRevenueReconciliation {
  const payments = uniquePayments(source.payments);
  const credits = source.invoiceCredits ?? [];
  const totalCollected = collectedRevenueForInvoices(source.invoices, payments, credits);

  const jobIds = new Set<string>();
  for (const job of source.jobs) jobIds.add(job.id);
  for (const invoice of source.invoices) {
    if (invoice.jobId) jobIds.add(invoice.jobId);
  }
  for (const payment of payments) {
    if (payment.jobId) jobIds.add(payment.jobId);
  }

  const jobAttributedPaymentIds = new Set<string>();
  const jobAttributedLegacyIds = new Set<string>();
  let attributedToJobs = 0;
  for (const jobId of jobIds) {
    attributedToJobs = roundMoney(
      attributedToJobs +
        collectedRevenueForJob({ jobId, invoices: source.invoices, payments, credits }),
    );
    for (const payment of paymentsForJob(jobId, source.invoices, payments)) {
      jobAttributedPaymentIds.add(payment.id);
    }
    for (const invoice of source.invoices.filter((row) => row.jobId === jobId)) {
      if (legacyCollectedForInvoice(invoice, payments, credits) > 0) jobAttributedLegacyIds.add(invoice.id);
    }
  }

  let unattributed = 0;
  for (const payment of payments) {
    if (!jobAttributedPaymentIds.has(payment.id)) unattributed += payment.amount;
  }
  for (const invoice of source.invoices) {
    if (!jobAttributedLegacyIds.has(invoice.id)) {
      unattributed += legacyCollectedForInvoice(invoice, payments, credits);
    }
  }

  const customerIds = new Set<string>();
  for (const invoice of source.invoices) {
    if (invoice.customerId) customerIds.add(invoice.customerId);
  }
  for (const payment of payments) {
    if (payment.customerId) customerIds.add(payment.customerId);
  }
  let attributedToCustomers = 0;
  for (const customerId of customerIds) {
    attributedToCustomers = roundMoney(
      attributedToCustomers +
        collectedRevenueForCustomer({ customerId, invoices: source.invoices, payments, credits }),
    );
  }

  const unattributedCollected = roundMoney(unattributed);
  return {
    totalCollected,
    attributedToJobs,
    attributedToCustomers,
    unattributedCollected,
    reconciles: roundMoney(attributedToJobs + unattributedCollected) === totalCollected,
    paymentCount: payments.length,
    legacyInvoiceCount: source.invoices.filter((invoice) => legacyCollectedForInvoice(invoice, payments, credits) > 0)
      .length,
  };
}
