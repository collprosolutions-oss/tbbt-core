/**
 * Stable calculator material identities. Pricing is keyed to these, never
 * to a specific estimate line, customer, or request.
 */
import {
  isNonSupplierMaterialIdentity,
  isStandardMaterialIdentity,
} from "@/lib/material-pricing/types";
import type { TakeoffItem } from "@/lib/material-takeoff/types";

export function calculatorMaterialIdentity(item: {
  id: string;
  kind: string;
}): string {
  if (item.kind === "custom" || item.id.startsWith("custom:")) {
    return item.id;
  }
  return item.kind || item.id;
}

export function materialSupportsSupplierProduct(item: {
  id: string;
  kind: string;
}): boolean {
  const identity = calculatorMaterialIdentity(item);
  if (isNonSupplierMaterialIdentity(identity) || isNonSupplierMaterialIdentity(item.kind)) {
    return false;
  }
  return true;
}

export function isFirstPassConcreteMappingTarget(item: TakeoffItem): boolean {
  return isStandardMaterialIdentity(calculatorMaterialIdentity(item));
}

export function mappingEligibleTakeoffItems(items: TakeoffItem[]) {
  return items.filter((item) => materialSupportsSupplierProduct(item));
}
