/**
 * Trusted Vercel deployment hostnames (platform-assigned *.vercel.app).
 * Used for Preview-safe navigation and for getAppUrl()'s preview fallback.
 * Never treats an arbitrary Host header / origin as trusted.
 */
const VERCEL_APP_HOST =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.vercel\.app$/i;

export function firstHeaderHost(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = value.split(",")[0]!.trim().toLowerCase();
  if (!raw || raw.includes("/") || raw.includes("@")) {
    return null;
  }
  const host = raw.split(":")[0]!.trim();
  return host || null;
}

export function isTrustedVercelAppHost(value: string | null | undefined): boolean {
  const host = firstHeaderHost(value);
  return Boolean(host && VERCEL_APP_HOST.test(host));
}
