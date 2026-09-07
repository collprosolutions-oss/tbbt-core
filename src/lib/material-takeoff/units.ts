/**
 * Linear / volume conversion for takeoff inputs.
 *
 * Intake currently stores IN/FT only. Unknown units are rejected rather
 * than guessed so customer-reported values cannot silently become bags
 * or sheets.
 */
import type { IntakeMeasurementUnit } from "@/lib/catalog-intake";

const LINEAR_FEET = new Set(["ft", "foot", "feet"]);
const LINEAR_INCHES = new Set(["in", "inch", "inches"]);
const REJECTED_LINEAR = new Set([
  "yd",
  "yard",
  "yards",
  "m",
  "meter",
  "meters",
  "cm",
  "mm",
  "sqft",
  "sq ft",
  "sq-ft",
  "sf",
  "cuft",
  "cu ft",
  "cu-ft",
  "cf",
  "cuyd",
  "cu yd",
  "cy",
  "yd3",
  "m3",
  "m2",
]);

export function roundTakeoff(value: number, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function parsePositiveNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

export function parseNonNegativeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

export function ceilCount(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(0, Math.ceil(value - 1e-9));
}

export function parseLinearUnitToken(
  raw: string | null | undefined,
): IntakeMeasurementUnit | null {
  const unit = (raw ?? "").trim().toLowerCase();
  if (!unit) return null;
  if (LINEAR_FEET.has(unit)) return "FT";
  if (LINEAR_INCHES.has(unit)) return "IN";
  return null;
}

export function isRejectedLinearUnit(raw: string | null | undefined) {
  const unit = (raw ?? "").trim().toLowerCase();
  if (!unit) return false;
  if (parseLinearUnitToken(unit)) return false;
  return REJECTED_LINEAR.has(unit) || unit.includes("yd") || unit.includes("sq") || unit.includes("cu");
}

export function linearToFeet(
  value: number,
  unit: IntakeMeasurementUnit,
): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (unit === "FT") return roundTakeoff(value, 4);
  return roundTakeoff(value / 12, 4);
}

export function inchesToFeet(inches: number): number | null {
  if (!Number.isFinite(inches) || inches <= 0) return null;
  return roundTakeoff(inches / 12, 4);
}

export function convertLinearToFeet(
  value: unknown,
  unitRaw: string | null | undefined,
): { feet: number | null; skipped: string | null } {
  const amount = parsePositiveNumber(value);
  if (amount == null) {
    return { feet: null, skipped: "missing-or-nonpositive" };
  }
  if (isRejectedLinearUnit(unitRaw)) {
    return { feet: null, skipped: `incompatible-unit:${unitRaw ?? ""}` };
  }
  const unit = parseLinearUnitToken(unitRaw) ?? (unitRaw ? null : "FT");
  if (!unit) {
    return { feet: null, skipped: `unknown-unit:${unitRaw ?? ""}` };
  }
  return { feet: linearToFeet(amount, unit), skipped: null };
}
