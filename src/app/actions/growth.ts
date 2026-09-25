"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { explainGrowthPerformance, explainGrowthPerformanceWithAi, proposeCampaignAngle, proposeCampaignAngleWithAi } from "@/lib/ai/growth";
import { loadGrowthWorkspace } from "@/lib/growth-data";
import {
  approveReactivationCandidates,
  correctLeadAttribution,
  createGrowthActionRequest,
  growthErrorMessage,
  recordCampaignCost,
  setGrowthActionStatus,
} from "@/lib/growth-ops";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog/codes";
import { prisma } from "@/lib/prisma";
import { requireOperatingProductAccess } from "@/lib/saas-billing/enforce";

export type GrowthActionState = { error?: string; message?: string; text?: string };

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function readAll(formData: FormData, key: string) {
  return formData
    .getAll(key)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function correctLeadAttributionAction(
  _prev: GrowthActionState,
  formData: FormData,
): Promise<GrowthActionState> {
  try {
    const access = await requireOperatingProductAccess(PRODUCT_CAPABILITIES.MARKETING_TOOLS);
    requireBusinessCapability(access, CAPABILITIES.MANAGE_MARKETING);
    await correctLeadAttribution(prisma, access, {
      requestId: readString(formData, "requestId"),
      leadSource: readString(formData, "leadSource") || null,
      campaignId: readString(formData, "campaignId") || null,
      landingPagePath: readString(formData, "landingPagePath") || null,
      reason: readString(formData, "reason"),
    });
    revalidatePath("/growth");
    return { message: "Working attribution updated. Original acquisition source was preserved." };
  } catch (error) {
    return { error: growthErrorMessage(error, "That attribution could not be corrected.") };
  }
}

export async function recordCampaignCostAction(
  _prev: GrowthActionState,
  formData: FormData,
): Promise<GrowthActionState> {
  try {
    const access = await requireOperatingProductAccess(PRODUCT_CAPABILITIES.MARKETING_TOOLS);
    requireBusinessCapability(access, CAPABILITIES.MANAGE_MARKETING);
    await recordCampaignCost(prisma, access, {
      campaignId: readString(formData, "campaignId"),
      recordedCost: readString(formData, "recordedCost") || null,
    });
    revalidatePath("/growth");
    revalidatePath("/marketing");
    return { message: "Recorded campaign cost saved. ROI uses this figure only when present." };
  } catch (error) {
    return { error: growthErrorMessage(error, "That campaign cost could not be saved.") };
  }
}

export async function createGrowthActionAction(
  _prev: GrowthActionState,
  formData: FormData,
): Promise<GrowthActionState> {
  try {
    const access = await requireOperatingProductAccess(PRODUCT_CAPABILITIES.MARKETING_TOOLS);
    await createGrowthActionRequest(prisma, access, {
      kind: readString(formData, "kind"),
      queue: readString(formData, "queue"),
      customerId: readString(formData, "customerId") || null,
      serviceRequestId: readString(formData, "serviceRequestId") || null,
      estimateId: readString(formData, "estimateId") || null,
      jobId: readString(formData, "jobId") || null,
      campaignId: readString(formData, "campaignId") || null,
      notes: readString(formData, "notes"),
      approve: readString(formData, "approve") === "1",
    });
    revalidatePath("/growth");
    return { message: "Follow-up request saved. Growth did not message the customer." };
  } catch (error) {
    return { error: growthErrorMessage(error, "That growth action could not be saved.") };
  }
}

export async function setGrowthActionStatusAction(
  _prev: GrowthActionState,
  formData: FormData,
): Promise<GrowthActionState> {
  try {
    const access = await requireOperatingProductAccess(PRODUCT_CAPABILITIES.MARKETING_TOOLS);
    requireBusinessCapability(access, CAPABILITIES.MANAGE_MARKETING);
    await setGrowthActionStatus(prisma, access, {
      actionId: readString(formData, "actionId"),
      status: readString(formData, "status"),
    });
    revalidatePath("/growth");
    return { message: "Growth action updated." };
  } catch (error) {
    return { error: growthErrorMessage(error, "That growth action could not be updated.") };
  }
}

export async function approveReactivationAction(
  _prev: GrowthActionState,
  formData: FormData,
): Promise<GrowthActionState> {
  try {
    const access = await requireOperatingProductAccess(PRODUCT_CAPABILITIES.MARKETING_TOOLS);
    requireBusinessCapability(access, CAPABILITIES.MANAGE_MARKETING);
    await approveReactivationCandidates(prisma, access, {
      customerIds: readAll(formData, "customerId"),
      campaignId: readString(formData, "campaignId") || null,
      notes: readString(formData, "notes"),
    });
    revalidatePath("/growth");
    return { message: "Selected customers were approved for reactivation. No messages were sent." };
  } catch (error) {
    return { error: growthErrorMessage(error, "Those reactivation candidates could not be approved.") };
  }
}

export async function explainGrowthAction(
  _prev: GrowthActionState,
  formData: FormData,
): Promise<GrowthActionState> {
  try {
    const access = await requireOperatingProductAccess(PRODUCT_CAPABILITIES.REPORTING_INSIGHTS);
    requireBusinessCapability(access, CAPABILITIES.MANAGE_MARKETING);
    const workspace = await loadGrowthWorkspace(prisma, access.businessId);
    const input = {
      leads: workspace.totals.leads,
      estimates: workspace.totals.estimates,
      collected: workspace.totals.collected,
      invoiced: workspace.totals.invoiced,
      campaigns: workspace.campaigns,
      recommendations: workspace.recommendations,
    };
    const useAi = readString(formData, "useAi") === "1";
    const result = useAi
      ? await explainGrowthPerformanceWithAi(
          prisma,
          {
            businessId: access.businessId,
            membershipId: access.workspace.membership.id,
            userId: access.workspace.user.id,
          },
          input,
          readString(formData, "attemptId") || `growth-explain:${randomUUID()}`,
        )
      : explainGrowthPerformance(input);
    return { message: result.text, text: result.text };
  } catch (error) {
    return { error: growthErrorMessage(error, "Growth performance could not be explained.") };
  }
}

export async function proposeGrowthAngleAction(
  _prev: GrowthActionState,
  formData: FormData,
): Promise<GrowthActionState> {
  try {
    const access = await requireOperatingProductAccess(PRODUCT_CAPABILITIES.MARKETING_TOOLS);
    requireBusinessCapability(access, CAPABILITIES.MANAGE_MARKETING);
    const workspace = await loadGrowthWorkspace(prisma, access.businessId);
    const input = {
      leads: workspace.totals.leads,
      estimates: workspace.totals.estimates,
      collected: workspace.totals.collected,
      invoiced: workspace.totals.invoiced,
      campaigns: workspace.campaigns,
      recommendations: workspace.recommendations,
    };
    const useAi = readString(formData, "useAi") === "1";
    const result = useAi
      ? await proposeCampaignAngleWithAi(
          prisma,
          {
            businessId: access.businessId,
            membershipId: access.workspace.membership.id,
            userId: access.workspace.user.id,
          },
          input,
          readString(formData, "attemptId") || `growth-angle:${randomUUID()}`,
        )
      : proposeCampaignAngle(input);
    return { message: result.text, text: result.text };
  } catch (error) {
    return { error: growthErrorMessage(error, "A campaign angle could not be drafted.") };
  }
}
