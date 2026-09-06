/**
 * Intake → quote handoff. Owner-only display of existing request photos
 * and customer-reported measurements, plus safe prefill of calculator
 * fields that already exist. This is not material takeoff: it never
 * invents quantities, formulas, or a second measurement system.
 */
import {
  CUSTOMER_REPORTED_MEASUREMENT,
  INTAKE_MEASUREMENT_AXES,
  formatCustomerMeasurement,
  parseIntakeMeasurementUnit,
  type IntakeMeasurementAxis,
  type IntakeMeasurementUnit,
} from "@/lib/catalog-intake";
import { requestPhotoOwnerSrc } from "@/lib/business-storage/request-photos";
import { DECORATIVE_WALL_PANELING_TEMPLATE } from "@/lib/estimate-calculators/decorative-wall-paneling-template";
import type { CalculatorDefinition } from "@/lib/estimate-calculators/types";
import {
  normalizeVariableScopeComponents,
  type VariableScopeComponent,
} from "@/lib/estimate-calculators/variable-scope";

export const CUSTOMER_REPORTED_MEASUREMENT_LABEL = "Customer-reported / unverified";

const LINEAR_UNITS = new Set(["in", "inch", "inches", "ft", "foot", "feet"]);

export type StoredIntakeMeasurement = {
  catalogItemId: string | null;
  source: string;
  width: number | null;
  height: number | null;
  length: number | null;
  quantity: number | null;
  unit: string;
};

export type OwnerIntakePhoto = {
  id: string;
  src: string;
  mimeType: string;
  fileName: string;
  previewable: boolean;
};

export type OwnerIntakeMeasurementView = {
  label: string;
  sourceLabel: string;
  catalogName: string;
};

function decimalToNumber(value: { toString(): string } | number | null | undefined) {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value.toString());
  return Number.isFinite(n) ? n : null;
}

export function isBrowserPreviewableRequestPhoto(mimeType: string) {
  const type = mimeType.trim().toLowerCase();
  return type === "image/jpeg" || type === "image/png" || type === "image/webp";
}

export function isRequestHeicMimeType(mimeType: string) {
  const type = mimeType.trim().toLowerCase();
  return type === "image/heic" || type === "image/heif";
}

export function measurementSourceLabel(source: string) {
  if (source === CUSTOMER_REPORTED_MEASUREMENT) {
    return CUSTOMER_REPORTED_MEASUREMENT_LABEL;
  }
  if (source === "CONTRACTOR_VERIFIED") {
    return "Contractor verified";
  }
  return source;
}

export function toStoredIntakeMeasurement(row: {
  source: string;
  width?: { toString(): string } | number | null;
  height?: { toString(): string } | number | null;
  length?: { toString(): string } | number | null;
  quantity?: number | null;
  unit: string;
  serviceRequestItem?: { serviceCatalogItemId?: string | null } | null;
  catalogItemId?: string | null;
}): StoredIntakeMeasurement {
  return {
    catalogItemId:
      row.catalogItemId ?? row.serviceRequestItem?.serviceCatalogItemId ?? null,
    source: row.source,
    width: decimalToNumber(row.width),
    height: decimalToNumber(row.height),
    length: decimalToNumber(row.length),
    quantity: row.quantity ?? null,
    unit: row.unit,
  };
}

export function formatOwnerIntakeMeasurement(
  row: StoredIntakeMeasurement,
  catalogName?: string | null,
): OwnerIntakeMeasurementView {
  const dims = formatCustomerMeasurement({
    width: row.width,
    height: row.height,
    length: row.length,
    quantity: row.quantity,
    unit: row.unit,
  });
  const name = catalogName?.trim() || "Selected work";
  return {
    catalogName: name,
    sourceLabel: measurementSourceLabel(row.source),
    label: `${name}: ${dims || "on file"} (${measurementSourceLabel(row.source)})`,
  };
}

/**
 * Photos shown on an estimate must belong to the same business and the
 * linked service request. Foreign-business or unlinked rows are dropped.
 */
export function ownerVisibleRequestPhotos<
  T extends {
    id: string;
    businessId: string;
    serviceRequestId: string;
    url: string;
    storedAssetId?: string | null;
    storedAsset?: {
      mimeType?: string | null;
      originalFilename?: string | null;
      visibility?: string | null;
      category?: string | null;
      status?: string | null;
      publicPath?: string | null;
    } | null;
  },
>(input: {
  businessId: string;
  serviceRequestId: string | null | undefined;
  photos: T[];
}): OwnerIntakePhoto[] {
  const requestId = input.serviceRequestId?.trim() ?? "";
  const businessId = input.businessId.trim();
  if (!requestId || !businessId) return [];

  return input.photos.flatMap((photo) => {
    if (photo.businessId !== businessId || photo.serviceRequestId !== requestId) {
      return [];
    }
    const asset = photo.storedAsset;
    if (asset) {
      if (asset.visibility && asset.visibility !== "PRIVATE") return [];
      if (asset.category && asset.category !== "CUSTOMER_PHOTO") return [];
      if (asset.status && asset.status !== "READY") return [];
      if (asset.publicPath) return [];
    }
    const mimeType = (asset?.mimeType ?? "").trim() || "image/jpeg";
    const fileName = (asset?.originalFilename ?? "").trim() || "Project photo";
    return [
      {
        id: photo.id,
        src: requestPhotoOwnerSrc(photo),
        mimeType,
        fileName,
        previewable: asset
          ? isBrowserPreviewableRequestPhoto(mimeType)
          : true,
      },
    ];
  });
}

export function ownerVisibleRequestMeasurements(
  input: {
    businessId: string;
    serviceRequestId: string | null | undefined;
    measurements: Array<{
      businessId: string;
      serviceRequestId: string;
      source: string;
      width?: { toString(): string } | number | null;
      height?: { toString(): string } | number | null;
      length?: { toString(): string } | number | null;
      quantity?: number | null;
      unit: string;
      serviceRequestItem?: {
        serviceCatalogItemId?: string | null;
        serviceCatalogItem?: { name?: string | null } | null;
        customDescription?: string | null;
      } | null;
    }>;
  },
): OwnerIntakeMeasurementView[] {
  const requestId = input.serviceRequestId?.trim() ?? "";
  const businessId = input.businessId.trim();
  if (!requestId || !businessId) return [];

  return input.measurements.flatMap((row) => {
    if (row.businessId !== businessId || row.serviceRequestId !== requestId) {
      return [];
    }
    const stored = toStoredIntakeMeasurement(row);
    const catalogName =
      row.serviceRequestItem?.serviceCatalogItem?.name ??
      row.serviceRequestItem?.customDescription ??
      null;
    return [formatOwnerIntakeMeasurement(stored, catalogName)];
  });
}

function parseLinearUnit(units?: string | null): IntakeMeasurementUnit | null {
  const raw = (units ?? "").trim().toLowerCase();
  if (!raw || !LINEAR_UNITS.has(raw)) return null;
  if (raw === "ft" || raw === "foot" || raw === "feet") return "FT";
  return "IN";
}

function axisFromComponent(component: VariableScopeComponent): IntakeMeasurementAxis | null {
  if (component.inputType !== "measurement") return null;
  const haystack = `${component.quantityKey ?? ""} ${component.key} ${component.name}`.toLowerCase();
  if (/\bwidth\b/.test(haystack) || haystack.includes("wallwidth")) return "width";
  if (/\bheight\b/.test(haystack) || haystack.includes("wallheight")) return "height";
  if (/\blength\b/.test(haystack) || /\bdepth\b/.test(haystack)) return "length";
  return null;
}

export function linearCalculatorMeasurementFields(input: {
  calculatorId?: string | null;
  components?: unknown[] | null;
  definition?: Pick<CalculatorDefinition, "calculatorId" | "components"> | null;
}) {
  const calculatorId =
    input.calculatorId ?? input.definition?.calculatorId ?? null;
  const rawComponents =
    input.components ??
    input.definition?.components ??
    (calculatorId === DECORATIVE_WALL_PANELING_TEMPLATE.calculatorId
      ? DECORATIVE_WALL_PANELING_TEMPLATE.components
      : null);
  const components = normalizeVariableScopeComponents(rawComponents);
  return components.flatMap((component) => {
    const axis = axisFromComponent(component);
    const unit = parseLinearUnit(component.units);
    if (!axis || !unit) return [];
    return [
      {
        axis,
        inputKey: component.quantityKey ?? component.key,
        unit,
      },
    ];
  });
}

export function convertLinearMeasurement(
  value: number,
  from: IntakeMeasurementUnit,
  to: IntakeMeasurementUnit,
) {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (from === to) return Math.round(value * 100) / 100;
  if (from === "IN" && to === "FT") return Math.round((value / 12) * 100) / 100;
  return Math.round(value * 12 * 100) / 100;
}

export function customerReportedMeasurementForCatalog(
  measurements: StoredIntakeMeasurement[],
  catalogItemId?: string | null,
) {
  if (!catalogItemId) return null;
  const matches = measurements.filter(
    (row) =>
      row.catalogItemId === catalogItemId &&
      row.source === CUSTOMER_REPORTED_MEASUREMENT,
  );
  return matches[matches.length - 1] ?? null;
}

/**
 * Map stored customer-reported axes onto existing calculator measurement
 * fields. Skips unknown axes, non-linear units, and keys that already
 * have an intentional value.
 */
export function calculatorPrefillFromStoredMeasurement(input: {
  measurement: StoredIntakeMeasurement | null;
  calculatorId?: string | null;
  components?: unknown[] | null;
  definition?: Pick<CalculatorDefinition, "calculatorId" | "components"> | null;
  existingInputs?: Record<string, unknown> | null;
}): { applied: Record<string, number>; skipped: string[] } {
  const applied: Record<string, number> = {};
  const skipped: string[] = [];
  const measurement = input.measurement;
  if (!measurement) return { applied, skipped };

  const fields = linearCalculatorMeasurementFields(input);
  if (fields.length === 0) {
    skipped.push("no-matching-calculator-fields");
    return { applied, skipped };
  }

  const storedUnit = parseIntakeMeasurementUnit(measurement.unit);
  for (const axis of INTAKE_MEASUREMENT_AXES) {
    const value = measurement[axis];
    const field = fields.find((item) => item.axis === axis);
    if (value == null) continue;
    if (!field) {
      skipped.push(axis);
      continue;
    }
    const converted = convertLinearMeasurement(value, storedUnit, field.unit);
    if (converted == null) {
      skipped.push(axis);
      continue;
    }
    const existing = input.existingInputs?.[field.inputKey];
    const existingNumber =
      typeof existing === "number"
        ? existing
        : typeof existing === "string"
          ? Number(existing)
          : NaN;
    if (Number.isFinite(existingNumber) && existingNumber > 0) {
      skipped.push(`${axis}:existing`);
      continue;
    }
    applied[field.inputKey] = converted;
  }
  return { applied, skipped };
}

export function mergeWorkAreaAndMeasurementPrefill(input: {
  workAreaInputs?: Record<string, unknown> | null;
  measurementInputs?: Record<string, number> | null;
}) {
  return {
    ...(input.measurementInputs ?? {}),
    ...(input.workAreaInputs ?? {}),
  };
}
