/**
 * Supplier price freshness. Do not invent false precision: if a source
 * has not been refreshed recently, say so.
 */
import {
  SUPPLIER_PRICE_CURRENT_MS,
  SUPPLIER_PRICE_FRESHNESS_LABELS,
  SUPPLIER_PRICE_RECENT_MS,
  type SupplierPriceFreshness,
} from "@/lib/material-pricing/types";

export function classifySupplierPriceFreshness(
  fetchedAt: Date | string | null | undefined,
  now: Date = new Date(),
): SupplierPriceFreshness {
  if (!fetchedAt) return "unavailable";
  const at = fetchedAt instanceof Date ? fetchedAt : new Date(fetchedAt);
  if (Number.isNaN(at.getTime())) return "unavailable";
  const age = now.getTime() - at.getTime();
  if (age < 0) return "current";
  if (age <= SUPPLIER_PRICE_CURRENT_MS) return "current";
  if (age <= SUPPLIER_PRICE_RECENT_MS) return "recently_checked";
  return "stale";
}

export function supplierPriceFreshnessLabel(status: SupplierPriceFreshness) {
  return SUPPLIER_PRICE_FRESHNESS_LABELS[status];
}

export function describeSupplierPriceCheck(
  fetchedAt: Date | string | null | undefined,
  now: Date = new Date(),
) {
  const status = classifySupplierPriceFreshness(fetchedAt, now);
  if (!fetchedAt || status === "unavailable") {
    return "Not checked";
  }
  const at = fetchedAt instanceof Date ? fetchedAt : new Date(fetchedAt);
  if (Number.isNaN(at.getTime())) return "Not checked";
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (at >= startOfToday) return "Checked today";
  const yesterday = new Date(startOfToday);
  yesterday.setDate(yesterday.getDate() - 1);
  if (at >= yesterday) return "Checked yesterday";
  return `Checked ${at.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}`;
}
