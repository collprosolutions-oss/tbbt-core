/**
 * Signed-in hosts for Meta and Google marketing consent.
 *
 * Session cookies are host-only. The browser must start consent and
 * finish destination selection on the same production origin. Only the
 * two canonical www origins are allowed. Apex hosts, preview
 * deployments, forwarded headers, userinfo, ports, and lookalikes are
 * not signed-in hosts and are rejected before any OAuth state is used.
 *
 * This module does not read request headers. Callers pass the Host
 * value (or an origin built only from that Host).
 */
import {
  GOOGLE_MARKETING_CONNECTION_CALLBACK_PATH,
  META_MARKETING_CONNECTION_CALLBACK_PATH,
} from "@/lib/marketing-connections/callback-path";

export const MARKETING_CONNECTION_PRODUCTION_ORIGINS = [
  "https://www.collproreno.com",
  "https://www.tbbtool.com",
] as const;

export type MarketingConnectionProductionOrigin =
  (typeof MARKETING_CONNECTION_PRODUCTION_ORIGINS)[number];

const ORIGIN_BY_HOST: Record<string, MarketingConnectionProductionOrigin> = {
  "www.collproreno.com": "https://www.collproreno.com",
  "www.tbbtool.com": "https://www.tbbtool.com",
};

export const MARKETING_CONNECTION_HOST_REJECTED_MESSAGE = "That connection host is not allowed.";

function exactHost(value: string): string | null {
  if (/[\s@\\?#%]/.test(value)) return null;
  if (value.includes("://")) {
    const schemeSplit = value.indexOf("://");
    const scheme = value.slice(0, schemeSplit).toLowerCase();
    if (scheme !== "https") return null;
    const remainder = value.slice(schemeSplit + 3);
    const slash = remainder.indexOf("/");
    const authority = (slash === -1 ? remainder : remainder.slice(0, slash)).toLowerCase();
    const path = slash === -1 ? "" : remainder.slice(slash);
    if (!authority || authority.includes(":") || authority.endsWith(".")) return null;
    if (path !== "" && path !== "/") return null;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }
    if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return null;
    if (parsed.protocol !== "https:") return null;
    if (parsed.hostname.toLowerCase() !== authority) return null;
    return ORIGIN_BY_HOST[authority] ? authority : null;
  }
  if (value.includes(":") || value.includes("/")) return null;
  const host = value.toLowerCase();
  if (!host || host.endsWith(".")) return null;
  return ORIGIN_BY_HOST[host] ? host : null;
}

/** Exact www origin, or null. Never canonicalizes apex, ports, or lookalikes. */
export function marketingConnectionProductionOrigin(
  value: string | null | undefined,
): MarketingConnectionProductionOrigin | null {
  if (typeof value !== "string") return null;
  if (!value || value !== value.trim()) return null;
  const host = exactHost(value);
  if (!host) return null;
  return ORIGIN_BY_HOST[host] ?? null;
}

export function marketingConnectionCallbackUrl(
  group: "META" | "GOOGLE",
  value: string | null | undefined,
): string | null {
  const origin = marketingConnectionProductionOrigin(value);
  if (!origin) return null;
  const path =
    group === "GOOGLE" ? GOOGLE_MARKETING_CONNECTION_CALLBACK_PATH : META_MARKETING_CONNECTION_CALLBACK_PATH;
  return `${origin}${path}`;
}

/** True only for the four registered production callback strings. */
export function isExactMarketingConnectionCallbackUrl(
  group: "META" | "GOOGLE",
  value: string | null | undefined,
): boolean {
  if (typeof value !== "string") return false;
  const path =
    group === "GOOGLE" ? GOOGLE_MARKETING_CONNECTION_CALLBACK_PATH : META_MARKETING_CONNECTION_CALLBACK_PATH;
  return MARKETING_CONNECTION_PRODUCTION_ORIGINS.some((origin) => value === `${origin}${path}`);
}
