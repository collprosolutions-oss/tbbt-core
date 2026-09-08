"use server";

import { revalidatePath } from "next/cache";
import { requireBusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  ProjectPaymentError,
  recordOwnerManualDeposit,
} from "@/lib/project-payments";
import { prisma } from "@/lib/prisma";

export type DepositActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function recordEstimateDeposit(
  _prev: DepositActionState,
  formData: FormData,
): Promise<DepositActionState> {
  try {
    const access = await requireBusinessAccess();
    requireBusinessCapability(access, CAPABILITIES.MANAGE_INVOICES);
    const estimateId = readString(formData, "estimateId");
    if (!estimateId) {
      return { error: "That deposit could not be recorded." };
    }
    await recordOwnerManualDeposit(prisma, access, {
      estimateId,
      amount: readString(formData, "amount"),
      method: readString(formData, "paymentMethod"),
      receivedAt: readString(formData, "receivedAt"),
      note: readString(formData, "note"),
    });
    revalidatePath(`/estimates/${estimateId}`);
    revalidatePath("/invoices");
    revalidatePath("/jobs");
    revalidatePath("/estimates");
    return { message: "Material deposit recorded." };
  } catch (error) {
    if (error instanceof ProjectPaymentError) {
      return { error: error.message };
    }
    return { error: "That deposit could not be recorded." };
  }
}
