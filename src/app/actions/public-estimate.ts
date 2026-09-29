"use server";

import { revalidatePath } from "next/cache";
import { findCurrentEstimateVersion } from "@/lib/estimate-version";
import {
  MIN_ESTIMATE_OPTIONS,
  OPTION_REQUIRED_MESSAGE,
} from "@/lib/estimate-options";
import { prisma } from "@/lib/prisma";
import { emitAndProcessBusinessEvent } from "@/lib/automation/events";

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
  | {
      ok: false;
      reason: "not_ready" | "stale" | "already_approved" | "option_required";
    };

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
  const rawOptionId = formData.get("estimateOptionId");
  // Required when the current SENT version has frozen priced options.
  // Compared against EstimateVersionOption rows on the current version
  // only — never trusted to select a historical or cross-tenant option.
  const submittedOptionId =
    typeof rawOptionId === "string" ? rawOptionId.trim() : "";

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
        select: { id: true, businessId: true, status: true },
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

      const versionOptions = await tx.estimateVersionOption.findMany({
        where: {
          estimateVersionId: currentVersion.id,
          businessId: current.businessId,
        },
        orderBy: { sortOrder: "asc" },
      });
      let approvedOptionId: string | null = null;
      let chosenTotal = currentVersion.total;
      let chosenAdjustment = currentVersion.laborMinimumAdjustment;

      if (versionOptions.length > 0) {
        if (versionOptions.length < MIN_ESTIMATE_OPTIONS) {
          return { ok: false, reason: "not_ready" };
        }
        if (!submittedOptionId) {
          return { ok: false, reason: "option_required" };
        }
        const chosen = versionOptions.find((option) => option.id === submittedOptionId);
        if (!chosen) {
          return { ok: false, reason: "stale" };
        }
        approvedOptionId = chosen.id;
        chosenTotal = chosen.total;
        chosenAdjustment = chosen.laborMinimumAdjustment;
      } else if (submittedOptionId) {
        return { ok: false, reason: "stale" };
      }

      const updated = await tx.estimate.updateMany({
        where: { id: current.id, status: "SENT" },
        data: {
          status: "APPROVED",
          approvedVersionId: currentVersion.id,
          approvedOptionId,
          total: chosenTotal,
          laborMinimumAdjustment: chosenAdjustment,
        },
      });

      if (updated.count !== 1) {
        return { ok: false, reason: "not_ready" };
      }

      await tx.estimateVersion.update({
        where: { id: currentVersion.id },
        data: { approvedAt: new Date() },
      });
      if (approvedOptionId) {
        await tx.estimateVersionOption.update({
          where: { id: approvedOptionId },
          data: { approvedAt: new Date() },
        });
      }

      return { ok: true };
    },
  );

  if (!result.ok) {
    if (result.reason === "stale") {
      return { error: STALE_VERSION_ERROR };
    }
    if (result.reason === "option_required") {
      return { error: OPTION_REQUIRED_MESSAGE };
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

  const approved = await prisma.estimate.findUnique({
    where: { publicToken: token },
    select: { id: true, businessId: true, customerId: true },
  });
  if (approved) {
    await emitAndProcessBusinessEvent(prisma, {
      businessId: approved.businessId,
      type: "ESTIMATE_APPROVED",
      subjectType: "ESTIMATE",
      subjectId: approved.id,
      payload: { customerId: approved.customerId },
      idempotencyKey: `ESTIMATE_APPROVED:${approved.id}`,
    });
  }

  revalidatePath(`/e/${token}`);
  revalidatePath("/pipeline");
  return { status: "APPROVED" };
}
