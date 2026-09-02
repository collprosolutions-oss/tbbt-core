"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { requireBusinessAccess } from "@/lib/access";
import { prisma } from "@/lib/prisma";
import {
  assertSettingsBusinessScope,
  settingsErrorMessage,
  updateBusinessProfileOp,
  updateLaborMinimumSettingsOp,
  updateSettingsPreferencesOp,
  updateWebsiteStoryOp,
} from "@/lib/settings-ops";
import type { SettingsPreferenceFlags } from "@/lib/settings";

export type SettingsActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function readConfirmed(formData: FormData) {
  return readString(formData, "confirmConsequential") === "1";
}

function revalidateSettings() {
  revalidatePath("/settings");
  revalidatePath("/estimates");
  revalidatePath("/services");
  revalidatePath("/dashboard");
}

export async function updateLaborMinimumSettings(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  try {
    const access = await requireBusinessAccess();
    assertSettingsBusinessScope(access, readString(formData, "businessId") || null);
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

    const result = await updateLaborMinimumSettingsOp(prisma, access, {
      enabled,
      amount,
      confirmed: readConfirmed(formData),
    });
    revalidateSettings();
    return result.unchanged
      ? { message: "No pricing-rule changes to save." }
      : { message: "Labor minimum updated for future estimates." };
  } catch (error) {
    return { error: settingsErrorMessage(error, "That pricing rule could not be saved.") };
  }
}

export async function updateBusinessProfileSettings(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  try {
    const access = await requireBusinessAccess();
    assertSettingsBusinessScope(access, readString(formData, "businessId") || null);
    const result = await updateBusinessProfileOp(prisma, access, {
      name: readString(formData, "name"),
      confirmed: readConfirmed(formData),
    });
    revalidateSettings();
    return result.unchanged
      ? { message: "No business-name changes to save." }
      : { message: "Business name updated." };
  } catch (error) {
    return { error: settingsErrorMessage(error, "That business profile could not be saved.") };
  }
}

const PREFERENCE_KEYS = [
  "estimateCommunicationEnabled",
  "scheduleNotificationEnabled",
  "invoiceCommunicationEnabled",
  "reviewRequestPreferenceEnabled",
  "marketingCommunicationEnabled",
  "notifyEstimateEvents",
  "notifyScheduleEvents",
  "notifyInvoiceEvents",
  "notifyPayrollEvents",
  "notifyTeamEvents",
] as const satisfies ReadonlyArray<keyof SettingsPreferenceFlags>;

export async function updateSettingsPreferences(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  try {
    const access = await requireBusinessAccess();
    assertSettingsBusinessScope(access, readString(formData, "businessId") || null);
    const flags: Partial<SettingsPreferenceFlags> = {};
    for (const key of PREFERENCE_KEYS) {
      if (formData.has(`pref_${key}`)) {
        flags[key] = readString(formData, key) === "on";
      }
    }
    const result = await updateSettingsPreferencesOp(prisma, access, flags);
    revalidateSettings();
    return result.unchanged
      ? { message: "No preference changes to save." }
      : { message: "Preferences saved. Delivery is not automated." };
  } catch (error) {
    return { error: settingsErrorMessage(error, "Those preferences could not be saved.") };
  }
}

export async function updateWebsiteStorySettings(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  try {
    const access = await requireBusinessAccess();
    assertSettingsBusinessScope(access, readString(formData, "businessId") || null);
    const result = await updateWebsiteStoryOp(prisma, access, {
      rawOwnerStory: readString(formData, "rawOwnerStory"),
      approvedPublicAboutCopy: readString(formData, "approvedPublicAboutCopy"),
    });
    revalidateSettings();
    revalidatePath(`/hire/${access.workspace.business.slug}/about`);
    return result.unchanged
      ? { message: "No Website Story changes to save." }
      : { message: "Website Story saved. Only approved public About copy appears on the website." };
  } catch (error) {
    return { error: settingsErrorMessage(error, "That Website Story could not be saved.") };
  }
}
