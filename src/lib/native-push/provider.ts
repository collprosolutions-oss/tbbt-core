import { isFakeNativePushAdapterEnabled } from "@/lib/native-push/config";
import { createDisconnectedNativePushProvider } from "@/lib/native-push/disconnected";
import { createFakeNativePushProvider } from "@/lib/native-push/fake";
import type { NativePushProvider } from "@/lib/native-push/types";

let cached: NativePushProvider | null = null;

export function getNativePushProvider(): NativePushProvider {
  if (!cached) {
    cached = isFakeNativePushAdapterEnabled()
      ? createFakeNativePushProvider()
      : createDisconnectedNativePushProvider();
  }
  return cached;
}

export function resetNativePushProvider() {
  cached = null;
}

export function setNativePushProvider(provider: NativePushProvider | null) {
  cached = provider;
}
