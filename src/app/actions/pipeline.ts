"use server";

/**
 * Pipeline server actions. Tenant scope always comes from
 * requireBusinessAccess() (session workspace), never from a client
 * businessId. OWNER/ADMIN only (MANAGE_PIPELINE).
 */
import { revalidatePath } from "next/cache";
import { requireBusinessAccess } from "@/lib/access";
import {
  pipelineErrorMessage,
  updatePipelineFollowUp,
  updatePipelineNotes,
  updatePipelineStage,
} from "@/lib/pipeline-ops";
import { prisma } from "@/lib/prisma";

export type PipelineActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function revalidatePipeline() {
  revalidatePath("/pipeline");
}

export async function updatePipelineStageAction(
  _prev: PipelineActionState,
  formData: FormData,
): Promise<PipelineActionState> {
  try {
    const access = await requireBusinessAccess();
    await updatePipelineStage(prisma, access, {
      opportunityKey: readString(formData, "opportunityKey"),
      ownerStage: readString(formData, "ownerStage"),
      lossReason: readString(formData, "lossReason") || undefined,
      lossReasonNote: readString(formData, "lossReasonNote") || undefined,
    });
    revalidatePipeline();
    return { message: "Pipeline stage updated." };
  } catch (error) {
    return { error: pipelineErrorMessage(error, "That pipeline stage could not be updated.") };
  }
}

export async function updatePipelineFollowUpAction(
  _prev: PipelineActionState,
  formData: FormData,
): Promise<PipelineActionState> {
  try {
    const access = await requireBusinessAccess();
    await updatePipelineFollowUp(prisma, access, {
      opportunityKey: readString(formData, "opportunityKey"),
      followUpOn: readString(formData, "followUpOn") || undefined,
    });
    revalidatePipeline();
    return { message: "Follow-up date saved. No customer message was sent." };
  } catch (error) {
    return { error: pipelineErrorMessage(error, "That follow-up date could not be saved.") };
  }
}

export async function updatePipelineNotesAction(
  _prev: PipelineActionState,
  formData: FormData,
): Promise<PipelineActionState> {
  try {
    const access = await requireBusinessAccess();
    await updatePipelineNotes(prisma, access, {
      opportunityKey: readString(formData, "opportunityKey"),
      notes: readString(formData, "notes") || undefined,
    });
    revalidatePipeline();
    return { message: "Pipeline notes saved." };
  } catch (error) {
    return { error: pipelineErrorMessage(error, "Those pipeline notes could not be saved.") };
  }
}
