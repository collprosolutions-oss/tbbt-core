"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOperatingBusinessAccess } from "@/lib/saas-billing/enforce";
import { BUSINESS_LAUNCH_PATH } from "@/lib/business-launch";
import {
  completeLaunchStep,
  deferLaunchStep,
  launchErrorMessage,
  resumeLaunchLater,
  skipLaunchStep,
} from "@/lib/business-launch-ops";
import { prisma } from "@/lib/prisma";

export type LaunchActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function readBool(formData: FormData, key: string) {
  return formData.get(key) === "on" || formData.get(key) === "1";
}

function readMinutes(formData: FormData, key: string, fallback: number) {
  const value = Number(readString(formData, key));
  return Number.isFinite(value) ? value : fallback;
}

function revalidateLaunch() {
  revalidatePath("/launch");
  revalidatePath("/dashboard");
  revalidatePath("/settings");
  revalidatePath("/business-health");
  revalidatePath("/knowledge");
  revalidatePath("/services");
}

export async function completeLaunchStepAction(
  _prev: LaunchActionState,
  formData: FormData,
): Promise<LaunchActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await completeLaunchStep(prisma, access, {
      stepKey: readString(formData, "stepKey"),
      name: readString(formData, "name"),
      phone: readString(formData, "phone"),
      email: readString(formData, "email"),
      website: readString(formData, "website"),
      serviceAreaLabel: readString(formData, "serviceAreaLabel"),
      serviceAreaCity: readString(formData, "serviceAreaCity"),
      serviceAreaRegion: readString(formData, "serviceAreaRegion"),
      serviceNames: formData
        .getAll("serviceNames")
        .flatMap((value) => (typeof value === "string" ? value.split("\n") : []))
        .map((value) => value.trim())
        .filter(Boolean),
      pricingApproach: readString(formData, "pricingApproach"),
      laborMinimumEnabled: readBool(formData, "laborMinimumEnabled"),
      laborMinimumAmount: readString(formData, "laborMinimumAmount"),
      confirmPricing: readBool(formData, "confirmPricing"),
      workStartMinutes: readMinutes(formData, "workStartMinutes", 480),
      workEndMinutes: readMinutes(formData, "workEndMinutes", 1020),
      workingWeekdays: formData
        .getAll("workingWeekdays")
        .map((value) => Number(String(value)))
        .filter((value) => Number.isInteger(value)),
      schedulingBufferMinutes: readMinutes(formData, "schedulingBufferMinutes", 30),
      schedulingNotes: readString(formData, "schedulingNotes"),
      teamNotes: readString(formData, "teamNotes"),
      paymentNotes: readString(formData, "paymentNotes"),
      estimateCommunicationEnabled:
        readString(formData, "stepKey") === "communication"
          ? readBool(formData, "estimateCommunicationEnabled")
          : undefined,
      scheduleNotificationEnabled:
        readString(formData, "stepKey") === "communication"
          ? readBool(formData, "scheduleNotificationEnabled")
          : undefined,
      invoiceCommunicationEnabled:
        readString(formData, "stepKey") === "communication"
          ? readBool(formData, "invoiceCommunicationEnabled")
          : undefined,
      brandVoice: readString(formData, "brandVoice"),
      identityNotes: readString(formData, "identityNotes"),
      about: readString(formData, "about"),
      goalTitle: readString(formData, "goalTitle"),
      goalDescription: readString(formData, "goalDescription"),
      businessStage: readString(formData, "businessStage"),
      confirmTrades: formData.getAll("confirmTrades").map((value) => String(value)),
    });
    revalidateLaunch();
    return { message: "Saved to your existing TBBT records. You still control what happens next." };
  } catch (error) {
    return { error: launchErrorMessage(error, "That launch step could not be saved.") };
  }
}

export async function skipLaunchStepAction(
  _prev: LaunchActionState,
  formData: FormData,
): Promise<LaunchActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await skipLaunchStep(prisma, access, readString(formData, "stepKey"));
    revalidateLaunch();
    return { message: "Step skipped. You can return to it later." };
  } catch (error) {
    return { error: launchErrorMessage(error, "That launch step could not be skipped.") };
  }
}

export async function deferLaunchStepAction(
  _prev: LaunchActionState,
  formData: FormData,
): Promise<LaunchActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await deferLaunchStep(prisma, access, readString(formData, "stepKey"));
    revalidateLaunch();
    return { message: "Step deferred. It stays on the checklist." };
  } catch (error) {
    return { error: launchErrorMessage(error, "That launch step could not be deferred.") };
  }
}

export async function resumeLaunchLaterAction() {
  const access = await requireOperatingBusinessAccess();
  await resumeLaunchLater(prisma, access);
  revalidateLaunch();
  redirect("/dashboard");
}

export async function startLaunchAction() {
  const { ensureLaunchProgress } = await import("@/lib/business-launch-ops");
  const access = await requireOperatingBusinessAccess();
  await ensureLaunchProgress(prisma, access);
  revalidateLaunch();
  redirect(BUSINESS_LAUNCH_PATH);
}
