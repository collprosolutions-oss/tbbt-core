/**
 * Native field push is provider-neutral. Development and scripts use the
 * fake adapter. Vercel production cannot enable the fake adapter and
 * stays disconnected — this slice never talks to Expo, FCM, or APNs.
 */
export const DISCONNECTED_NATIVE_PUSH_PROVIDER = "disconnected";
export const FAKE_NATIVE_PUSH_PROVIDER = "fake";

export function isFakeNativePushAdapterEnabled() {
  if (process.env.VERCEL_ENV === "production") {
    return false;
  }
  return process.env.TBBT_NATIVE_PUSH_ADAPTER === "fake";
}

export function isNativePushConfigured() {
  return isFakeNativePushAdapterEnabled();
}
