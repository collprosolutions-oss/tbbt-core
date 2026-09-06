/**
 * Reusable work-area / contents services for later trades
 * (flooring, painting, drywall, remodeling, cleaning).
 *
 * Contents moving, contents protection, and additional customer-belongings
 * cleaning stay separately identifiable. Job selections do not persist;
 * business rates do.
 */
import { roundMoney } from "@/lib/estimate-calculators/types";

export const WORK_AREA_HANDLING_LEVELS = [
  "clear",
  "light",
  "moderate",
  "heavy",
  "custom",
] as const;

export const CONTENTS_PROTECTION_LEVELS = [
  "none",
  "light",
  "moderate",
  "heavy",
  "custom",
] as const;

export const BELONGINGS_CLEANUP_LEVELS = [
  "none",
  "light",
  "moderate",
  "heavy",
  "custom",
] as const;

export type WorkAreaHandlingLevel = (typeof WORK_AREA_HANDLING_LEVELS)[number];
export type ContentsProtectionLevel = (typeof CONTENTS_PROTECTION_LEVELS)[number];
export type BelongingsCleanupLevel = (typeof BELONGINGS_CLEANUP_LEVELS)[number];

export type WorkAreaServiceRates = {
  light: number;
  moderate: number;
  heavy: number;
};

export const DEFAULT_CONTENTS_HANDLING_RATES: WorkAreaServiceRates = {
  light: 85,
  moderate: 165,
  heavy: 295,
};

export const DEFAULT_CONTENTS_PROTECTION_RATES: WorkAreaServiceRates = {
  light: 55,
  moderate: 110,
  heavy: 195,
};

export const DEFAULT_BELONGINGS_CLEANUP_RATES: WorkAreaServiceRates = {
  light: 45,
  moderate: 95,
  heavy: 165,
};

export function isWorkAreaHandlingLevel(
  value: unknown,
): value is WorkAreaHandlingLevel {
  return (
    typeof value === "string" &&
    (WORK_AREA_HANDLING_LEVELS as readonly string[]).includes(value)
  );
}

export function isContentsProtectionLevel(
  value: unknown,
): value is ContentsProtectionLevel {
  return (
    typeof value === "string" &&
    (CONTENTS_PROTECTION_LEVELS as readonly string[]).includes(value)
  );
}

export function isBelongingsCleanupLevel(
  value: unknown,
): value is BelongingsCleanupLevel {
  return (
    typeof value === "string" &&
    (BELONGINGS_CLEANUP_LEVELS as readonly string[]).includes(value)
  );
}

export function normalizeWorkAreaServiceRates(
  raw?: Record<string, unknown> | null,
  defaults: WorkAreaServiceRates = DEFAULT_CONTENTS_HANDLING_RATES,
): WorkAreaServiceRates {
  return {
    light: moneyOr(raw?.light, defaults.light),
    moderate: moneyOr(raw?.moderate, defaults.moderate),
    heavy: moneyOr(raw?.heavy, defaults.heavy),
  };
}

export function computeWorkAreaService(
  level: string,
  rates: WorkAreaServiceRates,
  customAmount = 0,
): { quantity: number; rate: number; amount: number; explicitZero: boolean } {
  if (level === "none" || level === "clear") {
    return { quantity: 1, rate: 0, amount: 0, explicitZero: true };
  }
  if (level === "custom") {
    const rate = moneyOr(customAmount, 0);
    return { quantity: 1, rate, amount: rate, explicitZero: rate === 0 };
  }
  const rate =
    level === "light"
      ? rates.light
      : level === "moderate"
        ? rates.moderate
        : level === "heavy"
          ? rates.heavy
          : 0;
  return { quantity: 1, rate, amount: rate, explicitZero: false };
}

export function workAreaHandlingLabel(level: string) {
  if (level === "clear") return "Work area clear / ready";
  if (level === "light") return "Light contents moving";
  if (level === "moderate") return "Moderate contents moving";
  if (level === "heavy") return "Heavy / significant contents moving";
  return "Custom contents-handling amount";
}

export function contentsProtectionLabel(level: string) {
  if (level === "none") return "No contractor protection required";
  if (level === "light") return "Light contents protection";
  if (level === "moderate") return "Moderate contents protection";
  if (level === "heavy") return "Heavy / extensive contents protection";
  return "Custom contents-protection amount";
}

export function belongingsCleanupLabel(level: string) {
  if (level === "none") return "Not included / not required";
  if (level === "light") return "Light belongings cleanup";
  if (level === "moderate") return "Moderate belongings cleanup";
  if (level === "heavy") return "Heavy / extensive belongings cleanup";
  return "Custom belongings-cleanup amount";
}

function moneyOr(value: unknown, fallback: number) {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount) || amount < 0) return fallback;
  return roundMoney(amount);
}
