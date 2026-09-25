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
import { requirePublicWebsiteView } from "@/lib/require-public-site";
import { publicTenantPageMetadata } from "@/lib/public-site-seo";
import { publishedProjectsDescription } from "@/lib/website-engine/copy";
import { publicOriginForSlug } from "@/lib/website-engine/hosts";
import { readRequestHost } from "@/lib/request-host";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const view = await requirePublicWebsiteView(slug);
  const site = view.site;
  const name = publicDisplayName(site.business);
  const origin = await publicOriginForSlug(prisma, site.business.slug, await readRequestHost());
  return publicTenantPageMetadata({
    business: site.business,
    title: `Projects | ${name}`,
    description: view.snapshot
      ? publishedProjectsDescription({ name, trades: view.snapshot.trades })
      : `Recent handyman and home-improvement project photos from ${name}.`,
    pathname: publicProjectsPath(site.business.slug),
    origin,
  });
}

export default async function PublicProjectsPage({ params }: PageProps) {
  const { slug } = await params;
  const view = await requirePublicWebsiteView(slug);
  const site = view.site;
  const phone = publicPhone(site.business);
  const gallery = view.snapshot?.gallery ?? [];
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
        {gallery.length > 0 ? (
          <section className="public-container py-8 grid gap-4 md:grid-cols-2">
            {gallery.map((item) => (
              <figure key={item.id}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={item.imageUrl} alt={item.title || "Project photo"} />
                {item.title || item.caption ? (
                  <figcaption className="mt-2 text-sm">
                    {item.title}
                    {item.caption ? ` — ${item.caption}` : ""}
                  </figcaption>
                ) : null}
              </figure>
            ))}
          </section>
        ) : (
          <PublicProjectsGallery slug={site.business.slug} />
        )}
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
