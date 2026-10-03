import { DISCONNECTED_NATIVE_PUSH_PROVIDER } from "@/lib/native-push/config";
import type {
  NativePushProvider,
  NativePushSendInput,
  NativePushSendResult,
} from "@/lib/native-push/types";

/**
 * Default adapter when Expo credentials are missing and the fake adapter
 * is off. Does not talk to Expo, FCM, or APNs and never reports SENT.
 */
export function createDisconnectedNativePushProvider(): NativePushProvider {
  return {
    id: DISCONNECTED_NATIVE_PUSH_PROVIDER,
    connected: false,
    async send(_input: NativePushSendInput): Promise<NativePushSendResult> {
      return {
        ok: false,
        status: "FAILED",
        error: "Native push delivery is not connected.",
      };
    },
  };
}
