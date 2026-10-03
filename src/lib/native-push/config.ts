/**
 * Native field push is provider-neutral. Development and scripts use the
 * fake adapter. Expo Push is the connected provider when EXPO_ACCESS_TOKEN
 * is set. Vercel production cannot enable the fake adapter. Missing
 * credentials stay disconnected — TBBT never invents a delivery.
 */
export const DISCONNECTED_NATIVE_PUSH_PROVIDER = "disconnected";
export const FAKE_NATIVE_PUSH_PROVIDER = "fake";
export const EXPO_NATIVE_PUSH_PROVIDER = "expo";
export const NATIVE_PUSH_MAX_ATTEMPTS = 3;
export const NATIVE_PUSH_PENDING_STALE_MS = 30_000;
/** Well below the stale PENDING reclaim window so a hung send fails first. */
export const NATIVE_PUSH_SEND_TIMEOUT_MS = 5_000;
export const NATIVE_PUSH_TEST_FLUSH_ENV = "TBBT_NATIVE_PUSH_TEST_FLUSH";

let pendingStaleMs = NATIVE_PUSH_PENDING_STALE_MS;

export function getNativePushPendingStaleMs() {
  return pendingStaleMs;
}

export function setNativePushPendingStaleMs(ms: number | null) {
  pendingStaleMs = ms == null ? NATIVE_PUSH_PENDING_STALE_MS : ms;
}

export function isFakeNativePushAdapterEnabled() {
  if (process.env.VERCEL_ENV === "production") {
    return false;
  }
  return process.env.TBBT_NATIVE_PUSH_ADAPTER === "fake";
}

export function getExpoAccessToken(): string | null {
  const value = process.env.EXPO_ACCESS_TOKEN?.trim();
  return value || null;
}

export function isExpoNativePushConfigured() {
  return getExpoAccessToken() !== null;
}

export function isNativePushConfigured() {
  return isFakeNativePushAdapterEnabled() || isExpoNativePushConfigured();
}
