import { DISCONNECTED_NATIVE_PUSH_PROVIDER } from "@/lib/native-push/config";
import type {
  NativePushProvider,
  NativePushSendInput,
  NativePushSendResult,
} from "@/lib/native-push/types";

/**
 * Default adapter. Does not talk to Expo, FCM, or APNs and never
 * reports SENT. Used in production and whenever the fake adapter is off.
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
