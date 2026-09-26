import type { Metadata } from "next";
import { publicIndexableSitemapPaths } from "@/lib/public-site";
import { publicCanonicalUrl } from "@/lib/public-site-seo";
import type { PublishedSeoPage, PublishedWebsiteSnapshot } from "@/lib/website-engine/snapshot";
import type { PublicWebsiteView } from "@/lib/website-engine/public";

export function snapshotPageMetadata(input: {
  snapshot: PublishedWebsiteSnapshot;
  page: PublishedSeoPage;
  pathname: string;
  ogImage?: string | null;
  origin?: string | null;
}): Metadata {
  const canonical = publicCanonicalUrl(
    input.snapshot.business.slug,
    input.pathname,
    input.origin,
  );
  return {
    title: { absolute: input.page.title },
    description: input.page.description,
    alternates: { canonical },
    robots:
      input.page.robots === "noindex"
        ? { index: false, follow: false }
        : { index: true, follow: true },
    openGraph: {
      title: input.page.title,
      description: input.page.description,
      url: canonical,
      images: input.ogImage ? [{ url: input.ogImage }] : undefined,
    },
  };
}

export function viewHomeMetadata(
  view: PublicWebsiteView,
  pathname: string,
  origin?: string | null,
): Metadata | null {
  if (!view.snapshot) return null;
  const og = view.snapshot.images.find((row) => row.page === "home")?.imageUrl ?? null;
  return snapshotPageMetadata({
    snapshot: view.snapshot,
    page: view.snapshot.seo.home,
    pathname,
    ogImage: og,
    origin,
  });
}

export function publishedSitemapPaths(snapshot: PublishedWebsiteSnapshot) {
  const slug = snapshot.business.slug;
  const paths = [...publicIndexableSitemapPaths(slug)];
  for (const service of snapshot.services) {
    paths.push(`/hire/${slug}/services/${service.slug}`);
  }
  for (const local of snapshot.localPages) {
    paths.push(`/hire/${slug}/in/${local.citySlug}/${local.serviceSlug}`);
  }
  return paths;
}
