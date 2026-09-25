/**
 * Small production-unit registry for trade-aware formulas.
 *
 * Public catalog pricing may use these units. Hourly units are not a
 * public pricing option — TBBT does not publish a per-hour rate.
 */

export const PRODUCTION_UNITS = [
  "each",
  "sf",
  "lf",
  "room",
  "bag",
  "opening",
] as const;

export type ProductionUnit = (typeof PRODUCTION_UNITS)[number];

export const PRODUCTION_UNIT_LABELS: Record<ProductionUnit, string> = {
  each: "each",
  sf: "sf",
  lf: "lf",
  room: "room",
  bag: "bag",
  opening: "opening",
};

export function isProductionUnit(value: unknown): value is ProductionUnit {
  return (
    typeof value === "string" &&
    (PRODUCTION_UNITS as readonly string[]).includes(value)
  );
}

export function normalizeProductionUnit(
  value: unknown,
  fallback: ProductionUnit = "each",
): ProductionUnit {
  if (isProductionUnit(value)) return value;
  if (typeof value !== "string") return fallback;
  const key = value.trim().toLowerCase();
  if (isProductionUnit(key)) return key;
  if (key === "ea" || key === "unit" || key === "count") return "each";
  if (key === "sqft" || key === "sq ft" || key === "square foot" || key === "square feet") {
    return "sf";
  }
  if (key === "lin ft" || key === "linear foot" || key === "linear feet") return "lf";
  if (key === "rooms") return "room";
  if (key === "bags") return "bag";
  if (key === "openings") return "opening";
  return fallback;
}

const HOURLY_UNIT_PATTERN = /\b(hour|hours|hourly|hr|hrs)\b/i;

export function isHourlyUnitLabel(value: unknown) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return HOURLY_UNIT_PATTERN.test(trimmed);
}

/**
 * Public catalog unit labels never advertise hourly pricing.
 * Unknown/empty labels fall back to no unit (Starting/From wording).
 */
export function publicProductionUnitLabel(unitLabel?: string | null) {
  const unit = unitLabel?.trim();
  if (!unit || isHourlyUnitLabel(unit)) return null;
  return unit;
}
