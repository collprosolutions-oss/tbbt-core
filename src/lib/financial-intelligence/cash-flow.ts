import { inRange } from "@/lib/reports";
import { roundMoney } from "@/lib/time-cards";
import type { FinancialSource } from "@/lib/financial-intelligence/source";

export const CASH_FLOW_COVERAGE_MESSAGE = "Based on recorded TBBT transactions.";

export const CASH_FLOW_RECORDED_ONLY_MESSAGE =
  "Based on recorded TBBT transactions. Collected customer payments, recorded expenses, and processed payroll only. Sent invoices are not cash in. No bank balance is assumed.";

export type KnownCashFlow = {
  bankConnected: false;
  accountingConnected: false;
  projectedBalance: null;
  collectedCustomerPayments: number;
  recordedExpenseOutflows: number;
  processedPayrollOutflows: number;
  otherKnownInflows: number;
  otherKnownOutflows: number;
  knownInflows: number;
  knownOutflows: number;
  netKnown: number;
  inflowCount: number;
  outflowCount: number;
  coverage: typeof CASH_FLOW_COVERAGE_MESSAGE;
  message: string;
};

export type KnownCashFlowInput = {
  collectedPayments: readonly { amount: number }[];
  recordedExpenses: readonly { amount: number }[];
  processedPayroll: readonly { authorizedGrossLaborAmount: number | null }[];
  otherInflows?: readonly { amount: number }[];
  otherOutflows?: readonly { amount: number }[];
};

/**
 * Known cash movement from TBBT-recorded facts.
 * Unpaid / SENT invoices are never inflows.
 * Payroll is an outflow only when the run is PROCESSED.
 */
export function buildKnownCashFlow(input: KnownCashFlowInput): KnownCashFlow {
  const collectedCustomerPayments = roundMoney(
    input.collectedPayments.reduce((sum, row) => sum + row.amount, 0),
  );
  const recordedExpenseOutflows = roundMoney(
    input.recordedExpenses.reduce((sum, row) => sum + row.amount, 0),
  );
  const processedPayrollOutflows = roundMoney(
    input.processedPayroll.reduce((sum, row) => sum + (row.authorizedGrossLaborAmount ?? 0), 0),
  );
  const otherKnownInflows = roundMoney((input.otherInflows ?? []).reduce((sum, row) => sum + row.amount, 0));
  const otherKnownOutflows = roundMoney((input.otherOutflows ?? []).reduce((sum, row) => sum + row.amount, 0));
  const knownInflows = roundMoney(collectedCustomerPayments + otherKnownInflows);
  const knownOutflows = roundMoney(recordedExpenseOutflows + processedPayrollOutflows + otherKnownOutflows);

  return {
    bankConnected: false,
    accountingConnected: false,
    projectedBalance: null,
    collectedCustomerPayments,
    recordedExpenseOutflows,
    processedPayrollOutflows,
    otherKnownInflows,
    otherKnownOutflows,
    knownInflows,
    knownOutflows,
    netKnown: roundMoney(knownInflows - knownOutflows),
    inflowCount: input.collectedPayments.length + (input.otherInflows?.length ?? 0),
    outflowCount:
      input.recordedExpenses.length + input.processedPayroll.length + (input.otherOutflows?.length ?? 0),
    coverage: CASH_FLOW_COVERAGE_MESSAGE,
    message: CASH_FLOW_RECORDED_ONLY_MESSAGE,
  };
}

export function collectedPaymentsInRange(
  source: FinancialSource,
  range: { start: Date | null; end: Date | null },
) {
  const paymentRows = source.payments.filter((payment) => inRange(payment.receivedAt, range));
  const paidInvoiceIds = new Set(
    paymentRows.map((payment) => payment.invoiceId).filter((id): id is string => Boolean(id)),
  );
  const legacyPaid = source.invoices.filter(
    (invoice) =>
      invoice.status === "PAID" &&
      invoice.paidAt != null &&
      inRange(invoice.paidAt, range) &&
      !source.payments.some((payment) => payment.invoiceId === invoice.id) &&
      !paidInvoiceIds.has(invoice.id),
  );
  return {
    payments: paymentRows,
    legacyPaid,
    collected: [
      ...paymentRows.map((row) => ({ amount: row.amount, at: row.receivedAt, kind: "payment" as const })),
      ...legacyPaid.map((row) => ({ amount: row.total, at: row.paidAt as Date, kind: "legacy-paid-invoice" as const })),
    ],
  };
}

export function buildKnownCashFlowFromSource(
  source: FinancialSource,
  range: { start: Date | null; end: Date | null },
): KnownCashFlow {
  const collected = collectedPaymentsInRange(source, range);
  return buildKnownCashFlow({
    collectedPayments: collected.collected,
    recordedExpenses: source.expenses.filter((expense) => inRange(expense.occurredOn, range)),
    processedPayroll: source.payrollRuns.filter(
      (run) => run.status === "PROCESSED" && run.processedAt != null && inRange(run.processedAt, range),
    ),
  });
}
