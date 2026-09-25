"use server";

import { revalidatePath } from "next/cache";
import { bsosErrorMessage, createBusinessActionItem, createBusinessGoal, updateBusinessActionStatus, updateBusinessGoalStatus } from "@/lib/bsos-ops";
import { createActionFromRecommendation, recommendationEvidenceKey, upsertRecommendationState } from "@/lib/bsos-actions";
import { buildBsosRecommendations } from "@/lib/bsos";
import { loadBsosFacts } from "@/lib/bsos-data";
import { prisma } from "@/lib/prisma";
import { requireOperatingBusinessAccess } from "@/lib/saas-billing/enforce";

export type BsosActionState = { error?: string; message?: string };

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function createGoalAction(
  _prev: BsosActionState,
  formData: FormData,
): Promise<BsosActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await createBusinessGoal(prisma, access, {
      title: readString(formData, "title"),
      description: readString(formData, "description"),
      recommendationKey: readString(formData, "recommendationKey") || undefined,
    });
    revalidatePath("/business-health");
    return { message: "Goal saved from owner input. It is not a recorded financial fact." };
  } catch (error) {
    return { error: bsosErrorMessage(error, "That goal could not be saved.") };
  }
}

export async function updateGoalStatusAction(
  _prev: BsosActionState,
  formData: FormData,
): Promise<BsosActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await updateBusinessGoalStatus(prisma, access, {
      goalId: readString(formData, "goalId"),
      status: readString(formData, "status"),
    });
    revalidatePath("/business-health");
    return { message: "Goal status updated." };
  } catch (error) {
    return { error: bsosErrorMessage(error, "That goal could not be updated.") };
  }
}

export async function createActionItemAction(
  _prev: BsosActionState,
  formData: FormData,
): Promise<BsosActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await createBusinessActionItem(prisma, access, {
      title: readString(formData, "title"),
      recommendationKey: readString(formData, "recommendationKey"),
      notes: readString(formData, "notes"),
      goalId: readString(formData, "goalId") || undefined,
    });
    revalidatePath("/business-health");
    return { message: "Action item added to the owner plan." };
  } catch (error) {
    return { error: bsosErrorMessage(error, "That action item could not be saved.") };
  }
}

export async function updateActionStatusAction(
  _prev: BsosActionState,
  formData: FormData,
): Promise<BsosActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await updateBusinessActionStatus(prisma, access, {
      actionId: readString(formData, "actionId"),
      status: readString(formData, "status"),
    });
    revalidatePath("/business-health");
    return { message: "Action item updated." };
  } catch (error) {
    return { error: bsosErrorMessage(error, "That action item could not be updated.") };
  }
}

export async function createRecommendationActionAction(
  _prev: BsosActionState,
  formData: FormData,
): Promise<BsosActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    const key = readString(formData, "recommendationKey");
    const facts = await loadBsosFacts(prisma, access.businessId);
    const recommendation = buildBsosRecommendations(facts).find((item) => item.key === key);
    if (!recommendation) {
      return { error: "That recommendation is not active from recorded facts." };
    }
    await createActionFromRecommendation(prisma, access, recommendation);
    revalidatePath("/business-health");
    return { message: "Action added to the owner plan. TBBT did not execute the work." };
  } catch (error) {
    return { error: bsosErrorMessage(error, "That recommendation could not become an action.") };
  }
}

export async function dismissRecommendationAction(
  _prev: BsosActionState,
  formData: FormData,
): Promise<BsosActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    const key = readString(formData, "recommendationKey");
    if (!key) return { error: "Choose a recommendation." };
    const facts = await loadBsosFacts(prisma, access.businessId);
    const recommendation = buildBsosRecommendations(facts).find((item) => item.key === key);
    await upsertRecommendationState(prisma, access, {
      recommendationKey: key,
      status: "DISMISSED",
      evidenceKey: recommendation ? recommendationEvidenceKey(recommendation) : undefined,
    });
    revalidatePath("/business-health");
    return { message: "Recommendation dismissed. It will stay in history until facts change." };
  } catch (error) {
    return { error: bsosErrorMessage(error, "That recommendation could not be dismissed.") };
  }
}

export async function completeRecommendationAction(
  _prev: BsosActionState,
  formData: FormData,
): Promise<BsosActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    const key = readString(formData, "recommendationKey");
    if (!key) return { error: "Choose a recommendation." };
    const facts = await loadBsosFacts(prisma, access.businessId);
    const recommendation = buildBsosRecommendations(facts).find((item) => item.key === key);
    await upsertRecommendationState(prisma, access, {
      recommendationKey: key,
      status: "COMPLETED",
      evidenceKey: recommendation ? recommendationEvidenceKey(recommendation) : undefined,
    });
    revalidatePath("/business-health");
    return { message: "Recommendation marked complete for this business." };
  } catch (error) {
    return { error: bsosErrorMessage(error, "That recommendation could not be completed.") };
  }
}
