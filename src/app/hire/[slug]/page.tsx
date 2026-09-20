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
import { loadPublicHomeImages } from "@/lib/public-site-images";
import { prisma } from "@/lib/prisma";
import { loadPublicAboutCopy } from "@/lib/public-site-data";
import { requirePublicSite } from "@/lib/require-public-site";
import {
  publicSiteMetaDescription,
  publicTenantPageMetadata,
} from "@/lib/public-site-seo";
import { resolvePublishedAboutCopy } from "@/lib/website-story";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const site = await requirePublicSite(slug);
  const about = resolvePublishedAboutCopy(
    await loadPublicAboutCopy(site.business.id),
    site.business.slug,
  );
  const name = publicDisplayName(site.business);
  return publicTenantPageMetadata({
    business: site.business,
    title: `${name} | Handyman Services`,
    description: publicSiteMetaDescription(site.business, about),
    pathname: publicHomePath(site.business.slug),
  });
}

export default async function PublicHirePage({ params }: PageProps) {
  const { slug } = await params;
  const site = await requirePublicSite(slug);

  const homeImages = await loadPublicHomeImages(prisma, site.business.id, site.groups);
  const name = publicDisplayName(site.business);
  const jsonLd = localBusinessJsonLd({
    name,
    slug: site.business.slug,
    phone: publicPhone(site.business),
    logoSrc: publicLogoSrc(site.business.slug),
    description: `Handyman services from ${name}. Request repairs, installations, mounting, carpentry, and other home projects.`,
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
      />
    </PublicSiteShell>
  );
}
