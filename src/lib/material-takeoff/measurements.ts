/**
 * Map existing intake / calculator measurements onto takeoff inputs.
 *
 * Customer-reported values stay labeled unverified and are skipped when
 * the unit or axis is incompatible with the selected formula.
 */
import {
  CUSTOMER_REPORTED_MEASUREMENT,
  CUSTOMER_REPORTED_MEASUREMENT_LABEL,
  type StoredIntakeMeasurement,
  convertLinearMeasurement,
  measurementSourceLabel,
} from "@/lib/intake-quote-handoff";
import { parseIntakeMeasurementUnit } from "@/lib/catalog-intake";
import type { CalculatorSnapshot } from "@/lib/estimate-calculators/types";
import { parseLinearUnitToken, parsePositiveNumber } from "@/lib/material-takeoff/units";
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
        ...(wallWidthFt != null ? { wallWidthFt } : {}),
        ...(wallHeightFt != null ? { wallHeightFt } : {}),
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
        ...(wallLengthFt != null ? { wallLengthFt } : {}),
        ...(wallHeightFt != null ? { wallHeightFt } : {}),
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
      ...(lengthFt != null ? { lengthFt } : {}),
      ...(widthFt != null ? { widthFt } : {}),
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
  const width = axisFeet(measurement.width, storedUnit, "width", skipped);
  const height = axisFeet(measurement.height, storedUnit, "height", skipped);
  const length = axisFeet(measurement.length, storedUnit, "length", skipped);

  if (takeoffType === "concrete-slab") {
    if (height != null) skipped.push("intake:height-not-used-as-slab-thickness");
    if (length == null) skipped.push("intake:length");
    if (width == null) skipped.push("intake:width");
    return {
      source: intakeSource(measurement),
      inputs: {
        ...(length != null ? { lengthFt: length } : {}),
        ...(width != null ? { widthFt: width } : {}),
      },
    };
  }

  if (takeoffType === "sheet-covering") {
    return {
      source: intakeSource(measurement),
      inputs: {
        ...(width != null ? { wallWidthFt: width } : length != null ? { wallWidthFt: length } : {}),
        ...(height != null ? { wallHeightFt: height } : {}),
      },
    };
  }

  return {
    source: intakeSource(measurement),
    inputs: {
      ...(length != null
        ? { wallLengthFt: length }
        : width != null
          ? { wallLengthFt: width }
          : {}),
      ...(height != null ? { wallHeightFt: height } : {}),
    },
  };
}

function axisFeet(
  value: number | null | undefined,
  unit: ReturnType<typeof parseIntakeMeasurementUnit>,
  axis: string,
  skipped: string[],
) {
  if (value == null) return null;
  const converted = convertLinearMeasurement(value, unit, "FT");
  if (converted == null) {
    skipped.push(`intake:${axis}`);
    return null;
  }
  return converted;
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
