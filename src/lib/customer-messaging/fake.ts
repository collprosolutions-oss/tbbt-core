import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { FAKE_CUSTOMER_MESSAGING_PROVIDER } from "@/lib/customer-messaging/config";
import type {
  CustomerMessageDeliveryUpdate,
  CustomerMessageSendInput,
  CustomerMessageSendResult,
  CustomerMessagingProvider,
} from "@/lib/customer-messaging/types";

export type FakeCustomerMessagingProvider = CustomerMessagingProvider & {
  sent: CustomerMessageSendInput[];
  failNext: boolean;
  throwNext: boolean;
  timeoutNext: boolean;
  errorCodeNext: string | null;
  setFailNext(value: boolean): void;
  setThrowNext(value: boolean): void;
  setTimeoutNext(value: boolean): void;
  setErrorCodeNext(value: string | null): void;
};

function validSignature(payload: string, signature: string | null, secret: string) {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createFakeCustomerMessagingProvider(
  webhookSecret: string | null = process.env.TBBT_CUSTOMER_MESSAGING_WEBHOOK_SECRET?.trim() || null,
): FakeCustomerMessagingProvider {
  const sent: CustomerMessageSendInput[] = [];

  const provider: FakeCustomerMessagingProvider = {
    id: FAKE_CUSTOMER_MESSAGING_PROVIDER,
    connected: true,
    sent,
    failNext: false,
    throwNext: false,
    timeoutNext: false,
    errorCodeNext: null,
    setFailNext(value) {
      provider.failNext = value;
    },
    setThrowNext(value) {
      provider.throwNext = value;
    },
    setTimeoutNext(value) {
      provider.timeoutNext = value;
    },
    setErrorCodeNext(value) {
      provider.errorCodeNext = value;
    },
    async send(input: CustomerMessageSendInput): Promise<CustomerMessageSendResult> {
      if (provider.throwNext) {
        provider.throwNext = false;
        throw new Error("Fake SMS provider threw.");
      }
      if (provider.timeoutNext) {
        provider.timeoutNext = false;
        const error = new Error("The messaging provider timed out.");
        error.name = "AbortError";
        throw error;
      }
      if (provider.errorCodeNext) {
        const errorCode = provider.errorCodeNext;
        provider.errorCodeNext = null;
        return {
          ok: false,
          status: "FAILED",
          error: `Fake SMS provider rejected the message (${errorCode}).`,
          errorCode,
        };
      }
      if (provider.failNext) {
        provider.failNext = false;
        return { ok: false, status: "FAILED", error: "Fake SMS provider rejected the message." };
      }
      sent.push(input);
      return {
        ok: true,
        status: "ACCEPTED",
        providerMessageId: `fake_sms_${randomUUID()}`,
        providerMetadata: { adapter: FAKE_CUSTOMER_MESSAGING_PROVIDER },
      };
    },
    verifyDeliveryCallback(payload: string, signature: string | null) {
      if (!webhookSecret || !validSignature(payload, signature, webhookSecret)) {
        return null;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return null;
      }
      if (!parsed || typeof parsed !== "object") return null;
      const record = parsed as Record<string, unknown>;
      if (typeof record.providerMessageId !== "string" || !record.providerMessageId) {
        return null;
      }
      if (record.status !== "SENT" && record.status !== "DELIVERED" && record.status !== "FAILED") {
        return null;
      }
      const update: CustomerMessageDeliveryUpdate = {
        provider: FAKE_CUSTOMER_MESSAGING_PROVIDER,
        providerMessageId: record.providerMessageId,
        status: record.status,
        failureReason: typeof record.failureReason === "string" ? record.failureReason : undefined,
        claimedBusinessId:
          typeof record.businessId === "string" ? record.businessId : null,
      };
      return update;
    },
  };

  return provider;
}
