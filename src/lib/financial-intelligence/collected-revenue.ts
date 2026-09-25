/**
 * Canonical collected-revenue reconciliation.
 *
 * Payment rows are the modern source of collected cash.
 * A PAID invoice with no Payment rows for that invoice may count its
 * full total as legacy collected revenue.
 *
 * One Payment is counted once, even if it is linked through both job
 * and invoice paths. A payment on invoice A never suppresses the legacy
 * fallback for a different invoice.
 *
 * SENT / unpaid invoice value is never collected cash.
 */
import { roundMoney } from "@/lib/time-cards";
import type { FinancialPayment, FinancialSource } from "@/lib/financial-intelligence/source";

export type CollectedInvoice = {
  id: string;
  status: string;
  total: number;
  jobId?: string | null;
  customerId?: string | null;
  paidAt?: Date | null;
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
  invoiceId: string,
): number {
  return roundMoney(
    payments.filter((payment) => payment.invoiceId === invoiceId).reduce((sum, payment) => sum + payment.amount, 0),
  );
}

/** Remaining SENT/PAID balance after recorded payments. Never negative. */
export function invoiceBalanceDue(
  invoice: Pick<CollectedInvoice, "id" | "total">,
  payments: readonly CollectedPayment[],
): number {
  return roundMoney(Math.max(0, invoice.total - paymentsAppliedToInvoice(payments, invoice.id)));
}

export function invoiceHasPaymentRows(
  invoiceId: string,
  payments: readonly CollectedPayment[],
): boolean {
  return payments.some((payment) => payment.invoiceId === invoiceId);
}

export function legacyCollectedForInvoice(
  invoice: CollectedInvoice,
  payments: readonly CollectedPayment[],
): number {
  if (invoice.status !== "PAID") return 0;
  if (invoiceHasPaymentRows(invoice.id, payments)) return 0;
  return roundMoney(invoice.total);
}

export function collectedAmountForInvoice(
  invoice: CollectedInvoice,
  payments: readonly CollectedPayment[],
): number {
  const applied = paymentsAppliedToInvoice(payments, invoice.id);
  return roundMoney(applied + legacyCollectedForInvoice(invoice, payments));
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
}): number {
  const jobInvoices = input.invoices.filter((invoice) => invoice.jobId === input.jobId);
  const attributed = paymentsForJob(input.jobId, input.invoices, input.payments);
  const fromPayments = attributed.reduce((sum, payment) => sum + payment.amount, 0);
  let legacyPaid = 0;
  for (const invoice of jobInvoices) {
    legacyPaid += legacyCollectedForInvoice(invoice, input.payments);
  }
  return roundMoney(fromPayments + legacyPaid);
}

export function collectedRevenueForCustomer(input: {
  customerId: string;
  invoices: readonly CollectedInvoice[];
  payments: readonly CollectedPayment[];
}): number {
  const customerInvoices = input.invoices.filter((invoice) => invoice.customerId === input.customerId);
  const attributed = paymentsForCustomer(input.customerId, input.invoices, input.payments);
  const fromPayments = attributed.reduce((sum, payment) => sum + payment.amount, 0);
  let legacyPaid = 0;
  for (const invoice of customerInvoices) {
    legacyPaid += legacyCollectedForInvoice(invoice, input.payments);
  }
  return roundMoney(fromPayments + legacyPaid);
}

export function collectedRevenueForInvoices(
  invoices: readonly CollectedInvoice[],
  payments: readonly CollectedPayment[],
): number {
  const countedPaymentIds = new Set<string>();
  let total = 0;
  for (const payment of payments) {
    if (countedPaymentIds.has(payment.id)) continue;
    countedPaymentIds.add(payment.id);
    total += payment.amount;
  }
  for (const invoice of invoices) {
    total += legacyCollectedForInvoice(invoice, payments);
  }
  return roundMoney(total);
}

export function outstandingReceivableAmount(
  invoices: readonly CollectedInvoice[],
  payments: readonly CollectedPayment[],
): { amount: number; count: number } {
  const sent = invoices.filter((invoice) => invoice.status === "SENT");
  const withBalance = sent
    .map((invoice) => ({ invoice, balance: invoiceBalanceDue(invoice, payments) }))
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
  source: Pick<FinancialSource, "invoices" | "payments" | "jobs">,
): CollectedRevenueReconciliation {
  const payments = uniquePayments(source.payments);
  const totalCollected = collectedRevenueForInvoices(source.invoices, payments);

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
      attributedToJobs + collectedRevenueForJob({ jobId, invoices: source.invoices, payments }),
    );
    for (const payment of paymentsForJob(jobId, source.invoices, payments)) {
      jobAttributedPaymentIds.add(payment.id);
    }
    for (const invoice of source.invoices.filter((row) => row.jobId === jobId)) {
      if (legacyCollectedForInvoice(invoice, payments) > 0) jobAttributedLegacyIds.add(invoice.id);
    }
  }

  let unattributed = 0;
  for (const payment of payments) {
    if (!jobAttributedPaymentIds.has(payment.id)) unattributed += payment.amount;
  }
  for (const invoice of source.invoices) {
    if (!jobAttributedLegacyIds.has(invoice.id)) unattributed += legacyCollectedForInvoice(invoice, payments);
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
        collectedRevenueForCustomer({ customerId, invoices: source.invoices, payments }),
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
    legacyInvoiceCount: source.invoices.filter((invoice) => legacyCollectedForInvoice(invoice, payments) > 0)
      .length,
  };
}
