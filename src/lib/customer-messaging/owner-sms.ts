/**
 * Internal OWNER SMS. Uses the existing communications provider and the
 * tenant's dedicated operational number as From. Never reads Customer
 * records, never checks customer consent, and never writes
 * CustomerCommunication.
 */
import { normalizePhone } from "@/lib/customer-identity";
import type {
  CustomerMessageSendResult,
  CustomerMessagingProvider,
  OwnerMessagePurpose,
} from "@/lib/customer-messaging/types";
import { OWNER_SMS_PROVIDER_TIMEOUT_MS, parseOwnerSmsE164 } from "@/lib/marketing";

export type SendOwnerSmsInput = {
  provider: CustomerMessagingProvider;
  businessId: string;
  communicationId: string;
  from: string | null | undefined;
  to: string | null | undefined;
  body: string;
  purpose: OwnerMessagePurpose;
  timeoutMs?: number;
};

class OwnerSmsTimeoutError extends Error {
  constructor() {
    super("The messaging provider timed out.");
    this.name = "OwnerSmsTimeoutError";
  }
}

function isUsableTenantFrom(digits: string) {
  return digits.length === 10 || (digits.length === 11 && digits.startsWith("1"));
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new OwnerSmsTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function sendOwnerSms(input: SendOwnerSmsInput): Promise<CustomerMessageSendResult> {
  if (!input.provider.connected) {
    return { ok: false, status: "NOT_SENT", error: "SMS delivery is not connected." };
  }

  const fromDigits = normalizePhone(input.from);
  if (!isUsableTenantFrom(fromDigits)) {
    return { ok: false, status: "NOT_SENT", error: "This business has no assigned SMS number." };
  }

  const toE164 = parseOwnerSmsE164(input.to);
  if (!toE164) {
    return { ok: false, status: "NOT_SENT", error: "Owner SMS destination is not on file." };
  }

  if (normalizePhone(fromDigits) === normalizePhone(toE164)) {
    return {
      ok: false,
      status: "NOT_SENT",
      error: "Owner SMS destination cannot be the tenant sending number.",
    };
  }

  try {
    return await withTimeout(
      input.provider.send({
        businessId: input.businessId,
        communicationId: input.communicationId,
        channel: "SMS",
        to: toE164,
        from: fromDigits,
        body: input.body,
        purpose: input.purpose,
      }),
      input.timeoutMs ?? OWNER_SMS_PROVIDER_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof OwnerSmsTimeoutError || (error instanceof Error && error.name === "AbortError")) {
      return { ok: false, status: "FAILED", error: "The messaging provider timed out." };
    }
    return { ok: false, status: "FAILED", error: "The messaging provider failed." };
  }
}
