"use server";

import { revalidatePath } from "next/cache";
import {
  PROJECT_CONVERSATION_PORTAL_RECEIVED_MESSAGE,
  PROJECT_CONVERSATION_PORTAL_UNAVAILABLE_MESSAGE,
} from "@/lib/project-conversation";
import { submitPortalProjectConversation } from "@/lib/project-conversation-ops";
import { prisma } from "@/lib/prisma";

export type PortalProjectConversationActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Customer Project Portal conversation post. Authorization is the Job's
 * unguessable projectToken only — never a browser-supplied
 * businessId, customerId, or jobId.
 */
export async function submitPortalProjectConversationAction(
  _prev: PortalProjectConversationActionState,
  formData: FormData,
): Promise<PortalProjectConversationActionState> {
  const token = readString(formData, "projectToken");

  try {
    const created = await submitPortalProjectConversation(prisma, {
      token,
      body: readString(formData, "body"),
      attemptId: readString(formData, "attemptId"),
    });
    if (!created.ok) {
      return { error: created.error };
    }

    revalidatePath(`/p/${token}`);
    revalidatePath(`/jobs/${created.jobId}`);
    if (created.reused) {
      return { message: PROJECT_CONVERSATION_PORTAL_RECEIVED_MESSAGE };
    }
    return { message: PROJECT_CONVERSATION_PORTAL_RECEIVED_MESSAGE };
  } catch {
    return { error: PROJECT_CONVERSATION_PORTAL_UNAVAILABLE_MESSAGE };
  }
}
