/**
 * Owner-only labor pricing helpers attached to takeoff types.
 *
 * Concrete slab is the first complete labor calculator (per 60-lb bag).
 * Generic custom work uses quantity × rate. Other trades can register
 * later without changing MATERIAL conversion or snapshot storage.
 * Recommendations never auto-apply to the labor line.
 */
import { roundMoney } from "@/lib/estimate-calculators/types";
import {
  extendedCustomerPrice,
  workingQuantity,
  type TakeoffSnapshot,
  type TakeoffTypeId,
} from "@/lib/material-takeoff/types";
import { parseNonNegativeNumber, parsePositiveNumber } from "@/lib/material-takeoff/units";

/** Configurable starting guidance for 60-lb sacked-concrete labor. */
export const DEFAULT_CONCRETE_60LB_BAG_LABOR_RATE = 36;

export const CONCRETE_60LB_BAG_LABOR_HELPER_ID = "concrete-60lb-bag-labor" as const;
export const GENERIC_CUSTOM_LABOR_HELPER_ID = "generic-custom-labor" as const;

/**
 * Normal complete-slab production covered by the $36 / 60-lb bag rate.
 * These tasks are the BASIS of the rate, not extras stacked on top.
 */
export const CONCRETE_PRODUCTION_LABOR_COVERS = [
  "site layout / normal preparation",
  "forms setup/removal",
  "reinforcement / mesh placement",
  "anchor installation when selected",
  "concrete mixing / placement",
  "screeding / leveling",
  "finishing",
  "cleanup",
] as const;

export type TakeoffLaborRecommendation = {
  available: boolean;
  unavailableReason: string | null;
  helperId: string | null;
  rate: number;
  rateLabel: string;
  units: number;
  unitLabel: string;
  productionQuantityLabel: string;
  coveredByProductionRate: readonly string[];
  baseLabor: number;
  laborAdjustment: number;
  recommendedLabor: number;
  customerMaterialTotal: number;
  recommendedSubtotal: number;
};

type LaborHelper = (snapshot: TakeoffSnapshot) => TakeoffLaborRecommendation;

const LABOR_HELPERS: Partial<Record<TakeoffTypeId, LaborHelper>> = {
  "concrete-slab": recommendConcreteSlabLabor,
  "generic-custom": recommendGenericCustomLabor,
};

export function concreteLaborRate(snapshot: TakeoffSnapshot) {
  return parsePositiveNumber(snapshot.laborRate) ?? DEFAULT_CONCRETE_60LB_BAG_LABOR_RATE;
}

export function snapshotLaborAdjustment(snapshot: TakeoffSnapshot) {
  return parseNonNegativeNumber(snapshot.laborAdjustment) ?? 0;
}

export function takeoffSelectedCustomerSellingTotal(snapshot: TakeoffSnapshot) {
  return roundMoney(
    snapshot.items.reduce(
      (sum, item) => sum + (item.selected ? extendedCustomerPrice(item) : 0),
      0,
    ),
  );
}

export function recommendTakeoffLabor(
  snapshot: TakeoffSnapshot,
): TakeoffLaborRecommendation {
  const helper = LABOR_HELPERS[snapshot.takeoffType];
  if (!helper) {
    return unavailable(
      "Labor pricing helper is not available for this takeoff type yet. Enter labor on the original request line.",
      takeoffSelectedCustomerSellingTotal(snapshot),
    );
  }
  return helper(snapshot);
}

function recommendConcreteSlabLabor(
  snapshot: TakeoffSnapshot,
): TakeoffLaborRecommendation {
  const materials = takeoffSelectedCustomerSellingTotal(snapshot);
  const bagSize = parsePositiveNumber(snapshot.inputs.bagSizeLb) ?? 60;
  const bags = snapshot.items.find((item) => item.id === "concrete-bags");
  const units = bags ? workingQuantity(bags) : 0;
  const rate = concreteLaborRate(snapshot);
  const laborAdjustment = snapshotLaborAdjustment(snapshot);
  const coveredByProductionRate = CONCRETE_PRODUCTION_LABOR_COVERS;

  if (bagSize !== 60) {
    return {
      ...unavailable(
        "This first labor helper is for 60-lb bags. Switch bag size to 60-lb or enter labor on the original request line.",
        materials,
        { rate, laborAdjustment, coveredByProductionRate },
      ),
      rateLabel: "Labor production rate / 60-lb bag",
    };
  }
  if (!(units > 0)) {
    return {
      ...unavailable(
        "Calculate bag quantity before applying a recommended labor price.",
        materials,
        { rate, laborAdjustment, coveredByProductionRate },
      ),
      rateLabel: "Labor production rate / 60-lb bag",
    };
  }

  const baseLabor = roundMoney(units * rate);
  const recommendedLabor = roundMoney(baseLabor + laborAdjustment);
  return {
    available: recommendedLabor > 0,
    unavailableReason:
      recommendedLabor > 0
        ? null
        : "The labor helper did not produce a recommended labor price.",
    helperId: CONCRETE_60LB_BAG_LABOR_HELPER_ID,
    rate,
    rateLabel: "Labor production rate / 60-lb bag",
    units,
    unitLabel: "60-lb bags",
    productionQuantityLabel: `${formatCount(units)} × 60-lb bags`,
    coveredByProductionRate,
    baseLabor,
    laborAdjustment,
    recommendedLabor,
    customerMaterialTotal: materials,
    recommendedSubtotal: roundMoney(recommendedLabor + materials),
  };
}

function recommendGenericCustomLabor(
  snapshot: TakeoffSnapshot,
): TakeoffLaborRecommendation {
  const materials = takeoffSelectedCustomerSellingTotal(snapshot);
  const units = parsePositiveNumber(snapshot.inputs.laborQuantity) ?? 1;
  const unitLabel =
    typeof snapshot.inputs.laborUnit === "string" && snapshot.inputs.laborUnit.trim()
      ? snapshot.inputs.laborUnit.trim()
      : "job";
  const rate = parseNonNegativeNumber(snapshot.laborRate) ?? 0;
  const laborAdjustment = snapshotLaborAdjustment(snapshot);
  if (!(rate > 0)) {
    return unavailable(
      "Enter a labor rate to recommend a custom labor price.",
      materials,
      { units, unitLabel, laborAdjustment },
    );
  }
  const baseLabor = roundMoney(units * rate);
  const recommendedLabor = roundMoney(baseLabor + laborAdjustment);
  return {
    available: recommendedLabor > 0,
    unavailableReason:
      recommendedLabor > 0
        ? null
        : "Enter a labor quantity and rate to recommend a custom labor price.",
    helperId: GENERIC_CUSTOM_LABOR_HELPER_ID,
    rate,
    rateLabel: `Labor rate / ${unitLabel}`,
    units,
    unitLabel,
    productionQuantityLabel: `${formatCount(units)} × ${unitLabel}`,
    coveredByProductionRate: [],
    baseLabor,
    laborAdjustment,
    recommendedLabor,
    customerMaterialTotal: materials,
    recommendedSubtotal: roundMoney(recommendedLabor + materials),
  };
}

function unavailable(
  reason: string,
  customerMaterialTotal: number,
  extras?: {
    rate?: number;
    units?: number;
    unitLabel?: string;
    laborAdjustment?: number;
    coveredByProductionRate?: readonly string[];
  },
): TakeoffLaborRecommendation {
  const laborAdjustment = extras?.laborAdjustment ?? 0;
  return {
    available: false,
    unavailableReason: reason,
    helperId: null,
    rate: extras?.rate ?? 0,
    rateLabel: "",
    units: extras?.units ?? 0,
    unitLabel: extras?.unitLabel ?? "",
    productionQuantityLabel: "",
    coveredByProductionRate: extras?.coveredByProductionRate ?? [],
    baseLabor: 0,
    laborAdjustment,
    recommendedLabor: 0,
    customerMaterialTotal,
    recommendedSubtotal: roundMoney(customerMaterialTotal + laborAdjustment),
  };
}

function formatCount(value: number) {
  return Number.isInteger(value) ? String(value) : String(value);
}
