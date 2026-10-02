"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import {
  approveCustomerChangeOrder,
  CUSTOMER_CHANGE_ORDER_UNAVAILABLE_ERROR,
  declineCustomerChangeOrder,
} from "@/lib/public-change-order-ops";

export type CustomerChangeOrderActionState = {
  status?: string;
  error?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * SECURITY: both actions below look a ChangeOrder up ONLY through the
 * combination of the Job's own unguessable `projectToken` (see
 * Job.projectToken in prisma/schema.prisma and src/app/p/[token]/page.tsx)
 * and `changeOrderId` scoped to that exact Job (`jobId: job.id`) -- never a
 * client-supplied businessId, and never a bare changeOrderId lookup that
 * could match another Job's row. An invalid token or a changeOrderId that
 * belongs to a different Job than the token both resolve to the same
 * generic "not available" error, revealing nothing about what does or
 * doesn't exist.
 *
 * The write transaction locks the Job and re-checks the live token so an
 * in-flight approve/decline cannot land after rotate/revoke commits.
 */
export async function approveChangeOrder(
  _prev: CustomerChangeOrderActionState,
  formData: FormData,
): Promise<CustomerChangeOrderActionState> {
  const token = readString(formData, "projectToken");
  const changeOrderId = readString(formData, "changeOrderId");

  if (!token || !changeOrderId) {
    return { error: CUSTOMER_CHANGE_ORDER_UNAVAILABLE_ERROR };
  }

  const result = await approveCustomerChangeOrder(prisma, {
    token,
    changeOrderId,
  });
  if ("error" in result) {
    return { error: result.error };
  }
  revalidatePath(`/p/${token}`);
  return { status: result.status };
}

export async function declineChangeOrder(
  _prev: CustomerChangeOrderActionState,
  formData: FormData,
): Promise<CustomerChangeOrderActionState> {
  const token = readString(formData, "projectToken");
  const changeOrderId = readString(formData, "changeOrderId");

  if (!token || !changeOrderId) {
    return { error: CUSTOMER_CHANGE_ORDER_UNAVAILABLE_ERROR };
  }

  const result = await declineCustomerChangeOrder(prisma, {
    token,
    changeOrderId,
  });
  if ("error" in result) {
    return { error: result.error };
  }
  revalidatePath(`/p/${token}`);
  return { status: result.status };
}
