"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ForbiddenError } from "@/lib/authorization";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { requireOperatingProductAccessForForm } from "@/lib/saas-billing/enforce";
import {
  CONFIRM_REQUIRED_MESSAGE,
  CUSTOMER_MERGE_ROUTE,
  CustomerMergeError,
  OWNER_ONLY_MERGE_MESSAGE,
} from "@/lib/customer-merge";
import { mergeConfirmedCustomers } from "@/lib/customer-merge-ops";
import { prisma } from "@/lib/prisma";

export type CustomerMergeActionState = {
  error?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

async function requireOwnerMergeAccess() {
  const operating = await requireOperatingProductAccessForForm(PRODUCT_CAPABILITIES.CRM);
  if (!operating.ok) return operating;
  try {
    if (operating.access.workspace.role !== "OWNER") {
      throw new ForbiddenError(OWNER_ONLY_MERGE_MESSAGE);
    }
    return operating;
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return { ok: false as const, error: OWNER_ONLY_MERGE_MESSAGE };
    }
    throw error;
  }
}

export async function mergeCustomersAction(
  _prev: CustomerMergeActionState,
  formData: FormData,
): Promise<CustomerMergeActionState> {
  const operating = await requireOwnerMergeAccess();
  if (!operating.ok) return { error: operating.error };

  const keepCustomerId = readString(formData, "keepCustomerId");
  const leftCustomerId = readString(formData, "leftCustomerId");
  const rightCustomerId = readString(formData, "rightCustomerId");
  const absorbCustomerId =
    keepCustomerId === leftCustomerId
      ? rightCustomerId
      : keepCustomerId === rightCustomerId
        ? leftCustomerId
        : "";
  const confirmedSameCustomer = readString(formData, "confirmSameCustomer") === "yes";

  if (!confirmedSameCustomer) {
    return { error: CONFIRM_REQUIRED_MESSAGE };
  }

  try {
    const result = await mergeConfirmedCustomers(prisma, operating.access, {
      keepCustomerId,
      absorbCustomerId,
      confirmedSameCustomer: true,
    });
    revalidatePath("/customers");
    revalidatePath(CUSTOMER_MERGE_ROUTE);
    revalidatePath(`/customers/${result.survivorId}`);
    redirect(`/customers/${result.survivorId}`);
  } catch (error) {
    if (error instanceof CustomerMergeError) {
      return { error: error.message };
    }
    if (error instanceof ForbiddenError) {
      return { error: OWNER_ONLY_MERGE_MESSAGE };
    }
    throw error;
  }
}
