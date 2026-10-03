import {
  isExpoNativePushConfigured,
  isFakeNativePushAdapterEnabled,
} from "@/lib/native-push/config";
import { createDisconnectedNativePushProvider } from "@/lib/native-push/disconnected";
import { createExpoNativePushProvider } from "@/lib/native-push/expo";
import { createFakeNativePushProvider } from "@/lib/native-push/fake";
import type { NativePushProvider } from "@/lib/native-push/types";

let cached: NativePushProvider | null = null;

export function getNativePushProvider(): NativePushProvider {
  if (!cached) {
    if (isFakeNativePushAdapterEnabled()) {
      cached = createFakeNativePushProvider();
    } else if (isExpoNativePushConfigured()) {
      cached = createExpoNativePushProvider();
    } else {
      cached = createDisconnectedNativePushProvider();
    }
  }
  return cached;
}

export function resetNativePushProvider() {
  cached = null;
}

export function setNativePushProvider(provider: NativePushProvider | null) {
  cached = provider;
}
