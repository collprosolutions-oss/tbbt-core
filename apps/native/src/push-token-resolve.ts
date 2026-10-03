export const NATIVE_PUSH_PERMISSION_DENIED =
  "Job alerts need notification permission on this device.";
export const NATIVE_PUSH_TOKEN_UNAVAILABLE =
  "Job alerts need an Expo push token from this device.";

export const EXPO_PUSH_TOKEN_PATTERN = /^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/;

export type NativePushDeviceTokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: "permission-denied" | "token-unavailable"; error: string };

export function isExpoPushToken(token: string) {
  return EXPO_PUSH_TOKEN_PATTERN.test(token.trim());
}

/**
 * Production opt-in never invents a random device token. Alerts stay
 * off/unavailable until permission is granted and a real Expo token exists.
 */
export function resolveNativePushOptInToken(input: {
  permissionGranted: boolean;
  expoToken: string | null | undefined;
  storedToken?: string | null;
  requirePermission?: boolean;
}): NativePushDeviceTokenResult {
  if (input.requirePermission && !input.permissionGranted) {
    return {
      ok: false,
      reason: "permission-denied",
      error: NATIVE_PUSH_PERMISSION_DENIED,
    };
  }
  const expo = typeof input.expoToken === "string" ? input.expoToken.trim() : "";
  if (isExpoPushToken(expo)) {
    return { ok: true, token: expo };
  }
  const stored = typeof input.storedToken === "string" ? input.storedToken.trim() : "";
  if (isExpoPushToken(stored)) {
    return { ok: true, token: stored };
  }
  return {
    ok: false,
    reason: "token-unavailable",
    error: NATIVE_PUSH_TOKEN_UNAVAILABLE,
  };
}
