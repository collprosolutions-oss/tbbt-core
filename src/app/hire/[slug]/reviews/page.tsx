import type { Metadata } from "next";
import { Clock, Handshake, Shield, Star, Users } from "lucide-react";
import "@/components/public/public-site.css";
import { PublicCtaBar } from "@/components/public/public-cta-bar";
import { PublicPageHero } from "@/components/public/public-page-hero";
import { PublicSiteShell } from "@/components/public/public-site-shell";
import { PublicUnavailable } from "@/components/public/public-unavailable";
import { smsHref } from "@/lib/directions";
import {
  REVIEWS_PLACEHOLDER_COPY,
  REVIEWS_TRUST_VALUES,
  REVIEWS_UNRATED_STATUS,
  publicDisplayName,
  publicHomePath,
  publicPhone,
  publicRequestPath,
} from "@/lib/public-site";
import { prisma } from "@/lib/prisma";
import { loadPublicSite } from "@/lib/public-site-data";
import { loadPublicReviewsImages } from "@/lib/public-site-images";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const site = await loadPublicSite(slug);
  const name = site ? publicDisplayName(site.business) : "Reviews";
  return {
    title: { absolute: `Reviews | ${name}` },
    description: `Customer feedback for ${name} will appear here when it is approved for public display.`,
  };
}

const TRUST_ICONS = [Shield, Clock, Handshake, Users] as const;

export default async function PublicReviewsPage({ params }: PageProps) {
  const { slug } = await params;
  const site = await loadPublicSite(slug);
  if (!site) {
    return <PublicUnavailable title="Page unavailable" body="This business could not be found." />;
  }
  const phone = publicPhone(site.business.slug);
  const images = await loadPublicReviewsImages(prisma, site.business.id, site.business.slug);

  return (
    <PublicSiteShell business={site.business} groups={site.groups}>
      <main>
        <PublicPageHero
          homeHref={publicHomePath(site.business.slug)}
          current="Reviews"
          title={<>Real Reviews.<br /><em>Real Results.</em></>}
          description="We take pride in our work. Public customer feedback will be shown here when it is available."
          imageSrc={images.hero.src}
          objectPosition={images.hero.objectPosition}
          phone={phone}
          smsHref={smsHref(phone)}
          requestHref={publicRequestPath(site.business.slug)}
        />
        <section className="public-trust-bar public-reviews-trust">
          <div className="public-container public-reviews-trust-grid">
            <div className="public-trust-item">
              <Star className="size-7 text-[var(--public-blue)]" aria-hidden="true" />
              <div>
                <h2>{REVIEWS_UNRATED_STATUS.title}</h2>
                <p>{REVIEWS_UNRATED_STATUS.body}</p>
              </div>
            </div>
            {REVIEWS_TRUST_VALUES.map((item, index) => {
              const Icon = TRUST_ICONS[index] ?? Shield;
              return (
                <div key={item.title} className="public-trust-item">
                  <Icon className="size-7 text-[var(--public-blue)]" aria-hidden="true" />
                  <div>
                    <h2>{item.title}</h2>
                    <p>{item.body}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
        <section className="bg-[var(--public-paper)] py-10">
          <div className="public-container">
            <h2 className="text-2xl font-extrabold uppercase">Customer Reviews</h2>
            <p className="mt-2 max-w-2xl text-muted-foreground">{REVIEWS_PLACEHOLDER_COPY}</p>
            <ul className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {Array.from({ length: 4 }).map((_, index) => (
                <li key={index} className="public-review-card">
                  <p className="text-xs font-extrabold tracking-[0.12em] uppercase">Review</p>
                  <p className="mt-4 text-sm leading-6 text-muted-foreground">
                    {REVIEWS_PLACEHOLDER_COPY}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>
        <PublicCtaBar
          title="Ready to start your project?"
          body="Let's make your home better — together. We're just a text away."
          requestHref={publicRequestPath(site.business.slug)}
          smsHref={smsHref(phone)}
          phone={phone}
        />
      </main>
    </PublicSiteShell>
  );
}
