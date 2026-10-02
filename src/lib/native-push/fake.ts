import { randomUUID } from "node:crypto";
import { FAKE_NATIVE_PUSH_PROVIDER } from "@/lib/native-push/config";
import { nativePushPayloadHasForbiddenFields } from "@/lib/native-push/payload";
import type {
  NativePushProvider,
  NativePushSendInput,
  NativePushSendResult,
} from "@/lib/native-push/types";

export type FakeNativePushSend = NativePushSendInput & {
  sentAt: Date;
};

export type FakeNativePushProvider = NativePushProvider & {
  sent: FakeNativePushSend[];
  sendCalls: number;
  failNext: boolean;
  throwNext: boolean;
  failAlways: boolean;
  sendDelayMs: number;
  setFailNext(value: boolean): void;
  setThrowNext(value: boolean): void;
  setFailAlways(value: boolean): void;
  setSendDelayMs(ms: number): void;
};

export function createFakeNativePushProvider(): FakeNativePushProvider {
  const sent: FakeNativePushSend[] = [];

  const provider: FakeNativePushProvider = {
    id: FAKE_NATIVE_PUSH_PROVIDER,
    connected: true,
    sent,
    sendCalls: 0,
    failNext: false,
    throwNext: false,
    failAlways: false,
    sendDelayMs: 0,
    setFailNext(value) {
      provider.failNext = value;
    },
    setThrowNext(value) {
      provider.throwNext = value;
    },
    setFailAlways(value) {
      provider.failAlways = value;
    },
    setSendDelayMs(ms) {
      provider.sendDelayMs = ms;
    },
    async send(input: NativePushSendInput): Promise<NativePushSendResult> {
      provider.sendCalls += 1;
      if (provider.sendDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, provider.sendDelayMs));
      }
      if (nativePushPayloadHasForbiddenFields(input.payload)) {
        return {
          ok: false,
          status: "FAILED",
          error: "Fake push provider refused a payload with forbidden fields.",
        };
      }
      if (provider.throwNext) {
        provider.throwNext = false;
        throw new Error("Fake push provider threw.");
      }
      if (provider.failAlways || provider.failNext) {
        provider.failNext = false;
        return { ok: false, status: "FAILED", error: "Fake push provider rejected the alert." };
      }
      sent.push({ ...input, sentAt: new Date() });
      return {
        ok: true,
        status: "SENT",
        providerMessageId: `fake_push_${randomUUID()}`,
      };
    },
  };

  return provider;
}
