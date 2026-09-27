const DEFAULT_API_URL = "http://localhost:43217";

export function resolveApiBaseUrl(value = process.env.EXPO_PUBLIC_TBBT_API_URL) {
  const trimmed = value?.trim().replace(/\/$/, "") ?? "";
  return trimmed || DEFAULT_API_URL;
}

export function nativeApiUrl(path: string, baseUrl = resolveApiBaseUrl()) {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${baseUrl}${suffix}`;
}
