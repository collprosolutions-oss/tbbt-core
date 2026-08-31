"use server";

import { revalidatePath } from "next/cache";
import { findCurrentEstimateVersion } from "@/lib/estimate-version";
import { prisma } from "@/lib/prisma";

export type ApproveEstimateResult = {
  status?: string;
  error?: string;
};

const GENERIC_ERROR = "This estimate is not available.";
const NOT_READY_ERROR = "This estimate is not ready to approve.";
const STALE_VERSION_ERROR =
  "This estimate was updated since you opened this page. Refresh to see the latest version before approving.";

type ApproveTransactionResult =
  | { ok: true }
  | { ok: false; reason: "not_ready" | "stale" | "already_approved" };

export async function approveEstimate(
  _prev: ApproveEstimateResult,
  formData: FormData,
): Promise<ApproveEstimateResult> {
  const raw = formData.get("publicToken");
  const token = typeof raw === "string" ? raw.trim() : "";
  const rawVersionId = formData.get("estimateVersionId");
  // Optional client-supplied hint of the version the customer was actually
  // shown when they clicked Approve. The server always determines the true
  // current version itself (see findCurrentEstimateVersion below); this
  // value is only ever compared against that truth to detect staleness. It
  // is never trusted to select which version gets approved.
  const submittedVersionId =
    typeof rawVersionId === "string" ? rawVersionId.trim() : "";

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

  const result = await prisma.$transaction(
    async (tx): Promise<ApproveTransactionResult> => {
      const current = await tx.estimate.findFirst({
        where: { publicToken: token },
        select: { id: true, status: true },
      });

      if (!current) {
        return { ok: false, reason: "not_ready" };
      }

      if (current.status === "APPROVED") {
        return { ok: false, reason: "already_approved" };
      }

      if (current.status !== "SENT") {
        return { ok: false, reason: "not_ready" };
      }

      // A SENT estimate must always have a current version once it has
      // been sent under this feature. If none exists, this is a legacy
      // estimate that was marked SENT before estimate versioning existed:
      // refuse rather than approve with no version to bind the approval
      // to. Re-sending (Return to Draft -> edit -> Send) creates Version 1
      // and unblocks approval.
      const currentVersion = await findCurrentEstimateVersion(
        tx,
        current.id,
      );
      if (!currentVersion) {
        return { ok: false, reason: "not_ready" };
      }

      // The customer's page showed a different version than what is
      // currently SENT (the owner returned this estimate to draft, edited
      // it, and sent a new version while this page was open). Reject
      // rather than silently approving content the customer never saw.
      if (submittedVersionId && submittedVersionId !== currentVersion.id) {
        return { ok: false, reason: "stale" };
      }

      const updated = await tx.estimate.updateMany({
        where: { id: current.id, status: "SENT" },
        data: {
          status: "APPROVED",
          approvedVersionId: currentVersion.id,
        },
      });

      if (updated.count !== 1) {
        return { ok: false, reason: "not_ready" };
      }

      await tx.estimateVersion.update({
        where: { id: currentVersion.id },
        data: { approvedAt: new Date() },
      });

      return { ok: true };
    },
  );

  if (!result.ok) {
    if (result.reason === "stale") {
      return { error: STALE_VERSION_ERROR };
    }
    if (result.reason === "already_approved") {
      return { status: "APPROVED" };
    }

    const finalState = await prisma.estimate.findUnique({
      where: { publicToken: token },
      select: { status: true },
    });
    if (finalState?.status === "APPROVED") {
      return { status: "APPROVED" };
    }
    return { error: NOT_READY_ERROR };
  }

  revalidatePath(`/e/${token}`);
  revalidatePath("/pipeline");
  return { status: "APPROVED" };
}
