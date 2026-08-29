"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";

export type CustomerChangeOrderActionState = {
  status?: string;
  error?: string;
};

const GENERIC_ERROR = "This change order is not available.";
const NOT_READY_ERROR = "This change order is not ready to respond to.";

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
 */
async function findJobByToken(token: string) {
  if (!token) {
    return null;
  }
  return prisma.job.findUnique({
    where: { projectToken: token },
    select: { id: true },
  });
}

export async function approveChangeOrder(
  _prev: CustomerChangeOrderActionState,
  formData: FormData,
): Promise<CustomerChangeOrderActionState> {
  const token = readString(formData, "projectToken");
  const changeOrderId = readString(formData, "changeOrderId");

  if (!token || !changeOrderId) {
    return { error: GENERIC_ERROR };
  }

  const job = await findJobByToken(token);
  if (!job) {
    return { error: GENERIC_ERROR };
  }

  const changeOrder = await prisma.changeOrder.findFirst({
    where: { id: changeOrderId, jobId: job.id },
    select: { id: true, status: true },
  });

  if (!changeOrder) {
    return { error: GENERIC_ERROR };
  }

  if (changeOrder.status === "APPROVED") {
    return { status: "APPROVED" };
  }

  if (changeOrder.status !== "SENT") {
    return { error: NOT_READY_ERROR };
  }

  // Guarded transition: only ever flips a currently-SENT row, and the sent
  // row's title/lineItems/total have been immutable since Send (see
  // src/app/actions/change-order.ts), so this always binds the customer's
  // approval to exactly the terms on record -- there is nothing else it
  // could have drifted to.
  const updated = await prisma.changeOrder.updateMany({
    where: { id: changeOrder.id, jobId: job.id, status: "SENT" },
    data: { status: "APPROVED", approvedAt: new Date() },
  });

  if (updated.count !== 1) {
    const finalState = await prisma.changeOrder.findUnique({
      where: { id: changeOrder.id },
      select: { status: true },
    });
    if (finalState?.status === "APPROVED") {
      return { status: "APPROVED" };
    }
    return { error: NOT_READY_ERROR };
  }

  revalidatePath(`/p/${token}`);
  return { status: "APPROVED" };
}

export async function declineChangeOrder(
  _prev: CustomerChangeOrderActionState,
  formData: FormData,
): Promise<CustomerChangeOrderActionState> {
  const token = readString(formData, "projectToken");
  const changeOrderId = readString(formData, "changeOrderId");

  if (!token || !changeOrderId) {
    return { error: GENERIC_ERROR };
  }

  const job = await findJobByToken(token);
  if (!job) {
    return { error: GENERIC_ERROR };
  }

  const changeOrder = await prisma.changeOrder.findFirst({
    where: { id: changeOrderId, jobId: job.id },
    select: { id: true, status: true },
  });

  if (!changeOrder) {
    return { error: GENERIC_ERROR };
  }

  if (changeOrder.status === "DECLINED") {
    return { status: "DECLINED" };
  }

  if (changeOrder.status !== "SENT") {
    return { error: NOT_READY_ERROR };
  }

  const updated = await prisma.changeOrder.updateMany({
    where: { id: changeOrder.id, jobId: job.id, status: "SENT" },
    data: { status: "DECLINED", declinedAt: new Date() },
  });

  if (updated.count !== 1) {
    const finalState = await prisma.changeOrder.findUnique({
      where: { id: changeOrder.id },
      select: { status: true },
    });
    if (finalState?.status === "DECLINED") {
      return { status: "DECLINED" };
    }
    return { error: NOT_READY_ERROR };
  }

  revalidatePath(`/p/${token}`);
  return { status: "DECLINED" };
}
