import { roundHours, roundMoney } from "@/lib/time-cards";
import type { JobProfitability } from "@/lib/financial-intelligence/job-profitability";

export type ServiceProfitRow = {
  catalogItemId: string | null;
  name: string;
  jobs: number;
  revenue: number | null;
  collectedRevenue: number;
  laborHours: number;
  directCost: number | null;
  grossProfit: number | null;
  grossMargin: number | null;
  averageTicket: number | null;
  estimateVariance: number | null;
  jobCount: number;
  attributed: boolean;
  laborCost: number | null;
  jobExpense: number | null;
  recordedMargin: number | null;
};

function emptyRow(name: string, catalogItemId: string | null, attributed: boolean): ServiceProfitRow {
  return {
    catalogItemId,
    name,
    jobs: 0,
    revenue: 0,
    collectedRevenue: 0,
    laborHours: 0,
    directCost: 0,
    grossProfit: 0,
    grossMargin: null,
    averageTicket: null,
    estimateVariance: 0,
    jobCount: 0,
    attributed,
    laborCost: 0,
    jobExpense: 0,
    recordedMargin: 0,
  };
}

/**
 * Aggregate completed (or financially active) jobs by catalog service.
 * Jobs that cannot be tied to exactly one catalog item stay Unattributed.
 */
export function buildServiceProfitability(jobs: readonly JobProfitability[]): ServiceProfitRow[] {
  const rows = new Map<string, ServiceProfitRow>();
  const unknown = emptyRow("Unattributed", null, false);

  function bucket(job: JobProfitability): ServiceProfitRow {
    if (!job.completeness.serviceAttributed || !job.catalogItemId) return unknown;
    const existing = rows.get(job.catalogItemId);
    if (existing) return existing;
    const created = emptyRow(job.catalogName ?? "Service", job.catalogItemId, true);
    rows.set(job.catalogItemId, created);
    return created;
  }

  for (const job of jobs) {
    const row = bucket(job);
    row.jobs += 1;
    row.jobCount += 1;
    row.laborHours = roundHours(row.laborHours + job.laborHours);
    if (row.revenue != null) row.revenue = roundMoney(row.revenue + job.billedRevenue);
    row.collectedRevenue = roundMoney(row.collectedRevenue + job.collectedRevenue);
    if (row.laborCost != null && job.directLaborCost != null) {
      row.laborCost = roundMoney(row.laborCost + job.directLaborCost);
    } else if (job.directLaborCost == null) {
      row.laborCost = null;
    }
    if (row.jobExpense != null) {
      row.jobExpense = roundMoney(row.jobExpense + job.materialsDirectExpense + job.otherAllocatedDirectExpense);
    }
    if (row.directCost != null && job.knownTotalDirectCost != null) {
      row.directCost = roundMoney(row.directCost + job.knownTotalDirectCost);
    } else if (job.knownTotalDirectCost == null) {
      row.directCost = null;
    }
    if (row.estimateVariance != null && job.estimateActual.totalCostVariance != null) {
      row.estimateVariance = roundMoney(row.estimateVariance + job.estimateActual.totalCostVariance);
    } else if (job.estimateActual.totalCostVariance == null && row.estimateVariance === 0 && row.jobs === 1) {
      row.estimateVariance = null;
    }
  }

  const all = [...rows.values(), unknown].filter(
    (row) => row.jobs > 0 || (row.revenue ?? 0) > 0 || (row.directCost ?? 0) > 0,
  );
  for (const row of all) {
    if (row.revenue == null || row.directCost == null) {
      row.grossProfit = null;
      row.recordedMargin = null;
      row.grossMargin = null;
      row.averageTicket = row.jobs > 0 && row.revenue != null ? roundMoney(row.revenue / row.jobs) : null;
    } else {
      row.grossProfit = roundMoney(row.revenue - row.directCost);
      row.recordedMargin = row.grossProfit;
      row.grossMargin = row.revenue > 0 ? roundMoney((row.grossProfit / row.revenue) * 100) : null;
      row.averageTicket = row.jobs > 0 ? roundMoney(row.revenue / row.jobs) : null;
    }
  }
  return all.sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0));
}
