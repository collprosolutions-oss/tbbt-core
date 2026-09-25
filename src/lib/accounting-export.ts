/**
 * Owner/admin accounting CSV export over recorded TBBT truth.
 *
 * This is not a general ledger, tax engine, or QuickBooks/Xero integration.
 * Invoice paid/remaining uses invoicePaymentBreakdown: recorded Payment
 * rows are modern cash truth, and a PAID invoice with zero allocated
 * Payment rows may use the full invoice total as the legacy fully-paid
 * fallback. A Payment row is never invented from invoice status.
 *
 * Job-only payments (invoiceId null) allocate to an invoice only when
 * that job has exactly one invoice. Multi-invoice jobs keep the payment
 * visible in payments.csv without double-counting it on every invoice.
 *
 * Human text cells neutralize spreadsheet formula prefixes. Expense rows
 * follow ACTIVE_EXPENSE_WHERE (non-voided). Stripe session, payment-intent,
 * and provider tokens are never selected.
 *
 * Callers must pass access.businessId from requireBusinessAccess().
 */
import type { MembershipRole, PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { CAPABILITIES, roleHasCapability } from "@/lib/authorization";
import {
  ACTIVE_EXPENSE_WHERE,
  EXPENSE_REVIEW_LABELS,
  REIMBURSEMENT_STATUS_LABELS,
  TAX_CATEGORY_LABELS,
  expenseCategoryLabel,
  isExpenseReviewStatus,
  isReimbursementStatus,
  isTaxCategory,
} from "@/lib/expenses";
import { invoiceNumberFromId, invoiceStatusLabel, jobReferenceFromId } from "@/lib/invoice-document";
import { paymentMethodLabel } from "@/lib/invoice-payment";
import {
  PAYMENT_PURPOSE_INVOICE_BALANCE,
  PAYMENT_PURPOSE_MATERIAL_DEPOSIT,
  invoicePaymentBreakdown,
} from "@/lib/project-payments";
import { buildZipStore, toCsv } from "@/lib/zip-store";

const FORMULA_PREFIX = /^[=+\-@]/;

export const PAYMENT_BASIS = {
  RECORDED_PAYMENTS: "RECORDED_PAYMENTS",
  LEGACY_PAID_STATUS: "LEGACY_PAID_STATUS",
  NO_RECORDED_PAYMENT: "NO_RECORDED_PAYMENT",
} as const;

export type PaymentBasis = (typeof PAYMENT_BASIS)[keyof typeof PAYMENT_BASIS];

export const ACCOUNTING_TEXT_COLUMNS = [
  "Customer",
  "Vendor",
  "Description",
  "Note",
  "Payment Reference",
  "Status Label",
  "Payment Method",
  "Payment Method Label",
  "Method",
  "Method Label",
  "Purpose",
  "Purpose Label",
  "Category",
  "Category Label",
  "Tax Category",
  "Tax Category Label",
  "Reimbursement Status",
  "Review Status",
] as const;

export const BUSINESS_EXPORT_CAPABILITY = CAPABILITIES.MANAGE_SETTINGS;

export const PAYMENT_PURPOSE_LABELS: Record<string, string> = {
  [PAYMENT_PURPOSE_MATERIAL_DEPOSIT]: "Material Deposit",
  [PAYMENT_PURPOSE_INVOICE_BALANCE]: "Invoice Balance",
};

export const ACCOUNTING_INVOICE_HEADERS = [
  "Invoice Number",
  "Invoice ID",
  "Customer",
  "Customer ID",
  "Job Reference",
  "Job ID",
  "Status",
  "Status Label",
  "Total",
  "Amount Paid",
  "Amount Remaining",
  "Payment Basis",
  "Issued At",
  "Paid At",
  "Payment Method",
  "Payment Method Label",
  "Payment Reference",
  "Created At",
  "Updated At",
] as const;

export const ACCOUNTING_PAYMENT_HEADERS = [
  "Payment ID",
  "Invoice Number",
  "Invoice ID",
  "Job Reference",
  "Job ID",
  "Customer",
  "Customer ID",
  "Amount",
  "Method",
  "Method Label",
  "Purpose",
  "Purpose Label",
  "Received At",
  "Created At",
  "Note",
] as const;

export const ACCOUNTING_EXPENSE_HEADERS = [
  "Expense ID",
  "Date",
  "Vendor",
  "Description",
  "Category",
  "Category Label",
  "Amount",
  "Job Reference",
  "Job ID",
  "Customer",
  "Customer ID",
  "Payment Method",
  "Payment Method Label",
  "Tax Category",
  "Tax Category Label",
  "Reimbursement Status",
  "Review Status",
  "Created At",
] as const;

export type AccountingMoney = Prisma.Decimal | number | string;

export type AccountingInvoiceRecord = {
  id: string;
  customerId: string | null;
  jobId: string | null;
  status: string;
  total: AccountingMoney;
  paidAt: Date | null;
  paymentMethod: string | null;
  paymentReference: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AccountingPaymentRecord = {
  id: string;
  customerId: string | null;
  invoiceId: string | null;
  jobId: string | null;
  purpose: string;
  amount: AccountingMoney;
  method: string;
  receivedAt: Date;
  note: string | null;
  createdAt: Date;
};

export type AccountingExpenseRecord = {
  id: string;
  vendor: string | null;
  description: string;
  amount: AccountingMoney;
  category: string;
  occurredOn: Date;
  jobId: string | null;
  customerId: string | null;
  paymentMethod: string | null;
  taxCategory: string | null;
  reimbursementStatus: string;
  reviewStatus: string;
  voidedAt: Date | null;
  createdAt: Date;
};

export type AccountingNamedRecord = {
  id: string;
  name: string;
};

export type AccountingJobRecord = {
  id: string;
};

export type AccountingExportSource = {
  businessId: string;
  businessName: string;
  slug: string;
  invoices: AccountingInvoiceRecord[];
  payments: AccountingPaymentRecord[];
  expenses: AccountingExpenseRecord[];
  customers: AccountingNamedRecord[];
  jobs: AccountingJobRecord[];
};

export type AccountingExportFile = {
  name: "invoices.csv" | "payments.csv" | "expenses.csv";
  data: string;
};

export type AccountingExportZipResult = {
  filename: string;
  bytes: Buffer;
};

export function canExportBusinessData(role: MembershipRole): boolean {
  return roleHasCapability(role, BUSINESS_EXPORT_CAPABILITY);
}

export function paymentPurposeLabel(purpose: string): string {
  return PAYMENT_PURPOSE_LABELS[purpose] ?? purpose;
}

export function exportMoney(value: AccountingMoney | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const amount = value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
  return amount.toFixed(2);
}

export function exportDateTime(value: Date | string | null | undefined): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

export function exportDate(value: Date | string | null | undefined): string {
  const iso = exportDateTime(value);
  return iso ? iso.slice(0, 10) : "";
}

/**
 * Neutralize spreadsheet formula-like text for accounting CSV cells.
 * Money and date helpers must not call this — a leading "-" on a
 * legitimate numeric amount stays numeric.
 */
export function exportAccountingText(value: string | null | undefined): string {
  if (value == null || value === "") return "";
  return FORMULA_PREFIX.test(value) ? `'${value}` : value;
}

export function accountingToCsv(
  headers: readonly string[],
  rows: Array<Record<string, string>>,
): string {
  const textColumns = new Set<string>(ACCOUNTING_TEXT_COLUMNS);
  return toCsv(
    headers,
    rows.map((row) => {
      const next: Record<string, string> = { ...row };
      for (const header of headers) {
        if (textColumns.has(header)) {
          next[header] = exportAccountingText(next[header]);
        }
      }
      return next;
    }),
  );
}

function nameById(rows: readonly AccountingNamedRecord[]): Map<string, string> {
  return new Map(rows.map((row) => [row.id, row.name]));
}

function compareByDateThenId(aDate: Date, aId: string, bDate: Date, bId: string): number {
  const byDate = aDate.getTime() - bDate.getTime();
  return byDate !== 0 ? byDate : aId.localeCompare(bId);
}

export function invoiceCountByJobId(
  invoices: readonly Pick<AccountingInvoiceRecord, "jobId">[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const invoice of invoices) {
    if (!invoice.jobId) continue;
    counts.set(invoice.jobId, (counts.get(invoice.jobId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Accounting-only allocation. Does not change project-payment matching.
 *
 * A. Payment.invoiceId set → that invoice only.
 * B. Payment.invoiceId null + jobId → the job's invoice only when the
 *    job has exactly one invoice.
 * C. Multi-invoice job → leave the job-only payment unallocated.
 */
export function paymentsAllocatedToInvoice<
  T extends { id: string; invoiceId: string | null; jobId: string | null },
>(
  invoice: { id: string; jobId?: string | null },
  payments: readonly T[],
  invoicesOnJob: number,
): T[] {
  const seen = new Set<string>();
  return payments.filter((row) => {
    if (seen.has(row.id)) return false;
    if (row.invoiceId === invoice.id) {
      seen.add(row.id);
      return true;
    }
    const jobOnlyFallback =
      row.invoiceId == null &&
      Boolean(invoice.jobId) &&
      row.jobId === invoice.jobId &&
      invoicesOnJob === 1;
    if (jobOnlyFallback) {
      seen.add(row.id);
      return true;
    }
    return false;
  });
}

export function accountingInvoicePaymentTotals(
  invoice: Pick<AccountingInvoiceRecord, "id" | "jobId" | "status" | "total">,
  payments: readonly AccountingPaymentRecord[],
  invoicesOnJob: number,
): {
  amountPaid: Prisma.Decimal;
  amountRemaining: Prisma.Decimal;
  paymentBasis: PaymentBasis;
  legacyFullyPaid: boolean;
} {
  const allocated = paymentsAllocatedToInvoice(invoice, payments, invoicesOnJob);
  const breakdown = invoicePaymentBreakdown({
    status: invoice.status,
    total: invoice.total,
    payments: allocated,
  });
  const paymentBasis: PaymentBasis =
    allocated.length > 0
      ? PAYMENT_BASIS.RECORDED_PAYMENTS
      : breakdown.legacyFullyPaid
        ? PAYMENT_BASIS.LEGACY_PAID_STATUS
        : PAYMENT_BASIS.NO_RECORDED_PAYMENT;
  return {
    amountPaid: breakdown.amountPaid,
    amountRemaining: breakdown.amountDue,
    paymentBasis,
    legacyFullyPaid: breakdown.legacyFullyPaid,
  };
}

export function buildAccountingInvoiceRows(source: AccountingExportSource): Array<Record<string, string>> {
  const customers = nameById(source.customers);
  const invoicesOnJob = invoiceCountByJobId(source.invoices);
  return [...source.invoices]
    .sort((a, b) => compareByDateThenId(a.createdAt, a.id, b.createdAt, b.id))
    .map((invoice) => {
      const totals = accountingInvoicePaymentTotals(
        invoice,
        source.payments,
        invoice.jobId ? (invoicesOnJob.get(invoice.jobId) ?? 0) : 0,
      );
      return {
        "Invoice Number": invoiceNumberFromId(invoice.id),
        "Invoice ID": invoice.id,
        Customer: invoice.customerId ? (customers.get(invoice.customerId) ?? "") : "",
        "Customer ID": invoice.customerId ?? "",
        "Job Reference": invoice.jobId ? jobReferenceFromId(invoice.jobId) : "",
        "Job ID": invoice.jobId ?? "",
        Status: invoice.status,
        "Status Label": invoiceStatusLabel(invoice.status),
        Total: exportMoney(invoice.total),
        "Amount Paid": exportMoney(totals.amountPaid),
        "Amount Remaining": exportMoney(totals.amountRemaining),
        "Payment Basis": totals.paymentBasis,
        "Issued At": exportDateTime(invoice.createdAt),
        "Paid At": exportDateTime(invoice.paidAt),
        "Payment Method": invoice.paymentMethod ?? "",
        "Payment Method Label": paymentMethodLabel(invoice.paymentMethod) ?? "",
        "Payment Reference": invoice.paymentReference ?? "",
        "Created At": exportDateTime(invoice.createdAt),
        "Updated At": exportDateTime(invoice.updatedAt),
      };
    });
}

export function buildAccountingPaymentRows(source: AccountingExportSource): Array<Record<string, string>> {
  const customers = nameById(source.customers);
  return [...source.payments]
    .sort((a, b) => compareByDateThenId(a.receivedAt, a.id, b.receivedAt, b.id))
    .map((payment) => ({
      "Payment ID": payment.id,
      "Invoice Number": payment.invoiceId ? invoiceNumberFromId(payment.invoiceId) : "",
      "Invoice ID": payment.invoiceId ?? "",
      "Job Reference": payment.jobId ? jobReferenceFromId(payment.jobId) : "",
      "Job ID": payment.jobId ?? "",
      Customer: payment.customerId ? (customers.get(payment.customerId) ?? "") : "",
      "Customer ID": payment.customerId ?? "",
      Amount: exportMoney(payment.amount),
      Method: payment.method,
      "Method Label": paymentMethodLabel(payment.method) ?? payment.method,
      Purpose: payment.purpose,
      "Purpose Label": paymentPurposeLabel(payment.purpose),
      "Received At": exportDateTime(payment.receivedAt),
      "Created At": exportDateTime(payment.createdAt),
      Note: payment.note ?? "",
    }));
}

export function buildAccountingExpenseRows(source: AccountingExportSource): Array<Record<string, string>> {
  const customers = nameById(source.customers);
  return source.expenses
    .filter((expense) => expense.voidedAt == null)
    .sort((a, b) => compareByDateThenId(a.occurredOn, a.id, b.occurredOn, b.id))
    .map((expense) => ({
      "Expense ID": expense.id,
      Date: exportDate(expense.occurredOn),
      Vendor: expense.vendor ?? "",
      Description: expense.description,
      Category: expense.category,
      "Category Label": expenseCategoryLabel(expense.category),
      Amount: exportMoney(expense.amount),
      "Job Reference": expense.jobId ? jobReferenceFromId(expense.jobId) : "",
      "Job ID": expense.jobId ?? "",
      Customer: expense.customerId ? (customers.get(expense.customerId) ?? "") : "",
      "Customer ID": expense.customerId ?? "",
      "Payment Method": expense.paymentMethod ?? "",
      "Payment Method Label": paymentMethodLabel(expense.paymentMethod) ?? "",
      "Tax Category": expense.taxCategory ?? "",
      "Tax Category Label":
        expense.taxCategory && isTaxCategory(expense.taxCategory)
          ? TAX_CATEGORY_LABELS[expense.taxCategory]
          : (expense.taxCategory ?? ""),
      "Reimbursement Status": isReimbursementStatus(expense.reimbursementStatus)
        ? REIMBURSEMENT_STATUS_LABELS[expense.reimbursementStatus]
        : expense.reimbursementStatus,
      "Review Status": isExpenseReviewStatus(expense.reviewStatus)
        ? EXPENSE_REVIEW_LABELS[expense.reviewStatus]
        : expense.reviewStatus,
      "Created At": exportDateTime(expense.createdAt),
    }));
}

export function accountingInvoicesCsv(source: AccountingExportSource): string {
  return accountingToCsv(ACCOUNTING_INVOICE_HEADERS, buildAccountingInvoiceRows(source));
}

export function accountingPaymentsCsv(source: AccountingExportSource): string {
  return accountingToCsv(ACCOUNTING_PAYMENT_HEADERS, buildAccountingPaymentRows(source));
}

export function accountingExpensesCsv(source: AccountingExportSource): string {
  return accountingToCsv(ACCOUNTING_EXPENSE_HEADERS, buildAccountingExpenseRows(source));
}

export function buildAccountingExportFiles(source: AccountingExportSource): AccountingExportFile[] {
  return [
    { name: "invoices.csv", data: accountingInvoicesCsv(source) },
    { name: "payments.csv", data: accountingPaymentsCsv(source) },
    { name: "expenses.csv", data: accountingExpensesCsv(source) },
  ];
}

export function emptyAccountingExportSource(
  input: Pick<AccountingExportSource, "businessId" | "businessName" | "slug">,
): AccountingExportSource {
  return {
    ...input,
    invoices: [],
    payments: [],
    expenses: [],
    customers: [],
    jobs: [],
  };
}

export async function loadAccountingExportSource(
  prisma: PrismaClient,
  businessId: string,
): Promise<AccountingExportSource> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { id: true, name: true, slug: true },
  });
  if (!business) {
    throw new Error("Business not found.");
  }

  const [invoices, payments, expenses, customers, jobs] = await Promise.all([
    prisma.invoice.findMany({
      where: { businessId },
      select: {
        id: true,
        customerId: true,
        jobId: true,
        status: true,
        total: true,
        paidAt: true,
        paymentMethod: true,
        paymentReference: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    prisma.payment.findMany({
      where: { businessId },
      select: {
        id: true,
        customerId: true,
        invoiceId: true,
        jobId: true,
        purpose: true,
        amount: true,
        method: true,
        receivedAt: true,
        note: true,
        createdAt: true,
      },
      orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
    }),
    prisma.expense.findMany({
      where: { businessId, ...ACTIVE_EXPENSE_WHERE },
      select: {
        id: true,
        vendor: true,
        description: true,
        amount: true,
        category: true,
        occurredOn: true,
        jobId: true,
        customerId: true,
        paymentMethod: true,
        taxCategory: true,
        reimbursementStatus: true,
        reviewStatus: true,
        voidedAt: true,
        createdAt: true,
      },
      orderBy: [{ occurredOn: "asc" }, { id: "asc" }],
    }),
    prisma.customer.findMany({
      where: { businessId },
      select: { id: true, name: true },
    }),
    prisma.job.findMany({
      where: { businessId },
      select: { id: true },
    }),
  ]);

  return {
    businessId: business.id,
    businessName: business.name,
    slug: business.slug,
    invoices,
    payments,
    expenses,
    customers,
    jobs,
  };
}

export async function buildAccountingExportZip(
  prisma: PrismaClient,
  businessId: string,
): Promise<AccountingExportZipResult> {
  const source = await loadAccountingExportSource(prisma, businessId);
  const date = new Date().toISOString().slice(0, 10);
  return {
    filename: `tbbt-accounting-${source.slug}-${date}.zip`,
    bytes: buildZipStore(buildAccountingExportFiles(source)),
  };
}
