"use server";

import { revalidatePath } from "next/cache";
import { requireOperatingBusinessAccessForForm } from "@/lib/saas-billing/enforce";
import { prisma } from "@/lib/prisma";
import {
  recordCustomerWarrantyCallback,
  recordJobWarrantyTerm,
  recordWarrantyCallbackOutcome,
  reviewWarrantyCallback,
  warrantyCallbackErrorMessage,
} from "@/lib/warranty-callback-ops";

export type WarrantyCallbackActionState = {
  error?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function recordWarrantyTermAction(
  _prev: WarrantyCallbackActionState,
  formData: FormData,
): Promise<WarrantyCallbackActionState> {
  const operating = await requireOperatingBusinessAccessForForm();
  if (!operating.ok) return { error: operating.error };
  const jobId = readString(formData, "jobId");
  try {
    const saved = await recordJobWarrantyTerm(prisma, operating.access, {
      jobId,
      statement: readString(formData, "statement"),
    });
    revalidatePath(`/jobs/${saved.jobId}`);
    return {};
  } catch (error) {
    return {
      error: warrantyCallbackErrorMessage(error, "The warranty terms could not be recorded."),
    };
  }
}

export async function recordWarrantyCallbackAction(
  _prev: WarrantyCallbackActionState,
  formData: FormData,
): Promise<WarrantyCallbackActionState> {
  const operating = await requireOperatingBusinessAccessForForm();
  if (!operating.ok) return { error: operating.error };
  const jobId = readString(formData, "jobId");
  try {
    const saved = await recordCustomerWarrantyCallback(prisma, operating.access, {
      jobId,
      report: readString(formData, "report"),
    });
    revalidatePath(`/jobs/${saved.jobId}`);
    return {};
  } catch (error) {
    return {
      error: warrantyCallbackErrorMessage(error, "The callback could not be recorded."),
    };
  }
}

export async function reviewWarrantyCallbackAction(
  _prev: WarrantyCallbackActionState,
  formData: FormData,
): Promise<WarrantyCallbackActionState> {
  const operating = await requireOperatingBusinessAccessForForm();
  if (!operating.ok) return { error: operating.error };
  const jobId = readString(formData, "jobId");
  try {
    const saved = await reviewWarrantyCallback(prisma, operating.access, {
      callbackId: readString(formData, "callbackId"),
      reviewNote: readString(formData, "reviewNote"),
    });
    revalidatePath(`/jobs/${jobId || saved.jobId}`);
    return {};
  } catch (error) {
    return {
      error: warrantyCallbackErrorMessage(error, "The callback could not be reviewed."),
    };
  }
}

export async function recordWarrantyCallbackOutcomeAction(
  _prev: WarrantyCallbackActionState,
  formData: FormData,
): Promise<WarrantyCallbackActionState> {
  const operating = await requireOperatingBusinessAccessForForm();
  if (!operating.ok) return { error: operating.error };
  const jobId = readString(formData, "jobId");
  try {
    const saved = await recordWarrantyCallbackOutcome(prisma, operating.access, {
      callbackId: readString(formData, "callbackId"),
      outcomeNote: readString(formData, "outcomeNote"),
    });
    revalidatePath(`/jobs/${jobId || saved.jobId}`);
    return {};
  } catch (error) {
    return {
      error: warrantyCallbackErrorMessage(
        error,
        "The callback outcome could not be recorded.",
      ),
    };
  }
}
