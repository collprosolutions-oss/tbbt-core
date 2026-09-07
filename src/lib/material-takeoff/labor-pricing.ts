/**
 * Owner-only labor pricing helpers attached to takeoff types.
 *
 * Concrete slab is the first registered helper (per 60-lb bag). Other
 * trades can register later without changing MATERIAL conversion or
 * snapshot storage. Recommendations never auto-apply to the labor line.
 */
import { roundMoney } from "@/lib/estimate-calculators/types";
import {
  extendedCustomerPrice,
  workingQuantity,
  type TakeoffSnapshot,
  type TakeoffTypeId,
} from "@/lib/material-takeoff/types";
import { parsePositiveNumber } from "@/lib/material-takeoff/units";

/** Configurable starting guidance for 60-lb sacked-concrete labor. */
export const DEFAULT_CONCRETE_60LB_BAG_LABOR_RATE = 36;

export const CONCRETE_60LB_BAG_LABOR_HELPER_ID = "concrete-60lb-bag-labor" as const;

export type TakeoffLaborRecommendation = {
  available: boolean;
  unavailableReason: string | null;
  helperId: string | null;
  rate: number;
  rateLabel: string;
  units: number;
  unitLabel: string;
  recommendedLabor: number;
  customerMaterialTotal: number;
  recommendedSubtotal: number;
};

type LaborHelper = (snapshot: TakeoffSnapshot) => TakeoffLaborRecommendation;

const LABOR_HELPERS: Partial<Record<TakeoffTypeId, LaborHelper>> = {
  "concrete-slab": recommendConcreteSlabLabor,
};

export function concreteLaborRate(snapshot: TakeoffSnapshot) {
  return parsePositiveNumber(snapshot.laborRate) ?? DEFAULT_CONCRETE_60LB_BAG_LABOR_RATE;
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

  if (bagSize !== 60) {
    return {
      ...unavailable(
        "This first labor helper is for 60-lb bags. Switch bag size to 60-lb or enter labor on the original request line.",
        materials,
      ),
      rate,
      rateLabel: "Labor rate per 60-lb bag",
    };
  }
  if (!(units > 0)) {
    return {
      ...unavailable(
        "Calculate bag quantity before applying a recommended labor price.",
        materials,
      ),
      rate,
      rateLabel: "Labor rate per 60-lb bag",
    };
  }

  const recommendedLabor = roundMoney(units * rate);
  return {
    available: recommendedLabor > 0,
    unavailableReason:
      recommendedLabor > 0
        ? null
        : "The labor helper did not produce a recommended labor price.",
    helperId: CONCRETE_60LB_BAG_LABOR_HELPER_ID,
    rate,
    rateLabel: "Labor rate per 60-lb bag",
    units,
    unitLabel: "60-lb bags",
    recommendedLabor,
    customerMaterialTotal: materials,
    recommendedSubtotal: roundMoney(recommendedLabor + materials),
  };
}

function unavailable(
  reason: string,
  customerMaterialTotal: number,
): TakeoffLaborRecommendation {
  return {
    available: false,
    unavailableReason: reason,
    helperId: null,
    rate: 0,
    rateLabel: "",
    units: 0,
    unitLabel: "",
    recommendedLabor: 0,
    customerMaterialTotal,
    recommendedSubtotal: customerMaterialTotal,
  };
}
