"use server";

import { revalidatePath } from "next/cache";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  PROJECT_CONVERSATION_JOB_REQUIRED_MESSAGE,
  PROJECT_CONVERSATION_OWNER_REUSED_MESSAGE,
  PROJECT_CONVERSATION_OWNER_SENT_MESSAGE,
} from "@/lib/project-conversation";
import { sendProjectConversationOwnerReply } from "@/lib/project-conversation-ops";
import { prisma } from "@/lib/prisma";
import { requireOperatingBusinessAccessForForm } from "@/lib/saas-billing/enforce";
import { isAiAttemptId } from "@/lib/ai/types";
import {
  buildComposeFormFields,
  composeIdempotencyKey,
  resolveComposeSendIntent,
} from "@/lib/communications/compose-flow";

export type ProjectConversationActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * OWNER/ADMIN reply for one job conversation. Job + customer are
 * resolved from the authorized workspace. Browser businessId never
 * authorizes. Send is explicit — opening the job page does not send.
 */
export async function sendProjectConversationReplyAction(
  _prev: ProjectConversationActionState,
  formData: FormData,
): Promise<ProjectConversationActionState> {
  const operating = await requireOperatingBusinessAccessForForm();
  if (!operating.ok) return { error: operating.error };
  requireBusinessCapability(operating.access, CAPABILITIES.MANAGE_COMMUNICATIONS);

  const jobId = readString(formData, "jobId");
  if (!jobId) return { error: PROJECT_CONVERSATION_JOB_REQUIRED_MESSAGE };
  const attemptId = readString(formData, "attemptId");
  if (!isAiAttemptId(attemptId)) {
    return { error: "Retry that send from the form." };
  }

  const job = await prisma.job.findFirst({
    where: { id: jobId, ...operating.access.scope },
    select: { id: true, businessId: true, customerId: true },
  });
  if (!job?.customerId) {
    return { error: PROJECT_CONVERSATION_JOB_REQUIRED_MESSAGE };
  }
  operating.access.assertOwned(job);

  const resolved = resolveComposeSendIntent(
    buildComposeFormFields({
      customerId: job.customerId,
      template: "job_update",
      channel: readString(formData, "channel"),
      subject: readString(formData, "subject"),
      body: readString(formData, "body"),
      attemptId,
      relatedType: "JOB",
      relatedId: job.id,
    }),
  );
  if (!resolved.ok) return { error: resolved.error };

  try {
    const result = await sendProjectConversationOwnerReply(
      prisma,
      operating.access,
      {
        jobId: job.id,
        channel: resolved.intent.channel,
        body: resolved.intent.body,
        subject: resolved.intent.subject,
        idempotencyKey: composeIdempotencyKey(resolved.intent),
        browserBusinessId: readString(formData, "businessId") || null,
      },
    );
    revalidatePath("/jobs");
    revalidatePath(`/jobs/${job.id}`);
    revalidatePath("/communications");
    revalidatePath(`/customers/${job.customerId}`);
    if (!result.ok) {
      return { error: result.failureReason ?? "The reply was not sent." };
    }
    return {
      message: result.reused
        ? PROJECT_CONVERSATION_OWNER_REUSED_MESSAGE
        : PROJECT_CONVERSATION_OWNER_SENT_MESSAGE,
    };
  } catch {
    return { error: "You do not have permission to do that." };
  }
}
