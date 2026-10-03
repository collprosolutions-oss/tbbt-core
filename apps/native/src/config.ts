import { rewriteAndroidLoopbackHost } from "./android";

const DEFAULT_API_URL = "http://localhost:43217";

let runtimeOs = process.env.EXPO_OS ?? "";

export function setNativeRuntimeOs(os: string) {
  runtimeOs = os;
}

export function nativeRuntimeOs() {
  return runtimeOs;
}

export function resolveApiBaseUrl(
  value = process.env.EXPO_PUBLIC_TBBT_API_URL,
  os = runtimeOs,
) {
  const trimmed = value?.trim().replace(/\/$/, "") ?? "";
  return rewriteAndroidLoopbackHost(trimmed || DEFAULT_API_URL, os);
}

export function nativeApiUrl(path: string, baseUrl = resolveApiBaseUrl()) {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${baseUrl}${suffix}`;
}
