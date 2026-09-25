"use server";

import { revalidatePath } from "next/cache";
import { requireOperatingBusinessAccess } from "@/lib/saas-billing/enforce";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { prisma } from "@/lib/prisma";
import { isAiAttemptId } from "@/lib/ai/types";
import { emitAndProcessBusinessEvent } from "@/lib/automation/events";
import {
  composeCustomerCommunication,
  isCommunicationAiAction,
  recordInboundCallEvent,
  recordMissedOrManualCall,
  runCommunicationAssist,
} from "@/lib/communications";
import {
  buildComposeFormFields,
  composeIdempotencyKey,
  resolveComposeSendIntent,
} from "@/lib/communications/compose-flow";
import { isCommunicationRelatedType } from "@/lib/communications/related";
import { isCommunicationComposeTemplate } from "@/lib/communications/types";

export type CommunicationsActionState = {
  error?: string;
  message?: string;
  text?: string;
  inProgress?: boolean;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function revalidateCommunications(customerId?: string) {
  revalidatePath("/communications");
  revalidatePath("/customers");
  if (customerId) revalidatePath(`/customers/${customerId}`);
}

export async function composeCommunicationAction(
  _prev: CommunicationsActionState,
  formData: FormData,
): Promise<CommunicationsActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    requireBusinessCapability(access, CAPABILITIES.MANAGE_COMMUNICATIONS);
    const template = readString(formData, "template");
    if (!isCommunicationComposeTemplate(template)) return { error: "Choose a message template." };
    const resolved = resolveComposeSendIntent(
      buildComposeFormFields({
        customerId: readString(formData, "customerId"),
        template,
        channel: readString(formData, "channel"),
        subject: readString(formData, "subject"),
        body: readString(formData, "body"),
        attemptId: readString(formData, "attemptId"),
        relatedType: readString(formData, "relatedType"),
        relatedId: readString(formData, "relatedId"),
      }),
    );
    if (!resolved.ok) return { error: resolved.error };
    const intent = resolved.intent;
    const result = await composeCustomerCommunication(prisma, access, {
      customerId: intent.customerId,
      channel: intent.channel,
      purpose: intent.purpose,
      subject: intent.subject,
      body: intent.body,
      relatedType: isCommunicationRelatedType(intent.relatedType) ? intent.relatedType : null,
      relatedId: intent.relatedId,
      idempotencyKey: composeIdempotencyKey(intent),
      browserBusinessId: readString(formData, "businessId") || null,
    });
    revalidateCommunications(intent.customerId);
    if (!result.ok) {
      return { error: result.failureReason ?? "The message was not sent." };
    }
    if (intent.purpose === "OWNER_FOLLOW_UP") {
      await emitAndProcessBusinessEvent(prisma, {
        businessId: access.businessId,
        type: "OWNER_FOLLOW_UP_CREATED",
        subjectType: "CUSTOMER",
        subjectId: intent.customerId,
        payload: { customerId: intent.customerId, communicationId: result.communicationId },
        idempotencyKey: `OWNER_FOLLOW_UP_CREATED:${result.communicationId ?? intent.attemptId}`,
      });
    }
    return { message: result.reused ? "That send was already recorded." : "Message recorded." };
  } catch {
    return { error: "You do not have permission to do that." };
  }
}

export async function logMissedCallAction(
  _prev: CommunicationsActionState,
  formData: FormData,
): Promise<CommunicationsActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    requireBusinessCapability(access, CAPABILITIES.MANAGE_COMMUNICATIONS);
    const attemptId = readString(formData, "attemptId");
    if (!isAiAttemptId(attemptId)) return { error: "Retry that call log from the form." };
    const result = await recordMissedOrManualCall(prisma, access, {
      kind: readString(formData, "kind") === "MANUAL_PHONE" ? "MANUAL_PHONE" : "MISSED_CALL",
      customerId: readString(formData, "customerId") || null,
      callerPhone: readString(formData, "callerPhone") || null,
      summary: readString(formData, "summary"),
      callbackNeeded: formData.get("callbackNeeded") === "on",
      requestId: readString(formData, "requestId") || null,
      jobId: readString(formData, "jobId") || null,
      idempotencyKey: attemptId,
      browserBusinessId: readString(formData, "businessId") || null,
    });
    revalidateCommunications(readString(formData, "customerId") || undefined);
    if (!result.ok) return { error: result.failureReason ?? "The call could not be logged." };
    if (result.ok && formData.get("callbackNeeded") === "on" && result.phoneInteractionId) {
      await emitAndProcessBusinessEvent(prisma, {
        businessId: access.businessId,
        type: "OWNER_FOLLOW_UP_CREATED",
        subjectType: "PHONE_INTERACTION",
        subjectId: result.phoneInteractionId,
        payload: {
          customerId: readString(formData, "customerId") || null,
          phoneInteractionId: result.phoneInteractionId,
        },
        idempotencyKey: `OWNER_FOLLOW_UP_CREATED:${result.phoneInteractionId}`,
      });
    }
    return {
      message: result.reused
        ? "That call log was already recorded."
        : result.actionItemId
          ? "Call logged and a callback task was created."
          : "Call logged.",
    };
  } catch {
    return { error: "You do not have permission to do that." };
  }
}

export async function recordInboundCallEventAction(
  _prev: CommunicationsActionState,
  formData: FormData,
): Promise<CommunicationsActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    requireBusinessCapability(access, CAPABILITIES.MANAGE_COMMUNICATIONS);
    const attemptId = readString(formData, "attemptId");
    if (!isAiAttemptId(attemptId)) return { error: "Retry that inbound event from the form." };
    const result = await recordInboundCallEvent(prisma, access, {
      phone: readString(formData, "callerPhone") || null,
      customerId: readString(formData, "customerId") || null,
      summary: readString(formData, "summary") || null,
      idempotencyKey: attemptId,
      browserBusinessId: readString(formData, "businessId") || null,
    });
    revalidatePath("/communications");
    return {
      message: result.event.status === "SKIPPED_NOT_CONNECTED"
        ? result.readiness.voice.reason
        : "Inbound call event recorded.",
    };
  } catch {
    return { error: "You do not have permission to do that." };
  }
}

export async function communicationAssistAction(
  _prev: CommunicationsActionState,
  formData: FormData,
): Promise<CommunicationsActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    requireBusinessCapability(access, CAPABILITIES.MANAGE_COMMUNICATIONS);
    requireBusinessCapability(access, CAPABILITIES.USE_AI_ASSIST);
    const action = readString(formData, "aiAction");
    const customerId = readString(formData, "customerId");
    const attemptId = readString(formData, "attemptId");
    if (!isCommunicationAiAction(action) || !customerId) {
      return { error: "Choose a customer and an AI assist action." };
    }
    if (!isAiAttemptId(attemptId)) return { error: "Retry that request from the form." };
    const result = await runCommunicationAssist(prisma, access, {
      action,
      customerId,
      original: readString(formData, "original") || null,
      context: readString(formData, "context") || null,
      idempotencyKey: `comm-ai:${access.businessId}:${action}:${attemptId}`,
    });
    if (result.status === "PENDING") {
      return { inProgress: true, message: result.message };
    }
    return {
      text: result.output?.text,
      message: result.message,
      error: result.status === "COMPLETED" ? undefined : result.failureReason ?? result.message,
    };
  } catch {
    return { error: "You do not have permission to do that." };
  }
}
