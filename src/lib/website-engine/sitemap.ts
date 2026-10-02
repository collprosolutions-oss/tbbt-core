/**
 * Public /sitemap.xml entries. Host is resolved first; CollPro fallback
 * is only for the CollPro public or local-preview host. Tenant,
 * unverified, and unknown hosts fail closed to an empty sitemap.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  isCollProPublicHost,
  isTbbtMarketingIndexableHost,
  tbbtCanonicalUrl,
  TBBT_MARKETING_PUBLIC_PATHS,
} from "@/lib/tbbt-marketing-host";
import {
  authorizedPublicOrigin,
  isLocalPreviewDefaultHost,
  resolvePublicHost,
} from "@/lib/website-engine/hosts";
import { loadPublicWebsiteView } from "@/lib/website-engine/public";
import { absolutePublicSitemapUrl, publishedSitemapPaths } from "@/lib/website-engine/seo";
import { COLLPRO_RENO_SLUGS, publicHomePath, publicIndexableSitemapPaths } from "@/lib/public-site";

type Db = PrismaClient | Prisma.TransactionClient;

export type PublicSitemapEntry = {
  url: string;
  changeFrequency: "weekly" | "monthly";
  priority: number;
};

function sitemapEntries(
  slug: string,
  paths: string[],
  origin: string | null,
): PublicSitemapEntry[] {
  return paths.map((path) => ({
    url: absolutePublicSitemapUrl(slug, path, origin),
    changeFrequency: "weekly" as const,
    priority: path === publicHomePath(slug) || path === "/" ? 1 : 0.6,
  }));
}

export function usesCollProSitemapFallback(host: string | null | undefined) {
  return isCollProPublicHost(host) || isLocalPreviewDefaultHost(host);
}

function collproFallbackSitemap(host: string | null | undefined): PublicSitemapEntry[] {
  const slug = COLLPRO_RENO_SLUGS[0];
  return sitemapEntries(
    slug,
    publicIndexableSitemapPaths(slug),
    authorizedPublicOrigin({ kind: "collpro", slug }, host),
  );
}

export async function buildPublicSitemap(
  db: Db,
  host: string | null | undefined,
): Promise<PublicSitemapEntry[]> {
  if (isTbbtMarketingIndexableHost(host)) {
    const paths = ["/", ...TBBT_MARKETING_PUBLIC_PATHS.filter((path) => path !== "/home")];
    return paths.map((path) => ({
      url: tbbtCanonicalUrl(path),
      changeFrequency: path === "/" ? "weekly" : "monthly",
      priority: path === "/" ? 1 : 0.7,
    }));
  }

  try {
    const resolved = await resolvePublicHost(db, host);
    const slug =
      resolved.kind === "collpro"
        ? COLLPRO_RENO_SLUGS[0]
        : resolved.kind === "tenant"
          ? resolved.slug
          : isLocalPreviewDefaultHost(host)
            ? COLLPRO_RENO_SLUGS[0]
            : null;
    if (!slug) return [];

    const view = await loadPublicWebsiteView(slug, db);
    if (!view) return [];
    const origin = authorizedPublicOrigin(resolved, host);
    const paths = view.snapshot
      ? publishedSitemapPaths(view.snapshot)
      : publicIndexableSitemapPaths(view.site.business.slug);
    if (resolved.kind === "tenant" && !paths.includes("/")) {
      paths.unshift("/");
    }
    return sitemapEntries(view.site.business.slug, paths, origin);
  } catch {
    if (usesCollProSitemapFallback(host)) {
      return collproFallbackSitemap(host);
    }
    return [];
  }
}
