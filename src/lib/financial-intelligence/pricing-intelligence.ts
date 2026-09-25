import { roundHours, roundMoney } from "@/lib/time-cards";
import type { JobProfitability } from "@/lib/financial-intelligence/job-profitability";
import type { LaborBurdenConfig } from "@/lib/financial-intelligence/labor-burden";
import type { ServiceProfitRow } from "@/lib/financial-intelligence/service-profitability";

export const PRICING_MIN_SAMPLE = 3;

export type PricingRecommendation = {
  key: string;
  title: string;
  kind: "owner-review";
  sampleSize: number;
  evidence: string[];
  currentResult: string;
  proposedAction: string;
  href: string;
};

function completedWithCost(jobs: readonly JobProfitability[]) {
  return jobs.filter(
    (job) => job.status === "COMPLETED" && job.completeness.laborCostComplete && job.knownTotalDirectCost != null,
  );
}

export function buildPricingRecommendations(input: {
  jobs: readonly JobProfitability[];
  services: readonly ServiceProfitRow[];
  laborBurden: LaborBurdenConfig;
  expenseGrowthPercent: number | null;
  currentExpenses: number;
  priorExpenses: number;
}): PricingRecommendation[] {
  const recommendations: PricingRecommendation[] = [];
  const completed = completedWithCost(input.jobs);
  const target = input.laborBurden.targetGrossMarginRate;

  if (target != null && completed.length >= PRICING_MIN_SAMPLE) {
    const under = completed.filter((job) => (job.grossMarginPct ?? 100) < target * 100);
    if (under.length >= Math.ceil(completed.length / 2)) {
      const avgMargin =
        completed.reduce((sum, job) => sum + (job.grossMarginPct ?? 0), 0) / completed.length;
      recommendations.push({
        key: "under-target-margin",
        title: "Jobs are frequently under the owner target margin",
        kind: "owner-review",
        sampleSize: completed.length,
        evidence: [
          `${under.length} of ${completed.length} completed jobs with complete cost data are below the owner target of ${roundMoney(target * 100)}%.`,
          `Average recorded gross margin on that sample is ${roundMoney(avgMargin)}%.`,
        ],
        currentResult: `${under.length}/${completed.length} jobs under target`,
        proposedAction: "Review service prices and estimate labor assumptions. TBBT will not change catalog prices.",
        href: "/reports?area=job-profitability",
      });
    }
  }

  const hourCompared = completed.filter((job) => job.estimateActual.estimatedLaborHours != null);
  if (hourCompared.length >= PRICING_MIN_SAMPLE) {
    const over = hourCompared.filter((job) => (job.estimateActual.laborHoursVariance ?? 0) > 0);
    if (over.length >= Math.ceil(hourCompared.length / 2)) {
      const avgVariance =
        hourCompared.reduce((sum, job) => sum + (job.estimateActual.laborHoursVariance ?? 0), 0) /
        hourCompared.length;
      recommendations.push({
        key: "labor-exceeds-estimate",
        title: "Actual labor consistently exceeds the estimate",
        kind: "owner-review",
        sampleSize: hourCompared.length,
        evidence: [
          `${over.length} of ${hourCompared.length} completed jobs used more approved hours than estimated labor quantity.`,
          `Average hour variance is ${roundHours(avgVariance)} hours.`,
        ],
        currentResult: `${over.length}/${hourCompared.length} jobs over estimated hours`,
        proposedAction: "Review estimate labor quantities before changing customer prices.",
        href: "/reports?area=estimate-accuracy",
      });
    }
  }

  for (const service of input.services) {
    if (!service.attributed || service.jobs < PRICING_MIN_SAMPLE) continue;
    const serviceJobs = completed.filter((job) => job.catalogItemId === service.catalogItemId);
    const compared = serviceJobs.filter((job) => job.estimateActual.estimatedLaborHours != null);
    if (compared.length < PRICING_MIN_SAMPLE) continue;
    const over = compared.filter((job) => (job.estimateActual.laborHoursVariance ?? 0) > 0);
    if (over.length >= Math.ceil(compared.length / 2)) {
      recommendations.push({
        key: `service-hour-overrun:${service.catalogItemId}`,
        title: `${service.name} commonly needs more hours than estimated`,
        kind: "owner-review",
        sampleSize: compared.length,
        evidence: [
          `${over.length} of ${compared.length} completed ${service.name} jobs ran over estimated labor hours.`,
          `Recorded average ticket is ${service.averageTicket == null ? "unavailable" : String(service.averageTicket)}.`,
        ],
        currentResult: `${over.length}/${compared.length} ${service.name} jobs over hours`,
        proposedAction: `Review the ${service.name} estimate template. Catalog price is unchanged.`,
        href: "/services",
      });
    }
  }

  if (
    input.expenseGrowthPercent != null &&
    input.expenseGrowthPercent >= 25 &&
    input.currentExpenses > 0 &&
    input.priorExpenses > 0
  ) {
    recommendations.push({
      key: "recurring-cost-growth",
      title: "Recorded expenses grew versus the prior period",
      kind: "owner-review",
      sampleSize: 2,
      evidence: [
        `Current-period recorded expenses ${roundMoney(input.currentExpenses)} versus prior ${roundMoney(input.priorExpenses)}.`,
        `Change is ${roundMoney(input.expenseGrowthPercent)}%.`,
      ],
      currentResult: `${roundMoney(input.expenseGrowthPercent)}% expense growth`,
      proposedAction: "Review recurring vendors and job materials. No liability was created.",
      href: "/reports?area=expenses",
    });
  }

  if (completed.length >= PRICING_MIN_SAMPLE * 2) {
    const sorted = [...completed].sort((a, b) => a.jobId.localeCompare(b.jobId));
    const mid = Math.floor(sorted.length / 2);
    const earlier = sorted.slice(0, mid);
    const later = sorted.slice(mid);
    const earlierMargin =
      earlier.reduce((sum, job) => sum + (job.grossMarginPct ?? 0), 0) / earlier.length;
    const laterMargin = later.reduce((sum, job) => sum + (job.grossMarginPct ?? 0), 0) / later.length;
    if (laterMargin + 5 < earlierMargin) {
      recommendations.push({
        key: "margin-erosion",
        title: "Recorded job margins are lower on more recent completed work",
        kind: "owner-review",
        sampleSize: completed.length,
        evidence: [
          `Earlier sample average margin ${roundMoney(earlierMargin)}% (n=${earlier.length}).`,
          `Later sample average margin ${roundMoney(laterMargin)}% (n=${later.length}).`,
        ],
        currentResult: `${roundMoney(laterMargin - earlierMargin)} pts later vs earlier`,
        proposedAction: "Inspect recent jobs for labor overrun or material cost growth before changing prices.",
        href: "/reports?area=job-profitability",
      });
    }
  }

  return recommendations;
}
