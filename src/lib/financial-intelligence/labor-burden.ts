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
  kind: "recorded-wage" | "owner-assumption";
  explanation: string;
};

export const NO_BURDEN_CONFIGURED_MESSAGE =
  "No employer labor burden is configured. Labor cost uses recorded wage only.";

export const BURDEN_ASSUMPTION_MESSAGE =
  "Employer burden is an owner-configured planning assumption, not a recorded cash fact.";

/** Percent fields: 1 means 1%. Stored internally as a decimal fraction. */
export const TARGET_MARGIN_PERCENT_MAX = 100;
export const BURDEN_PERCENT_MAX = 200;

export function emptyLaborBurdenConfig(): LaborBurdenConfig {
  return { burdenRate: null, targetGrossMarginRate: null, notes: null };
}

/**
 * Parse an owner-entered percent field.
 * Blank / missing → null (not configured).
 * 1 → 0.01, 0.5 → 0.005, 12.5 → 0.125, 40 → 0.40.
 * Decimals are never reinterpreted as already-normalized fractions.
 */
export function parsePercentInput(
  raw: string | null | undefined,
  options?: { maxPercent?: number },
): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const percent = Number(trimmed);
  if (!Number.isFinite(percent) || percent < 0) return null;
  const maxPercent = options?.maxPercent ?? BURDEN_PERCENT_MAX;
  if (percent > maxPercent) return null;
  return Math.round((percent / 100) * 10_000) / 10_000;
}

/** @deprecated Use parsePercentInput. Same percent-field semantics. */
export function parseOptionalRate(raw: string | null | undefined): number | null {
  return parsePercentInput(raw);
}

export function formatRatePercent(rate: number | null): string | null {
  if (rate == null) return null;
  return `${roundMoney(rate * 100)}%`;
}

/**
 * Apply optional employer burden to recorded wage-only labor cost.
 * Missing wage cost stays incomplete. Unconfigured burden stays wage-only.
 * The burden amount is an owner assumption, not recorded cash.
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
      kind: burdenRate == null ? "recorded-wage" : "owner-assumption",
      explanation:
        burdenRate == null
          ? `${NO_BURDEN_CONFIGURED_MESSAGE} Wage snapshots are incomplete, so labor cost is omitted.`
          : `${BURDEN_ASSUMPTION_MESSAGE} Wage snapshots are incomplete, so burden cannot be applied to a recorded labor cost.`,
    };
  }

  if (burdenRate == null) {
    return {
      wageOnlyCost: roundMoney(wageOnlyCost),
      burdenRate: null,
      burdenAmount: null,
      laborCostWithBurden: roundMoney(wageOnlyCost),
      burdenSource: "none",
      kind: "recorded-wage",
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
    kind: "owner-assumption",
    explanation: `${BURDEN_ASSUMPTION_MESSAGE} Using owner-configured ${formatRatePercent(burdenRate)} labor burden assumption.`,
  };
}
