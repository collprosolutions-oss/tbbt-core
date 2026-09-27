"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireBusinessAccess } from "@/lib/access";
import {
  SCENARIO_PLANNER_PATH,
  scenarioPlannerHref,
} from "@/lib/owner-scenario-planner";
import { ownerScenarioAssumptionSetErrorMessage, saveOwnerScenarioAssumptionSet } from "@/lib/owner-scenario-planner-ops";
import { prisma } from "@/lib/prisma";

export type OwnerScenarioAssumptionSetActionState = { error?: string; message?: string };

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

export async function saveOwnerScenarioAssumptionSetAction(
  _prev: OwnerScenarioAssumptionSetActionState,
  formData: FormData,
): Promise<OwnerScenarioAssumptionSetActionState> {
  try {
    const access = await requireBusinessAccess();
    const result = await saveOwnerScenarioAssumptionSet(prisma, access, {
      name: readString(formData, "name"),
      workload: readString(formData, "workload"),
      materials: readString(formData, "materials"),
      labor: readString(formData, "labor"),
      price: readString(formData, "price"),
      assumeUnpaid: readString(formData, "assumeUnpaid"),
    });
    revalidatePath(SCENARIO_PLANNER_PATH);
    redirect(scenarioPlannerHref({ set: result.set.id }));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "digest" in error &&
      typeof (error as { digest?: string }).digest === "string" &&
      (error as { digest: string }).digest.startsWith("NEXT_REDIRECT")
    ) {
      throw error;
    }
    return {
      error: ownerScenarioAssumptionSetErrorMessage(error, "That assumption set could not be saved."),
    };
  }
}
