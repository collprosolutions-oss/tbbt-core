"use server";

import { revalidatePath } from "next/cache";
import { requireOperatingBusinessAccess } from "@/lib/saas-billing/enforce";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { prisma } from "@/lib/prisma";
import { ensureDefaultAutomationRules, updateAutomationRule } from "@/lib/automation/rules";
import { processPendingAutomationRuns } from "@/lib/automation/processor";
import { scanScheduledBusinessEvents } from "@/lib/automation/scan";

export type AutomationActionState = { error?: string; message?: string };

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function updateAutomationRuleAction(
  _prev: AutomationActionState,
  formData: FormData,
): Promise<AutomationActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await ensureDefaultAutomationRules(prisma, access.businessId);
    await updateAutomationRule(prisma, access, {
      ruleId: readString(formData, "ruleId"),
      enabled: readString(formData, "enabled") === "true",
      channel: readString(formData, "channel") || undefined,
      delayMinutes: readString(formData, "delayMinutes")
        ? Number(readString(formData, "delayMinutes"))
        : undefined,
    });
    revalidatePath("/settings");
    revalidatePath("/business-health");
    return { message: "Automation rule saved. Messages still require a connected provider or a manual SENT mark." };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "That automation rule could not be saved." };
  }
}

export async function processDueAutomationsAction(
  _prev: AutomationActionState,
  formData: FormData,
): Promise<AutomationActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
    void formData;
    await scanScheduledBusinessEvents(prisma, access.businessId);
    const processed = await processPendingAutomationRuns(prisma, access.businessId);
    revalidatePath("/settings");
    revalidatePath("/business-health");
    return {
      message: `Processed ${processed.length} due automation run(s). Provider failures did not change core records.`,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Due automations could not be processed." };
  }
}
