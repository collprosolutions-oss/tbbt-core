"use server";

import { revalidatePath } from "next/cache";
import { requireBusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { prisma } from "@/lib/prisma";

export type AdditionalWorkRequestActionState = {
  error?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Dismisses an OPEN customer additional-work request without creating a
 * Change Order from it. Never touches Job/Estimate/Invoice scope or price --
 * this is purely an internal review-item state change. To act on a request
 * by pricing it, use createChangeOrder(..., additionalWorkRequestId) in
 * src/app/actions/change-order.ts instead.
 */
export async function dismissAdditionalWorkRequest(
  _prev: AdditionalWorkRequestActionState,
  formData: FormData,
): Promise<AdditionalWorkRequestActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CHANGE_ORDERS);
  const requestId = readString(formData, "requestId");

  if (!requestId) {
    return { error: "That request could not be found." };
  }

  const request = access.assertOwned(
    await prisma.additionalWorkRequest.findFirst({
      where: { id: requestId, ...access.scope },
    }),
  );

  if (request.status !== "OPEN") {
    return { error: "That request has already been handled." };
  }

  const updated = await prisma.additionalWorkRequest.updateMany({
    where: { id: request.id, businessId: access.businessId, status: "OPEN" },
    data: { status: "DISMISSED", reviewedAt: new Date() },
  });

  if (updated.count !== 1) {
    return { error: "That request has already been handled." };
  }

  revalidatePath(`/jobs/${request.jobId}`);
  return {};
}
