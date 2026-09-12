"use server";

import { revalidatePath } from "next/cache";
import { requireBusinessAccess } from "@/lib/access";
import { ForbiddenError, requireBusinessRole } from "@/lib/authorization";
import { FounderAccessError, requireFounderAccess } from "@/lib/founder-access";
import { prisma } from "@/lib/prisma";
import {
  executeOperationalTestDataCleanup,
  testDataCleanupErrorMessage,
} from "@/lib/test-data-cleanup";

export type ClearTestDataActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

async function requireFounderOwnerCleanupAccess() {
  const access = await requireBusinessAccess();
  requireBusinessRole(access, "OWNER");
  await requireFounderAccess();
  return access;
}

export async function clearOperationalTestData(
  _prev: ClearTestDataActionState,
  formData: FormData,
): Promise<ClearTestDataActionState> {
  try {
    const access = await requireFounderOwnerCleanupAccess();
    const confirmation = readString(formData, "confirmation");
    if (readString(formData, "businessId")) {
      return { error: "This action cannot accept a browser-supplied business." };
    }

    const preview = await executeOperationalTestDataCleanup(prisma, {
      businessId: access.businessId,
      confirmation,
      changedByMembershipId: access.workspace.membership.id,
    });

    revalidatePath("/settings");
    revalidatePath("/customers");
    revalidatePath("/requests");
    revalidatePath("/estimates");
    revalidatePath("/jobs");
    revalidatePath("/invoices");
    revalidatePath("/dashboard");
    revalidatePath("/pipeline");
    revalidatePath("/reviews");
    revalidatePath("/marketing");
    revalidatePath("/expenses");
    revalidatePath("/time-cards");
    revalidatePath("/payroll");
    revalidatePath("/reports");

    return {
      message: `Cleared ${preview.willDelete.customers} customer${
        preview.willDelete.customers === 1 ? "" : "s"
      } and related operational test records. Catalog, website, Stripe, and business settings were left unchanged.`,
    };
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof FounderAccessError) {
      return { error: "You do not have permission to do that." };
    }
    return {
      error: testDataCleanupErrorMessage(
        error,
        "Test data could not be cleared.",
      ),
    };
  }
}
