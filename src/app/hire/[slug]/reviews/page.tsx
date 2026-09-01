import type { Metadata } from "next";
import { Clock, MessageSquare, Shield } from "lucide-react";
import "@/components/public/public-site.css";
import { PublicCtaBar } from "@/components/public/public-cta-bar";
import { PublicPageHero } from "@/components/public/public-page-hero";
import { PublicSiteShell } from "@/components/public/public-site-shell";
import { PublicUnavailable } from "@/components/public/public-unavailable";
import { smsHref } from "@/lib/directions";
import {
  PUBLIC_REVIEWS_HERO_IMAGE,
  REVIEWS_PLACEHOLDER_COPY,
  TRUST_POINTS,
  publicDisplayName,
  publicHomePath,
  publicPhone,
  publicRequestPath,
} from "@/lib/public-site";
import { loadPublicSite } from "@/lib/public-site-data";

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

const HIGHLIGHTS = [
  { title: "Quality Work", body: TRUST_POINTS[0].body, Icon: Shield },
  { title: "Clear Estimates", body: TRUST_POINTS[1].body, Icon: Clock },
  { title: "Great Communication", body: TRUST_POINTS[2].body, Icon: MessageSquare },
] as const;

export default async function PublicReviewsPage({ params }: PageProps) {
  const { slug } = await params;
  const site = await loadPublicSite(slug);
  if (!site) {
    return <PublicUnavailable title="Page unavailable" body="This business could not be found." />;
  }
  const phone = publicPhone(site.business.slug);
  return (
    <PublicSiteShell business={site.business} groups={site.groups}>
      <main>
        <PublicPageHero
          homeHref={publicHomePath(site.business.slug)}
          current="Reviews"
          title={<>Real Reviews.<br /><em>Real Results.</em></>}
          description="We take pride in our work. Public customer feedback will be shown here when it is available."
          imageSrc={PUBLIC_REVIEWS_HERO_IMAGE}
          phone={phone}
          smsHref={smsHref(phone)}
          requestHref={publicRequestPath(site.business.slug)}
        />
        <section className="bg-white">
          <div className="public-container grid gap-8 py-10 md:grid-cols-3">
            <div>
              <p className="text-xs font-extrabold tracking-[0.14em] uppercase">Customer feedback</p>
              <p className="mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
                Public reviews will be listed here when they are approved for display.
              </p>
            </div>
            <div className="grid gap-4">
              {HIGHLIGHTS.map((item) => (
                <div key={item.title} className="flex gap-3">
                  <item.Icon className="mt-0.5 size-6 shrink-0 text-[var(--public-blue)]" />
                  <div>
                    <h2 className="font-extrabold">{item.title}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">{item.body}</p>
                  </div>
                </div>
              ))}
            </div>
            <div>
              <p className="text-xs font-extrabold tracking-[0.14em] uppercase">Reviewed on</p>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                Public platform reviews will appear here as they become available.
              </p>
            </div>
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
