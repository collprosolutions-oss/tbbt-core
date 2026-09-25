import { isAiAttemptId } from "@/lib/ai/types";
import {
  isCommunicationChannel,
  isCommunicationComposeTemplate,
  type CommunicationComposeTemplate,
} from "@/lib/communications/types";
import {
  productCapabilityForTemplate,
  purposeForComposeTemplate,
} from "@/lib/communications/entitlements";
import type { CustomerMessagePurpose } from "@/lib/customer-messaging/types";
import type { ProductCapabilityCode } from "@/lib/product-catalog/codes";

export type ComposeFormFields = {
  customerId: string;
  template: CommunicationComposeTemplate;
  channel: string;
  subject: string;
  body: string;
  attemptId: string;
  relatedType: string;
  relatedId: string;
};

export type ComposeSendIntent = {
  customerId: string;
  template: CommunicationComposeTemplate;
  purpose: CustomerMessagePurpose;
  channel: string;
  subject: string;
  body: string;
  attemptId: string;
  relatedType: string | null;
  relatedId: string | null;
  requiredCapability: ProductCapabilityCode;
};

export function buildComposeFormFields(input: {
  customerId: string;
  template: CommunicationComposeTemplate;
  channel: string;
  subject: string;
  body: string;
  attemptId: string;
  relatedType?: string | null;
  relatedId?: string | null;
}): ComposeFormFields {
  return {
    customerId: input.customerId.trim(),
    template: input.template,
    channel: input.channel,
    subject: input.subject,
    body: input.body,
    attemptId: input.attemptId.trim(),
    relatedType: input.relatedType?.trim() ?? "",
    relatedId: input.relatedId?.trim() ?? "",
  };
}

export function resolveComposeSendIntent(
  fields: ComposeFormFields,
): { ok: true; intent: ComposeSendIntent } | { ok: false; error: string } {
  if (!fields.customerId) return { ok: false, error: "Choose a customer." };
  if (!isCommunicationComposeTemplate(fields.template)) {
    return { ok: false, error: "Choose a message template." };
  }
  if (!isCommunicationChannel(fields.channel)) {
    return { ok: false, error: "Choose a communication channel." };
  }
  if (!isAiAttemptId(fields.attemptId)) {
    return { ok: false, error: "Retry that send from the form." };
  }
  if (!fields.body.trim()) return { ok: false, error: "Message and idempotency key are required." };

  const purpose = purposeForComposeTemplate(fields.template);
  return {
    ok: true,
    intent: {
      customerId: fields.customerId,
      template: fields.template,
      purpose,
      channel: fields.channel,
      subject: fields.subject,
      body: fields.body,
      attemptId: fields.attemptId,
      relatedType: fields.relatedType || null,
      relatedId: fields.relatedId || null,
      requiredCapability: productCapabilityForTemplate(fields.template),
    },
  };
}

export function composeIdempotencyKey(intent: ComposeSendIntent) {
  return `comm:${intent.channel}:${intent.purpose}:${intent.customerId}:${intent.attemptId}`;
}

/**
 * One logical send retry keeps the same attempt id.
 * After a confirmed success, the next intentional send gets a new key.
 * Call this with the action result, never with stale pre-dispatch state.
 */
export function shouldRotateCommunicationSendAttemptId(result: {
  error?: string;
  message?: string;
  inProgress?: boolean;
}) {
  if (result.inProgress) return false;
  if (result.error) return false;
  return Boolean(result.message);
}

export function shouldRotateCommunicationAiAttemptId(result: {
  inProgress?: boolean;
  text?: string;
  error?: string;
}) {
  if (result.inProgress) return false;
  return Boolean(result.text || result.error);
}

export function nextCommunicationAttemptId(
  current: string,
  result: { error?: string; message?: string; text?: string; inProgress?: boolean },
  rotate: (state: typeof result) => boolean,
  createId: () => string,
) {
  return rotate(result) ? createId() : current;
}
