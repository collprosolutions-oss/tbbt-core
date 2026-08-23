"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";

export type ApproveEstimateResult = {
  status?: string;
  error?: string;
};

const GENERIC_ERROR = "This estimate is not available.";

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

  if (estimate.status !== "DRAFT") {
    return { status: estimate.status };
  }

  const updated = await prisma.estimate.update({
    where: { publicToken: token },
    data: { status: "APPROVED" },
    select: { status: true },
  });

  revalidatePath(`/e/${token}`);
  return { status: updated.status };
}
