import type { Metadata } from "next";
import "@/components/public/public-site.css";
import { PublicAbout } from "@/components/public/public-about";
import { PublicCtaBar } from "@/components/public/public-cta-bar";
import { PublicPageHero } from "@/components/public/public-page-hero";
import { PublicSiteShell } from "@/components/public/public-site-shell";
import { PublicUnavailable } from "@/components/public/public-unavailable";
import { smsHref } from "@/lib/directions";
import {
  ABOUT_COPY,
  publicDisplayName,
  publicHomePath,
  publicPhone,
  publicRequestPath,
} from "@/lib/public-site";
import { prisma } from "@/lib/prisma";
import { loadPublicSite } from "@/lib/public-site-data";
import { loadPublicAboutImages } from "@/lib/public-site-images";
import { resolvePublishedAboutCopy } from "@/lib/website-story";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const site = await loadPublicSite(slug);
  const name = site ? publicDisplayName(site.business) : "About";
  return {
    title: { absolute: `About Us | ${name}` },
    description: `Learn how ${name} helps homeowners with handyman projects and written estimates.`,
  };
}

export default async function PublicAboutPage({ params }: PageProps) {
  const { slug } = await params;
  const site = await loadPublicSite(slug);
  if (!site) {
    return <PublicUnavailable title="Page unavailable" body="This business could not be found." />;
  }
  const phone = publicPhone(site.business.slug);
  const [images, settings] = await Promise.all([
    loadPublicAboutImages(prisma, site.business.id, site.business.slug),
    prisma.businessSettings.findUnique({
      where: { businessId: site.business.id },
      select: { approvedPublicAboutCopy: true },
    }),
  ]);
  const storyCopy = resolvePublishedAboutCopy(settings?.approvedPublicAboutCopy);

  return (
    <PublicSiteShell business={site.business} groups={site.groups}>
      <main>
        <PublicPageHero
          homeHref={publicHomePath(site.business.slug)}
          current="About Us"
          title={ABOUT_COPY.title}
          description={ABOUT_COPY.lead}
          imageSrc={images.hero.src}
          objectPosition={images.hero.objectPosition}
          objectZoom={images.hero.objectZoom}
          phone={phone}
          smsHref={smsHref(phone)}
          requestHref={publicRequestPath(site.business.slug)}
        />
        <PublicAbout storyImage={images.story} storyCopy={storyCopy} />
        <PublicCtaBar
          title="Ready to work together?"
          body="Tell us about your project and we will review the request before preparing a written estimate."
          requestHref={publicRequestPath(site.business.slug)}
          smsHref={smsHref(phone)}
          phone={phone}
        />
      </main>
    </PublicSiteShell>
  );
}
