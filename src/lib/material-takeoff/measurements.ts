/**
 * Map existing intake / calculator measurements onto takeoff inputs.
 *
 * Customer-reported values stay labeled unverified and are skipped when
 * the unit or axis is incompatible with the selected formula.
 */
import {
  CUSTOMER_REPORTED_MEASUREMENT_LABEL,
  type StoredIntakeMeasurement,
  measurementSourceLabel,
} from "@/lib/intake-quote-handoff";
import {
  CUSTOMER_REPORTED_MEASUREMENT,
  parseIntakeMeasurementUnit,
} from "@/lib/catalog-intake";
import type { CalculatorSnapshot } from "@/lib/estimate-calculators/types";
import {
  feetAndInchesToFeet,
  parseLinearUnitToken,
  parsePositiveNumber,
  roundTakeoff,
  splitFeetAndInches,
  splitTotalInches,
} from "@/lib/material-takeoff/units";
import type {
  TakeoffMeasurementSource,
  TakeoffTypeId,
} from "@/lib/material-takeoff/types";

export type TakeoffInputSuggestion = {
  inputs: Record<string, unknown>;
  measurementSource: TakeoffMeasurementSource | null;
  skippedMeasurements: string[];
};

export function suggestedTakeoffType(input: {
  calculatorId?: string | null;
  title?: string | null;
}): TakeoffTypeId | null {
  const calculatorId = input.calculatorId ?? "";
  const title = (input.title ?? "").toLowerCase();
  if (
    calculatorId === "decorative-wall-paneling" ||
    title.includes("panel") ||
    title.includes("plywood") ||
    title.includes("sheet")
  ) {
    return "sheet-covering";
  }
  if (title.includes("concrete") || title.includes("slab")) {
    return "concrete-slab";
  }
  if (title.includes("fram") || title.includes("stud wall")) {
    return "framed-wall";
  }
  return null;
}

export function suggestTakeoffInputs(input: {
  takeoffType: TakeoffTypeId;
  calculatorSnapshot?: CalculatorSnapshot | null;
  intakeMeasurement?: StoredIntakeMeasurement | null;
}): TakeoffInputSuggestion {
  const skipped: string[] = [];
  const fromCalculator = inputsFromCalculator(
    input.takeoffType,
    input.calculatorSnapshot,
    skipped,
  );
  const fromIntake = inputsFromIntake(
    input.takeoffType,
    input.intakeMeasurement,
    skipped,
  );
  const inputs = { ...fromIntake.inputs, ...fromCalculator.inputs };
  const measurementSource =
    fromCalculator.source ?? fromIntake.source ?? {
      kind: "manual" as const,
      label: "Owner-entered",
      unverified: false,
    };
  return {
    inputs,
    measurementSource:
      Object.keys(inputs).length > 0 ? measurementSource : fromIntake.source ?? fromCalculator.source,
    skippedMeasurements: skipped,
  };
}

function inputsFromCalculator(
  takeoffType: TakeoffTypeId,
  snapshot: CalculatorSnapshot | null | undefined,
  skipped: string[],
): { inputs: Record<string, unknown>; source: TakeoffMeasurementSource | null } {
  const values = snapshot?.inputs;
  if (!values) return { inputs: {}, source: null };
  const source: TakeoffMeasurementSource = {
    kind: "calculator",
    label: "Owner calculator measurements",
    unverified: false,
  };
  if (takeoffType === "sheet-covering") {
    const wallWidthFt = parsePositiveNumber(values.wallWidthFt);
    const wallHeightFt = parsePositiveNumber(values.wallHeightFt);
    if (wallWidthFt == null) skipped.push("calculator:wallWidthFt");
    if (wallHeightFt == null) skipped.push("calculator:wallHeightFt");
    return {
      source,
      inputs: {
        ...(wallWidthFt != null ? feetFields("wallWidth", wallWidthFt) : {}),
        ...(wallHeightFt != null ? feetFields("wallHeight", wallHeightFt) : {}),
        slidingPatioDoors: values.slidingPatioDoors ?? 0,
        standardDoors: values.standardDoors ?? 0,
        windows: values.windows ?? 0,
      },
    };
  }
  if (takeoffType === "framed-wall") {
    const wallLengthFt =
      parsePositiveNumber(values.wallLengthFt) ??
      parsePositiveNumber(values.wallWidthFt) ??
      parsePositiveNumber(values.lengthFt);
    const wallHeightFt = parsePositiveNumber(values.wallHeightFt);
    if (wallLengthFt == null) skipped.push("calculator:wallLengthFt");
    if (wallHeightFt == null) skipped.push("calculator:wallHeightFt");
    return {
      source,
      inputs: {
        ...(wallLengthFt != null ? feetFields("wallLength", wallLengthFt) : {}),
        ...(wallHeightFt != null ? feetFields("wallHeight", wallHeightFt) : {}),
      },
    };
  }
  const lengthFt =
    parsePositiveNumber(values.lengthFt) ?? parsePositiveNumber(values.wallLengthFt);
  const widthFt =
    parsePositiveNumber(values.widthFt) ?? parsePositiveNumber(values.wallWidthFt);
  if (lengthFt == null) skipped.push("calculator:lengthFt");
  if (widthFt == null) skipped.push("calculator:widthFt");
  if (values.thicknessIn == null && values.wallHeightFt != null) {
    skipped.push("calculator:height-not-used-as-slab-thickness");
  }
  return {
    source,
    inputs: {
      ...(lengthFt != null ? feetFields("length", lengthFt) : {}),
      ...(widthFt != null ? feetFields("width", widthFt) : {}),
    },
  };
}

function inputsFromIntake(
  takeoffType: TakeoffTypeId,
  measurement: StoredIntakeMeasurement | null | undefined,
  skipped: string[],
): { inputs: Record<string, unknown>; source: TakeoffMeasurementSource | null } {
  if (!measurement) return { inputs: {}, source: null };
  const unitToken = parseLinearUnitToken(measurement.unit);
  if (!unitToken) {
    skipped.push(`intake:incompatible-unit:${measurement.unit}`);
    return {
      inputs: {},
      source: intakeSource(measurement),
    };
  }
  const storedUnit = parseIntakeMeasurementUnit(measurement.unit);
  const width = axisLinear(measurement.width, storedUnit, "width", skipped);
  const height = axisLinear(measurement.height, storedUnit, "height", skipped);
  const length = axisLinear(measurement.length, storedUnit, "length", skipped);

  if (takeoffType === "concrete-slab") {
    if (height != null) skipped.push("intake:height-not-used-as-slab-thickness");
    if (length == null) skipped.push("intake:length");
    if (width == null) skipped.push("intake:width");
    return {
      source: intakeSource(measurement),
      inputs: {
        ...(length != null
          ? {
              lengthFt: length.totalFt,
              lengthFtPart: length.feetPart,
              lengthInPart: length.inchesPart,
            }
          : {}),
        ...(width != null
          ? {
              widthFt: width.totalFt,
              widthFtPart: width.feetPart,
              widthInPart: width.inchesPart,
            }
          : {}),
      },
    };
  }

  if (takeoffType === "sheet-covering") {
    const wallWidth = width ?? length;
    return {
      source: intakeSource(measurement),
      inputs: {
        ...(wallWidth != null
          ? {
              wallWidthFt: wallWidth.totalFt,
              wallWidthFtPart: wallWidth.feetPart,
              wallWidthInPart: wallWidth.inchesPart,
            }
          : {}),
        ...(height != null
          ? {
              wallHeightFt: height.totalFt,
              wallHeightFtPart: height.feetPart,
              wallHeightInPart: height.inchesPart,
            }
          : {}),
      },
    };
  }

  const wallLength = length ?? width;
  return {
    source: intakeSource(measurement),
    inputs: {
      ...(wallLength != null
        ? {
            wallLengthFt: wallLength.totalFt,
            wallLengthFtPart: wallLength.feetPart,
            wallLengthInPart: wallLength.inchesPart,
          }
        : {}),
      ...(height != null
        ? {
            wallHeightFt: height.totalFt,
            wallHeightFtPart: height.feetPart,
            wallHeightInPart: height.inchesPart,
          }
        : {}),
    },
  };
}

function feetFields(prefix: string, totalFt: number) {
  const parts = splitFeetAndInches(totalFt);
  return {
    [`${prefix}Ft`]: roundTakeoff(totalFt, 4),
    [`${prefix}FtPart`]: parts.feet,
    [`${prefix}InPart`]: parts.inches,
  };
}

function axisLinear(
  value: number | null | undefined,
  unit: ReturnType<typeof parseIntakeMeasurementUnit>,
  axis: string,
  skipped: string[],
): { totalFt: number; feetPart: number; inchesPart: number } | null {
  if (value == null) return null;
  if (unit === "IN") {
    const parts = splitTotalInches(value);
    return {
      totalFt: feetAndInchesToFeet(parts.feet, parts.inches),
      feetPart: parts.feet,
      inchesPart: parts.inches,
    };
  }
  if (unit === "FT") {
    const parts = splitFeetAndInches(value);
    return {
      totalFt: roundTakeoff(value, 4),
      feetPart: parts.feet,
      inchesPart: parts.inches,
    };
  }
  skipped.push(`intake:${axis}`);
  return null;
}

function intakeSource(measurement: StoredIntakeMeasurement): TakeoffMeasurementSource {
  const unverified = measurement.source === CUSTOMER_REPORTED_MEASUREMENT;
  return {
    kind: "intake",
    label: unverified
      ? CUSTOMER_REPORTED_MEASUREMENT_LABEL
      : measurementSourceLabel(measurement.source),
    unverified,
  };
}

export function pickIntakeMeasurementForLine(
  measurements: StoredIntakeMeasurement[],
  catalogItemId?: string | null,
) {
  if (catalogItemId) {
    const matches = measurements.filter((row) => row.catalogItemId === catalogItemId);
    if (matches.length > 0) return matches[matches.length - 1] ?? null;
  }
  return measurements[measurements.length - 1] ?? null;
}
