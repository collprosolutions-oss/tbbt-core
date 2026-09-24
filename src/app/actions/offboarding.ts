"use server";

import { revalidatePath } from "next/cache";
import { requireBusinessAccess } from "@/lib/access";
import { ForbiddenError } from "@/lib/authorization";
import {
  OffboardingError,
  requestBusinessOffboardingOp,
} from "@/lib/offboarding";
import { prisma } from "@/lib/prisma";

export type OffboardingActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function requestOffboardingAction(
  _prev: OffboardingActionState,
  formData: FormData,
): Promise<OffboardingActionState> {
  try {
    const access = await requireBusinessAccess();
    const result = await requestBusinessOffboardingOp(prisma, access, {
      confirmation: readString(formData, "confirmation"),
      acknowledgedExport: formData.get("acknowledgedExport") === "1",
    });
    revalidatePath("/settings");
    return {
      message: result.recordsDeleted
        ? "Unexpected delete."
        : "Cancellation is recorded. Historical customers, jobs, invoices, payments, and time cards stay on file. Software access ends at the current period if a paid subscription is scheduled to cancel.",
    };
  } catch (error) {
    if (error instanceof OffboardingError || error instanceof ForbiddenError) {
      return { error: error.message };
    }
    throw error;
  }
}
