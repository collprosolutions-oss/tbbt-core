"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { requireOperatingBusinessAccessForForm } from "@/lib/saas-billing/enforce";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { prisma } from "@/lib/prisma";
import {
  addWebsiteGalleryItem,
  listWebsitePublishes,
  publishWebsite,
  removeWebsiteGalleryItem,
  rollbackWebsite,
  saveWebsiteLocalPageDraft,
  saveWebsiteSeoDraft,
  setReviewWebsiteSelected,
  WebsitePublishError,
} from "@/lib/website-engine";

export type WebsiteEngineActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function publishError(error: unknown, fallback: string) {
  if (error instanceof WebsitePublishError) return error.message;
  if (error instanceof Error && error.name === "WebsitePublishError") return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  return fallback;
}

export async function publishWebsiteAction(
  _prev: WebsiteEngineActionState,
  formData: FormData,
): Promise<WebsiteEngineActionState> {
  const operating = await requireOperatingBusinessAccessForForm();
  if (!operating.ok) return { error: operating.error };
  requireBusinessCapability(operating.access, CAPABILITIES.MANAGE_SETTINGS);
  try {
    const result = await publishWebsite(prisma, operating.access, {
      idempotencyKey: readString(formData, "idempotencyKey") || randomUUID(),
    });
    revalidatePath("/settings");
    revalidatePath(`/hire/${operating.access.workspace.business.slug}`);
    return { message: `Published version ${result.versionNumber}.` };
  } catch (error) {
    return { error: publishError(error, "Could not publish the website.") };
  }
}

export async function rollbackWebsiteAction(
  _prev: WebsiteEngineActionState,
  formData: FormData,
): Promise<WebsiteEngineActionState> {
  const operating = await requireOperatingBusinessAccessForForm();
  if (!operating.ok) return { error: operating.error };
  requireBusinessCapability(operating.access, CAPABILITIES.MANAGE_SETTINGS);
  try {
    const result = await rollbackWebsite(prisma, operating.access, {
      publishId: readString(formData, "publishId"),
      idempotencyKey: readString(formData, "idempotencyKey") || randomUUID(),
    });
    revalidatePath("/settings");
    revalidatePath(`/hire/${operating.access.workspace.business.slug}`);
    return { message: `Rolled back. Current version is ${result.versionNumber}.` };
  } catch (error) {
    return { error: publishError(error, "Could not roll back that website version.") };
  }
}

export async function setReviewWebsiteSelectedAction(
  reviewId: string,
  selected: boolean,
): Promise<WebsiteEngineActionState> {
  const operating = await requireOperatingBusinessAccessForForm();
  if (!operating.ok) return { error: operating.error };
  try {
    await setReviewWebsiteSelected(prisma, operating.access, { reviewId, selected });
    revalidatePath("/settings");
    return { message: selected ? "Review selected for the next publish." : "Review removed from the next publish." };
  } catch (error) {
    return { error: publishError(error, "Could not update that review.") };
  }
}

export async function addWebsiteGalleryItemAction(
  _prev: WebsiteEngineActionState,
  formData: FormData,
): Promise<WebsiteEngineActionState> {
  const operating = await requireOperatingBusinessAccessForForm();
  if (!operating.ok) return { error: operating.error };
  try {
    await addWebsiteGalleryItem(prisma, operating.access, {
      storedAssetId: readString(formData, "storedAssetId"),
      title: readString(formData, "title"),
      caption: readString(formData, "caption"),
      catalogItemId: readString(formData, "catalogItemId") || null,
    });
    revalidatePath("/settings");
    return { message: "Gallery image added. Publish to show it on the public site." };
  } catch (error) {
    return { error: publishError(error, "Could not add that gallery image.") };
  }
}

export async function removeWebsiteGalleryItemAction(id: string): Promise<WebsiteEngineActionState> {
  const operating = await requireOperatingBusinessAccessForForm();
  if (!operating.ok) return { error: operating.error };
  try {
    await removeWebsiteGalleryItem(prisma, operating.access, { id });
    revalidatePath("/settings");
    return { message: "Gallery image removed from the next publish." };
  } catch (error) {
    return { error: publishError(error, "Could not remove that gallery image.") };
  }
}

export async function saveWebsiteSeoDraftAction(
  _prev: WebsiteEngineActionState,
  formData: FormData,
): Promise<WebsiteEngineActionState> {
  const operating = await requireOperatingBusinessAccessForForm();
  if (!operating.ok) return { error: operating.error };
  try {
    await saveWebsiteSeoDraft(prisma, operating.access, {
      seoTitleHome: readString(formData, "seoTitleHome"),
      seoDescriptionHome: readString(formData, "seoDescriptionHome"),
      seoTitleServices: readString(formData, "seoTitleServices"),
      seoDescriptionServices: readString(formData, "seoDescriptionServices"),
      seoTitleAbout: readString(formData, "seoTitleAbout"),
      seoDescriptionAbout: readString(formData, "seoDescriptionAbout"),
      seoTitleRequest: readString(formData, "seoTitleRequest"),
      seoDescriptionRequest: readString(formData, "seoDescriptionRequest"),
      websiteHeroHeadline: readString(formData, "websiteHeroHeadline"),
      websiteHeroSupporting: readString(formData, "websiteHeroSupporting"),
    });
    revalidatePath("/settings");
    return { message: "Website copy saved. Publish to update the public site." };
  } catch (error) {
    return { error: publishError(error, "Could not save website copy.") };
  }
}

export async function saveWebsiteLocalPageDraftAction(
  _prev: WebsiteEngineActionState,
  formData: FormData,
): Promise<WebsiteEngineActionState> {
  const operating = await requireOperatingBusinessAccessForForm();
  if (!operating.ok) return { error: operating.error };
  try {
    const pair = readString(formData, "pair");
    const [serviceAreaId, catalogItemId] = pair.includes(":")
      ? pair.split(":")
      : [readString(formData, "serviceAreaId"), readString(formData, "catalogItemId")];
    await saveWebsiteLocalPageDraft(prisma, operating.access, {
      serviceAreaId: serviceAreaId ?? "",
      catalogItemId: catalogItemId ?? "",
      draftCopy: readString(formData, "draftCopy"),
    });
    revalidatePath("/settings");
    return { message: "Local page draft saved. Publish to update the public site." };
  } catch (error) {
    return { error: publishError(error, "Could not save that local page draft.") };
  }
}

export async function loadWebsitePublishHistoryAction() {
  const operating = await requireOperatingBusinessAccessForForm();
  if (!operating.ok) return { error: operating.error, currentId: null, versions: [] };
  return listWebsitePublishes(prisma, operating.access);
}
