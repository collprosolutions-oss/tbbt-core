/** Android-only field-app helpers. Keep this file free of react-native so Node proofs can import it. */

export const NATIVE_APP_VERSION = "0.1.0";
export const NATIVE_ANDROID_VERSION_CODE = 1;
export const NATIVE_ANDROID_PACKAGE = "com.tbbt.field";
export const ANDROID_EMULATOR_LOOPBACK_HOST = "10.0.2.2";
export const ANDROID_REFRESH_COLORS = ["#86efac"] as const;
export const ANDROID_REFRESH_BACKGROUND = "#1f2937";

export function nativePushPlatform(os: string): "ios" | "android" | "expo" {
  if (os === "android") return "android";
  if (os === "ios") return "ios";
  return "expo";
}

export function rewriteAndroidLoopbackHost(baseUrl: string, os: string) {
  const trimmed = baseUrl.trim().replace(/\/$/, "");
  if (os !== "android" || !trimmed) return trimmed;
  return trimmed.replace(
    /^(https?:\/\/)(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i,
    `$1${ANDROID_EMULATOR_LOOPBACK_HOST}`,
  );
}

export function nativeScreenPaddingTop(os: string, statusBarHeight?: number | null) {
  if (os === "android") {
    const bar = typeof statusBarHeight === "number" && statusBarHeight > 0 ? statusBarHeight : 24;
    return bar + 16;
  }
  return 64;
}

export function nativeBuildStampLabel(
  version = NATIVE_APP_VERSION,
  versionCode = NATIVE_ANDROID_VERSION_CODE,
) {
  return `TBBT Field ${version} (${versionCode})`;
}

export function readNativePushDeviceTokenFromParts(input: {
  headerToken?: string | null;
  bodyToken?: unknown;
}) {
  const body = typeof input.bodyToken === "string" ? input.bodyToken.trim() : "";
  const header = typeof input.headerToken === "string" ? input.headerToken.trim() : "";
  return body || header;
}
