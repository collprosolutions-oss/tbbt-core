import type { MetadataRoute } from "next";
import { readRequestHost } from "@/lib/request-host";
import {
  isTbbtMarketingIndexableHost,
  tbbtCanonicalUrl,
  TBBT_MARKETING_PUBLIC_PATHS,
} from "@/lib/tbbt-marketing-host";
import { prisma } from "@/lib/prisma";
import { authorizedPublicOrigin, resolvePublicHost } from "@/lib/website-engine/hosts";
import { loadPublicWebsiteView } from "@/lib/website-engine/public";
import { publishedSitemapPaths } from "@/lib/website-engine/seo";
import { publicCanonicalUrl } from "@/lib/public-site-seo";
import { COLLPRO_RENO_SLUGS, publicHomePath, publicServicesPath, publicAboutPath, publicRequestPath } from "@/lib/public-site";

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

  const resolved = await resolvePublicHost(prisma, host);
  const slug =
    resolved.kind === "collpro"
      ? COLLPRO_RENO_SLUGS[0]
      : resolved.kind === "tenant"
        ? resolved.slug
        : null;
  if (!slug) return [];

  const view = await loadPublicWebsiteView(slug);
  if (!view) return [];
  const origin = authorizedPublicOrigin(resolved, host);
  const paths = view.snapshot
    ? publishedSitemapPaths(view.snapshot)
    : [
        publicHomePath(view.site.business.slug),
        publicServicesPath(view.site.business.slug),
        publicAboutPath(view.site.business.slug),
        publicRequestPath(view.site.business.slug),
      ];
  if (resolved.kind === "tenant" && !paths.includes("/")) {
    paths.unshift("/");
  }
  return paths.map((path) => ({
    url: publicCanonicalUrl(view.site.business.slug, path, origin),
    changeFrequency: "weekly" as const,
    priority: path === publicHomePath(view.site.business.slug) || path === "/" ? 1 : 0.6,
  }));
}
