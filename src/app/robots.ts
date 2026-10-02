import type { MetadataRoute } from "next";
import { APP_NAV } from "@/lib/nav";
import { COLLPRO_RENO_SLUGS } from "@/lib/public-site";
import { readRequestHost } from "@/lib/request-host";
import {
  isCollProPublicHost,
  isTbbtMarketingIndexableHost,
  TBBT_MARKETING_CANONICAL_ORIGIN,
  TBBT_MARKETING_PUBLIC_PATHS,
} from "@/lib/tbbt-marketing-host";
import { authorizedPublicOrigin } from "@/lib/website-engine/hosts";

const APP_DISALLOW = [
  ...APP_NAV.map((item) => item.href),
  "/setup",
  "/field",
  "/access-restricted",
  "/api/",
  "/calendar/feed/",
];

export default async function robots(): Promise<MetadataRoute.Robots> {
  const host = await readRequestHost();
  if (isTbbtMarketingIndexableHost(host)) {
    return {
      rules: {
        userAgent: "*",
        allow: [
          "/",
          ...TBBT_MARKETING_PUBLIC_PATHS.filter((path) => path !== "/home"),
        ],
        disallow: ["/home", ...APP_DISALLOW],
      },
      sitemap: `${TBBT_MARKETING_CANONICAL_ORIGIN}/sitemap.xml`,
      host: "www.tbbtool.com",
    };
  }

  const origin = isCollProPublicHost(host)
    ? authorizedPublicOrigin({ kind: "collpro", slug: COLLPRO_RENO_SLUGS[0] }, host)
    : authorizedPublicOrigin({ kind: "unknown" }, host);
  const sitemapOrigin = origin?.replace(/\/$/, "");
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/hire/", "/r/", "/e/", "/p/"],
      disallow: [...TBBT_MARKETING_PUBLIC_PATHS, ...APP_DISALLOW],
    },
    sitemap: sitemapOrigin ? `${sitemapOrigin}/sitemap.xml` : undefined,
  };
}
