import type { MetadataRoute } from "next";
import { readRequestHost } from "@/lib/request-host";
import { prisma } from "@/lib/prisma";
import { isLocalPreviewDefaultHost } from "@/lib/website-engine/hosts";
import { publishedSitemapPaths } from "@/lib/website-engine/seo";
import { publicIndexableSitemapPaths } from "@/lib/public-site";
import { buildPublicSitemap } from "@/lib/website-engine/sitemap";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export { isLocalPreviewDefaultHost, publishedSitemapPaths, publicIndexableSitemapPaths };

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const host = await readRequestHost();
  return buildPublicSitemap(prisma, host);
}
