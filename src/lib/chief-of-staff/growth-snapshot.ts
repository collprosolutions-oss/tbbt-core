/**
 * Turn-scoped Growth snapshot for Chief of Staff.
 *
 * This is not a general cache. Catalog/BSOS already loads GrowthSource
 * once per turn for Business Health counts. The Growth specialist reuses
 * that same snapshot instead of loading again.
 */
import type { GrowthSource } from "@/lib/growth-engine";
import type { ProductCapabilityCode } from "@/lib/product-catalog/codes";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog/codes";

export type GrowthTurnSnapshot = {
  entitled: boolean;
  missingCapabilities: ProductCapabilityCode[];
  source: GrowthSource | null;
  failed: boolean;
  failureMessage?: string;
};

export const EMPTY_GROWTH_SNAPSHOT: GrowthTurnSnapshot = {
  entitled: false,
  missingCapabilities: [
    PRODUCT_CAPABILITIES.MARKETING_TOOLS,
    PRODUCT_CAPABILITIES.REPORTING_INSIGHTS,
  ],
  source: null,
  failed: false,
};

let injectedLoadFailure = false;
let specialistInterpretationCount = 0;

export function setInjectedGrowthLoadFailure(value: boolean) {
  injectedLoadFailure = value;
}

export function shouldInjectGrowthLoadFailure() {
  return injectedLoadFailure;
}

export function recordGrowthSpecialistInterpretation() {
  specialistInterpretationCount += 1;
}

export function getGrowthSpecialistInterpretationCount() {
  return specialistInterpretationCount;
}

export function resetGrowthSpecialistCounters() {
  specialistInterpretationCount = 0;
  injectedLoadFailure = false;
}
