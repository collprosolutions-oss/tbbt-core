"use server";

import { revalidatePath } from "next/cache";
import { requireOperatingBusinessAccessForForm } from "@/lib/saas-billing/enforce";
import { CAPABILITIES, requireBusinessCapability, requireBusinessRole } from "@/lib/authorization";
import {
  activateBusinessTradeOp,
  deactivateBusinessTradeOp,
} from "@/lib/business-trades";
import { prisma } from "@/lib/prisma";
import { isConfiguredTrade } from "@/lib/trades";

export type BusinessTradeActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function activateBusinessTradeAction(
  _prev: BusinessTradeActionState,
  formData: FormData,
): Promise<BusinessTradeActionState> {
  const operating = await requireOperatingBusinessAccessForForm();
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  requireBusinessRole(access, "OWNER");
  const tradeCode = readString(formData, "tradeCode");
  if (!isConfiguredTrade(tradeCode)) {
    return { error: "That trade is not configured." };
  }
  try {
    await activateBusinessTradeOp(prisma, access, tradeCode);
    revalidatePath("/settings");
    revalidatePath("/services");
    return { message: "Trade activated for this business." };
  } catch (error) {
    return {
      error:
        error instanceof Error && error.message
          ? error.message
          : "Could not activate that trade.",
    };
  }
}

export async function deactivateBusinessTradeAction(
  _prev: BusinessTradeActionState,
  formData: FormData,
): Promise<BusinessTradeActionState> {
  const operating = await requireOperatingBusinessAccessForForm();
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  requireBusinessRole(access, "OWNER");
  const tradeCode = readString(formData, "tradeCode");
  if (!isConfiguredTrade(tradeCode)) {
    return { error: "That trade is not configured." };
  }
  try {
    await deactivateBusinessTradeOp(prisma, access, tradeCode);
    revalidatePath("/settings");
    revalidatePath("/services");
    return { message: "Trade deactivated for this business." };
  } catch (error) {
    return {
      error:
        error instanceof Error && error.message
          ? error.message
          : "Could not deactivate that trade.",
    };
  }
}
