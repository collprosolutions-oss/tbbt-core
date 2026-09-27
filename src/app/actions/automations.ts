"use server";

import { revalidatePath } from "next/cache";
import { requireOperatingBusinessAccess } from "@/lib/saas-billing/enforce";
import { toggleOwnedAutomationRuleEnabled } from "@/lib/automations";
import { prisma } from "@/lib/prisma";

export type AutomationsActionState = { error?: string; message?: string };

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function toggleAutomationRuleEnabledAction(
  _prev: AutomationsActionState,
  formData: FormData,
): Promise<AutomationsActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await toggleOwnedAutomationRuleEnabled(prisma, access, {
      ruleId: readString(formData, "ruleId"),
      enabled: readString(formData, "enabled") === "true",
    });
    revalidatePath("/automations");
    return {
      message: "Automation rule updated. Enabling or disabling does not run the rule now.",
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "That automation rule could not be updated.",
    };
  }
}
