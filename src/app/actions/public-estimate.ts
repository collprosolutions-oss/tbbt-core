"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";

export type ApproveEstimateResult = {
  status?: string;
  error?: string;
};

const GENERIC_ERROR = "This estimate is not available.";
const NOT_READY_ERROR = "This estimate is not ready to approve.";

export async function approveEstimate(
  publicToken: string,
): Promise<ApproveEstimateResult> {
  const token = publicToken.trim();
  if (!token) {
    return { error: GENERIC_ERROR };
  }

  const estimate = await prisma.estimate.findUnique({
    where: { publicToken: token },
    select: { status: true, publicToken: true },
  });

  if (!estimate) {
    return { error: GENERIC_ERROR };
  }

  if (estimate.status === "APPROVED") {
    return { status: estimate.status };
  }

  if (estimate.status !== "SENT") {
    return { error: NOT_READY_ERROR };
  }

  const updated = await prisma.estimate.updateMany({
    where: { publicToken: token, status: "SENT" },
    data: { status: "APPROVED" },
  });

  if (updated.count !== 1) {
    const current = await prisma.estimate.findUnique({
      where: { publicToken: token },
      select: { status: true },
    });
    if (current?.status === "APPROVED") {
      return { status: current.status };
    }
    return { error: NOT_READY_ERROR };
  }

  revalidatePath(`/e/${token}`);
  return { status: "APPROVED" };
}
