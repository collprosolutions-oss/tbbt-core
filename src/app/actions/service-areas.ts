"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireOperatingBusinessAccess } from "@/lib/saas-billing/enforce";
import { serviceAreaErrorMessage, setServiceAreaEnabled, upsertServiceArea } from "@/lib/service-area-ops";

export type ServiceAreaActionState = { error?: string; message?: string };

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function saveServiceAreaAction(
  _prev: ServiceAreaActionState,
  formData: FormData,
): Promise<ServiceAreaActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await upsertServiceArea(prisma, access, {
      areaId: readString(formData, "areaId") || undefined,
      kind: readString(formData, "kind"),
      label: readString(formData, "label"),
      city: readString(formData, "city"),
      region: readString(formData, "region"),
      postalCode: readString(formData, "postalCode"),
      enabled: readString(formData, "enabled") !== "0",
      travelAdjustment: readString(formData, "travelAdjustment") || undefined,
      minimumAdjustment: readString(formData, "minimumAdjustment") || undefined,
      notes: readString(formData, "notes"),
    });
    revalidatePath("/settings");
    revalidatePath("/business-health");
    return { message: "Service area saved. Historical requests were not rewritten." };
  } catch (error) {
    return { error: serviceAreaErrorMessage(error, "That service area could not be saved.") };
  }
}

export async function toggleServiceAreaAction(
  _prev: ServiceAreaActionState,
  formData: FormData,
): Promise<ServiceAreaActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await setServiceAreaEnabled(prisma, access, {
      areaId: readString(formData, "areaId"),
      enabled: readString(formData, "enabled") === "1",
    });
    revalidatePath("/settings");
    return { message: "Service area updated." };
  } catch (error) {
    return { error: serviceAreaErrorMessage(error, "That service area could not be updated.") };
  }
}
