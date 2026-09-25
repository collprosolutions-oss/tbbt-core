import type { Metadata } from "next";
import "@/components/public/public-site.css";
import { PublicHome } from "@/components/public/public-home";
import { PublicSiteShell } from "@/components/public/public-site-shell";
import {
  localBusinessJsonLd,
  publicDisplayName,
  publicHomePath,
  publicLogoSrc,
  publicPhone,
} from "@/lib/public-site";
import { buildPublicHomeImagePresentation, loadPublicHomeImages } from "@/lib/public-site-images";
import { prisma } from "@/lib/prisma";
import { requirePublicSite, requirePublicWebsiteView } from "@/lib/require-public-site";
import {
  publicSiteMetaDescription,
  publicTenantPageMetadata,
} from "@/lib/public-site-seo";
import { snapshotToImageRows } from "@/lib/website-engine/public";
import { viewHomeMetadata } from "@/lib/website-engine/seo";
import {
  publishedHeroImageAlt,
  publishedLocalBusinessDescription,
  publishedServicesHeadline,
} from "@/lib/website-engine/copy";
import { publicOriginForSlug } from "@/lib/website-engine/hosts";
import { readRequestHost } from "@/lib/request-host";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const view = await requirePublicWebsiteView(slug);
  const site: Awaited<ReturnType<typeof requirePublicSite>> = view.site;
  const origin = await publicOriginForSlug(prisma, site.business.slug, await readRequestHost());
  const snapshotMeta = viewHomeMetadata(view, publicHomePath(site.business.slug), origin);
  if (snapshotMeta) return snapshotMeta;
  const name = publicDisplayName(site.business);
  return publicTenantPageMetadata({
    business: site.business,
    title: `${name} | Services`,
    description: publicSiteMetaDescription(site.business, view.about),
    pathname: publicHomePath(site.business.slug),
    origin,
  });
}

export default async function PublicHirePage({ params }: PageProps) {
  const { slug } = await params;
  const view = await requirePublicWebsiteView(slug);
  const site: Awaited<ReturnType<typeof requirePublicSite>> = view.site;

  const homeImages = view.snapshot
    ? buildPublicHomeImagePresentation(site.groups, snapshotToImageRows(view.snapshot))
    : await loadPublicHomeImages(prisma, site.business.id, site.groups);
  const name = publicDisplayName(site.business);
  const origin = await publicOriginForSlug(prisma, site.business.slug, await readRequestHost());
  const jsonLd = localBusinessJsonLd({
    name,
    slug: site.business.slug,
    phone: publicPhone(site.business),
    logoSrc: publicLogoSrc(site.business.slug),
    description: view.snapshot
      ? publishedLocalBusinessDescription({
          name,
          trades: view.snapshot.trades,
          area: view.snapshot.business.publicServiceAreaLabel,
        })
      : `Handyman services from ${name}. Request repairs, installations, mounting, carpentry, and other home projects.`,
    origin,
  });

  return (
    <PublicSiteShell business={site.business} groups={site.groups}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <PublicHome
        business={site.business}
        items={site.items}
        groups={site.groups}
        images={homeImages}
        headline={view.snapshot?.home.headline}
        supporting={view.snapshot?.home.supporting}
        servicesHeading={
          view.snapshot ? publishedServicesHeadline(view.snapshot.trades) : undefined
        }
        heroImageAlt={
          view.snapshot ? publishedHeroImageAlt(view.snapshot.trades) : undefined
        }
      />
    </PublicSiteShell>
  );
}
