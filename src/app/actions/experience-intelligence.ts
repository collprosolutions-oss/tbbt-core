"use server";

import { revalidatePath } from "next/cache";
import { requireOperatingBusinessAccess } from "@/lib/saas-billing/enforce";
import {
  experienceErrorMessage,
  reviewExperienceCandidate,
  scanExperienceCandidates,
} from "@/lib/experience-intelligence-ops";
import { prisma } from "@/lib/prisma";

export type ExperienceActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function scanExperienceCandidatesAction(
  _prev?: ExperienceActionState,
  _formData?: FormData,
): Promise<ExperienceActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    const result = await scanExperienceCandidates(prisma, access);
    revalidatePath("/knowledge");
    revalidatePath("/business-health");
    return { message: `${result.createdCount} candidate learning(s) ready for review. ${result.message}` };
  } catch (error) {
    return { error: experienceErrorMessage(error, "Candidate learnings could not be scanned.") };
  }
}

export async function reviewExperienceCandidateAction(
  _prev: ExperienceActionState,
  formData: FormData,
): Promise<ExperienceActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await reviewExperienceCandidate(prisma, access, {
      candidateId: readString(formData, "candidateId"),
      status: readString(formData, "status"),
    });
    revalidatePath("/knowledge");
    revalidatePath("/business-health");
    return { message: "Candidate learning updated. Trusted policy is only created when you approve." };
  } catch (error) {
    return { error: experienceErrorMessage(error, "That candidate could not be reviewed.") };
  }
}
