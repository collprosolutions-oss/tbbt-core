import type { MetadataRoute } from "next";
import { readRequestHost } from "@/lib/request-host";
import {
  isTbbtMarketingIndexableHost,
  tbbtCanonicalUrl,
  TBBT_MARKETING_PUBLIC_PATHS,
} from "@/lib/tbbt-marketing-host";
import { prisma } from "@/lib/prisma";
import { authorizedPublicOrigin, isLocalPreviewDefaultHost, resolvePublicHost } from "@/lib/website-engine/hosts";
import { loadPublicWebsiteView } from "@/lib/website-engine/public";
import { absolutePublicSitemapUrl, publishedSitemapPaths } from "@/lib/website-engine/seo";
import { COLLPRO_RENO_SLUGS, publicHomePath, publicIndexableSitemapPaths } from "@/lib/public-site";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function sitemapEntries(
  slug: string,
  paths: string[],
  origin: string | null,
): MetadataRoute.Sitemap {
  return paths.map((path) => ({
    url: absolutePublicSitemapUrl(slug, path, origin),
    changeFrequency: "weekly" as const,
    priority: path === publicHomePath(slug) || path === "/" ? 1 : 0.6,
  }));
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const host = await readRequestHost();
  if (isTbbtMarketingIndexableHost(host)) {
    const paths = ["/", ...TBBT_MARKETING_PUBLIC_PATHS.filter((path) => path !== "/home")];
    return paths.map((path) => ({
      url: tbbtCanonicalUrl(path),
      changeFrequency: path === "/" ? "weekly" : "monthly",
      priority: path === "/" ? 1 : 0.7,
    }));
  }

  try {
    const resolved = await resolvePublicHost(prisma, host);
    const slug =
      resolved.kind === "collpro"
        ? COLLPRO_RENO_SLUGS[0]
        : resolved.kind === "tenant"
          ? resolved.slug
          : isLocalPreviewDefaultHost(host)
            ? COLLPRO_RENO_SLUGS[0]
            : null;
    if (!slug) return [];

    const view = await loadPublicWebsiteView(slug);
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
    const slug = COLLPRO_RENO_SLUGS[0];
    return sitemapEntries(slug, publicIndexableSitemapPaths(slug), authorizedPublicOrigin(
      { kind: "collpro", slug },
      host,
    ));
  }
}
