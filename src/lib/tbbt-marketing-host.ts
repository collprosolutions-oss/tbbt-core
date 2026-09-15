/**
 * Hostname routing for the TBBT corporate marketing site vs CollPro's
 * public tenant website.
 *
 * Intended production split:
 *   tbbtools.com / www.tbbtools.com  → TBBT marketing homepage at `/`
 *   collproreno.com / www.collproreno.com → CollPro public website at `/`
 *
 * Marketing inner routes (/features, /trades, /pricing, /about,
 * /resources, /privacy, /terms, /contact, and preview-only /home) are
 * always rendered so local and Vercel Preview can review them without
 * the corporate domain. Those hosts must noindex that copy; canonical
 * URLs always point at https://tbbtools.com.
 *
 * Local `/` stays CollPro unless TBBT_MARKETING_SITE=1 or the Host is
 * listed in TBBT_MARKETING_HOST. CollPro production hosts never serve
 * the TBBT homepage, even if those flags are set.
 *
 * This module is request-header pure — it does not import next/headers
 * so Node check scripts can import it.
 */
import { firstHeaderHost } from "@/lib/vercel-app-host";

export const TBBT_MARKETING_CANONICAL_HOST = "tbbtools.com";
export const TBBT_MARKETING_CANONICAL_ORIGIN = "https://tbbtools.com";

export const TBBT_MARKETING_PRODUCTION_HOSTS = [
  "tbbtools.com",
  "www.tbbtools.com",
] as const;

export const COLLPRO_PUBLIC_HOSTS = [
  "collproreno.com",
  "www.collproreno.com",
] as const;

/** Inner TBBT marketing routes. `/` is host-switched and is not in this list. */
export const TBBT_MARKETING_PUBLIC_PATHS = [
  "/home",
  "/features",
  "/trades",
  "/pricing",
  "/about",
  "/resources",
  "/privacy",
  "/terms",
  "/contact",
] as const;

export type TbbtMarketingPublicPath =
  (typeof TBBT_MARKETING_PUBLIC_PATHS)[number];

export function isTbbtMarketingPublicPath(
  pathname: string,
): pathname is TbbtMarketingPublicPath {
  return (TBBT_MARKETING_PUBLIC_PATHS as readonly string[]).includes(pathname);
}

function parseHostList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const hosts: string[] = [];
  for (const part of raw.split(",")) {
    const host = firstHeaderHost(part.trim());
    if (host) hosts.push(host);
  }
  return hosts;
}

export function extraTbbtMarketingHosts(
  raw: string | null | undefined = process.env.TBBT_MARKETING_HOST,
): string[] {
  return parseHostList(raw);
}

export function isCollProPublicHost(host: string | null | undefined): boolean {
  const normalized = firstHeaderHost(host);
  return Boolean(
    normalized &&
      (COLLPRO_PUBLIC_HOSTS as readonly string[]).includes(normalized),
  );
}

export function isTbbtMarketingHost(
  host: string | null | undefined,
  extraHostsRaw: string | null | undefined = process.env.TBBT_MARKETING_HOST,
): boolean {
  const normalized = firstHeaderHost(host);
  if (!normalized) return false;
  if ((TBBT_MARKETING_PRODUCTION_HOSTS as readonly string[]).includes(normalized)) {
    return true;
  }
  return extraTbbtMarketingHosts(extraHostsRaw).includes(normalized);
}

export function isTbbtMarketingIndexableHost(
  host: string | null | undefined,
): boolean {
  const normalized = firstHeaderHost(host);
  return Boolean(
    normalized &&
      (TBBT_MARKETING_PRODUCTION_HOSTS as readonly string[]).includes(
        normalized,
      ),
  );
}

function isEnabledFlag(value: string | null | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/**
 * Whether `/` should render the TBBT marketing homepage instead of CollPro.
 * CollPro production hosts always keep the tenant website.
 */
export function shouldServeTbbtMarketingHome(
  host: string | null | undefined,
  options?: {
    marketingSite?: string | null;
    extraHosts?: string | null;
  },
): boolean {
  if (isCollProPublicHost(host)) return false;
  const extra = options && "extraHosts" in options
    ? options.extraHosts
    : process.env.TBBT_MARKETING_HOST;
  if (isTbbtMarketingHost(host, extra)) return true;
  const flag = options && "marketingSite" in options
    ? options.marketingSite
    : process.env.TBBT_MARKETING_SITE;
  return isEnabledFlag(flag);
}

export function tbbtCanonicalPath(pathname: string): string {
  if (pathname === "/home" || pathname === "") return "/";
  return pathname.startsWith("/") ? pathname : `/${pathname}`;
}

export function tbbtCanonicalUrl(pathname: string): string {
  const path = tbbtCanonicalPath(pathname);
  if (path === "/") return `${TBBT_MARKETING_CANONICAL_ORIGIN}/`;
  return `${TBBT_MARKETING_CANONICAL_ORIGIN}${path}`;
}

export function tbbtMarketingHomeHref(
  host: string | null | undefined,
  options?: {
    marketingSite?: string | null;
    extraHosts?: string | null;
  },
): string {
  return shouldServeTbbtMarketingHome(host, options) ? "/" : "/home";
}

export function tbbtMarketingRobots(
  host: string | null | undefined,
): { index: boolean; follow: boolean } {
  if (isTbbtMarketingIndexableHost(host)) {
    return { index: true, follow: true };
  }
  return { index: false, follow: false };
}
