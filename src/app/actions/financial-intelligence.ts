"use server";

import { revalidatePath } from "next/cache";
import {
  financialIntelligenceErrorMessage,
  reviewRecurringExpensePattern,
  saveLaborBurdenSetting,
} from "@/lib/financial-intelligence-ops";
import { prisma } from "@/lib/prisma";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { requireOperatingProductAccess } from "@/lib/saas-billing/enforce";

export type FinancialIntelligenceActionState = { error?: string; message?: string };

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function saveLaborBurdenAction(
  _prev: FinancialIntelligenceActionState,
  formData: FormData,
): Promise<FinancialIntelligenceActionState> {
  try {
    const access = await requireOperatingProductAccess(PRODUCT_CAPABILITIES.REPORTING_INSIGHTS);
    await saveLaborBurdenSetting(prisma, access, {
      burdenRate: readString(formData, "burdenRate"),
      targetGrossMarginRate: readString(formData, "targetGrossMarginRate"),
      notes: readString(formData, "notes"),
    });
    revalidatePath("/settings/payroll");
    revalidatePath("/reports");
    revalidatePath("/business-health");
    return { message: "Labor burden and target margin saved. Historical wage snapshots are unchanged." };
  } catch (error) {
    return { error: financialIntelligenceErrorMessage(error, "That labor burden setting could not be saved.") };
  }
}

export async function reviewRecurringPatternAction(
  _prev: FinancialIntelligenceActionState,
  formData: FormData,
): Promise<FinancialIntelligenceActionState> {
  try {
    const access = await requireOperatingProductAccess(PRODUCT_CAPABILITIES.REPORTING_INSIGHTS);
    const status = readString(formData, "ownerStatus");
    if (status !== "CONFIRMED" && status !== "DISMISSED") {
      return { error: "Choose confirm or dismiss." };
    }
    await reviewRecurringExpensePattern(prisma, access, {
      patternKey: readString(formData, "patternKey"),
      ownerStatus: status,
    });
    revalidatePath("/reports");
    revalidatePath("/expenses");
    return {
      message:
        status === "CONFIRMED"
          ? "Pattern confirmed. No payable or liability was created."
          : "Pattern dismissed. No payable was created.",
    };
  } catch (error) {
    return { error: financialIntelligenceErrorMessage(error, "That recurring pattern could not be reviewed.") };
  }
}
