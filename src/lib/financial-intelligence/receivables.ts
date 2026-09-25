import { inRange } from "@/lib/reports";
import { roundMoney } from "@/lib/time-cards";
import { invoiceBalanceDue, paymentsAppliedToInvoice } from "@/lib/financial-intelligence/collected-revenue";
import type { FinancialSource } from "@/lib/financial-intelligence/source";

export const RECEIVABLE_AGING_BUCKETS = ["0-30", "31-60", "61-90", "90+"] as const;
export type ReceivableAgingBucket = (typeof RECEIVABLE_AGING_BUCKETS)[number];

export type ReceivableRow = {
  invoiceId: string;
  customerId: string | null;
  customerName: string;
  jobId: string | null;
  status: "SENT";
  invoiceTotal: number;
  collectedAgainstInvoice: number;
  balanceDue: number;
  issuedAt: Date;
  ageDays: number;
  agingBucket: ReceivableAgingBucket;
  dueDate: null;
  href: string;
};

export type ReceivablesAging = {
  rows: ReceivableRow[];
  totalOutstanding: number;
  count: number;
  buckets: Record<ReceivableAgingBucket, { count: number; amount: number }>;
};

export function agingBucketForDays(ageDays: number): ReceivableAgingBucket {
  if (ageDays <= 30) return "0-30";
  if (ageDays <= 60) return "31-60";
  if (ageDays <= 90) return "61-90";
  return "90+";
}

export function ageInWholeDays(from: Date, now: Date): number {
  const ms = now.getTime() - from.getTime();
  if (ms <= 0) return 0;
  return Math.floor(ms / 86_400_000);
}

/**
 * Owner-facing receivables from SENT invoices only.
 * Due dates are never invented — Invoice has no due-date field.
 * Balance due subtracts recorded payments on that invoice.
 */
export function buildReceivables(source: FinancialSource, now: Date = new Date()): ReceivablesAging {
  const emptyBuckets = {
    "0-30": { count: 0, amount: 0 },
    "31-60": { count: 0, amount: 0 },
    "61-90": { count: 0, amount: 0 },
    "90+": { count: 0, amount: 0 },
  } satisfies ReceivablesAging["buckets"];

  const rows: ReceivableRow[] = source.invoices
    .filter((invoice) => invoice.status === "SENT")
    .map((invoice) => {
      const collectedAgainstInvoice = paymentsAppliedToInvoice(source.payments, invoice.id);
      const balanceDue = invoiceBalanceDue(invoice, source.payments);
      const ageDays = ageInWholeDays(invoice.createdAt, now);
      const agingBucket = agingBucketForDays(ageDays);
      const customer = source.customers.find((row) => row.id === invoice.customerId);
      return {
        invoiceId: invoice.id,
        customerId: invoice.customerId,
        customerName: customer?.name ?? "Customer",
        jobId: invoice.jobId,
        status: "SENT" as const,
        invoiceTotal: roundMoney(invoice.total),
        collectedAgainstInvoice,
        balanceDue,
        issuedAt: invoice.createdAt,
        ageDays,
        agingBucket,
        dueDate: null,
        href: `/invoices/${invoice.id}`,
      };
    })
    .filter((row) => row.balanceDue > 0)
    .sort((a, b) => b.ageDays - a.ageDays || b.balanceDue - a.balanceDue);

  for (const row of rows) {
    emptyBuckets[row.agingBucket].count += 1;
    emptyBuckets[row.agingBucket].amount = roundMoney(emptyBuckets[row.agingBucket].amount + row.balanceDue);
  }

  return {
    rows,
    totalOutstanding: roundMoney(rows.reduce((sum, row) => sum + row.balanceDue, 0)),
    count: rows.length,
    buckets: emptyBuckets,
  };
}

export function receivablesInRange(aging: ReceivablesAging, range: { start: Date | null; end: Date | null }) {
  return aging.rows.filter((row) => inRange(row.issuedAt, range));
}
