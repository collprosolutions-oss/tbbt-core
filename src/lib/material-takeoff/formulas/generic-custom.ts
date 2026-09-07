/**
 * Generic custom estimating takeoff.
 *
 * Safety net when no specialized trade formula is registered. Owners
 * enter labor and add materials themselves. Do not invent trade math.
 */
import {
  TAKEOFF_TYPE_LABELS,
  type TakeoffSnapshot,
} from "@/lib/material-takeoff/types";
import {
  parseNonNegativeNumber,
  parsePositiveNumber,
} from "@/lib/material-takeoff/units";

export const GENERIC_CUSTOM_TAKEOFF_ID = "generic-custom" as const;

export type GenericCustomInputs = {
  laborQuantity: number;
  laborUnit: string;
};

export function emptyGenericCustomInputs(
  partial?: Record<string, unknown> | null,
): GenericCustomInputs {
  const unit =
    typeof partial?.laborUnit === "string" && partial.laborUnit.trim()
      ? partial.laborUnit.trim()
      : "job";
  return {
    laborQuantity:
      parsePositiveNumber(partial?.laborQuantity) ??
      parseNonNegativeNumber(partial?.laborQuantity) ??
      1,
    laborUnit: unit,
  };
}

export function computeGenericCustomTakeoff(input: {
  inputs?: Record<string, unknown> | null;
  wastePercent?: number;
  measurementSource?: TakeoffSnapshot["measurementSource"];
  skippedMeasurements?: string[];
}): { snapshot: TakeoffSnapshot; rejected: string | null } {
  const inputs = emptyGenericCustomInputs(input.inputs);
  const wastePercent = parseNonNegativeNumber(input.wastePercent) ?? 0;
  return {
    rejected: null,
    snapshot: {
      version: 1,
      takeoffType: GENERIC_CUSTOM_TAKEOFF_ID,
      inputs: { ...inputs },
      wastePercent,
      markupPercent: 0,
      laborRate: 0,
      laborAdjustment: 0,
      measurementSource: input.measurementSource ?? null,
      explanation:
        `${TAKEOFF_TYPE_LABELS[GENERIC_CUSTOM_TAKEOFF_ID]} has no specialized trade formula. ` +
        "Enter labor quantity and rate, add materials, then apply recommended pricing.",
      skippedMeasurements: input.skippedMeasurements ?? [],
      removedItemIds: [],
      items: [],
    },
  };
}
