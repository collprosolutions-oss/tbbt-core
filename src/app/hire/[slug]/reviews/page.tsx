import type { Metadata } from "next";
import { Clock, Handshake, Shield, Star, Users } from "lucide-react";
import "@/components/public/public-site.css";
import { PublicCtaBar } from "@/components/public/public-cta-bar";
import { PublicPageHero } from "@/components/public/public-page-hero";
import { PublicSiteShell } from "@/components/public/public-site-shell";
import { smsHref } from "@/lib/directions";
import {
  REVIEWS_PLACEHOLDER_COPY,
  REVIEWS_TRUST_VALUES,
  REVIEWS_UNRATED_STATUS,
  publicDisplayName,
  publicHomePath,
  publicPhone,
  publicRequestPath,
  publicReviewsPath,
} from "@/lib/public-site";
import { prisma } from "@/lib/prisma";
import { requirePublicWebsiteView } from "@/lib/require-public-site";
import { publicTenantPageMetadata } from "@/lib/public-site-seo";
import { buildPublicReviewsImagePresentation, loadPublicReviewsImages } from "@/lib/public-site-images";
import { snapshotToImageRows } from "@/lib/website-engine/public";
import { publicOriginForSlug } from "@/lib/website-engine/hosts";
import { readRequestHost } from "@/lib/request-host";

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
    title: `Reviews | ${name}`,
    description: `Customer feedback for ${name} will appear here when it is approved for public display.`,
    pathname: publicReviewsPath(site.business.slug),
    origin,
  });
}

const TRUST_ICONS = [Shield, Clock, Handshake, Users] as const;

export default async function PublicReviewsPage({ params }: PageProps) {
  const { slug } = await params;
  const view = await requirePublicWebsiteView(slug);
  const site = view.site;
  const phone = publicPhone(site.business);
  const images = view.snapshot
    ? buildPublicReviewsImagePresentation(snapshotToImageRows(view.snapshot), site.business.slug)
    : await loadPublicReviewsImages(prisma, site.business.id, site.business.slug);
  const publishedReviews = view.snapshot?.reviews ?? [];

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
          objectZoom={images.hero.objectZoom}
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
                <div key={item.title} className="public-trust-item public-reviews-trust-value">
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
            <p className="mt-2 max-w-2xl text-muted-foreground">
              {publishedReviews.length > 0
                ? "Customer reviews selected by the owner for public display."
                : REVIEWS_PLACEHOLDER_COPY}
            </p>
            <ul className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {publishedReviews.length > 0
                ? publishedReviews.map((review) => (
                    <li key={review.id} className="public-review-card">
                      <p className="text-xs font-extrabold tracking-[0.12em] uppercase">
                        {review.platform}
                        {review.rating != null ? ` · ${review.rating}/5` : ""}
                      </p>
                      <p className="mt-4 text-sm leading-6">{review.reviewText}</p>
                    </li>
                  ))
                : Array.from({ length: 4 }).map((_, index) => (
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
