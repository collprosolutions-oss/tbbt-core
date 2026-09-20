import type { Metadata } from "next";
import "@/components/public/public-site.css";
import { PublicCtaBar } from "@/components/public/public-cta-bar";
import { PublicPageHero } from "@/components/public/public-page-hero";
import { PublicProjectsGallery } from "@/components/public/public-projects-gallery";
import { PublicSiteShell } from "@/components/public/public-site-shell";
import { smsHref } from "@/lib/directions";
import {
  PUBLIC_PROJECTS_HERO_IMAGE,
  publicDisplayName,
  publicHomePath,
  publicPhone,
  publicProjectsPath,
  publicRequestPath,
} from "@/lib/public-site";
import { requirePublicSite } from "@/lib/require-public-site";
import { publicTenantPageMetadata } from "@/lib/public-site-seo";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const site = await requirePublicSite(slug);
  const name = publicDisplayName(site.business);
  return publicTenantPageMetadata({
    business: site.business,
    title: `Projects | ${name}`,
    description: `Recent handyman and home-improvement project photos from ${name}.`,
    pathname: publicProjectsPath(site.business.slug),
  });
}

export default async function PublicProjectsPage({ params }: PageProps) {
  const { slug } = await params;
  const site = await requirePublicSite(slug);
  const phone = publicPhone(site.business);
  return (
    <PublicSiteShell business={site.business} groups={site.groups}>
      <main>
        <PublicPageHero
          homeHref={publicHomePath(site.business.slug)}
          current="Projects"
          title={<>Real Projects.<br /><em>Real Results.</em></>}
          description="Take a look at some of the recent work we've completed for our local homeowners. Quality work you can see."
          imageSrc={PUBLIC_PROJECTS_HERO_IMAGE}
          phone={phone}
          smsHref={smsHref(phone)}
          requestHref={publicRequestPath(site.business.slug)}
        />
        <PublicProjectsGallery slug={site.business.slug} />
        <PublicCtaBar
          title="Have a project in mind?"
          body="Let's make it happen. We're here to help."
          requestHref={publicRequestPath(site.business.slug)}
          smsHref={smsHref(phone)}
          phone={phone}
        />
      </main>
    </PublicSiteShell>
  );
}
