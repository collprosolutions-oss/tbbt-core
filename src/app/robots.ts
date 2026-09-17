import type { MetadataRoute } from "next";
import { APP_NAV } from "@/lib/nav";
import { readRequestHost } from "@/lib/request-host";
import {
  isTbbtMarketingIndexableHost,
  TBBT_MARKETING_CANONICAL_ORIGIN,
  TBBT_MARKETING_PUBLIC_PATHS,
} from "@/lib/tbbt-marketing-host";

const APP_DISALLOW = [
  ...APP_NAV.map((item) => item.href),
  "/setup",
  "/field",
  "/access-restricted",
  "/api/",
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

  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/hire/", "/r/", "/e/", "/p/"],
      disallow: [...TBBT_MARKETING_PUBLIC_PATHS, ...APP_DISALLOW],
    },
  };
}
