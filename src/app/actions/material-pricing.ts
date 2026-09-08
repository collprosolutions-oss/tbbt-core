"use server";

import { revalidatePath } from "next/cache";
import { requireBusinessAccess } from "@/lib/access";
import {
  applyCurrentSupplierPriceToDraft,
  confirmSupplierStorePrice,
  refreshSupplierPrices,
  saveSupplierPreference,
} from "@/lib/material-pricing/db";
import { parseTakeoffFormSnapshot } from "@/lib/material-takeoff";
import { estimateLineErrorMessage } from "@/lib/estimate-line-ops";
import { parsePositiveNumber } from "@/lib/material-takeoff/units";
import { prisma } from "@/lib/prisma";

export type MaterialPricingActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function revalidateEstimate(estimateId: string) {
  if (estimateId) revalidatePath(`/estimates/${estimateId}`);
  revalidatePath("/settings");
  revalidatePath("/estimates");
}

export async function saveBusinessSupplierPricingSettings(
  _prev: MaterialPricingActionState,
  formData: FormData,
): Promise<MaterialPricingActionState> {
  try {
    const access = await requireBusinessAccess();
    await saveSupplierPreference(prisma, access, {
      providerId: readString(formData, "providerId") || "home-depot",
      enabled: readString(formData, "enabled") !== "0",
      locationZip: readString(formData, "locationZip") || null,
      locationLabel: readString(formData, "locationLabel") || null,
      seedSuggestedMappings: true,
    });
    revalidatePath("/settings");
    revalidatePath("/estimates");
    return {
      message:
        "Preferred supplier and location saved. Concrete slab mappings were seeded. Existing draft, sent, and approved prices were not changed.",
    };
  } catch (error) {
    return {
      error: estimateLineErrorMessage(error, "Could not save supplier pricing settings."),
    };
  }
}

export async function refreshBusinessSupplierPrices(
  _prev: MaterialPricingActionState,
  formData: FormData,
): Promise<MaterialPricingActionState> {
  try {
    const access = await requireBusinessAccess();
    const result = await refreshSupplierPrices(prisma, access, {
      providerId: readString(formData, "providerId") || "home-depot",
    });
    const estimateId = readString(formData, "estimateId");
    revalidateEstimate(estimateId);
    const live = result.quotes.some((quote) => quote.sourceMode === "live-api");
    return {
      message: live
        ? `Refreshed ${result.quotes.length} supplier price${result.quotes.length === 1 ? "" : "s"}.`
        : `Refreshed ${result.quotes.length} catalog-reference price${result.quotes.length === 1 ? "" : "s"}. Live Home Depot pricing is not connected. Draft prices were not changed.`,
    };
  } catch (error) {
    return {
      error: estimateLineErrorMessage(error, "Could not refresh supplier prices."),
    };
  }
}

export async function applyEstimateCurrentSupplierPrice(
  _prev: MaterialPricingActionState,
  formData: FormData,
): Promise<MaterialPricingActionState> {
  try {
    const estimateId = readString(formData, "estimateId");
    const itemId = readString(formData, "itemId");
    const snapshot = parseTakeoffFormSnapshot(readString(formData, "takeoffJson"));
    if (!snapshot || !itemId) {
      return { error: "Calculate the takeoff before using a supplier price." };
    }
    const access = await requireBusinessAccess();
    const cost = parsePositiveNumber(readString(formData, "supplierUnitCost"));
    const result = await applyCurrentSupplierPriceToDraft(prisma, access, {
      estimateId,
      lineItemId: readString(formData, "lineItemId") || null,
      itemId,
      snapshot,
      supplierUnitCost: cost,
    });
    revalidateEstimate(estimateId);
    return {
      message: `Used current supplier price $${result.appliedCost.toFixed(2)} as internal unit cost. Business defaults were not changed. Customer selling price uses existing markup when markup is set.`,
    };
  } catch (error) {
    return {
      error: estimateLineErrorMessage(error, "Could not apply that supplier price."),
    };
  }
}

export async function confirmEstimateSupplierStorePrice(
  _prev: MaterialPricingActionState,
  formData: FormData,
): Promise<MaterialPricingActionState> {
  try {
    const access = await requireBusinessAccess();
    const price = parsePositiveNumber(readString(formData, "storePrice"));
    if (price == null) {
      return { error: "Enter a store price greater than 0." };
    }
    await confirmSupplierStorePrice(prisma, access, {
      providerId: readString(formData, "providerId") || "home-depot",
      productId: readString(formData, "productId"),
      currentPrice: price,
      productName: readString(formData, "productName") || null,
    });
    revalidateEstimate(readString(formData, "estimateId"));
    return { message: "Owner-confirmed store price saved. Draft prices were not changed." };
  } catch (error) {
    return {
      error: estimateLineErrorMessage(error, "Could not save that store price."),
    };
  }
}
