"use server";

import { revalidatePath } from "next/cache";
import { requireOperatingBusinessAccess } from "@/lib/saas-billing/enforce";
import { ForbiddenError } from "@/lib/authorization";
import {
  OwnershipTransferError,
  transferBusinessOwnershipOp,
} from "@/lib/ownership-transfer";
import { prisma } from "@/lib/prisma";

export type OwnershipActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function transferOwnershipAction(
  _prev: OwnershipActionState,
  formData: FormData,
): Promise<OwnershipActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    const result = await transferBusinessOwnershipOp(prisma, access, {
      targetMembershipId: readString(formData, "targetMembershipId"),
      confirmation: readString(formData, "confirmation"),
    });
    revalidatePath("/settings");
    revalidatePath("/team");
    return {
      message: `Ownership moved to ${result.newOwnerName} (${result.newOwnerEmail}). You are now an ADMIN. History is preserved.`,
    };
  } catch (error) {
    if (error instanceof OwnershipTransferError || error instanceof ForbiddenError) {
      return { error: error.message };
    }
    throw error;
  }
}
