"use server";

import { revalidatePath } from "next/cache";
import { createMarketingCampaign, marketingErrorMessage, saveMarketingBrandVoice, setMarketingCampaignStatus } from "@/lib/marketing-ops";
import { prisma } from "@/lib/prisma";
import { requireOperatingBusinessAccess } from "@/lib/saas-billing/enforce";

export type CampaignActionState = { error?: string; message?: string };

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function createCampaignAction(
  _prev: CampaignActionState,
  formData: FormData,
): Promise<CampaignActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await createMarketingCampaign(prisma, access, {
      name: readString(formData, "name"),
      sourceKey: readString(formData, "sourceKey") || undefined,
      notes: readString(formData, "notes"),
    });
    revalidatePath("/marketing");
    return { message: "Campaign record saved. It is not an external ad account." };
  } catch (error) {
    return { error: marketingErrorMessage(error, "That campaign could not be saved.") };
  }
}

export async function setCampaignStatusAction(
  _prev: CampaignActionState,
  formData: FormData,
): Promise<CampaignActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await setMarketingCampaignStatus(prisma, access, {
      campaignId: readString(formData, "campaignId"),
      status: readString(formData, "status"),
    });
    revalidatePath("/marketing");
    return { message: "Campaign status updated." };
  } catch (error) {
    return { error: marketingErrorMessage(error, "That campaign could not be updated.") };
  }
}

export async function saveBrandVoiceAction(
  _prev: CampaignActionState,
  formData: FormData,
): Promise<CampaignActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await saveMarketingBrandVoice(prisma, access, {
      brandVoice: readString(formData, "brandVoice"),
      identityNotes: readString(formData, "identityNotes"),
    });
    revalidatePath("/marketing");
    return { message: "Brand voice saved for future drafts." };
  } catch (error) {
    return { error: marketingErrorMessage(error, "Brand voice could not be saved.") };
  }
}
