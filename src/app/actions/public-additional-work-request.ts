"use server";

import { revalidatePath } from "next/cache";
import { createCustomerAdditionalWorkRequest } from "@/lib/additional-work-request";
import { prisma } from "@/lib/prisma";

export type RequestAdditionalWorkState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function readAllStrings(formData: FormData, key: string) {
  return formData
    .getAll(key)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * "+ Request Additional Work" on the Customer Project Portal. This is NOT
 * approval and NEVER creates a ChangeOrder or changes approved scope,
 * price, Job total, or Invoice total by itself -- it only creates an
 * internal review item (AdditionalWorkRequest, status OPEN) that an
 * owner/admin later reviews from the Job/Work Order page and decides to
 * price into a ChangeOrder, handle separately, or dismiss.
 *
 * SECURITY: scoped only by the Job's own unguessable projectToken, exactly
 * like the rest of the Customer Project Portal (see
 * src/app/p/[token]/page.tsx) -- never a client-supplied businessId/jobId.
 * Catalog IDs are re-validated against the token-looked-up Job.businessId.
 */
export async function requestAdditionalWork(
  _prev: RequestAdditionalWorkState,
  formData: FormData,
): Promise<RequestAdditionalWorkState> {
  const token = readString(formData, "projectToken");
  const includeOtherRaw = readString(formData, "includeOther");
  const includeOther =
    includeOtherRaw === "on" ||
    includeOtherRaw === "true" ||
    includeOtherRaw === "1";
  const catalogItemIds = [
    ...readAllStrings(formData, "serviceCatalogItemId"),
    ...readAllStrings(formData, "serviceCatalogItemIds"),
  ];
  const quantityValues = readAllStrings(formData, "quantity");
  const catalogQuantities: Record<string, string> = {};
  catalogItemIds.forEach((id, index) => {
    const paired = quantityValues[index];
    const named = readString(formData, `quantity:${id}`);
    if (named) catalogQuantities[id] = named;
    else if (paired) catalogQuantities[id] = paired;
  });

  const created = await createCustomerAdditionalWorkRequest(prisma, {
    token,
    catalogItemIds,
    catalogQuantities,
    includeOther,
    otherDescription: readString(formData, "otherDescription"),
    otherQuantity: readString(formData, "otherQuantity") || undefined,
    notes:
      readString(formData, "notes") || readString(formData, "description"),
  });

  if (!created.ok) {
    return { error: created.error };
  }

  revalidatePath(`/p/${token}`);
  revalidatePath(`/jobs/${created.jobId}`);
  return {
    message:
      "Thanks! We received your request and will follow up about pricing and scheduling.",
  };
}
