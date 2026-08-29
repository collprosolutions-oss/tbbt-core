"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { requireBusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { persistDraftEstimateTotal } from "@/lib/labor-minimum";
import { prisma } from "@/lib/prisma";

export type SettingsActionState = {
  error?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function updateLaborMinimumSettings(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  const enabled = readString(formData, "enabled") === "on";
  const rawAmount = readString(formData, "amount");

  let amount: Prisma.Decimal | null = null;
  if (rawAmount) {
    try {
      amount = new Prisma.Decimal(rawAmount);
    } catch {
      return { error: "Enter a valid minimum amount." };
    }
    if (amount.isNaN() || amount.lte(0)) {
      return { error: "Enter a valid minimum amount." };
    }
  }

  if (enabled && !amount) {
    return { error: "Enter a minimum amount to turn this on." };
  }

  await prisma.business.update({
    where: { id: access.businessId },
    data: {
      laborMinimumEnabled: enabled,
      laborMinimumAmount: amount,
    },
  });

  const drafts = await prisma.estimate.findMany({
    where: { ...access.scope, status: "DRAFT" },
    select: { id: true },
  });

  if (drafts.length > 0) {
    await prisma.$transaction(async (tx) => {
      for (const draft of drafts) {
        await persistDraftEstimateTotal(tx, draft.id, access.businessId);
      }
    });
  }

  revalidatePath("/settings");
  revalidatePath("/estimates");
  return {};
}
