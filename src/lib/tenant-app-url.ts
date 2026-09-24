/**
 * Tenant-aware public/app origins.
 *
 * CollPro remains on the CollPro production host. Other SaaS tenants must
 * never receive www.collproreno.com branding or hostnames in customer
 * links. Local / preview NEXT_PUBLIC_APP_URL is used for every slug.
 */
import { getAppUrl, PRODUCTION_APP_ORIGIN } from "@/lib/mail";
import {
  isCollProPublicHost,
  TBBT_MARKETING_CANONICAL_ORIGIN,
} from "@/lib/tbbt-marketing-host";
import { firstHeaderHost } from "@/lib/vercel-app-host";

const COLLPRO_TENANT_SLUGS = [
  "collpro-reno",
  "collpro-reno-handyman-services",
] as const;

function isCollProTenantSlug(slug: string | null | undefined): boolean {
  return Boolean(
    slug && (COLLPRO_TENANT_SLUGS as readonly string[]).includes(slug.trim().toLowerCase()),
  );
}

export const TBBT_APP_CANONICAL_ORIGIN = TBBT_MARKETING_CANONICAL_ORIGIN;
export const COLLPRO_PRODUCTION_ORIGIN = PRODUCTION_APP_ORIGIN;

function originHost(origin: string | null | undefined): string | null {
  if (!origin) return null;
  try {
    return firstHeaderHost(new URL(origin).host);
  } catch {
    return firstHeaderHost(origin);
  }
}

/**
 * Absolute origin used for this tenant's customer-facing TBBT links
 * (/hire, /e, /p, /r). Never uses a CollPro hostname for a non-CollPro slug.
 */
export function getTenantAppOrigin(slug: string | null | undefined): string | null {
  const configured = getAppUrl();
  const collProTenant = isCollProTenantSlug(slug);

  if (configured) {
    const host = originHost(configured);
    if (host && isCollProPublicHost(host) && !collProTenant) {
      return TBBT_APP_CANONICAL_ORIGIN;
    }
    return configured;
  }

  if (process.env.VERCEL_ENV === "production") {
    return collProTenant ? COLLPRO_PRODUCTION_ORIGIN : TBBT_APP_CANONICAL_ORIGIN;
  }

  return null;
}

export function tenantAbsoluteUrl(
  slug: string | null | undefined,
  path: string,
): string | null {
  const origin = getTenantAppOrigin(slug);
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (!origin) return normalized;
  return `${origin}${normalized}`;
}

export function tenantPublicSiteUrl(slug: string): string {
  const origin = getTenantAppOrigin(slug);
  if (isCollProTenantSlug(slug)) {
    return origin ? `${origin}/` : "/";
  }
  return origin ? `${origin}/hire/${slug}` : `/hire/${slug}`;
}

export function tenantEstimateUrl(slug: string, publicToken: string): string | null {
  return tenantAbsoluteUrl(slug, `/e/${publicToken}`);
}

export function tenantProjectUrl(slug: string, projectToken: string): string | null {
  return tenantAbsoluteUrl(slug, `/p/${projectToken}`);
}

export function tenantInvoiceUrl(slug: string, projectToken: string): string | null {
  return tenantAbsoluteUrl(slug, `/p/${projectToken}/invoice`);
}
