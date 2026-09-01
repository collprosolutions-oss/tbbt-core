import type { Metadata } from "next";
import "@/components/public/public-site.css";
import { PublicCtaBar } from "@/components/public/public-cta-bar";
import { PublicPageHero } from "@/components/public/public-page-hero";
import { PublicProjectsGallery } from "@/components/public/public-projects-gallery";
import { PublicSiteShell } from "@/components/public/public-site-shell";
import { PublicUnavailable } from "@/components/public/public-unavailable";
import { telHref } from "@/lib/directions";
import {
  publicDisplayName,
  publicHomePath,
  publicPhone,
  publicRequestPath,
} from "@/lib/public-site";
import { loadPublicSite } from "@/lib/public-site-data";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const site = await loadPublicSite(slug);
  const name = site ? publicDisplayName(site.business) : "Projects";
  return {
    title: { absolute: `Projects | ${name}` },
    description: `Recent handyman and home-improvement project photos from ${name}.`,
  };
}

export default async function PublicProjectsPage({ params }: PageProps) {
  const { slug } = await params;
  const site = await loadPublicSite(slug);

  if (!site) {
    return (
      <PublicUnavailable
        title="Page unavailable"
        body="This business could not be found."
      />
    );
  }

  const phone = publicPhone(site.business.slug);

  return (
    <PublicSiteShell business={site.business} groups={site.groups}>
      <main>
        <PublicPageHero
          homeHref={publicHomePath(site.business.slug)}
          current="Projects"
          title="Projects"
          description="Take a look at some of our recent handyman work and home improvement projects. Quality work on every project, big or small."
        />
        <PublicProjectsGallery />
        <PublicCtaBar
          title="Have a project in mind?"
          body="Let's bring your vision to life. Get a clear estimate and professional service from start to finish."
          requestHref={publicRequestPath(site.business.slug)}
          callHref={telHref(phone)}
          phone={phone}
        />
      </main>
    </PublicSiteShell>
  );
}
