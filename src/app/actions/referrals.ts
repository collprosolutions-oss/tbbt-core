"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import {
  advanceReferralRequest,
  cancelCustomerFollowUp,
  cancelReferralRequest,
  createCustomerFollowUp,
  createReferralRequest,
  recordReferral,
  referralErrorMessage,
} from "@/lib/referral-ops";
import { sendReviewRequestReminder, stopReviewRequestReminders, reviewsErrorMessage } from "@/lib/reviews-ops";
import { requireOperatingBusinessAccess } from "@/lib/saas-billing/enforce";

export type ReferralActionState = { error?: string; message?: string };

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function refresh() {
  revalidatePath("/reviews");
  revalidatePath("/marketing");
  revalidatePath("/customers");
}

export async function createReferralRequestAction(
  _prev: ReferralActionState,
  formData: FormData,
): Promise<ReferralActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await createReferralRequest(prisma, access, {
      customerId: readString(formData, "customerId"),
      jobId: readString(formData, "jobId") || undefined,
      requestText: readString(formData, "requestText") || undefined,
      notes: readString(formData, "notes") || undefined,
    });
    refresh();
    return { message: "Referral request draft saved." };
  } catch (error) {
    return { error: referralErrorMessage(error, "That referral request could not be saved.") };
  }
}

export async function advanceReferralRequestAction(
  _prev: ReferralActionState,
  formData: FormData,
): Promise<ReferralActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await advanceReferralRequest(prisma, access, { requestId: readString(formData, "requestId") });
    refresh();
    return { message: "Referral request advanced. Delivery uses connected adapters only." };
  } catch (error) {
    return { error: referralErrorMessage(error, "That referral request could not be updated.") };
  }
}

export async function cancelReferralRequestAction(
  _prev: ReferralActionState,
  formData: FormData,
): Promise<ReferralActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await cancelReferralRequest(prisma, access, { requestId: readString(formData, "requestId") });
    refresh();
    return { message: "Referral request cancelled." };
  } catch (error) {
    return { error: referralErrorMessage(error, "That referral request could not be cancelled.") };
  }
}

export async function recordReferralAction(
  _prev: ReferralActionState,
  formData: FormData,
): Promise<ReferralActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await recordReferral(prisma, access, {
      sourceCustomerId: readString(formData, "sourceCustomerId"),
      referredCustomerId: readString(formData, "referredCustomerId") || undefined,
      referralRequestId: readString(formData, "referralRequestId") || undefined,
      campaignId: readString(formData, "campaignId") || undefined,
      notes: readString(formData, "notes") || undefined,
    });
    refresh();
    return { message: "Referral recorded from existing customers only." };
  } catch (error) {
    return { error: referralErrorMessage(error, "That referral could not be recorded.") };
  }
}

export async function createFollowUpAction(
  _prev: ReferralActionState,
  formData: FormData,
): Promise<ReferralActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    const kind = readString(formData, "kind") === "REPEAT" ? "REPEAT" : "JOB_COMPLETE";
    await createCustomerFollowUp(prisma, access, {
      customerId: readString(formData, "customerId"),
      jobId: readString(formData, "jobId") || undefined,
      kind,
      notes: readString(formData, "notes") || undefined,
    });
    refresh();
    return { message: "Follow-up recorded. Delivery uses connected adapters only." };
  } catch (error) {
    return { error: referralErrorMessage(error, "That follow-up could not be saved.") };
  }
}

export async function cancelFollowUpAction(
  _prev: ReferralActionState,
  formData: FormData,
): Promise<ReferralActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await cancelCustomerFollowUp(prisma, access, { followUpId: readString(formData, "followUpId") });
    refresh();
    return { message: "Follow-up cancelled." };
  } catch (error) {
    return { error: referralErrorMessage(error, "That follow-up could not be cancelled.") };
  }
}

export async function sendReviewReminderAction(
  _prev: ReferralActionState,
  formData: FormData,
): Promise<ReferralActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await sendReviewRequestReminder(prisma, access, { requestId: readString(formData, "requestId") });
    refresh();
    return { message: "Reminder attempted through connected adapters." };
  } catch (error) {
    return { error: reviewsErrorMessage(error, "That reminder could not be sent.") };
  }
}

export async function stopReviewRemindersAction(
  _prev: ReferralActionState,
  formData: FormData,
): Promise<ReferralActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await stopReviewRequestReminders(prisma, access, { requestId: readString(formData, "requestId") });
    refresh();
    return { message: "Reminders stopped for this request." };
  } catch (error) {
    return { error: reviewsErrorMessage(error, "Reminders could not be stopped.") };
  }
}
