"use server";

/**
 * Partner / vendor opportunity directory actions. Tenant scope always
 * comes from requireBusinessAccess() (session workspace), never from a
 * client businessId. OWNER/ADMIN only.
 */
import { revalidatePath } from "next/cache";
import { requireOperatingBusinessAccess } from "@/lib/saas-billing/enforce";
import {
  DIRECTORY_ROUTE,
  createPartnerVendorOpportunity,
  directoryErrorMessage,
  reviewPartnerVendorOpportunity,
  updatePartnerVendorOpportunity,
} from "@/lib/partner-vendor-directory";
import { prisma } from "@/lib/prisma";

export type DirectoryActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function revalidateDirectory() {
  revalidatePath(DIRECTORY_ROUTE);
}

export async function createPartnerVendorOpportunityAction(
  _prev: DirectoryActionState,
  formData: FormData,
): Promise<DirectoryActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await createPartnerVendorOpportunity(prisma, access, {
      kind: readString(formData, "kind"),
      name: readString(formData, "name"),
      summary: readString(formData, "summary"),
      notes: readString(formData, "notes"),
      contactName: readString(formData, "contactName") || null,
      contactEmail: readString(formData, "contactEmail") || null,
      contactPhone: readString(formData, "contactPhone") || null,
      website: readString(formData, "website") || null,
      category: readString(formData, "category") || null,
      locationDescription: readString(formData, "locationDescription") || null,
      source: readString(formData, "source"),
      supplierId: readString(formData, "supplierId") || null,
      referralId: readString(formData, "referralId") || null,
    });
    revalidateDirectory();
    return { message: "Opportunity recorded for this business. TBBT did not publish it anywhere else." };
  } catch (error) {
    return { error: directoryErrorMessage(error, "That opportunity could not be saved.") };
  }
}

export async function updatePartnerVendorOpportunityAction(
  _prev: DirectoryActionState,
  formData: FormData,
): Promise<DirectoryActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await updatePartnerVendorOpportunity(prisma, access, {
      opportunityId: readString(formData, "opportunityId"),
      kind: readString(formData, "kind"),
      name: readString(formData, "name"),
      summary: readString(formData, "summary"),
      notes: readString(formData, "notes"),
      contactName: readString(formData, "contactName") || null,
      contactEmail: readString(formData, "contactEmail") || null,
      contactPhone: readString(formData, "contactPhone") || null,
      website: readString(formData, "website") || null,
      category: readString(formData, "category") || null,
      locationDescription: readString(formData, "locationDescription") || null,
      source: readString(formData, "source"),
      supplierId: readString(formData, "supplierId") || null,
      referralId: readString(formData, "referralId") || null,
    });
    revalidateDirectory();
    return { message: "Opportunity updated. Source and review stay owner-managed." };
  } catch (error) {
    return { error: directoryErrorMessage(error, "That opportunity could not be updated.") };
  }
}

export async function reviewPartnerVendorOpportunityAction(
  _prev: DirectoryActionState,
  formData: FormData,
): Promise<DirectoryActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await reviewPartnerVendorOpportunity(prisma, access, {
      opportunityId: readString(formData, "opportunityId"),
      reviewStatus: readString(formData, "reviewStatus"),
      reviewNotes: readString(formData, "reviewNotes") || null,
    });
    revalidateDirectory();
    return { message: "Manual review recorded for this business only." };
  } catch (error) {
    return { error: directoryErrorMessage(error, "That opportunity could not be reviewed.") };
  }
}
