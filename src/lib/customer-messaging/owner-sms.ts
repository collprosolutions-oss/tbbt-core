/**
 * Internal OWNER SMS. Uses the existing communications provider and the
 * tenant's dedicated operational number as From. Never reads Customer
 * records, never checks customer consent, and never writes
 * CustomerCommunication.
 */
import { isUsableNormalizedPhone, normalizePhone } from "@/lib/customer-identity";
import type {
  CustomerMessageSendResult,
  CustomerMessagingProvider,
  OwnerMessagePurpose,
} from "@/lib/customer-messaging/types";

export type SendOwnerSmsInput = {
  provider: CustomerMessagingProvider;
  businessId: string;
  communicationId: string;
  from: string | null | undefined;
  to: string | null | undefined;
  body: string;
  purpose: OwnerMessagePurpose;
};

export async function sendOwnerSms(input: SendOwnerSmsInput): Promise<CustomerMessageSendResult> {
  if (!input.provider.connected) {
    return { ok: false, status: "NOT_SENT", error: "SMS delivery is not connected." };
  }

  const fromDigits = normalizePhone(input.from);
  if (!isUsableNormalizedPhone(fromDigits)) {
    return { ok: false, status: "NOT_SENT", error: "This business has no assigned SMS number." };
  }

  const toDigits = normalizePhone(input.to);
  if (!isUsableNormalizedPhone(toDigits)) {
    return { ok: false, status: "NOT_SENT", error: "Owner SMS destination is not on file." };
  }

  if (fromDigits === toDigits) {
    return {
      ok: false,
      status: "NOT_SENT",
      error: "Owner SMS destination cannot be the tenant sending number.",
    };
  }

  try {
    return await input.provider.send({
      businessId: input.businessId,
      communicationId: input.communicationId,
      channel: "SMS",
      to: toDigits,
      from: fromDigits,
      body: input.body,
      purpose: input.purpose,
    });
  } catch {
    return { ok: false, status: "FAILED", error: "The messaging provider failed." };
  }
}
