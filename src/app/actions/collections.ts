"use server";

import { revalidatePath } from "next/cache";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog/codes";
import { prisma } from "@/lib/prisma";
import {
  COLLECTIONS_NEXT_STEP_RECORDED_MESSAGE,
  COLLECTIONS_NEXT_STEP_UPDATED_MESSAGE,
  COLLECTIONS_RESOLUTION_UNCHANGED_MESSAGE,
  COLLECTIONS_RESOLVED_MESSAGE,
  COLLECTIONS_ROUTE,
  collectionWorkItemErrorMessage,
  recordCollectionNextStep,
  resolveCollectionWorkItem,
} from "@/lib/collections";
import { requireOperatingProductAccess } from "@/lib/saas-billing/enforce";

export type CollectionWorkItemActionState = { error?: string; message?: string };

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function recordCollectionNextStepAction(
  _prev: CollectionWorkItemActionState,
  formData: FormData,
): Promise<CollectionWorkItemActionState> {
  try {
    const access = await requireOperatingProductAccess(PRODUCT_CAPABILITIES.ESTIMATES_INVOICES);
    const result = await recordCollectionNextStep(prisma, access, {
      invoiceId: readString(formData, "invoiceId"),
      nextStep: readString(formData, "nextStep"),
      note: readString(formData, "note"),
    });
    revalidatePath(COLLECTIONS_ROUTE);
    revalidatePath("/invoices");
    return {
      message:
        result.outcome === "CREATED"
          ? COLLECTIONS_NEXT_STEP_RECORDED_MESSAGE
          : COLLECTIONS_NEXT_STEP_UPDATED_MESSAGE,
    };
  } catch (error) {
    return {
      error: collectionWorkItemErrorMessage(error, "That next step could not be recorded."),
    };
  }
}

export async function resolveCollectionWorkItemAction(
  _prev: CollectionWorkItemActionState,
  formData: FormData,
): Promise<CollectionWorkItemActionState> {
  try {
    const access = await requireOperatingProductAccess(PRODUCT_CAPABILITIES.ESTIMATES_INVOICES);
    const result = await resolveCollectionWorkItem(prisma, access, {
      invoiceId: readString(formData, "invoiceId"),
      note: readString(formData, "note"),
    });
    revalidatePath(COLLECTIONS_ROUTE);
    revalidatePath("/invoices");
    if (result.outcome === "UNCHANGED") {
      return { message: COLLECTIONS_RESOLUTION_UNCHANGED_MESSAGE };
    }
    return { message: COLLECTIONS_RESOLVED_MESSAGE };
  } catch (error) {
    return {
      error: collectionWorkItemErrorMessage(error, "That resolution could not be recorded."),
    };
  }
}
