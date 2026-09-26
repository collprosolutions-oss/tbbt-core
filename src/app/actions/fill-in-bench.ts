"use server";

import { revalidatePath } from "next/cache";
import { saveFillInBenchWorker, type WorkforceActionState } from "@/app/actions/workforce";
import { requireOperatingProductAccessForForm } from "@/lib/saas-billing/enforce";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { setFillInBenchActiveOp, WorkforceError } from "@/lib/workforce-ops";
import { prisma } from "@/lib/prisma";

export type FillInBenchActionState = WorkforceActionState;

export { saveFillInBenchWorker };

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function revalidateFillInBench() {
  revalidatePath("/team");
  revalidatePath("/team/bench");
}

export async function setFillInBenchActive(
  _prev: FillInBenchActionState,
  formData: FormData,
): Promise<FillInBenchActionState> {
  const operating = await requireOperatingProductAccessForForm(PRODUCT_CAPABILITIES.TEAM_MANAGEMENT);
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MEMBERS);

  const id = readString(formData, "id");
  if (!id) return { error: "That bench worker could not be found." };

  try {
    await setFillInBenchActiveOp(prisma, access, {
      id,
      active: readString(formData, "active") === "1",
    });
  } catch (error) {
    if (error instanceof WorkforceError) return { error: error.message };
    throw error;
  }

  revalidateFillInBench();
  return {
    message:
      readString(formData, "active") === "1"
        ? "Bench worker reactivated. No job, login, or message was created."
        : "Bench worker deactivated. No job or roster assignment was changed.",
  };
}
