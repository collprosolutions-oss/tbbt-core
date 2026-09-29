"use server";

import { revalidatePath } from "next/cache";
import { requireBusinessAccess } from "@/lib/access";
import { MONTHLY_GOALS_PATH } from "@/lib/monthly-goals";
import { monthlyBusinessGoalErrorMessage, saveMonthlyBusinessGoal } from "@/lib/monthly-goals-ops";
import { prisma } from "@/lib/prisma";

export type MonthlyBusinessGoalActionState = { error?: string; message?: string };

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

export async function saveMonthlyBusinessGoalAction(
  _prev: MonthlyBusinessGoalActionState,
  formData: FormData,
): Promise<MonthlyBusinessGoalActionState> {
  try {
    const access = await requireBusinessAccess();
    const result = await saveMonthlyBusinessGoal(prisma, access, {
      month: readString(formData, "month"),
      jobsCompleted: readString(formData, "jobsCompleted"),
      invoicesPaid: readString(formData, "invoicesPaid"),
      revenueReceived: readString(formData, "revenueReceived"),
    });
    revalidatePath(MONTHLY_GOALS_PATH);
    return { message: result.message };
  } catch (error) {
    return {
      error: monthlyBusinessGoalErrorMessage(error, "Those monthly targets could not be saved."),
    };
  }
}
