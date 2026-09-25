import { roundMoney } from "@/lib/time-cards";
import type { JobProfitability } from "@/lib/financial-intelligence/job-profitability";
import type { ReceivableRow } from "@/lib/financial-intelligence/receivables";
import type { FinancialSource } from "@/lib/financial-intelligence/source";

export type CustomerProfitRow = {
  customerId: string;
  name: string;
  invoiced: number;
  collected: number;
  knownDirectCost: number | null;
  grossProfit: number | null;
  jobCount: number;
  averageTicket: number | null;
  outstandingReceivables: number;
  href: string;
};

export type CustomerLifetimeRow = {
  customerId: string;
  name: string;
  paidRevenue: number;
  paidInvoiceCount: number;
  completedJobs: number;
  isRepeat: boolean;
  href: string;
};

export function buildCustomerProfitability(
  source: FinancialSource,
  jobs: readonly JobProfitability[],
  receivables: readonly ReceivableRow[],
): CustomerProfitRow[] {
  return source.customers
    .map((customer) => {
      const customerJobs = jobs.filter((job) => job.customerId === customer.id);
      const invoices = source.invoices.filter(
        (invoice) => invoice.customerId === customer.id && (invoice.status === "SENT" || invoice.status === "PAID"),
      );
      const invoiced = roundMoney(invoices.reduce((sum, invoice) => sum + invoice.total, 0));
      const collected = roundMoney(
        customerJobs.reduce((sum, job) => sum + job.collectedRevenue, 0) ||
          source.invoices
            .filter((invoice) => invoice.customerId === customer.id && invoice.status === "PAID")
            .reduce((sum, invoice) => sum + invoice.total, 0),
      );
      const outstandingReceivables = roundMoney(
        receivables.filter((row) => row.customerId === customer.id).reduce((sum, row) => sum + row.balanceDue, 0),
      );
      let knownDirectCost: number | null = 0;
      for (const job of customerJobs) {
        if (job.knownTotalDirectCost == null) {
          knownDirectCost = null;
          break;
        }
        knownDirectCost = roundMoney(knownDirectCost + job.knownTotalDirectCost);
      }
      if (customerJobs.length === 0) knownDirectCost = 0;
      const jobCount = customerJobs.length || source.jobs.filter((job) => job.customerId === customer.id).length;
      const grossProfit = knownDirectCost == null ? null : roundMoney(invoiced - knownDirectCost);
      const hasSignal = invoiced > 0 || collected > 0 || jobCount > 0 || outstandingReceivables > 0;
      if (!hasSignal) return null;
      return {
        customerId: customer.id,
        name: customer.name,
        invoiced,
        collected,
        knownDirectCost,
        grossProfit,
        jobCount,
        averageTicket: jobCount > 0 && invoiced > 0 ? roundMoney(invoiced / jobCount) : invoiced > 0 ? invoiced : null,
        outstandingReceivables,
        href: `/customers/${customer.id}`,
      } satisfies CustomerProfitRow;
    })
    .filter((row): row is CustomerProfitRow => row != null)
    .sort((a, b) => b.collected - a.collected || b.invoiced - a.invoiced);
}

export function buildCustomerLifetime(
  customers: readonly { id: string; name: string; createdAt: Date }[],
  invoices: readonly { customerId: string | null; status: string; total: number }[],
  jobs: readonly { customerId: string | null; status: string }[],
): CustomerLifetimeRow[] {
  return customers
    .map((customer) => {
      const paid = invoices.filter((invoice) => invoice.customerId === customer.id && invoice.status === "PAID");
      const completed = jobs.filter(
        (job) => job.customerId === customer.id && job.status === "COMPLETED",
      ).length;
      const paidRevenue = roundMoney(paid.reduce((sum, invoice) => sum + invoice.total, 0));
      return {
        customerId: customer.id,
        name: customer.name,
        paidRevenue,
        paidInvoiceCount: paid.length,
        completedJobs: completed,
        isRepeat: completed > 1 || paid.length > 1,
        href: `/customers/${customer.id}`,
      };
    })
    .filter((row) => row.paidRevenue > 0 || row.completedJobs > 0)
    .sort((a, b) => b.paidRevenue - a.paidRevenue);
}
