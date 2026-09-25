/**
 * Public host → Business resolution boundary.
 *
 * Verified custom domains are the only future non-CollPro hostname
 * mapping. UNVERIFIED bindings never authorize. This PR does not
 * provision DNS or mark a hostname verified.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { COLLPRO_RENO_SLUGS, DEFAULT_PUBLIC_BUSINESS_SLUG } from "@/lib/public-site";
import {
  isCollProPublicHost,
  isTbbtMarketingHost,
  shouldServeTbbtMarketingHome,
  TBBT_MARKETING_CANONICAL_ORIGIN,
} from "@/lib/tbbt-marketing-host";
import { getAppUrl } from "@/lib/mail";
import { getTenantAppOrigin } from "@/lib/tenant-app-url";
import { firstHeaderHost } from "@/lib/vercel-app-host";

type Db = PrismaClient | Prisma.TransactionClient;

export type ResolvedPublicHost =
  | { kind: "marketing" }
  | { kind: "collpro"; slug: string }
  | { kind: "tenant"; slug: string; businessId: string }
  | { kind: "unverified" }
  | { kind: "unknown" };

function normalizeHostname(host: string | null | undefined) {
  return (host ?? "").trim().toLowerCase().replace(/:\d+$/, "");
}

function httpsOriginForHostname(hostname: string) {
  return `https://${hostname}`;
}

export function isLocalPreviewDefaultHost(host: string | null | undefined) {
  const hostname = firstHeaderHost(host) || normalizeHostname(host);
  if (!hostname) return true;
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  ) {
    return true;
  }
  if (hostname.endsWith(".vercel.app")) return true;
  const appHost = firstHeaderHost(getAppUrl() ?? "");
  return Boolean(appHost && hostname === appHost);
}

export async function resolvePublicHost(
  db: Db,
  host: string | null | undefined,
): Promise<ResolvedPublicHost> {
  const hostname = normalizeHostname(host);
  if (!hostname) return { kind: "unknown" };
  if (shouldServeTbbtMarketingHome(hostname) || isTbbtMarketingHost(hostname)) {
    return { kind: "marketing" };
  }
  if (isCollProPublicHost(hostname)) {
    return { kind: "collpro", slug: COLLPRO_RENO_SLUGS[0] };
  }
  try {
    const binding = await db.websiteHostBinding.findFirst({
      where: { hostname },
      select: { businessId: true, status: true, business: { select: { slug: true } } },
    });
    if (!binding) return { kind: "unknown" };
    if (binding.status !== "VERIFIED") return { kind: "unverified" };
    return {
      kind: "tenant",
      slug: binding.business.slug,
      businessId: binding.businessId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/WebsiteHostBinding|does not exist/i.test(message)) return { kind: "unknown" };
    throw error;
  }
}

export function authorizedPublicOrigin(
  resolved: ResolvedPublicHost,
  host: string | null | undefined,
) {
  const hostname = normalizeHostname(host);
  if (resolved.kind === "tenant" && hostname) return httpsOriginForHostname(hostname);
  if (resolved.kind === "collpro") return getTenantAppOrigin(resolved.slug);
  if (resolved.kind === "marketing") return TBBT_MARKETING_CANONICAL_ORIGIN;
  return null;
}

export async function publicOriginForSlug(
  db: Db,
  slug: string,
  host: string | null | undefined,
) {
  const resolved = await resolvePublicHost(db, host);
  if (resolved.kind === "tenant" && resolved.slug === slug) {
    return authorizedPublicOrigin(resolved, host);
  }
  return null;
}

export type PublicRootResolution =
  | { kind: "marketing" }
  | { kind: "site"; slug: string; origin: string | null }
  | { kind: "unknown" };

export async function resolvePublicRoot(
  db: Db,
  host: string | null | undefined,
): Promise<PublicRootResolution> {
  const resolved = await resolvePublicHost(db, host);
  if (resolved.kind === "marketing") return { kind: "marketing" };
  if (resolved.kind === "tenant") {
    return {
      kind: "site",
      slug: resolved.slug,
      origin: authorizedPublicOrigin(resolved, host),
    };
  }
  if (resolved.kind === "collpro") {
    return {
      kind: "site",
      slug: resolved.slug,
      origin: authorizedPublicOrigin(resolved, host),
    };
  }
  if (resolved.kind === "unverified") return { kind: "unknown" };
  if (isLocalPreviewDefaultHost(host)) {
    return {
      kind: "site",
      slug: DEFAULT_PUBLIC_BUSINESS_SLUG,
      origin: getAppUrl(),
    };
  }
  return { kind: "unknown" };
}
