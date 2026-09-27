"use server";

import { revalidatePath } from "next/cache";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  attachCleaningCrewChecklist,
  cleaningVisitErrorMessage,
  recordAssignedVisitOutcome,
  setAssignedChecklistItem,
  setCleaningVisitCadence,
} from "@/lib/cleaning-visit-ops";
import { findAssignedJob } from "@/lib/field-access";
import { prisma } from "@/lib/prisma";
import {
  requireSaasOperatingEntitlement,
  saasOperatingErrorMessage,
  SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE,
} from "@/lib/saas-billing/entitlement";
import { requireOperatingBusinessAccess } from "@/lib/saas-billing/enforce";

export type CleaningVisitActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function revalidateVisit(jobId: string) {
  revalidatePath(`/jobs/${jobId}`);
  revalidatePath(`/field/jobs/${jobId}`);
  revalidatePath("/field");
}

export async function setCleaningVisitCadenceAction(
  _prev: CleaningVisitActionState,
  formData: FormData,
): Promise<CleaningVisitActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    requireBusinessCapability(access, CAPABILITIES.MANAGE_JOBS);
    const jobId = readString(formData, "jobId");
    if (!jobId) return { error: "That job could not be found." };
    await setCleaningVisitCadence(prisma, access, {
      jobId,
      cadence: readString(formData, "cadence"),
    });
    revalidateVisit(jobId);
    return { message: "Visit cadence recorded. No later jobs were created." };
  } catch (error) {
    return {
      error: cleaningVisitErrorMessage(error, "That visit cadence could not be saved."),
    };
  }
}

export async function attachCleaningCrewChecklistAction(
  _prev: CleaningVisitActionState,
  formData: FormData,
): Promise<CleaningVisitActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    requireBusinessCapability(access, CAPABILITIES.MANAGE_JOBS);
    const jobId = readString(formData, "jobId");
    const procedureId = readString(formData, "procedureId");
    if (!jobId) return { error: "That job could not be found." };
    if (!procedureId) return { error: "Choose an approved Cleaning checklist." };
    await attachCleaningCrewChecklist(prisma, access, { jobId, procedureId });
    revalidateVisit(jobId);
    return { message: "Crew checklist attached to this visit." };
  } catch (error) {
    return {
      error: cleaningVisitErrorMessage(error, "That checklist could not be attached."),
    };
  }
}

async function requireAssignedOperating(jobId: string) {
  const result = await findAssignedJob(jobId);
  if (!result.job) {
    return { ...result, error: "That job isn't assigned to you." };
  }
  try {
    await requireSaasOperatingEntitlement(prisma, result);
  } catch (error) {
    return {
      ...result,
      job: null,
      error: saasOperatingErrorMessage(error) ?? SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE,
    };
  }
  return { ...result, error: undefined as string | undefined };
}

export async function setAssignedChecklistItemAction(
  _prev: CleaningVisitActionState,
  formData: FormData,
): Promise<CleaningVisitActionState> {
  const jobId = readString(formData, "jobId");
  const itemKey = readString(formData, "itemKey");
  const checked = readString(formData, "checked") === "1";
  if (!jobId || !itemKey) {
    return { error: "That checklist item could not be updated." };
  }
  const assigned = await requireAssignedOperating(jobId);
  if (!assigned.job) {
    return { error: assigned.error ?? "That job isn't assigned to you." };
  }
  try {
    await setAssignedChecklistItem(
      prisma,
      { businessId: assigned.businessId, membershipId: assigned.membershipId },
      { jobId: assigned.job.id, itemKey, checked },
    );
    revalidateVisit(assigned.job.id);
    return {};
  } catch (error) {
    return {
      error: cleaningVisitErrorMessage(error, "That checklist item could not be updated."),
    };
  }
}

export async function recordAssignedVisitOutcomeAction(
  _prev: CleaningVisitActionState,
  formData: FormData,
): Promise<CleaningVisitActionState> {
  const jobId = readString(formData, "jobId");
  if (!jobId) return { error: "That job could not be found." };
  const assigned = await requireAssignedOperating(jobId);
  if (!assigned.job) {
    return { error: assigned.error ?? "That job isn't assigned to you." };
  }
  try {
    const recorded = await recordAssignedVisitOutcome(
      prisma,
      { businessId: assigned.businessId, membershipId: assigned.membershipId },
      {
        jobId: assigned.job.id,
        outcomeStatus: readString(formData, "outcomeStatus"),
      },
    );
    revalidateVisit(assigned.job.id);
    return {
      message:
        recorded.visit.outcomeStatus === "RE_CLEAN_REQUESTED"
          ? "Re-clean requested is recorded. No later job was created."
          : "Visit completed is recorded.",
    };
  } catch (error) {
    return {
      error: cleaningVisitErrorMessage(error, "That visit outcome could not be recorded."),
    };
  }
}
