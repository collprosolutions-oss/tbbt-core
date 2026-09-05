export const INTAKE_MEASUREMENT_MODES = [
  "NONE",
  "OPTIONAL",
  "RECOMMENDED",
  "REQUIRED",
] as const;
export type IntakeMeasurementMode = (typeof INTAKE_MEASUREMENT_MODES)[number];

export const INTAKE_MEASUREMENT_AXES = ["width", "height", "length"] as const;
export type IntakeMeasurementAxis = (typeof INTAKE_MEASUREMENT_AXES)[number];

export const INTAKE_MEASUREMENT_UNITS = ["IN", "FT"] as const;
export type IntakeMeasurementUnit = (typeof INTAKE_MEASUREMENT_UNITS)[number];

export const MEASUREMENT_SOURCES = [
  "CUSTOMER_REPORTED",
  "CONTRACTOR_VERIFIED",
] as const;
export type MeasurementSource = (typeof MEASUREMENT_SOURCES)[number];

export const CUSTOMER_REPORTED_MEASUREMENT = "CUSTOMER_REPORTED" as const;
export const CONTRACTOR_VERIFIED_MEASUREMENT = "CONTRACTOR_VERIFIED" as const;

export type CatalogIntakeMeasurementConfig = {
  mode: IntakeMeasurementMode;
  axes: IntakeMeasurementAxis[];
  unit: IntakeMeasurementUnit;
};

export type CustomerReportedMeasurement = {
  catalogItemId: string;
  width: string;
  height: string;
  length: string;
  quantity: number | null;
  unit: IntakeMeasurementUnit;
};

export function parseIntakeMeasurementMode(value: string | null | undefined) {
  const mode = (value ?? "NONE").trim().toUpperCase();
  return (INTAKE_MEASUREMENT_MODES as readonly string[]).includes(mode)
    ? (mode as IntakeMeasurementMode)
    : "NONE";
}

export function parseIntakeMeasurementUnit(value: string | null | undefined) {
  const unit = (value ?? "IN").trim().toUpperCase();
  return unit === "FT" ? "FT" : "IN";
}

export function parseIntakeMeasurementAxes(value: string | null | undefined) {
  const raw = (value ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const axes = INTAKE_MEASUREMENT_AXES.filter((axis) => raw.includes(axis));
  return axes;
}

export function resolveCatalogIntakeConfig(item: {
  intakeMeasurementMode?: string | null;
  intakeMeasurementAxes?: string | null;
  intakeMeasurementUnit?: string | null;
}): CatalogIntakeMeasurementConfig {
  const mode = parseIntakeMeasurementMode(item.intakeMeasurementMode);
  return {
    mode,
    axes: mode === "NONE" ? [] : parseIntakeMeasurementAxes(item.intakeMeasurementAxes),
    unit: parseIntakeMeasurementUnit(item.intakeMeasurementUnit),
  };
}

export function catalogAsksMeasurements(config: CatalogIntakeMeasurementConfig) {
  return config.mode !== "NONE" && config.axes.length > 0;
}

function parseMeasurementNumber(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0 || value > 9999) return null;
  return value;
}

export function validateCustomerMeasurementInput(
  config: CatalogIntakeMeasurementConfig,
  input: { width?: string; height?: string; length?: string },
):
  | { ok: true; values: { width: number | null; height: number | null; length: number | null } }
  | { ok: false; error: string } {
  if (!catalogAsksMeasurements(config)) {
    return { ok: true, values: { width: null, height: null, length: null } };
  }

  const values = {
    width: config.axes.includes("width") ? parseMeasurementNumber(input.width ?? "") : null,
    height: config.axes.includes("height") ? parseMeasurementNumber(input.height ?? "") : null,
    length: config.axes.includes("length") ? parseMeasurementNumber(input.length ?? "") : null,
  };

  for (const axis of config.axes) {
    const raw = input[axis] ?? "";
    if (raw.trim() && values[axis] == null) {
      return { ok: false, error: "Enter measurements as a positive number, such as 32 or 48.5." };
    }
  }

  const missingRequired = config.axes.filter((axis) => values[axis] == null);
  if (config.mode === "REQUIRED" && missingRequired.length > 0) {
    return {
      ok: false,
      error: "Please enter the approximate measurements for the selected work.",
    };
  }

  return { ok: true, values };
}

export function measurementUnitLabel(unit: IntakeMeasurementUnit) {
  return unit === "FT" ? "ft" : "in";
}

export function formatCustomerMeasurement(input: {
  width?: number | null;
  height?: number | null;
  length?: number | null;
  quantity?: number | null;
  unit: string;
}) {
  const unit = measurementUnitLabel(parseIntakeMeasurementUnit(input.unit));
  const parts: string[] = [];
  if (input.width != null) parts.push(`Width ${input.width} ${unit}`);
  if (input.height != null) parts.push(`Height ${input.height} ${unit}`);
  if (input.length != null) parts.push(`Depth ${input.length} ${unit}`);
  if (input.quantity != null) parts.push(`Qty ${input.quantity}`);
  return parts.join(" · ");
}
