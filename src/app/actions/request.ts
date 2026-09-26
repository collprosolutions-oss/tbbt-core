"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { requireOperatingProductAccessForForm } from "@/lib/saas-billing/enforce";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { createOwnerLoggedLead } from "@/lib/owner-log-lead";
import { prisma } from "@/lib/prisma";

export type LogLeadActionState = {
  error?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Owner/admin phone / walk-in / referral capture.
 *
 * Always creates a tenant-scoped ServiceRequest. Capability is the same
 * request-management gate used to convert a request into an estimate
 * (MANAGE_ESTIMATES). MEMBER is unchanged. Client businessId is ignored.
 */
export async function logLead(
  _prev: LogLeadActionState,
  formData: FormData,
): Promise<LogLeadActionState> {
  const operating = await requireOperatingProductAccessForForm(
    PRODUCT_CAPABILITIES.ESTIMATES_INVOICES,
  );
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);

  const result = await createOwnerLoggedLead(prisma, access, {
    mode: readString(formData, "mode") === "existing" ? "existing" : "new",
    customerId: readString(formData, "customerId") || null,
    name: readString(formData, "name"),
    email: readString(formData, "email"),
    phone: readString(formData, "phone"),
    propertyChoice: readString(formData, "propertyChoice") || "none",
    streetAddress: readString(formData, "streetAddress"),
    unit: readString(formData, "unit"),
    city: readString(formData, "city"),
    region: readString(formData, "region"),
    postalCode: readString(formData, "postalCode"),
    summary: readString(formData, "summary"),
    notes: readString(formData, "notes"),
    channel: readString(formData, "channel"),
    serviceCatalogItemId: readString(formData, "serviceCatalogItemId") || null,
    tradeCode: readString(formData, "tradeCode") || null,
    submissionId: readString(formData, "submissionId") || null,
  });

  if (!result.ok) {
    return { error: result.error };
  }

  revalidatePath("/requests");
  revalidatePath("/pipeline");
  revalidatePath("/dashboard");
  revalidatePath("/customers");
  redirect(`/requests?selected=${result.requestId}`);
}
