"use server";

import { revalidatePath } from "next/cache";
import { requireBusinessAccess } from "@/lib/access";
import {
  businessLocationErrorMessage,
  createBusinessLocation,
  setBusinessLocationStatus,
  updateBusinessLocation,
} from "@/lib/business-location-ops";
import { prisma } from "@/lib/prisma";

export type BusinessLocationActionState = { error?: string; message?: string };

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function revalidateLocationSurfaces() {
  revalidatePath("/settings");
}

export async function createBusinessLocationAction(
  _prev: BusinessLocationActionState,
  formData: FormData,
): Promise<BusinessLocationActionState> {
  try {
    const access = await requireBusinessAccess();
    await createBusinessLocation(prisma, access, {
      name: readString(formData, "name"),
      addressLine1: readString(formData, "addressLine1"),
      addressLine2: readString(formData, "addressLine2"),
      city: readString(formData, "city"),
      region: readString(formData, "region"),
      postalCode: readString(formData, "postalCode"),
      notes: readString(formData, "notes"),
    });
    revalidateLocationSurfaces();
    return {
      message:
        "Location saved. Timezone, Stripe, service areas, and existing jobs were not changed.",
    };
  } catch (error) {
    return {
      error: businessLocationErrorMessage(error, "That location could not be saved."),
    };
  }
}

export async function updateBusinessLocationAction(
  _prev: BusinessLocationActionState,
  formData: FormData,
): Promise<BusinessLocationActionState> {
  try {
    const access = await requireBusinessAccess();
    await updateBusinessLocation(prisma, access, {
      locationId: readString(formData, "locationId"),
      name: readString(formData, "name"),
      addressLine1: readString(formData, "addressLine1"),
      addressLine2: readString(formData, "addressLine2"),
      city: readString(formData, "city"),
      region: readString(formData, "region"),
      postalCode: readString(formData, "postalCode"),
      notes: readString(formData, "notes"),
    });
    revalidateLocationSurfaces();
    return { message: "Location updated. Existing jobs were not rewritten." };
  } catch (error) {
    return {
      error: businessLocationErrorMessage(error, "That location could not be updated."),
    };
  }
}

export async function archiveBusinessLocationAction(
  _prev: BusinessLocationActionState,
  formData: FormData,
): Promise<BusinessLocationActionState> {
  try {
    const access = await requireBusinessAccess();
    await setBusinessLocationStatus(prisma, access, {
      locationId: readString(formData, "locationId"),
      status: "ARCHIVED",
    });
    revalidateLocationSurfaces();
    return { message: "Location archived. Historical jobs were not rewritten." };
  } catch (error) {
    return {
      error: businessLocationErrorMessage(error, "That location could not be archived."),
    };
  }
}

export async function restoreBusinessLocationAction(
  _prev: BusinessLocationActionState,
  formData: FormData,
): Promise<BusinessLocationActionState> {
  try {
    const access = await requireBusinessAccess();
    await setBusinessLocationStatus(prisma, access, {
      locationId: readString(formData, "locationId"),
      status: "ACTIVE",
    });
    revalidateLocationSurfaces();
    return { message: "Location restored." };
  } catch (error) {
    return {
      error: businessLocationErrorMessage(error, "That location could not be restored."),
    };
  }
}
