import { roundMoney } from "@/lib/time-cards";

export type LaborBurdenConfig = {
  burdenRate: number | null;
  targetGrossMarginRate: number | null;
  notes: string | null;
};

export type LaborBurdenApplication = {
  wageOnlyCost: number | null;
  burdenRate: number | null;
  burdenAmount: number | null;
  laborCostWithBurden: number | null;
  burdenSource: "none" | "business-default";
  explanation: string;
};

export const NO_BURDEN_CONFIGURED_MESSAGE =
  "No employer labor burden is configured. Labor cost uses recorded wage only.";

export function emptyLaborBurdenConfig(): LaborBurdenConfig {
  return { burdenRate: null, targetGrossMarginRate: null, notes: null };
}

/**
 * Parse an optional owner-entered rate.
 * Blank / missing → null (not configured).
 * Values greater than 1 are treated as percents (15 → 0.15).
 * Never invents a default rate.
 */
export function parseOptionalRate(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const amount = Number(trimmed);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const rate = amount > 1 ? amount / 100 : amount;
  if (rate > 2) return null;
  return Math.round(rate * 10_000) / 10_000;
}

export function formatRatePercent(rate: number | null): string | null {
  if (rate == null) return null;
  return `${roundMoney(rate * 100)}%`;
}

/**
 * Apply optional employer burden to recorded wage-only labor cost.
 * Missing wage cost stays incomplete. Unconfigured burden stays wage-only.
 */
export function applyLaborBurden(
  wageOnlyCost: number | null,
  config: LaborBurdenConfig | null | undefined,
): LaborBurdenApplication {
  const burdenRate = config?.burdenRate ?? null;
  if (wageOnlyCost == null) {
    return {
      wageOnlyCost: null,
      burdenRate,
      burdenAmount: null,
      laborCostWithBurden: null,
      burdenSource: burdenRate == null ? "none" : "business-default",
      explanation:
        burdenRate == null
          ? `${NO_BURDEN_CONFIGURED_MESSAGE} Wage snapshots are incomplete, so labor cost is omitted.`
          : "Wage snapshots are incomplete, so burden cannot be applied to a recorded labor cost.",
    };
  }

  if (burdenRate == null) {
    return {
      wageOnlyCost: roundMoney(wageOnlyCost),
      burdenRate: null,
      burdenAmount: null,
      laborCostWithBurden: roundMoney(wageOnlyCost),
      burdenSource: "none",
      explanation: NO_BURDEN_CONFIGURED_MESSAGE,
    };
  }

  const burdenAmount = roundMoney(wageOnlyCost * burdenRate);
  return {
    wageOnlyCost: roundMoney(wageOnlyCost),
    burdenRate,
    burdenAmount,
    laborCostWithBurden: roundMoney(wageOnlyCost + burdenAmount),
    burdenSource: "business-default",
    explanation: `Employer burden of ${formatRatePercent(burdenRate)} applied to recorded wage-only labor.`,
  };
}
