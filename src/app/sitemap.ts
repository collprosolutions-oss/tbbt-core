import type { MetadataRoute } from "next";
import { readRequestHost } from "@/lib/request-host";
import {
  isTbbtMarketingIndexableHost,
  tbbtCanonicalUrl,
  TBBT_MARKETING_PUBLIC_PATHS,
} from "@/lib/tbbt-marketing-host";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const host = await readRequestHost();
  if (!isTbbtMarketingIndexableHost(host)) {
    return [];
  }

  const paths = ["/", ...TBBT_MARKETING_PUBLIC_PATHS.filter((path) => path !== "/home")];
  return paths.map((path) => ({
    url: tbbtCanonicalUrl(path),
    changeFrequency: path === "/" ? "weekly" : "monthly",
    priority: path === "/" ? 1 : 0.7,
  }));
}
