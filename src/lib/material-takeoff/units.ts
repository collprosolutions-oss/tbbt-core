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

/** True while the owner is mid-keystroke on a decimal or mixed fraction. */
export function isIncompleteNumericDraft(raw: string): boolean {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (trimmed === "-" || trimmed === "." || trimmed === "-.") return true;
  if (/^-?\d+\.$/.test(trimmed)) return true;
  if (/^-?\d+-$/.test(trimmed)) return true;
  if (/^-?\d+\s+$/.test(raw)) return true;
  if (/^-?\d+\s+\d*$/.test(trimmed)) return true;
  if (/^-?\d+\s+\d+\/$/.test(trimmed)) return true;
  if (/^-?\d+\/$/.test(trimmed)) return true;
  return false;
}

export function parsePositiveNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    if (isIncompleteNumericDraft(value)) return null;
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
    if (isIncompleteNumericDraft(value)) return null;
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

const UNICODE_FRACTIONS: Record<string, string> = {
  "¼": "1/4",
  "½": "1/2",
  "¾": "3/4",
  "⅓": "1/3",
  "⅔": "2/3",
  "⅛": "1/8",
  "⅜": "3/8",
  "⅝": "5/8",
  "⅞": "7/8",
  "⅙": "1/6",
  "⅚": "5/6",
};

/**
 * Parse construction measurements: 4.5, 4 1/2, 4-1/2, 4½, 1/2.
 * Returns null when empty or not a number. Zero is allowed.
 */
export function parseConstructionNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;
  let raw = value.trim();
  if (!raw) return null;
  for (const [glyph, ascii] of Object.entries(UNICODE_FRACTIONS)) {
    raw = raw.split(glyph).join(` ${ascii} `);
  }
  raw = raw.replace(/(\d)\s+(\d+\s*\/\s*\d+)/, "$1 $2").replace(/\s+/g, " ").trim();
  const mixed = raw.match(/^(-?\d+(?:\.\d+)?)\s*[- ]\s*(\d+)\s*\/\s*(\d+)$/);
  if (mixed) {
    const whole = Number(mixed[1]);
    const num = Number(mixed[2]);
    const den = Number(mixed[3]);
    if (!Number.isFinite(whole) || !Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
      return null;
    }
    const sign = whole < 0 ? -1 : 1;
    return sign * (Math.abs(whole) + num / den);
  }
  const fraction = raw.match(/^(-)?(\d+)\s*\/\s*(\d+)$/);
  if (fraction) {
    const num = Number(fraction[2]);
    const den = Number(fraction[3]);
    if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
    const signed = num / den;
    return fraction[1] ? -signed : signed;
  }
  if (!/^-?\d+(\.\d+)?$/.test(raw) && !/^-?\.\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function parseNonNegativeConstructionNumber(value: unknown): number | null {
  const parsed = parseConstructionNumber(value);
  if (parsed == null || parsed < 0) return null;
  return parsed;
}

export function parsePositiveConstructionNumber(value: unknown): number | null {
  const parsed = parseConstructionNumber(value);
  if (parsed == null || parsed <= 0) return null;
  return parsed;
}

export function parseNonNegativeInteger(value: unknown): number | null {
  const parsed = parseNonNegativeNumber(value);
  if (parsed == null || !Number.isInteger(parsed)) return null;
  return parsed;
}

export type TakeoffNumericParseMode = "decimal" | "integer" | "construction";

/**
 * Parse a takeoff numeric field without committing incomplete drafts
 * such as "6." or "4 1/". Malformed and negative values are invalid.
 */
export function parseTakeoffNumericInput(
  raw: string,
  mode: TakeoffNumericParseMode = "decimal",
): { status: "incomplete" | "empty" | "invalid" | "ok"; value: number | null } {
  if (typeof raw !== "string") return { status: "invalid", value: null };
  if (isIncompleteNumericDraft(raw)) return { status: "incomplete", value: null };
  if (!raw.trim()) return { status: "empty", value: null };
  const parsed =
    mode === "integer"
      ? parseNonNegativeInteger(raw)
      : mode === "construction"
        ? parseNonNegativeConstructionNumber(raw)
        : parseNonNegativeNumber(raw);
  if (parsed == null) return { status: "invalid", value: null };
  return { status: "ok", value: parsed };
}

export function feetAndInchesToFeet(feet: number, inches: number): number {
  const ft = Number.isFinite(feet) ? Math.max(0, feet) : 0;
  const inch = Number.isFinite(inches) ? Math.max(0, inches) : 0;
  return roundTakeoff(ft + inch / 12, 4);
}

/** Split stored decimal feet into construction feet + inches (nearest 1/8 in). */
export function splitFeetAndInches(totalFeet: number): { feet: number; inches: number } {
  if (!Number.isFinite(totalFeet) || totalFeet <= 0) return { feet: 0, inches: 0 };
  const totalInches = Math.round(totalFeet * 12 * 8 + Number.EPSILON) / 8;
  return splitTotalInches(totalInches);
}

export function splitTotalInches(totalInches: number): { feet: number; inches: number } {
  if (!Number.isFinite(totalInches) || totalInches <= 0) return { feet: 0, inches: 0 };
  const rounded = roundTakeoff(totalInches, 4);
  const feet = Math.floor((rounded + 1e-9) / 12);
  const inches = roundTakeoff(rounded - feet * 12, 4);
  if (inches >= 12 - 1e-9) return { feet: feet + 1, inches: 0 };
  return { feet, inches };
}

export function formatFeetInches(totalFeet: number): string {
  const parts = splitFeetAndInches(totalFeet);
  const inchLabel = Number.isInteger(parts.inches)
    ? String(parts.inches)
    : String(roundTakeoff(parts.inches, 4));
  return `${parts.feet} ft ${inchLabel} in`;
}

export function resolveFeetInchesInput(
  partial: Record<string, unknown> | null | undefined,
  totalKey: string,
  feetPartKey: string,
  inchesPartKey: string,
): { totalFt: number; feetPart: number; inchesPart: number } {
  const hasFeetPart =
    partial != null && Object.prototype.hasOwnProperty.call(partial, feetPartKey);
  const hasInchesPart =
    partial != null && Object.prototype.hasOwnProperty.call(partial, inchesPartKey);
  if (hasFeetPart || hasInchesPart) {
    const feetPart = parseNonNegativeConstructionNumber(partial?.[feetPartKey]) ?? 0;
    const inchesPart = parseNonNegativeConstructionNumber(partial?.[inchesPartKey]) ?? 0;
    return {
      totalFt: feetAndInchesToFeet(feetPart, inchesPart),
      feetPart,
      inchesPart,
    };
  }
  const totalFt = parseNonNegativeNumber(partial?.[totalKey]) ?? 0;
  const split = splitFeetAndInches(totalFt);
  return { totalFt, feetPart: split.feet, inchesPart: split.inches };
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
